// 재산세 신고 자료·과거 기록(ALM-260) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { PrincipalCache } from '../src/auth/principal';
import { catalog } from '../src/auth/permissions';
import { createApi } from '../src/main';
import { MemoryCounterStore, SharedLimiter } from '../src/common/shared';
import type { FileStore } from '../src/files/files';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_tax_${Date.now()}`;
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
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-TAX_${who}:web`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await raw(who, method, path, body);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'TAX', name: 'Tax', idpType: 'OIDC' }, domains: ['tax.test'],
    users: [{ email: 'ac@tax.test', displayName: 'Accountant', roles: ['ASSET_ACCOUNTANT'] },
            { email: 'am@tax.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'emp@tax.test', displayName: 'Employee', roles: [] }] })).tenantId;
  for (const u of ['ac', 'am', 'emp']) await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2`, [u, `${u}@tax.test`]);
  const q = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0]?.id as string;
  ids.co = await q(`INSERT INTO company (id, tenant_id, company_code, name, sap_enabled) VALUES (gen_random_uuid(), $1, '1000', 'BSG', true) RETURNING id`, [tenantId]);
  ids.s1 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]);
  ids.s2 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'NYC', 'New York') RETURNING id`, [tenantId]);
  ids.cat = await q(`INSERT INTO category (id, tenant_id, category_code, name, useful_life_years) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook', 5) RETURNING id`, [tenantId]);
  const asset = (tag: string, site: string, cols: Record<string, unknown>) => {
    const ks = Object.keys(cols);
    return q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id, site_id${ks.map((k) => `, ${k}`).join('')})
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MANUAL', $5, $6${ks.map((_, i) => `, $${7 + i}`).join('')}) RETURNING id`,
    [tenantId, tag, `Laptop ${tag}`, ids.cat, ids.co, site, ...Object.values(cols)]);
  };
  // SAP 자산: SAP 취득가 10,000(ALM 구매가 9,000은 무시), 2024 취득
  ids.a1 = await asset('AT-000001', ids.s1, { sap_asset_no: '1000001', sap_sub_no: '0', is_capitalized: true, sap_cap_date: '2024-03-01', purchase_cost: 9000 });
  await owner.query(`INSERT INTO asset_value (id, tenant_id, asset_id, fiscal_year, period, acquisition_value, accum_depreciation, net_book_value, received_at)
    VALUES (gen_random_uuid(), $1, $2, 2025, 12, 10000, 3000, 7000, now())`, [tenantId, ids.a1]);
  ids.a2 = await asset('AT-000002', ids.s1, { purchase_date: '2025-06-01', purchase_cost: 2000 });         // ALM 구매가
  ids.a3 = await asset('AT-000003', ids.s1, { purchase_date: '2023-01-01' });                              // 원가 모름
  ids.a4 = await asset('AT-000004', ids.s1, { purchase_date: '2026-02-01', purchase_cost: 500 });          // 기준일 뒤 취득
  ids.a5 = await asset('AT-000005', ids.s1, { purchase_date: '2020-01-01', purchase_cost: 800, status: 'RETIRED', sap_deact_date: '2025-12-01' });
  ids.a6 = await asset('AT-000006', ids.s2, { purchase_date: '2024-01-01', purchase_cost: 700 });          // 관할 없음
  ids.a7 = await asset('AT-000007', ids.s1, { purchase_date: '2025-01-01', purchase_cost: 100, status: 'ON_ORDER' });
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

test('재산세: 권한·참고값·관할·계수표', { skip }, async () => {
  assert.equal((await call('emp', 'GET', '/tax/filings')).status, 403);
  const ref = await call('ac', 'GET', '/tax/reference');
  assert.equal(ref.status, 200);
  assert.deepEqual(ref.body.presets.map((p: { state: string }) => p.state), ['GA', 'AL', 'TX', 'CA', 'IL', 'NJ']);
  assert.equal(ref.body.presets.find((p: { state: string }) => p.state === 'IL').taxable, false);
  assert.equal((await call('am', 'GET', '/tax/jurisdictions')).status, 200, '자산 관리자는 조회만');

  const ga = { state: 'ga', county: 'Fulton', name: 'Fulton County, GA', formCode: 'PT-50P', lienMonth: 1, lienDay: 1, dueMonth: 4, dueDay: 1,
    assessmentRatio: 0.4, millage: 30, exemptionMode: 'THRESHOLD', exemptionAmount: 20000, factorSet: 'GA_DOR' };
  assert.equal((await call('am', 'POST', '/tax/jurisdictions', ga)).status, 403);
  assert.equal((await call('ac', 'POST', '/tax/jurisdictions', { ...ga, lienMonth: 13 })).status, 400);
  const j = await call('ac', 'POST', '/tax/jurisdictions', ga);
  assert.equal(j.status, 201, JSON.stringify(j.body));
  assert.equal(j.body.state, 'GA');
  ids.jur = j.body.id;
  assert.equal((await call('ac', 'POST', '/tax/jurisdictions', ga)).status, 409);
  const s = await call('ac', 'PUT', `/tax/jurisdictions/${ids.jur}/sites`, { siteIds: [ids.s1] });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.sites.map((x: { siteCode: string }) => x.siteCode), ['ATL']);

  assert.equal((await call('ac', 'POST', '/tax/factors:load-reference', { factorSet: 'GENERIC_SL' })).status, 409);
  const f = await call('ac', 'POST', '/tax/factors:load-reference', { factorSet: 'GA_DOR' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.deepEqual(f.body.tableYears, [2024]);
  assert.equal(f.body.rows.find((r: { lifeClass: string; age: number }) => r.lifeClass === 'I' && r.age === 2).factor, 0.74);
  const bad = await call('ac', 'PUT', '/tax/factors', { factorSet: 'GA_DOR', tableYear: 2026, rows: [{ lifeClass: 'I', age: 1, factor: 0.9 }, { lifeClass: 'I', age: 1, factor: 0.8 }] });
  assert.equal(bad.status, 400, '같은 구분·경과연수 중복');
  const cm = await call('ac', 'GET', '/tax/class-map?factorSet=GA_DOR');
  assert.equal(cm.body.items[0].defaultClass, 'I', '내용연수 5년 → Class I');
});

test('재산세: 신고 자료 계산·면제·다시 계산·행·엑셀', { skip }, async () => {
  const r = await call('ac', 'POST', '/tax/filings', { companyId: ids.co, jurisdictionId: ids.jur, taxYear: 2026 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.f26 = r.body.id;
  assert.equal(r.body.lienDate, '2026-01-01');
  assert.equal(r.body.dueDate, '2026-04-01');
  assert.equal(r.body.assetCount, 3, 'a1·a2·a3 (a4 기준일 뒤, a5 처분, a6 관할 없음, a7 발주 중)');
  assert.equal(r.body.totalCost, 12000, 'SAP 10,000 + ALM 2,000');
  assert.equal(r.body.totalMarketValue, 9140, '10,000×0.74 + 2,000×0.87');
  assert.equal(r.body.exemption, 9140, '$20,000 이하 면제');
  assert.equal(r.body.estimatedTax, 0);
  const codes = r.body.warnings.map((w: { code: string }) => w.code);
  for (const c of ['OLD_FACTOR_TABLE', 'NO_JURISDICTION', 'UNKNOWN_COST', 'EXEMPT']) assert.ok(codes.includes(c), c);
  assert.equal((await call('ac', 'POST', '/tax/filings', { companyId: ids.co, jurisdictionId: ids.jur, taxYear: 2026 })).status, 409);

  await call('ac', 'PATCH', `/tax/jurisdictions/${ids.jur}`, { exemptionMode: 'NONE' });
  const g = await call('ac', 'POST', `/tax/filings/${ids.f26}:regenerate`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.assessedValue, 3656, '9,140 × 40%');
  assert.equal(g.body.estimatedTax, 109.68, '3,656 × 30 ÷ 1,000');
  assert.equal(g.body.schedule.length, 3);

  const lines = await call('ac', 'GET', `/tax/filings/${ids.f26}/lines`);
  assert.equal(lines.body.total, 3);
  const a1 = lines.body.items.find((l: { assetTag: string }) => l.assetTag === 'AT-000001');
  assert.equal(a1.costSource, 'SAP');
  assert.equal(a1.originalCost, 10000);
  assert.equal(a1.age, 2);
  assert.equal(a1.change, 'NEW');
  assert.equal(lines.body.items.find((l: { assetTag: string }) => l.assetTag === 'AT-000003').originalCost, undefined);

  const x = await raw('am', 'GET', `/tax/filings/${ids.f26}/export`);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type') ?? '', /spreadsheetml/);
  assert.match(x.headers.get('content-disposition') ?? '', /BPP_2026_GA_Fulton_1000\.xlsx/);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(buf.includes(Buffer.from('xl/worksheets/sheet6.xml')));
  assert.ok(buf.includes(Buffer.from('AT-000001')));
});

test('재산세: 신고 완료·고지 기록·정정·과거 기록·전년 대비', { skip }, async () => {
  assert.equal((await call('ac', 'PATCH', `/tax/filings/${ids.f26}`, { actualTax: 100 })).status, 409, 'DRAFT에서는 고지 기록 불가');
  const fl = await call('ac', 'POST', `/tax/filings/${ids.f26}:file`, { filedAt: '2026-03-20', filingRef: 'FUL-2026-001' });
  assert.equal(fl.status, 200, JSON.stringify(fl.body));
  assert.equal(fl.body.status, 'FILED');
  assert.equal((await call('ac', 'POST', `/tax/filings/${ids.f26}:regenerate`)).status, 409);
  assert.equal((await call('ac', 'DELETE', `/tax/filings/${ids.f26}`)).status, 409);
  const re = await call('ac', 'POST', `/tax/filings/${ids.f26}:reopen`);
  assert.equal(re.body.status, 'DRAFT');
  await call('ac', 'POST', `/tax/filings/${ids.f26}:file`, { filedAt: '2026-03-21' });
  const as = await call('ac', 'PATCH', `/tax/filings/${ids.f26}`, { actualAssessed: 3700, actualTax: 111.0 });
  assert.equal(as.body.status, 'ASSESSED');
  assert.equal(as.body.actualTax, 111);
  assert.equal((await call('ac', 'POST', `/tax/filings/${ids.f26}:reopen`)).status, 409, '고지 결과가 있으면 정정 불가');

  // 2026년 중: a2 처분, a8 신규
  await owner.query(`UPDATE asset SET status = 'DISPOSED' WHERE id = $1`, [ids.a2]);
  await owner.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, occurred_at, channel) VALUES (gen_random_uuid(), $1, $2, 'DISPOSED', '2026-06-01', 'WEB')`, [tenantId, ids.a2]);
  await owner.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id, site_id, purchase_date, purchase_cost)
    VALUES (gen_random_uuid(), $1, 'AT-000008', 'Monitor', $2, 'MANUAL', $3, $4, '2026-05-01', 3000)`, [tenantId, ids.cat, ids.co, ids.s1]);
  const n = await call('ac', 'POST', '/tax/filings', { companyId: ids.co, jurisdictionId: ids.jur, taxYear: 2027 });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  ids.f27 = n.body.id;
  assert.equal(n.body.changes.NEW.count, 2, 'AT-000004(2026-02 취득)·AT-000008');
  assert.equal(n.body.changes.CARRIED.count, 2);
  assert.equal(n.body.changes.DISPOSED.count, 1);
  assert.equal(n.body.prior.taxYear, 2026);
  assert.equal(n.body.prior.actualTax, 111);
  const disp = await call('ac', 'GET', `/tax/filings/${ids.f27}/lines?change=DISPOSED`);
  assert.equal(disp.body.items[0].assetTag, 'AT-000002');
  assert.equal(disp.body.items[0].disposalDate, '2026-06-01');

  // 구분 매핑: Notebook → Class II
  const cm = await call('ac', 'PUT', '/tax/class-map', { factorSet: 'GA_DOR', items: [{ categoryId: ids.cat, lifeClass: 'II' }] });
  assert.equal(cm.body.items[0].lifeClass, 'II');
  await call('ac', 'POST', `/tax/filings/${ids.f27}:regenerate`);
  const l27 = await call('ac', 'GET', `/tax/filings/${ids.f27}/lines?q=AT-000001`);
  assert.equal(l27.body.items[0].lifeClass, 'II');
  assert.equal(l27.body.items[0].factor, 0.78, 'Class II 경과 3년');

  const h = await call('am', 'GET', '/tax/filings');
  assert.deepEqual(h.body.years, [2027, 2026]);
  assert.equal(h.body.items.length, 2);
  const h26 = await call('ac', 'GET', '/tax/filings?taxYear=2026&state=ga');
  assert.equal(h26.body.items.length, 1);
  assert.equal(h26.body.items[0].status, 'ASSESSED');
  assert.equal((await call('ac', 'GET', '/tax/filings?status=DRAFT')).body.items[0].taxYear, 2027);
  assert.equal((await call('ac', 'DELETE', `/tax/filings/${ids.f27}`)).status, 204);
});
