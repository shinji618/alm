// 대시보드(ALM-010, WBS 4.1) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { PrincipalCache } from '../src/platform/identity/principal';
import { catalog } from '../src/platform/identity/permissions';
import { createApi } from '../src/main';
import { MemoryCounterStore, SharedLimiter } from '../src/common/shared';
import type { FileStore } from '../src/files/files';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_dash_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
const ids: Record<string, string> = {};
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)], filesScanRequired: false,
};
const fakeCognito = {
  verifyAccess: async (t: string) => { const [, u, c] = t.split(':'); if (!u) throw new Error('bad'); return { sub: 's', username: u, client_id: c, token_use: 'access', exp: 0 }; },
};
const files: FileStore = {
  presignPut: async (key) => ({ url: `https://s3.test/${key}`, headers: {} }), presignGet: async (key) => `https://s3.test/${key}?get`,
  head: async () => null, scanStatus: async () => undefined, remove: async () => undefined,
};

async function raw(who: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-DSH_${who}:web`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await raw(who, method, path, body);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

import { setRoleScopeByEmail } from './roleHelper';
import { clearDashboardCache } from '../src/dashboard/dashboard';

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'DSH', name: 'Dash', idpType: 'OIDC' }, domains: ['dsh.test'],
    users: [{ email: 'am@dsh.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'ac@dsh.test', displayName: 'Accountant', roles: ['ASSET_ACCOUNTANT'] },
            { email: 'dm@dsh.test', displayName: 'Dept Mgr', roles: ['DEPT_MANAGER'] },
            { email: 'emp@dsh.test', displayName: 'Employee', roles: [] }] })).tenantId;
  for (const u of ['am', 'ac', 'dm', 'emp']) await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2`, [u, `${u}@dsh.test`]);
  const q = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0]?.id as string;
  ids.co = await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [tenantId]);
  ids.s1 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]);
  ids.s2 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'NYC', 'New York') RETURNING id`, [tenantId]);
  ids.cc1 = await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [tenantId, ids.co]);
  ids.cc2 = await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC200', 'Sales', $2) RETURNING id`, [tenantId, ids.co]);
  await setRoleScopeByEmail((s, a) => owner.query(s, a), 'dm@dsh.test', { costCenter: ids.cc1 });
  ids.nb = await q(`INSERT INTO category (id, tenant_id, category_code, name, useful_life_years) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook', 3) RETURNING id`, [tenantId]);
  ids.mon = await q(`INSERT INTO category (id, tenant_id, category_code, name, useful_life_years) VALUES (gen_random_uuid(), $1, 'MON', 'Monitor', 5) RETURNING id`, [tenantId]);
  const asset = (tag: string, cat: string, site: string, cc: string, cols: Record<string, unknown> = {}) => {
    const ks = Object.keys(cols);
    return q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id, site_id, cost_center_id${ks.map((k) => `, ${k}`).join('')})
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MANUAL', $5, $6, $7${ks.map((_, i) => `, $${8 + i}`).join('')}) RETURNING id`,
    [tenantId, tag, `Item ${tag}`, cat, ids.co, site, cc, ...Object.values(cols)]);
  };
  // a1: 사용 중, 내용연수(3년) 경과, 보증 20일 남음, SAP 금액
  ids.a1 = await asset('AT-000001', ids.nb, ids.s1, ids.cc1, { status: 'IN_USE', purchase_date: '2020-01-01', warranty_end_date: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10) });
  await owner.query(`INSERT INTO asset_value (id, tenant_id, asset_id, fiscal_year, period, acquisition_value, accum_depreciation, net_book_value, received_at)
    VALUES (gen_random_uuid(), $1, $2, 2026, 9, 1000, 300, 700, now())`, [tenantId, ids.a1]);
  ids.a2 = await asset('AT-000002', ids.nb, ids.s2, ids.cc2, { status: 'IN_STOCK', purchase_date: '2026-01-01', warranty_end_date: new Date(Date.now() + 100 * 864e5).toISOString().slice(0, 10) });
  ids.a3 = await asset('AT-000003', ids.mon, ids.s1, ids.cc1, { status: 'RETIRED' });
  ids.a4 = await asset('AT-000004', ids.mon, ids.s1, ids.cc2, { status: 'ON_ORDER' });
  await owner.query(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, status, company_id, payload) VALUES (gen_random_uuid(), $1, 'AR-00001', 'ASSET_CHANGE', 'FAILED', $2, '{}')`, [tenantId, ids.co]);
  const tpl = await q(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, zpl, is_default) VALUES (gen_random_uuid(), $1, 'STD', 'Std', 'QR_CODE128', '^XA^XZ', true) RETURNING id`, [tenantId]);
  await owner.query(`INSERT INTO label_print_job (id, tenant_id, asset_id, template_id, source) VALUES (gen_random_uuid(), $1, $2, $3, 'BULK')`, [tenantId, ids.a2, tpl]);
  await owner.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, occurred_at) VALUES (gen_random_uuid(), $1, $2, 'CREATED', 'UI', now() - interval '1 hour'),
    (gen_random_uuid(), $1, $3, 'ASSIGNED', 'UI', now())`, [tenantId, ids.a1, ids.a2]);
  const api = await createApi({ cfg, db: app, cognito: fakeCognito as never, principals: new PrincipalCache(), limiter: new SharedLimiter(new MemoryCounterStore()), files });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.getHttpServer().address() as AddressInfo).port}/api/v1`;
  close = () => api.close();
});

after(async () => {
  if (skip) return;
  await close?.(); await app?.close(); await owner?.end();
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

const kpi = (b: { kpis: { key: string; value: number | null; secondary?: number | null }[] }, key: string) => b.kpis.find((x) => x.key === key);

test('대시보드: 자산 관리자 — KPI·단계·카테고리·갱신·조치·최근 활동', { skip }, async () => {
  const r = await call('am', 'GET', '/dashboard');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.valuePeriod, '009/2026');
  assert.equal(kpi(b, 'activeAssets')!.value, 2, '폐기·발주 중 제외');
  assert.deepEqual([kpi(b, 'nbv')!.value, kpi(b, 'nbv')!.secondary], [700, 1000]);
  assert.equal(kpi(b, 'warrantyExpiring')!.value, 1, '90일 이내');
  assert.equal(kpi(b, 'licenseCompliance')!.value, null, '라이선스 없음 → —');
  assert.equal(kpi(b, 'countVariance')!.value, 0);
  assert.equal(kpi(b, 'sapErrors')!.value, 1);
  assert.deepEqual(b.stages.map((x: { stage: string; count: number }) => [x.stage, x.count]),
    [['PLAN', 1], ['PROCURE', 0], ['DEPLOY', 1], ['OPERATE', 0], ['MAINTAIN', 1], ['RETIRE', 1]]);
  assert.deepEqual(b.categories.map((x: Record<string, unknown>) => [x.name, x.total, x.inUse, x.inStock, x.pastUsefulLife, x.nbv]), [['Notebook', 2, 1, 1, 1, 700]]);
  assert.deepEqual(b.renewals.map((x: { kind: string; daysLeft: number }) => [x.kind, x.daysLeft]), [['WARRANTY', 20], ['WARRANTY', 100]]);
  assert.deepEqual(b.actions.map((x: { kind: string; count: number }) => [x.kind, x.count]), [['POSTING_ERROR', 1], ['LABEL_QUEUED', 1]]);
  assert.deepEqual(b.activity.map((x: { assetTag: string; eventType: string }) => [x.assetTag, x.eventType]), [['AT-000002', 'ASSIGNED'], ['AT-000001', 'CREATED']]);
  // 사이트 필터
  const nyc = (await call('am', 'GET', `/dashboard?siteId=${ids.s2}`)).body;
  assert.equal(kpi(nyc, 'activeAssets')!.value, 1);
  assert.equal((await call('am', 'GET', '/dashboard?siteId=bad')).status, 400);
});

test('대시보드: 권한별 — 부서 관리자 코스트센터 범위·금액 없음, 자산회계 SAP 오류, 직원 불가', { skip }, async () => {
  const dm = (await call('dm', 'GET', '/dashboard')).body;
  assert.equal(kpi(dm, 'activeAssets')!.value, 1, 'CC100만');
  assert.equal(kpi(dm, 'nbv')!.value, null, 'amount.read 없음');
  assert.equal(dm.categories[0].nbv, null);
  assert.deepEqual(dm.kpis.map((x: { key: string }) => x.key), ['activeAssets', 'nbv', 'warrantyExpiring']);
  assert.deepEqual(dm.activity.map((x: { assetTag: string }) => x.assetTag), ['AT-000001']);
  const ac = (await call('ac', 'GET', '/dashboard')).body;
  assert.equal(kpi(ac, 'sapErrors')!.value, 1);
  assert.ok(ac.actions.some((x: { kind: string; count: number }) => x.kind === 'POSTING_ERROR' && x.count === 1));
  assert.equal((await call('emp', 'GET', '/dashboard')).status, 403);
  // 5분 캐시: 바뀐 자산은 refresh=true일 때 반영
  await owner.query(`UPDATE asset SET status = 'IN_USE' WHERE id = $1`, [ids.a4]);
  assert.equal(kpi((await call('dm', 'GET', '/dashboard')).body, 'activeAssets')!.value, 1, '캐시');
  assert.equal(kpi((await call('am', 'GET', '/dashboard?refresh=true')).body, 'activeAssets')!.value, 3);
  clearDashboardCache();
});
