// Bundle 자산 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
const dbName = `alm_bundle_${Date.now()}`;
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

async function raw(who: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-BUN_${who}:web`, 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(who: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await raw(who, method, path, body, extra);
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
  tenantId = (await seed(owner, { tenant: { code: 'BUN', name: 'Bundle', idpType: 'OIDC' }, domains: ['bun.test'],
    users: [{ email: 'am@bun.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'atl@bun.test', displayName: 'ATL Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'ac@bun.test', displayName: 'Accountant', roles: ['ASSET_ACCOUNTANT'] },
            { email: 'kim@bun.test', displayName: 'Kim', roles: [] },
            { email: 'c1@bun.test', displayName: 'Counter', roles: ['COUNTER'] }] })).tenantId;
  for (const u of ['am', 'atl', 'ac', 'kim', 'c1']) await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2`, [u, `${u}@bun.test`]);
  const q = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0]?.id as string;
  ids.co = await q(`INSERT INTO company (id, tenant_id, company_code, name, sap_enabled) VALUES (gen_random_uuid(), $1, '1000', 'BSG', true) RETURNING id`, [tenantId]);
  ids.s1 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]);
  ids.s2 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'NYC', 'New York') RETURNING id`, [tenantId]);
  await owner.query(`UPDATE user_role SET site_id = $1 WHERE user_id = (SELECT id FROM app_user WHERE email = 'atl@bun.test')`, [ids.s1]);
  ids.r1 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-101', 'Office 101', 'RM-1') RETURNING id`, [tenantId, ids.s1]);
  ids.r2 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-102', 'Office 102', 'RM-2') RETURNING id`, [tenantId, ids.s1]);
  ids.r3 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'NYC-201', 'NY', 'RM-3') RETURNING id`, [tenantId, ids.s2]);
  ids.cc = await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [tenantId, ids.co]);
  ids.nb = await q(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`, [tenantId]);
  ids.m1 = await q(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name, part_no) VALUES (gen_random_uuid(), $1, $2, 'Dell', 'Latitude 7440', 'LAT7440') RETURNING id`, [tenantId, ids.nb]);
  ids.m2 = await q(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name) VALUES (gen_random_uuid(), $1, $2, 'Lenovo', 'T14') RETURNING id`, [tenantId, ids.nb]);
  ids.cls = await q(`INSERT INTO asset_class (id, tenant_id, class_code, name, default_useful_life_years) VALUES (gen_random_uuid(), $1, '00003200', 'IT HW', 5) RETURNING id`, [tenantId]);
  ids.co2 = await q(`INSERT INTO company (id, tenant_id, company_code, name, sap_enabled) VALUES (gen_random_uuid(), $1, '2000', 'Other', false) RETURNING id`, [tenantId]);
  ids.cc2 = await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC900', 'X', $2) RETURNING id`, [tenantId, ids.co2]);
  const mk = (tag: string, cost: number | null, extra = '', more: unknown[] = []) => q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, model_id, source, company_id, site_id, room_id, cost_center_id, purchase_cost${extra ? `, ${extra}` : ''})
    VALUES (gen_random_uuid(), $1, $2, $2, $3, $4, 'MANUAL', $5, $6, $7, $8, $9${more.map((_, i) => `, $${10 + i}`).join('')}) RETURNING id`, [tenantId, tag, ids.nb, ids.m1, ids.co, ids.s1, ids.r1, ids.cc, cost, ...more]);
  ids.c1 = await mk('AT-000101', 1000);
  ids.c2 = await mk('AT-000102', 500.5);
  ids.c3 = await mk('AT-000103', 200);
  ids.sap = await mk('AT-000104', 900, 'sap_asset_no', ['000001000050']);
  ids.other = await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, model_id, source, company_id, site_id, room_id, cost_center_id)
    VALUES (gen_random_uuid(), $1, 'AT-000105', 'other co', $2, $3, 'MANUAL', $4, $5, $6, $7) RETURNING id`, [tenantId, ids.nb, ids.m1, ids.co2, ids.s1, ids.r1, ids.cc2]);
  ids.a1 = await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, model_id, source, company_id, site_id, room_id, cost_center_id)
    VALUES (gen_random_uuid(), $1, 'AT-000001', 'Old name', $2, $3, 'MANUAL', $4, $5, $6, $7) RETURNING id`, [tenantId, ids.nb, ids.m1, ids.co, ids.s1, ids.r1, ids.cc]);
  ids.a2 = await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, model_id, source, company_id, site_id, room_id, cost_center_id)
    VALUES (gen_random_uuid(), $1, 'AT-000002', 'NY laptop', $2, $3, 'MANUAL', $4, $5, $6, $7) RETURNING id`, [tenantId, ids.nb, ids.m1, ids.co, ids.s2, ids.r3, ids.cc]);
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


test('Bundle: 등록(구성품·SAP 등록 취득가 = 구성품 합)·구성품 규칙·상세·목록', { skip }, async () => {
  const base = { isBundle: true, categoryId: ids.nb, description: 'Conference room AV set', companyId: ids.co, roomId: ids.r1, costCenterId: ids.cc, printLabel: false };
  assert.equal((await call('am', 'POST', '/assets', { ...base, isBundle: false, modelId: ids.m1, componentIds: [ids.c1] })).status, 400, 'componentIds는 Bundle만');
  const bad = await call('am', 'POST', '/assets', { ...base, componentIds: [ids.c1, ids.sap, ids.other] });
  assert.equal(bad.status, 409);
  assert.deepEqual(bad.body.errors.map((e: { field: string }) => e.field).sort(), ['AT-000104', 'AT-000105']);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset WHERE is_bundle`)).rows[0].n, 0, '되돌림');

  const r = await call('am', 'POST', '/assets', { ...base, componentIds: [ids.c1, ids.c2], registerInSap: true, assetClassId: ids.cls });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.b = r.body.asset.id;
  assert.equal(r.body.asset.isBundle, true);
  assert.deepEqual(r.body.asset.components.map((x: { assetTag: string }) => x.assetTag), ['AT-000101', 'AT-000102']);
  assert.equal(r.body.asset.componentCostTotal, 1500.5);
  assert.equal(r.body.createdRequest.requestType, 'NEW_ASSET');
  assert.equal(Number((await owner.query(`SELECT acquisition_value FROM asset_request WHERE id = $1`, [r.body.createdRequest.id])).rows[0].acquisition_value), 1500.5);
  ids.bReq = r.body.createdRequest.id;

  // 구성품 추가·빼기
  const dup = await call('am', 'POST', `/assets/${ids.b}/components`, { assetTags: ['at-000101', 'AT-000104', 'AT-999999'] });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body.errors.map((e: { field: string; code: string }) => [e.field, e.code]).sort(), [['AT-000104', 'ALM-E322'], ['AT-999999', 'ALM-E404']]);
  assert.equal((await call('am', 'POST', `/assets/${ids.c3}/components`, { assetIds: [ids.c1] })).status, 409, 'Bundle 아님');
  assert.equal((await call('am', 'POST', `/assets/${ids.b}/components`, { assetIds: [ids.b] })).status, 409, '자기 자신');
  const add = await call('am', 'POST', `/assets/${ids.b}/components`, { assetTags: ['at-000103', 'AT-000101'] });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual(add.body.added, ['AT-000103']);
  assert.equal(add.body.components.length, 3);
  assert.equal((await call('kim', 'POST', `/assets/${ids.b}/components`, { assetIds: [ids.a1] })).status, 403);
  const rm = await call('am', 'DELETE', `/assets/${ids.b}/components/${ids.c3}`);
  assert.equal(rm.status, 200);
  assert.equal(rm.body.components.length, 2);
  assert.equal((await call('am', 'DELETE', `/assets/${ids.b}/components/${ids.c3}`)).status, 404);

  const c = await call('am', 'GET', `/assets/${ids.c1}`);
  assert.deepEqual(c.body.bundle, { id: ids.b, assetTag: r.body.asset.assetTag, description: 'Conference room AV set' });
  const list = await call('am', 'GET', '/assets?pageSize=100');
  const row = (id: string) => list.body.items.find((x: { id: string }) => x.id === id);
  assert.deepEqual([row(ids.b).isBundle, row(ids.b).componentCount], [true, 2]);
  assert.equal(row(ids.c1).bundleAssetTag, r.body.asset.assetTag);
  const hist = (await owner.query(`SELECT changes FROM asset_event WHERE asset_id = $1 AND event_type = 'UPDATED' ORDER BY occurred_at`, [ids.c3])).rows.map((x) => x.changes);
  assert.equal(hist.length, 2);
});

test('Bundle: 구성품은 SAP 신규 등록 요청 불가, 진행 중 NEW_ASSET이 있으면 구성품이 될 수 없음', { skip }, async () => {
  const req = await call('am', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: ids.c1, reason: 'x', assetClassId: ids.cls, targetCostCenterId: ids.cc, acquisitionValue: 100 });
  assert.equal(req.status, 409);
  assert.match(req.body.detail, /Bundle/);
  const own = await call('am', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: ids.c3, reason: 'x', assetClassId: ids.cls, targetCostCenterId: ids.cc, acquisitionValue: 100 });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const add = await call('am', 'POST', `/assets/${ids.b}/components`, { assetIds: [ids.c3] });
  assert.equal(add.status, 409);
  assert.match(add.body.errors[0].message, /SAP 신규 등록 요청/);
  await owner.query(`UPDATE asset_request SET status = 'CANCELLED' WHERE id = $1`, [own.body.id ?? own.body.request?.id]);
});

test('Bundle: 실사는 구성품별, SAP 실사 결과는 Bundle 1건', { skip }, async () => {
  // Bundle이 SAP에 등록된 것으로
  await owner.query(`UPDATE asset_request SET status = 'POSTED' WHERE id = $1`, [ids.bReq]);
  await owner.query(`UPDATE asset SET sap_asset_no = '000001000060', sap_sub_no = '0000', is_capitalized = true, asset_class_id = $2 WHERE id = $1`, [ids.b, ids.cls]);
  const camp = await call('am', 'POST', '/count-campaigns', { campaignCode: 'PIB1', name: 'Bundle count', companyId: ids.co, keyDate: '2026-10-15', dueDate: '2026-10-31',
    scope: { siteIds: [ids.s1], assetClassIds: [ids.cls] } });
  assert.equal(camp.status, 201, JSON.stringify(camp.body));
  const id = camp.body.campaign.id ?? camp.body.id;
  await call('am', 'GET', `/count-campaigns/${id}/tasks`);
  await owner.query(`UPDATE count_task SET assignee_id = (SELECT id FROM app_user WHERE email = 'c1@bun.test') WHERE campaign_id = $1`, [id]);
  const st = await call('am', 'POST', `/count-campaigns/${id}:start`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const items = (await owner.query(`SELECT a.asset_tag FROM count_item ci JOIN asset a ON a.id = ci.asset_id WHERE ci.campaign_id = $1 ORDER BY 1`, [id])).rows.map((x) => x.asset_tag);
  assert.deepEqual(items, ['AT-000101', 'AT-000102'], 'Bundle 제외, 구성품은 Bundle의 클래스로 범위에 들어감');
  await owner.query(`UPDATE count_item SET result = 'FOUND' WHERE campaign_id = $1`, [id]);
  await owner.query(`UPDATE count_item SET result = 'MISPLACED', variance_action = 'ACCEPT' WHERE campaign_id = $1 AND asset_id = $2`, [id, ids.c2]);
  await owner.query(`UPDATE count_campaign SET status = 'REVIEW' WHERE id = $1`, [id]);
  const post = await call('ac', 'POST', `/count-campaigns/${id}:post-results`);
  assert.equal(post.status, 202, JSON.stringify(post.body));
  const ps = (await owner.query(`SELECT asset_id, payload FROM sap_posting WHERE posting_type = 'COUNT_RESULT'`)).rows;
  assert.deepEqual(ps.map((x) => [x.asset_id, x.payload.inventoryNote]), [[ids.b, 'PIB1-MV']]);
  const comp = (await owner.query(`SELECT last_count_note FROM asset WHERE id = ANY($1) ORDER BY asset_tag`, [[ids.c1, ids.c2]])).rows.map((x) => x.last_count_note);
  assert.deepEqual(comp, ['PIB1-OK', 'PIB1-MV']);
});

test('Bundle: 폐기하면 구성품도 함께(할당 반납)', { skip }, async () => {
  const { applyRequest } = await import('../src/requests/requests');
  await owner.query(`UPDATE asset SET status = 'IN_USE', assigned_user_id = (SELECT id FROM app_user WHERE email = 'kim@bun.test') WHERE id = $1`, [ids.c1]);
  await owner.query(`INSERT INTO asset_assignment (id, tenant_id, asset_id, user_id, checked_out_at) VALUES (gen_random_uuid(), $1, $2, (SELECT id FROM app_user WHERE email = 'kim@bun.test'), now())`, [tenantId, ids.c1]);
  const b = (await owner.query(`SELECT * FROM asset WHERE id = $1`, [ids.b])).rows[0];
  await owner.query('BEGIN');
  const ch = await applyRequest(owner as never, { id: null, request_no: 'AR-T1', request_type: 'RETIRE' }, b);
  await owner.query('COMMIT');
  assert.deepEqual((ch.components as { after: string[] }).after, ['AT-000101', 'AT-000102']);
  const rows = (await owner.query(`SELECT status, assigned_user_id FROM asset WHERE id = ANY($1) ORDER BY asset_tag`, [[ids.c1, ids.c2, ids.c3]])).rows;
  assert.deepEqual(rows.map((x) => x.status), ['RETIRED', 'RETIRED', 'IN_STOCK'], '빠진 구성품은 그대로');
  assert.equal(rows[0].assigned_user_id, null);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset_assignment WHERE asset_id = $1 AND returned_at IS NULL`, [ids.c1])).rows[0].n, 0);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset_event WHERE asset_id = ANY($1) AND event_type = 'RETIRED'`, [[ids.c1, ids.c2]])).rows[0].n, 2);
});

test('일괄 업로드: isBundle 행으로 Bundle 등록, bundleTag로 구성품 연결(같은 파일·기존 자산), 미리보기는 되돌림', { skip }, async () => {
  const { buildXlsx } = await import('../src/common/xlsx');
  const HEAD = ['assetTag', 'description', 'categoryCode', 'model', 'companyCode', 'roomCode', 'costCenterCode', 'isBundle', 'bundleTag'];
  const rows = [
    [null, 'Speaker', 'NB', 'LAT7440', '1000', 'ATL-101', 'CC100', null, 'AV-SET-1'],   // 2: 신규 구성품(Bundle은 아래 행)
    ['AV-SET-1', 'Huddle AV set', 'NB', null, '1000', 'ATL-101', 'CC100', 'Y', null],   // 3: Bundle(모델 없음)
    ['AT-000103', null, null, null, null, null, null, null, 'av-set-1'],                 // 4: 기존 자산을 구성품으로
    ['AT-000104', null, null, null, null, null, null, null, 'AV-SET-1'],                 // 5: SAP 자산은 안 됨
    [null, 'Mic', 'NB', 'LAT7440', '1000', 'ATL-101', 'CC100', null, 'NOPE-1'],          // 6: 없는 Bundle
  ];
  const file = { fileName: 'b.xlsx', contentBase64: buildXlsx([{ name: 'Assets', rows: [HEAD, ...rows] }]).toString('base64') };
  const before = (await owner.query(`SELECT count(*)::int AS n FROM asset`)).rows[0].n;
  const pv = await call('am', 'POST', '/admin/asset-import:preview', file);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  const r = (b: { rows: { rowNo: number }[] }, n: number) => b.rows.find((x) => x.rowNo === n) as unknown as { action: string; status: string; changes?: string[]; errors: { code: string; field?: string }[] };
  assert.deepEqual(pv.body.rows.map((x: { rowNo: number }) => x.rowNo), [2, 3, 4, 5, 6], '행 순서대로');
  assert.deepEqual([r(pv.body, 2).status, r(pv.body, 3).status, r(pv.body, 4).status], ['OK', 'OK', 'OK']);
  assert.deepEqual(r(pv.body, 4).changes, ['bundleTag']);
  assert.deepEqual(r(pv.body, 5).errors.map((e) => [e.field, e.code]), [['bundleTag', 'BUNDLE_COMPONENT']]);
  assert.deepEqual(r(pv.body, 6).errors.map((e) => [e.field, e.code]), [['bundleTag', 'UNKNOWN_BUNDLE']]);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset`)).rows[0].n, before, '미리보기는 바꾸지 않음');
  assert.equal((await owner.query(`SELECT parent_asset_id FROM asset WHERE id = $1`, [ids.c3])).rows[0].parent_asset_id, null);

  const ap = await call('am', 'POST', '/admin/asset-import:apply', file);
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.deepEqual(ap.body.summary, { rows: 5, create: 2, update: 1, unchanged: 0, errors: 2, warnings: 0 });
  const b = (await owner.query(`SELECT id, is_bundle, model_id FROM asset WHERE asset_tag = 'AV-SET-1'`)).rows[0];
  assert.deepEqual([b.is_bundle, b.model_id], [true, null]);
  const comps = (await owner.query(`SELECT description FROM asset WHERE parent_asset_id = $1 ORDER BY description`, [b.id])).rows.map((x) => x.description);
  assert.deepEqual(comps, ['AT-000103', 'Speaker']);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset WHERE description = 'Mic'`)).rows[0].n, 0, '오류 행은 건너뜀');

  const t = await raw('am', 'GET', '/admin/asset-import/template?withAssets=true');
  const { readXlsx } = await import('../src/common/xlsxRead');
  const sheet = readXlsx(Buffer.from(await t.arrayBuffer()), 'Assets');
  const col = (name: string) => sheet.rows[0].indexOf(name);
  const row = (tag: string) => sheet.rows.find((x) => x[0] === tag)!;
  assert.equal(row('AV-SET-1')[col('isBundle')], 'Y');
  assert.equal(row('AT-000103')[col('bundleTag')], 'AV-SET-1');
});

test('PDA-09 자산 조회: 구성품은 소속 Bundle, Bundle은 구성품 목록(구성품이 내 실사 대상이면 상세)', { skip }, async () => {
  const pda = async (tag: string) => {
    const r = await fetch(`${base}/pda/assets/${tag}`, { headers: { authorization: 'Bearer at:T-BUN_c1:pda', 'x-device-id': 'TC58-9' } });
    return { status: r.status, body: await r.json() as any };   // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  await owner.query(`INSERT INTO pda_device (id, tenant_id, device_serial, is_active) VALUES (gen_random_uuid(), $1, 'TC58-9', true)`, [tenantId]);
  const bt = (await owner.query(`SELECT asset_tag FROM asset WHERE id = $1`, [ids.b])).rows[0].asset_tag;
  await owner.query(`UPDATE asset SET status = 'IN_STOCK' WHERE id = ANY($1)`, [[ids.b, ids.c1, ids.c2]]);
  const off = await pda(bt);
  assert.equal(off.body.limited, true, JSON.stringify(off.body));
  await owner.query(`UPDATE count_campaign SET status = 'COUNTING' WHERE campaign_code = 'PIB1'`);
  const c = await pda('at-000101');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.bundle, { assetTag: bt, description: 'Conference room AV set', sapAssetNo: '1000060' });
  const b = await pda(bt);
  assert.deepEqual([b.body.limited, b.body.isBundle, b.body.componentCount], [false, true, 2]);
  assert.deepEqual(b.body.components.map((x: { assetTag: string }) => x.assetTag), ['AT-000101', 'AT-000102']);
});

test('모델 직접 입력(선택): 마스터와 맞으면 연결, 아니면 글자 그대로, 비우면 지움', { skip }, async () => {
  const base = { categoryId: ids.nb, description: 'Model test', companyId: ids.co, roomId: ids.r1, costCenterId: ids.cc, printLabel: false };
  const none = await call('am', 'POST', '/assets', base);
  assert.equal(none.status, 201, JSON.stringify(none.body));
  assert.equal(none.body.asset.modelId, undefined);
  const hit = await call('am', 'POST', '/assets', { ...base, modelName: ' lat7440 ' });
  assert.deepEqual([hit.body.asset.modelId, hit.body.asset.modelName], [ids.m1, 'Dell Latitude 7440']);
  const free = await call('am', 'POST', '/assets', { ...base, modelName: 'HP  Custom   X1' });
  assert.deepEqual([free.body.asset.modelId, free.body.asset.modelName], [undefined, 'HP Custom X1']);
  const id = free.body.asset.id;
  const list = await call('am', 'GET', '/assets?q=custom');
  assert.deepEqual(list.body.items.map((x: { modelName?: string }) => x.modelName), ['HP Custom X1']);
  const p1 = await call('am', 'PATCH', `/assets/${id}`, { modelName: 'Dell Latitude 7440' }, { 'if-match': `"${free.body.asset.version}"` });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.deepEqual([p1.body.asset.modelId, p1.body.asset.modelName], [ids.m1, 'Dell Latitude 7440']);
  const p2 = await call('am', 'PATCH', `/assets/${id}`, { modelName: '' }, { 'if-match': `"${p1.body.asset.version}"` });
  assert.deepEqual([p2.body.asset.modelId, p2.body.asset.modelName], [undefined, undefined]);
  assert.deepEqual((await owner.query(`SELECT model_id, model_text FROM asset WHERE id = $1`, [id])).rows[0], { model_id: null, model_text: null });
});

test('자동 채번은 이미 쓰인 AT-번호를 건너뜀(일괄 업로드로 적힌 태그가 채번보다 앞선 경우)', { skip }, async () => {
  const base = { categoryId: ids.nb, description: 'Seq test', companyId: ids.co, roomId: ids.r1, costCenterId: ids.cc, printLabel: false };
  const a = await call('am', 'POST', '/assets', base);
  const n = Number(a.body.asset.assetTag.slice(3));
  for (const k of [1, 2]) {
    await owner.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id, site_id, room_id, cost_center_id)
      VALUES (gen_random_uuid(), $1, $2, 'uploaded', $3, 'MANUAL', $4, $5, $6, $7)`, [tenantId, `AT-${String(n + k).padStart(6, '0')}`, ids.nb, ids.co, ids.s1, ids.r1, ids.cc]);
  }
  const b = await call('am', 'POST', '/assets', { ...base, isBundle: true, modelName: 'Samsung 27inch 4k monitor', assetClassId: ids.cls, purchaseCost: 2500, registerInSap: true });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.asset.assetTag, `AT-${String(n + 3).padStart(6, '0')}`);
});
