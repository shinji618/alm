// 자산 목록·상세·등록·수정 API 통합 시험(ALM-110~112, 09 4.1 범위·4.2 금액, WBS 4.2). 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_asset_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
const ids: Record<string, string> = {};
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)],
};
const fakeCognito = {
  verifyAccess: async (t: string) => { const [, u, c] = t.split(':'); if (!u) throw new Error('bad'); return { sub: 's', username: u, client_id: c, token_use: 'access', exp: 0 }; },
};
async function call(who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-AST_${who}:web`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const nb = (o: Record<string, unknown> = {}) => ({ categoryId: ids.catNb, modelId: ids.modelNb, description: 'Latitude 7450', serialNo: 'SN-1',
  companyId: ids.co, roomId: ids.roomAtl, costCenterId: ids.cc100, purchaseCost: 1500, ...o });

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'AST', name: 'Asset test', idpType: 'OIDC' }, domains: ['ast.test'],
    users: [{ email: 'mgr@ast.test', displayName: 'Manager', roles: ['ASSET_MANAGER'] }, { email: 'mgrw@ast.test', displayName: 'West Mgr', roles: [] },
      { email: 'dept@ast.test', displayName: 'Dept', roles: [] }, { email: 'emp@ast.test', displayName: 'Emp', roles: [] },
      { email: 'acct@ast.test', displayName: 'Acct', roles: ['ASSET_ACCOUNTANT'] }] })).tenantId;
  for (const u of ['mgr', 'mgrw', 'dept', 'emp', 'acct']) {
    ids[u] = (await q(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@ast.test`]))[0].id;
  }
  const ins = async (sql: string, p: unknown[]) => (await q(sql, [tenantId, ...p]))[0].id as string;
  ids.co = await ins(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, []);
  ids.siteAtl = await ins(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, []);
  ids.siteWest = await ins(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'WEST', 'West') RETURNING id`, []);
  ids.roomAtl = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-101', 'Office', 'RM-ATL-101') RETURNING id`, [ids.siteAtl]);
  ids.roomAtl2 = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-102', 'Lab', 'RM-ATL-102') RETURNING id`, [ids.siteAtl]);
  ids.roomWest = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'W-1', 'West', 'RM-W-1') RETURNING id`, [ids.siteWest]);
  ids.cc100 = await ins(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [ids.co]);
  ids.cc200 = await ins(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC200', 'HR', $2) RETURNING id`, [ids.co]);
  ids.cls = await ins(`INSERT INTO asset_class (id, tenant_id, class_code, name, default_useful_life_years) VALUES (gen_random_uuid(), $1, '3100', 'IT HW', 3) RETURNING id`, []);
  ids.catNb = await ins(`INSERT INTO category (id, tenant_id, category_code, name, default_asset_class_id) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook', $2) RETURNING id`, [ids.cls]);
  ids.catMon = await ins(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'MON', 'Monitor') RETURNING id`, []);
  ids.modelNb = await ins(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name) VALUES (gen_random_uuid(), $1, $2, 'Dell', 'Latitude 7450') RETURNING id`, [ids.catNb]);
  ids.modelMon = await ins(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name) VALUES (gen_random_uuid(), $1, $2, 'Dell', 'U2724') RETURNING id`, [ids.catMon]);
  await q(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, zpl, is_default) VALUES (gen_random_uuid(), $1, 'STD', 'Std', 'QR_CODE128', '^XA^XZ', true)`, [tenantId]);
  await q(`INSERT INTO setting (id, tenant_id, key, value) VALUES (gen_random_uuid(), $1, 'asset.capitalization_threshold', '1000')`, [tenantId]);
  // 범위가 있는 역할 행: West 사이트 자산 관리자, CC100 부서 관리자
  await q(`INSERT INTO user_role (id, tenant_id, user_id, role, site_id) VALUES (gen_random_uuid(), $1, $2, 'ASSET_MANAGER', $3)`, [tenantId, ids.mgrw, ids.siteWest]);
  await q(`INSERT INTO user_role (id, tenant_id, user_id, role, cost_center_id) VALUES (gen_random_uuid(), $1, $2, 'DEPT_MANAGER', $3)`, [tenantId, ids.dept, ids.cc100]);
  const api = await createApi({ cfg, db: app, cognito: fakeCognito as never, principals: new PrincipalCache() });
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

test('등록: 권한·검증·범위, 태그 채번, IN_USE 할당, 자본화 대상이면 신규 자산 요청(2단계 승인 대기), 라벨 대기열', { skip }, async () => {
  assert.equal((await call('emp', 'POST', '/assets', nb())).status, 403, '일반 사용자는 asset.write 없음');
  const bad = await call('mgr', 'POST', '/assets', nb({ modelId: ids.modelMon, status: 'IN_USE' }));
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: { field: string }) => e.field), ['assignedUserId']);
  const cat = await call('mgr', 'POST', '/assets', nb({ modelId: ids.modelMon }));
  assert.equal(cat.status, 400); assert.equal(cat.body.errors[0].field, 'modelId', '카테고리에 속하지 않은 모델');
  assert.equal((await call('mgrw', 'POST', '/assets', nb())).status, 403, 'West 관리자는 Atlanta 룸에 등록 못함');

  const r = await call('mgr', 'POST', '/assets', nb({ status: 'IN_USE', assignedUserId: ids.emp }));
  assert.equal(r.status, 201);
  const a = r.body.asset;
  ids.a1 = a.id;
  assert.equal(a.assetTag, 'AT-000001'); assert.equal(a.status, 'IN_USE'); assert.equal(a.siteId, ids.siteAtl); assert.equal(a.version, 1);
  assert.equal(a.financial.isCapitalized, false); assert.equal(a.financial.assetClass, '3100', '카테고리 기본 클래스');
  assert.deepEqual({ ...r.body.createdRequest, id: undefined }, { id: undefined, requestNo: 'AR-00001', requestType: 'NEW_ASSET', status: 'SUBMITTED' });
  assert.deepEqual(a.openRequests.map((x: { requestNo: string }) => x.requestNo), ['AR-00001']);
  assert.deepEqual((await q(`SELECT step_no, approver_role, decision FROM approval ORDER BY step_no`)).map((x) => [x.step_no, x.approver_role, x.decision]),
    [[1, 'DEPT_MANAGER', 'PENDING'], [2, 'ASSET_ACCOUNTANT', 'PENDING']]);
  assert.ok(r.body.labelJobId);
  assert.equal((await q(`SELECT count(*)::int AS n FROM asset_assignment WHERE asset_id = $1 AND user_id = $2 AND returned_at IS NULL`, [a.id, ids.emp]))[0].n, 1);

  const w = await call('mgrw', 'POST', '/assets', nb({ categoryId: ids.catMon, modelId: ids.modelMon, description: 'Monitor', roomId: ids.roomWest,
    costCenterId: ids.cc200, purchaseCost: 300, printLabel: false }));
  assert.equal(w.status, 201);
  ids.a2 = w.body.asset.id;
  assert.equal(w.body.asset.assetTag, 'AT-000002');
  assert.equal(w.body.createdRequest, undefined, '자산클래스 없음 → 자본화 대상 아님');
  assert.equal(w.body.labelJobId, undefined);
  const low = await call('mgr', 'POST', '/assets', nb({ purchaseCost: 500, serialNo: 'SN-LOW' }));
  ids.a3 = low.body.asset.id;
  assert.equal(low.body.createdRequest, undefined, '자본화 기준 금액(1000) 미만');
});

test('목록: 역할 범위(전체·사이트·코스트센터·본인), 검색·필터·정렬, 금액 마스킹', { skip }, async () => {
  await q(`INSERT INTO asset_value (id, tenant_id, asset_id, fiscal_year, period, acquisition_value, accum_depreciation, net_book_value, received_at)
    VALUES (gen_random_uuid(), $1, $2, 2026, 9, 1500, -375, 1125, now())`, [tenantId, ids.a1]);
  const tags = async (who: string, qs = '') => (await call(who, 'GET', `/assets${qs}`)).body.items.map((x: { assetTag: string }) => x.assetTag).sort();
  assert.deepEqual(await tags('mgr'), ['AT-000001', 'AT-000002', 'AT-000003']);
  assert.deepEqual(await tags('mgrw'), ['AT-000002'], 'West 사이트만');
  assert.deepEqual(await tags('dept'), ['AT-000001', 'AT-000003'], 'CC100만');
  assert.deepEqual(await tags('emp'), ['AT-000001'], '본인 할당만');
  assert.deepEqual(await tags('mgr', '?q=sn-low'), ['AT-000003']);
  assert.deepEqual(await tags('mgr', '?status=IN_USE,ON_ORDER'), ['AT-000001']);
  assert.deepEqual(await tags('mgr', `?categoryId=${ids.catMon}`), ['AT-000002']);
  assert.deepEqual(await tags('mgr', '?stage=DEPLOY'), ['AT-000002', 'AT-000003']);
  assert.equal((await call('mgr', 'GET', '/assets?status=NOPE')).status, 400);
  assert.equal((await call('dept', 'GET', '/assets?sort=-nbv')).status, 400, '금액 권한 없으면 금액 정렬 불가');

  const m = await call('mgr', 'GET', '/assets?sort=assetTag&pageSize=2');
  assert.deepEqual([m.body.total, m.body.items.length, m.body.items[0].assetTag, m.body.items[0].nbv], [3, 2, 'AT-000001', 1125]);
  assert.equal(m.body.items[0].assignedUserName, 'Emp');
  const d = await call('dept', 'GET', '/assets?sort=assetTag');
  assert.equal(d.body.items[0].nbv, null, '부서 관리자는 금액 null');
});

test('상세: 범위 밖 404, 수정 가능 필드, 금액 마스킹, 하위 탭', { skip }, async () => {
  assert.equal((await call('emp', 'GET', `/assets/${ids.a2}`)).status, 404);
  assert.equal((await call('mgr', 'GET', '/assets/not-a-uuid')).status, 404);
  const m = await call('mgr', 'GET', `/assets/${ids.a1}`);
  assert.equal(m.headers.get('etag'), '"1"');
  assert.equal(m.body.financial.netBookValue, 1125); assert.equal(m.body.financial.valueAsOf, '2026/009');
  assert.ok(m.body.editableFields.includes('dueBackDate'));
  const e = await call('emp', 'GET', `/assets/${ids.a1}`);
  assert.equal(e.body.financial.netBookValue, null); assert.deepEqual(e.body.editableFields, []);
  assert.equal((await call('emp', 'GET', `/assets/${ids.a1}/values`)).status, 403, 'amount.read 필요');
  assert.deepEqual((await call('acct', 'GET', `/assets/${ids.a1}/values`)).body.items, [{ fiscalYear: 2026, period: 9, acquisitionValue: 1500, accumDepreciation: -375, netBookValue: 1125 }]);
  const asg = await call('emp', 'GET', `/assets/${ids.a1}/assignments`);
  assert.equal(asg.body.items[0].userName, 'Emp'); assert.equal(asg.body.items[0].roomCode, 'ATL-101');
  assert.deepEqual((await call('mgr', 'GET', `/assets/${ids.a1}/attachments`)).body, { items: [] });
});

test('수정: If-Match·버전 충돌·SAP 필드 422, 범위, SAP 자산 변경은 CHANGE 요청 + 전기 대기, 이력 금액 마스킹', { skip }, async () => {
  const url = `/assets/${ids.a1}`;
  assert.equal((await call('mgr', 'PATCH', url, { notes: 'x' })).status, 428);
  assert.equal((await call('mgr', 'PATCH', url, { notes: 'x' }, { 'if-match': '"9"' })).body.code, 'ALM-E310');
  const sap = await call('mgr', 'PATCH', url, { costCenterId: ids.cc200 }, { 'if-match': '"1"' });
  assert.equal(sap.status, 422); assert.equal(sap.body.code, 'ALM-E211');
  assert.equal((await call('mgrw', 'PATCH', url, { notes: 'x' }, { 'if-match': '"1"' })).status, 404, '범위 밖');
  assert.equal((await call('mgr', 'PATCH', url, { status: 'RETIRED' }, { 'if-match': '"1"' })).status, 400);

  const plain = await call('mgr', 'PATCH', url, { notes: 'first', ipAddress: '10.1.2.3', macAddress: 'aa-bb-cc-dd-ee-ff' }, { 'if-match': '"1"' });
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body.createdRequests, [], 'SAP 번호 없는 자산은 요청 없음');
  assert.equal(plain.body.asset.version, 2); assert.equal(plain.body.asset.ipAddress, '10.1.2.3'); assert.equal(plain.body.asset.macAddress, 'AA:BB:CC:DD:EE:FF');
  assert.equal((await call('mgr', 'PATCH', url, { notes: 'first' }, { 'if-match': '"2"' })).body.asset.version, 2, '바뀐 값 없음');

  await q(`UPDATE asset SET sap_asset_no = '000000300001', sap_sub_no = '0000', is_capitalized = true WHERE id = $1`, [ids.a1]);
  const ch = await call('mgr', 'PATCH', url, { description: 'Latitude 7450 (IT)', roomId: ids.roomAtl2, notes: 'moved' }, { 'if-match': '"2"' });
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.body.createdRequests.map((x: { requestType: string; status: string }) => [x.requestType, x.status]), [['CHANGE', 'ACCT_APPROVED']]);
  const post = (await q(`SELECT posting_id, posting_type, status, payload FROM sap_posting`))[0];
  assert.deepEqual([post.posting_type, post.status, post.payload], ['ASSET_CHANGE', 'READY', { fields: { description: 'Latitude 7450 (IT)', location: 'ATL-102' } }]);
  assert.equal(post.posting_id, ch.body.createdRequests[0].requestNo);
  assert.equal((await call('mgr', 'PATCH', url, { roomId: ids.roomWest }, { 'if-match': '"3"' })).status, 200, '전체 범위 관리자는 다른 사이트로 이동 가능');
  assert.equal((await call('mgr', 'PATCH', url, { serialNo: 'S'.repeat(19) }, { 'if-match': '"4"' })).status, 400, 'SAP 자산 시리얼 18자');

  await q(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, changes) VALUES (gen_random_uuid(), $1, $2, 'UPDATED', 'UI', '{"purchase_cost": {"before": 1500, "after": 1600}, "notes": {"before": "a", "after": "b"}}')`,
    [tenantId, ids.a1]);
  const he = (await call('emp', 'GET', `/assets/${ids.a1}/history?pageSize=1`)).body;
  assert.deepEqual(he.items[0].changes, { purchase_cost: { before: null, after: null }, notes: { before: 'a', after: 'b' } });
  assert.equal(he.total, 5);
  const hm = (await call('mgr', 'GET', `/assets/${ids.a1}/history?pageSize=1`)).body;
  assert.deepEqual(hm.items[0].changes.purchase_cost, { before: 1500, after: 1600 });
  const all = (await call('mgr', 'GET', `/assets/${ids.a1}/history`)).body.items.map((x: { eventType: string; actorName?: string }) => [x.eventType, x.actorName ?? null]);
  assert.deepEqual(all.slice(-1), [['CREATED', 'Manager']]);
});

test('드롭다운: 범위 밖 사이트·룸 제외, 사용자 목록 권한', { skip }, async () => {
  const w = (await call('mgrw', 'GET', '/lookups?types=sites,rooms,categories,models,costCenters')).body;
  assert.deepEqual(w.sites.map((x: { code: string }) => x.code), ['WEST']);
  assert.deepEqual(w.rooms.map((x: { code: string }) => x.code), ['W-1']);
  assert.equal(w.models.find((x: { label: string }) => x.label === 'Dell U2724').parentId, ids.catMon);
  assert.deepEqual(w.costCenters.map((x: { code: string }) => x.code), ['CC100', 'CC200']);
  assert.deepEqual((await call('mgr', 'GET', '/lookups?types=sites')).body.sites.map((x: { code: string }) => x.code), ['ATL', 'WEST']);
  assert.deepEqual((await call('emp', 'GET', '/lookups?types=users')).body, { users: [] });
  const u = (await call('mgr', 'GET', '/lookups?types=users&q=em')).body.users;
  assert.deepEqual(u.map((x: { label: string }) => x.label), ['Emp']);
  assert.equal((await call('mgr', 'GET', '/lookups?types=nope')).status, 400);
});
