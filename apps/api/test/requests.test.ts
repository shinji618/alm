// 자산 요청·승인 통합 시험(ALM-230, WBS 4.3): 작성·검증, 승인 자격(책임 코스트센터·자산회계), 직무 분리, 반려, 취소,
// 최종 승인 → SAP 전기 건(유형별 payload) 또는 ALM 전용 자산 즉시 반영, SAP 결과 반영, 승인함·navCounts, 자산 상세 구매·입고.
// 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Pool, PoolClient } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { PrincipalCache } from '../src/auth/principal';
import { catalog } from '../src/auth/permissions';
import { createApi } from '../src/main';
import { postResult } from '../src/sap/postings';
import type { SapConn } from '../src/auth/sap';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_req_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>, conn: SapConn;
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
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-REQ_${who}:web`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const step = async (reqId: string, no: number) => (await q('SELECT id FROM approval WHERE asset_request_id = $1 AND step_no = $2', [reqId, no]))[0].id as string;
async function sapResult(postingId: string, body: Record<string, unknown>) {
  await owner.query('BEGIN');
  try {
    const r = await postResult(owner as unknown as PoolClient, conn, postingId, { postingId, ...body });
    await owner.query('COMMIT');
    return r;
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
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
  const users = ['mgr', 'emp', 'dept1', 'dept3', 'acct', 'both', 'mgr2', 'adm'];
  tenantId = (await seed(owner, { tenant: { code: 'REQ', name: 'Request test', idpType: 'OIDC' }, domains: ['req.test'],
    users: [{ email: 'mgr@req.test', displayName: 'Manager', roles: ['ASSET_MANAGER'] }, { email: 'emp@req.test', displayName: 'Emp', roles: [] },
      { email: 'dept1@req.test', displayName: 'Dept 100', roles: [] }, { email: 'dept3@req.test', displayName: 'Dept 300', roles: [] },
      { email: 'acct@req.test', displayName: 'Acct', roles: ['ASSET_ACCOUNTANT'] }, { email: 'both@req.test', displayName: 'Both', roles: ['ASSET_ACCOUNTANT'] },
      { email: 'mgr2@req.test', displayName: 'Manager 2', roles: ['ASSET_MANAGER'] }, { email: 'adm@req.test', displayName: 'Admin', roles: ['SYS_ADMIN'] }] })).tenantId;
  for (const u of users) ids[u] = (await q(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@req.test`]))[0].id;
  const ins = async (sql: string, p: unknown[] = []) => (await q(sql, [tenantId, ...p]))[0].id as string;
  ids.co = await ins(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`);
  ids.site = await ins(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`);
  ids.room1 = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-101', 'Office', 'RM-1') RETURNING id`, [ids.site]);
  ids.room2 = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-201', 'IT', 'RM-2') RETURNING id`, [ids.site]);
  ids.pc1 = await ins(`INSERT INTO profit_center (id, tenant_id, controlling_area, profit_center_code, name, segment) VALUES (gen_random_uuid(), $1, 'A000', 'P1', 'Corp', 'S1') RETURNING id`);
  ids.pc2 = await ins(`INSERT INTO profit_center (id, tenant_id, controlling_area, profit_center_code, name, segment) VALUES (gen_random_uuid(), $1, 'A000', 'P2', 'Sales', 'S2') RETURNING id`);
  const cc = (code: string, pc: string) => ins(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id, profit_center_id)
    VALUES (gen_random_uuid(), $1, 'A000', $2, $2, $3, $4) RETURNING id`, [code, ids.co, pc]);
  ids.cc100 = await cc('CC100', ids.pc1); ids.cc200 = await cc('CC200', ids.pc1); ids.cc300 = await cc('CC300', ids.pc2);
  ids.cls = await ins(`INSERT INTO asset_class (id, tenant_id, class_code, name, default_useful_life_years) VALUES (gen_random_uuid(), $1, '00003200', 'IT HW', 5) RETURNING id`);
  ids.lowCls = await ins(`INSERT INTO asset_class (id, tenant_id, class_code, name, default_useful_life_years, is_low_value) VALUES (gen_random_uuid(), $1, '00009000', 'LVA', 1, true) RETURNING id`);
  ids.cat = await ins(`INSERT INTO category (id, tenant_id, category_code, name, default_asset_class_id) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook', $2) RETURNING id`, [ids.cls]);
  const asset = (tag: string, o: { sap?: string; status?: string; user?: string } = {}) => ins(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source,
      company_id, site_id, room_id, cost_center_id, sap_asset_no, sap_sub_no, assigned_user_id, is_capitalized)
    VALUES (gen_random_uuid(), $1, $2::varchar, $2::varchar || ' laptop', $3, $4::asset_status, 'MANUAL', $5, $6, $7, $8, $9, $10, $11, $9::varchar IS NOT NULL) RETURNING id`,
  [tag, ids.cat, o.status ?? 'IN_STOCK', ids.co, ids.site, ids.room1, ids.cc100, o.sap ?? null, o.sap ? '0000' : null, o.user ?? null]);
  ids.sapA = await asset('S1000000', { sap: '000001000000', status: 'IN_USE', user: ids.emp });
  ids.sapB = await asset('S1000001', { sap: '000001000001' });
  ids.localA = await asset('AT-000001');
  ids.localB = await asset('AT-000002');
  await q(`INSERT INTO asset_assignment (id, tenant_id, asset_id, user_id, checked_out_at) VALUES (gen_random_uuid(), $1, $2, $3, now())`, [tenantId, ids.sapA, ids.emp]);
  // 범위가 있는 역할 행: CC100·CC300 부서 관리자, both = CC300 부서 관리자 + 자산회계(직무 분리 시험)
  const role = (u: string, r: string, ccId: string) => q(`INSERT INTO user_role (id, tenant_id, user_id, role, cost_center_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [tenantId, ids[u], r, ccId]);
  await role('dept1', 'DEPT_MANAGER', ids.cc100); await role('dept3', 'DEPT_MANAGER', ids.cc300); await role('both', 'DEPT_MANAGER', ids.cc300);
  conn = { tenantId, tenantCode: 'REQ', connectionId: '00000000-0000-0000-0000-000000000001', companyId: ids.co, companyCode: '1000', systemId: 'S4H-100', allowedCidrs: [], clientId: 'c' };
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

test('작성: 유형별 필수·검증, 범위, DRAFT, 진행 중 요청 409', { skip }, async () => {
  const bad = await call('mgr', 'POST', '/asset-requests', { requestType: 'TRANSFER', assetId: ids.sapA, targetCostCenterId: ids.cc300 });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: { field: string }) => e.field).sort(), ['effectiveDate', 'reason']);
  const ch = await call('mgr', 'POST', '/asset-requests', { requestType: 'CHANGE', assetId: ids.sapA, reason: 'x', changes: { costCenter: 'CC200' } });
  assert.equal(ch.status, 400); assert.equal(ch.body.errors[0].field, 'changes.costCenter', '변경 필드 제한');
  assert.equal((await call('mgr', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: ids.sapA, reason: 'x', assetClassId: ids.cls,
    targetCostCenterId: ids.cc100, acquisitionValue: 100 })).status, 409, '이미 SAP 자산');
  const low = await call('mgr', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: ids.localB, reason: 'x', assetClassId: ids.lowCls,
    targetCostCenterId: ids.cc100, acquisitionValue: 100 });
  assert.equal(low.status, 400); assert.equal(low.body.errors[0].field, 'assetClassId', '저가 클래스는 SAP 등록 안 함');
  assert.equal((await call('emp', 'POST', '/asset-requests', { requestType: 'RETIRE', assetId: ids.localA, reason: 'x', retireType: 'SCRAP',
    effectiveDate: '2026-10-31' })).status, 404, '직원은 본인 할당 자산만');
  assert.equal((await call('dept1', 'GET', '/approvals/inbox')).body.total, 0);

  const r = await call('mgr', 'POST', '/asset-requests', { requestType: 'TRANSFER', assetId: ids.sapA, reason: '영업팀 이동', targetCostCenterId: ids.cc300,
    effectiveDate: '2026-11-01', retireType: 'SCRAP' });
  assert.equal(r.status, 201);
  ids.r1 = r.body.id;
  assert.equal(r.body.requestNo, 'AR-00001'); assert.equal(r.body.status, 'DRAFT'); assert.equal(r.body.isProfitCenterChange, true, '손익센터 P1→P2');
  assert.equal(r.body.request.retireType, undefined, '유형에 없는 값은 버림');
  assert.deepEqual(r.body.actions, { submit: true, edit: true, cancel: true });
  assert.equal(r.body.labels.targetCostCenter, 'CC300 · CC300');
  const dup = await call('mgr', 'POST', '/asset-requests', { requestType: 'RETIRE', assetId: ids.sapA, reason: 'x', retireType: 'SCRAP', effectiveDate: '2026-10-31' });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'ALM-E315');
  // 수정: If-Match·요청자만
  assert.equal((await call('mgr', 'PATCH', `/asset-requests/${ids.r1}`, { reason: 'y' })).status, 428);
  assert.equal((await call('mgr', 'PATCH', `/asset-requests/${ids.r1}`, { reason: 'y' }, { 'if-match': '"9"' })).status, 409);
  const p = await call('mgr', 'PATCH', `/asset-requests/${ids.r1}`, { reason: '영업팀 이동(11월)', targetCostCenterId: ids.cc300, effectiveDate: '2026-11-02' }, { 'if-match': '"1"' });
  assert.equal(p.status, 200); assert.equal(p.body.version, 2); assert.equal(p.body.request.effectiveDate, '2026-11-02');
  assert.equal((await call('emp', 'GET', `/asset-requests/${ids.r1}`)).status, 404, '직원 범위 밖');
});

test('승인: 책임 코스트센터 부서 관리자 → 자산회계, 직무 분리, 최종 승인 시 ABUMN 전기 건, SAP 결과로 자산 반영', { skip }, async () => {
  const s = await call('mgr', 'POST', `/asset-requests/${ids.r1}:submit`);
  assert.equal(s.status, 200); assert.equal(s.body.status, 'SUBMITTED');
  assert.deepEqual(s.body.approvals.map((x: { stepNo: number; approverRole: string; decision: string }) => [x.stepNo, x.approverRole, x.decision]),
    [[1, 'DEPT_MANAGER', 'PENDING'], [2, 'ASSET_ACCOUNTANT', 'PENDING']]);
  assert.equal((await call('mgr', 'POST', `/asset-requests/${ids.r1}:submit`)).status, 409);
  const mails = await q(`SELECT u.email FROM notification n JOIN app_user u ON u.id = n.recipient_id WHERE n.template = 'APPROVAL_REQUESTED' ORDER BY 1`);
  assert.deepEqual(mails.map((m) => m.email), ['both@req.test', 'dept3@req.test'], '대상 코스트센터(CC300) 부서 관리자에게');

  assert.equal((await call('dept1', 'GET', '/approvals/inbox')).body.total, 0, 'CC100 관리자는 대상 아님');
  assert.equal((await call('acct', 'GET', '/approvals/inbox')).body.total, 0, '2단계는 아직');
  const ib = await call('dept3', 'GET', '/approvals/inbox');
  assert.equal(ib.body.total, 1);
  assert.equal(ib.body.items[0].summary, 'S1000000 → CC300 (손익센터 변경)');
  assert.equal((await call('dept3', 'GET', '/me')).body.navCounts.requests, 1);
  const s1 = await step(ids.r1, 1), s2 = await step(ids.r1, 2);
  assert.equal((await call('dept1', 'POST', `/approvals/${s1}:approve`, {})).status, 403, '다른 코스트센터');
  assert.equal((await call('acct', 'POST', `/approvals/${s2}:approve`, {})).status, 409, '앞 단계가 남음');
  const d = await call('dept3', 'GET', `/asset-requests/${ids.r1}`);
  assert.equal(d.status, 200, '승인자는 범위 밖이어도 본다'); assert.equal(d.body.actions.approve, s1);

  const a1 = await call('both', 'POST', `/approvals/${s1}:approve`, { comment: 'OK' });
  assert.equal(a1.status, 200); assert.equal(a1.body.requestStatus, 'MGR_APPROVED'); assert.equal(a1.body.approverName, 'Both');
  const sod = await call('both', 'POST', `/approvals/${s2}:approve`, {});
  assert.equal(sod.status, 403); assert.equal(sod.body.code, 'ALM-E403', '1단계 승인자는 2단계 불가');
  assert.equal((await call('both', 'GET', '/approvals/inbox')).body.total, 0);
  assert.equal((await call('acct', 'GET', '/approvals/inbox')).body.total, 1);
  const a2 = await call('acct', 'POST', `/approvals/${s2}:approve`, {});
  assert.equal(a2.status, 200); assert.equal(a2.body.requestStatus, 'ACCT_APPROVED');
  assert.equal((await call('acct', 'POST', `/approvals/${s2}:approve`, {})).status, 409, '이미 결정');
  const [pst] = await q(`SELECT posting_type, status, payload, value_date::text AS vd, approved_by FROM sap_posting WHERE posting_id = 'AR-00001'`);
  assert.equal(pst.posting_type, 'ASSET_TRANSFER'); assert.equal(pst.status, 'READY'); assert.equal(pst.vd, '2026-11-02'); assert.equal(pst.approved_by, ids.acct);
  assert.deepEqual(pst.payload, { newCostCenter: 'CC300', newProfitCenter: 'P2', percent: 100, createNewSubNo: false });
  assert.equal((await q('SELECT cost_center_id FROM asset WHERE id = $1', [ids.sapA]))[0].cost_center_id, ids.cc100, 'SAP 전기 전에는 그대로');
  assert.equal((await q(`SELECT count(*)::int AS n FROM notification WHERE template = 'APPROVAL_DECIDED' AND recipient_id = $1`, [ids.mgr]))[0].n, 1);

  const res = await sapResult('AR-00001', { status: 'POSTED', sapDocument: { belnr: '0100000123', gjahr: '2026' } });
  assert.equal(res.status, 200);
  assert.equal((await q('SELECT cost_center_id FROM asset WHERE id = $1', [ids.sapA]))[0].cost_center_id, ids.cc300);
  const det = await call('mgr', 'GET', `/asset-requests/${ids.r1}`);
  assert.equal(det.body.status, 'POSTED'); assert.equal(det.body.posting.sapDocumentNo, '0100000123'); assert.deepEqual(det.body.actions, {});
});

test('반려(의견 필수) → 요청자 메일, 자산 그대로. ALM 전용 자산 매각은 승인 즉시 반영(전기 없음)', { skip }, async () => {
  const r = await call('mgr', 'POST', '/asset-requests', { requestType: 'RETIRE', assetId: ids.localA, reason: '파손', retireType: 'SCRAP',
    effectiveDate: '2026-10-31', submit: true });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'SUBMITTED');
  const s1 = await step(r.body.id, 1);
  const noComment = await call('dept1', 'POST', `/approvals/${s1}:reject`, {});
  assert.equal(noComment.status, 400);
  const rj = await call('dept1', 'POST', `/approvals/${s1}:reject`, { comment: '수리 가능' });
  assert.equal(rj.status, 200); assert.equal(rj.body.requestStatus, 'REJECTED');
  assert.deepEqual((await q('SELECT decision FROM approval WHERE asset_request_id = $1 ORDER BY step_no', [r.body.id])).map((x) => x.decision), ['REJECTED', 'SKIPPED']);
  assert.equal((await q('SELECT status FROM asset WHERE id = $1', [ids.localA]))[0].status, 'IN_STOCK');

  const sale = await call('mgr', 'POST', '/asset-requests', { requestType: 'SALE', assetId: ids.localA, reason: '노후 매각', saleAmount: 120, buyer: 'Recycler Inc', submit: true });
  assert.equal(sale.status, 201, '반려된 요청은 진행 중이 아님');
  assert.equal((await call('dept1', 'GET', `/asset-requests/${sale.body.id}`)).body.request.saleAmount, 120, '지금 단계 승인자는 금액을 본다');
  assert.equal((await call('dept1', 'POST', `/approvals/${await step(sale.body.id, 1)}:approve`, {})).status, 200);
  assert.equal((await call('dept1', 'GET', `/asset-requests/${sale.body.id}`)).body.request.saleAmount, undefined, '단계가 지나면 금액 숨김');
  const fin = await call('acct', 'POST', `/approvals/${await step(sale.body.id, 2)}:approve`, {});
  assert.equal(fin.body.requestStatus, 'POSTED');
  assert.equal((await q(`SELECT count(*)::int AS n FROM sap_posting WHERE asset_request_id = $1`, [sale.body.id]))[0].n, 0);
  assert.equal((await q('SELECT status FROM asset WHERE id = $1', [ids.localA]))[0].status, 'DISPOSED');
  assert.equal((await q(`SELECT event_type FROM asset_event WHERE asset_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [ids.localA]))[0].event_type, 'DISPOSED');
  assert.equal((await call('mgr', 'POST', '/asset-requests', { requestType: 'CHANGE', assetId: ids.localA, reason: 'x', changes: { description: 'y' } })).status, 409, '처분된 자산');
});

test('신규 SAP 등록(NEW_ASSET) payload, CHANGE 룸 변경 취소, 전기 중 취소 409, 목록 필터', { skip }, async () => {
  const n = await call('mgr', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: ids.localB, reason: 'SAP 등록', assetClassId: ids.cls,
    targetCostCenterId: ids.cc100, acquisitionValue: 1800, effectiveDate: '2026-10-15', submit: true });
  assert.equal(n.status, 201);
  await call('dept1', 'POST', `/approvals/${await step(n.body.id, 1)}:approve`, {});
  await call('acct', 'POST', `/approvals/${await step(n.body.id, 2)}:approve`, {});
  const [pst] = await q(`SELECT posting_type, payload FROM sap_posting WHERE asset_request_id = $1`, [n.body.id]);
  assert.equal(pst.posting_type, 'ASSET_CREATE');
  assert.deepEqual(pst.payload, { assetClass: '00003200', description: 'AT-000002 laptop', costCenter: 'CC100', capDate: '2026-10-15', inventoryNo: 'AT-000002', location: 'ATL-101' });
  await sapResult(n.body.requestNo, { status: 'POSTED', asset: { assetNo: '000001000009', subNo: '0000' } });
  const [a] = await q('SELECT sap_asset_no, asset_class_id, is_capitalized FROM asset WHERE id = $1', [ids.localB]);
  assert.deepEqual(a, { sap_asset_no: '000001000009', asset_class_id: ids.cls, is_capitalized: true });

  const c = await call('mgr', 'POST', '/asset-requests', { requestType: 'CHANGE', assetId: ids.sapB, reason: '자리 이동', targetRoomId: ids.room2, submit: true });
  assert.equal(c.status, 201);
  const cc = await call('mgr', 'POST', `/asset-requests/${c.body.id}:cancel`);
  assert.equal(cc.status, 200); assert.equal(cc.body.status, 'CANCELLED');
  assert.deepEqual(cc.body.approvals.map((x: { decision: string }) => x.decision), ['SKIPPED', 'SKIPPED']);

  const c2 = await call('mgr', 'POST', '/asset-requests', { requestType: 'CHANGE', assetId: ids.sapB, reason: '자리 이동', targetRoomId: ids.room2,
    changes: { serialNo: 'SN-NEW' }, submit: true });
  await call('dept1', 'POST', `/approvals/${await step(c2.body.id, 1)}:approve`, {});
  await call('acct', 'POST', `/approvals/${await step(c2.body.id, 2)}:approve`, {});
  const [p2] = await q(`SELECT payload FROM sap_posting WHERE asset_request_id = $1`, [c2.body.id]);
  assert.deepEqual(p2.payload, { fields: { serialNo: 'SN-NEW', location: 'ATL-201' } });
  await q(`UPDATE sap_posting SET status = 'CLAIMED', lease_until = now() + interval '15 minutes' WHERE asset_request_id = $1`, [c2.body.id]);
  assert.equal((await call('mgr', 'POST', `/asset-requests/${c2.body.id}:cancel`)).status, 409, 'SAP이 전기 중');
  await sapResult(c2.body.requestNo, { status: 'POSTED' });
  const [b] = await q('SELECT room_id, serial_no FROM asset WHERE id = $1', [ids.sapB]);
  assert.deepEqual(b, { room_id: ids.room2, serial_no: 'SN-NEW' });

  const list = await call('mgr', 'GET', '/asset-requests?type=CHANGE&status=CANCELLED');
  assert.deepEqual(list.body.items.map((x: { requestNo: string }) => x.requestNo), [c.body.requestNo]);
  assert.equal((await call('mgr', 'GET', '/asset-requests?q=S1000001')).body.total, 2);
  assert.equal((await call('emp', 'GET', '/asset-requests')).body.total, 0, '직원은 본인 요청만');
  assert.equal((await call('mgr', 'GET', '/asset-requests?status=NOPE')).status, 400);
});

test('자산 상세: 구매·입고(PO 항목·입고 행)', { skip }, async () => {
  const [po] = await q(`INSERT INTO po_item (id, tenant_id, po_no, item_no, company_id, vendor_name, description, quantity, unit_price, gr_quantity)
    VALUES (gen_random_uuid(), $1, '4500000029', '00010', $2, 'Dell', 'Latitude', 1, 1500, 1) RETURNING id`, [tenantId, ids.co]);
  const [gr] = await q(`INSERT INTO goods_receipt (id, tenant_id, po_item_id, material_doc, doc_year, doc_item, movement_type, quantity, posting_date)
    VALUES (gen_random_uuid(), $1, $2, '5000000050', 2026, '0001', '101', 1, '2026-10-13') RETURNING id`, [tenantId, po.id]);
  await q('UPDATE asset SET po_item_id = $2, goods_receipt_id = $3 WHERE id = $1', [ids.sapA, po.id, gr.id]);
  const d = await call('mgr', 'GET', `/assets/${ids.sapA}`);
  assert.deepEqual(d.body.purchase, { poNo: '4500000029', poItem: '00010', vendorName: 'Dell', description: 'Latitude', quantity: 1, grQuantity: 1,
    unitPrice: 1500, goodsReceipt: { materialDoc: '5000000050', docYear: 2026, docItem: '0001', movementType: '101', quantity: 1, postingDate: '2026-10-13' } });
  assert.equal((await call('mgr', 'GET', `/assets/${ids.sapB}`)).body.purchase, undefined);
});

test('부서 관리자가 없는 코스트센터: 자산회계가 1단계를 대리 결정([대리] 표시), 2단계는 다른 자산회계', { skip }, async () => {
  const [a] = await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, site_id, room_id, cost_center_id)
    VALUES (gen_random_uuid(), $1, 'AT-000200', 'HR laptop', $2, 'IN_STOCK', 'MANUAL', $3, $4, $5, $6) RETURNING id`, [tenantId, ids.cat, ids.co, ids.site, ids.room1, ids.cc200]);
  await q(`DELETE FROM notification`);
  const r = await call('mgr', 'POST', '/asset-requests', { requestType: 'RETIRE', assetId: a.id, reason: '분실', retireType: 'LOSS', effectiveDate: '2026-10-20', submit: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.deptManagerMissing, true);
  const mails = await q(`SELECT u.email FROM notification n JOIN app_user u ON u.id = n.recipient_id WHERE n.template = 'APPROVAL_REQUESTED' ORDER BY 1`);
  assert.deepEqual(mails.map((m) => m.email), ['acct@req.test', 'both@req.test'], 'CC200 부서 관리자가 없어 자산회계에게');
  assert.equal((await call('dept1', 'GET', '/approvals/inbox')).body.total, 0);
  assert.equal((await call('acct', 'GET', '/approvals/inbox')).body.items.filter((x: { targetId: string }) => x.targetId === r.body.id)[0].stepNo, 1);
  const s1 = await step(r.body.id, 1), s2 = await step(r.body.id, 2);
  assert.equal((await call('dept1', 'POST', `/approvals/${s1}:approve`, {})).status, 404, '다른 코스트센터 부서 관리자에게는 보이지 않음');
  const a1 = await call('acct', 'POST', `/approvals/${s1}:approve`, { comment: '분실 확인' });
  assert.equal(a1.status, 200); assert.equal(a1.body.comment, '[대리] 부서 관리자 없음 → 자산회계 결정 · 분실 확인');
  assert.equal((await call('acct', 'POST', `/approvals/${s2}:approve`, {})).status, 403, '같은 자산회계가 2단계까지는 못 함');
  const a2 = await call('both', 'POST', `/approvals/${s2}:approve`, {});
  assert.equal(a2.body.requestStatus, 'POSTED');
  assert.equal((await q('SELECT status FROM asset WHERE id = $1', [a.id]))[0].status, 'RETIRED');
});

test('회사 설정: SAP 연계를 끈 회사(승인 1단계·0단계), SAP 신규 등록 불가, 설정 검증', { skip }, async () => {
  assert.equal((await call('mgr', 'GET', '/admin/companies')).status, 403);
  const co = await call('adm', 'POST', '/admin/companies', { companyCode: '2000', name: 'No SAP Inc', approvalSteps: 1 });
  assert.equal(co.status, 201);
  assert.deepEqual([co.body.sapEnabled, co.body.approvalSteps, co.body.sapConnections], [false, 1, 0]);
  assert.equal((await call('adm', 'POST', '/admin/companies', { companyCode: '2000', name: 'dup' })).status, 409);
  const bad = await call('adm', 'PATCH', `/admin/companies/${co.body.id}`, { sapEnabled: true, approvalSteps: 1 });
  assert.equal(bad.status, 400); assert.equal(bad.body.errors[0].field, 'approvalSteps', 'SAP 연계 회사는 2단계만');
  assert.equal((await call('adm', 'PATCH', `/admin/companies/${ids.co}`, { approvalSteps: 0 })).status, 400);
  const lk = await call('mgr', 'GET', '/lookups?types=companies');
  assert.deepEqual(lk.body.companies.map((x: { code: string; extra: { sapEnabled: boolean } }) => [x.code, x.extra.sapEnabled]), [['1000', true], ['2000', false]]);
  assert.equal((await call('mgr', 'GET', '/me')).body.features.sap, true);

  const [cc] = await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'N100', 'NoSAP IT', $2) RETURNING id`, [tenantId, co.body.id]);
  const mk = async (tag: string) => (await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, site_id, room_id, cost_center_id, sap_asset_no, sap_sub_no)
    VALUES (gen_random_uuid(), $1, $2::varchar, 'NoSAP laptop', $3, 'IN_STOCK', 'MANUAL', $4, $5, $6, $7, '00000900' || right($2::varchar, 4), '0000') RETURNING id`,
  [tenantId, tag, ids.cat, co.body.id, ids.site, ids.room1, cc.id]))[0].id as string;
  const n1 = await mk('NS-0001'), n2 = await mk('NS-0002');
  const det = await call('mgr', 'GET', `/assets/${n1}`);
  assert.equal(det.body.financial.sapEnabled, false);
  const na = await call('mgr', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: n1, reason: 'x', assetClassId: ids.cls, targetCostCenterId: cc.id, acquisitionValue: 10 });
  assert.equal(na.status, 422, 'SAP 연계를 끈 회사는 SAP 신규 등록 불가');

  // 승인 1단계, 부서 관리자 없음 → 다른 자산 관리자가 대리. SAP 자산번호가 있어도 전기 없이 바로 반영
  const r = await call('mgr', 'POST', '/asset-requests', { requestType: 'RETIRE', assetId: n1, reason: '노후', retireType: 'SCRAP', effectiveDate: '2026-10-31', submit: true });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.sapEnabled, r.body.approvalSteps, r.body.approvals.length, r.body.deptManagerMissing], [false, 1, 1, true]);
  assert.equal((await call('acct', 'GET', '/approvals/inbox')).body.items.some((x: { targetId: string }) => x.targetId === r.body.id), false, '1단계 회사의 대리는 자산회계가 아님');
  const s1 = await step(r.body.id, 1);
  assert.equal((await call('mgr', 'POST', `/approvals/${s1}:approve`, {})).status, 403, '요청자 본인');
  const a1 = await call('mgr2', 'POST', `/approvals/${s1}:approve`, {});
  assert.equal(a1.status, 200); assert.equal(a1.body.requestStatus, 'POSTED');
  assert.match(a1.body.comment, /자산 관리자 결정/);
  assert.equal((await q('SELECT count(*)::int AS n FROM sap_posting WHERE asset_request_id = $1', [r.body.id]))[0].n, 0);
  assert.equal((await q('SELECT status FROM asset WHERE id = $1', [n1]))[0].status, 'RETIRED');

  // 승인 없음: 자산 관리자가 제출하면 바로 반영
  assert.equal((await call('adm', 'PATCH', `/admin/companies/${co.body.id}`, { approvalSteps: 0 })).body.approvalSteps, 0);
  const sale = await call('mgr', 'POST', '/asset-requests', { requestType: 'SALE', assetId: n2, reason: '매각', saleAmount: 50, buyer: 'Buyer', submit: true });
  assert.equal(sale.status, 201); assert.equal(sale.body.status, 'POSTED'); assert.equal(sale.body.approvals.length, 0);
  assert.equal((await q('SELECT status FROM asset WHERE id = $1', [n2]))[0].status, 'DISPOSED');
});

test('코스트센터·자산클래스 직접 관리: SAP 끈 회사만, 중복·사용 중 비활성 409, 직접 만든 클래스는 SAP 등록 불가', { skip }, async () => {
  const [co2] = await q(`SELECT id FROM company WHERE company_code = '2000'`);
  assert.equal((await call('emp', 'GET', '/admin/cost-centers')).status, 403);
  const cc = await call('mgr', 'POST', '/admin/cost-centers', { companyId: co2.id, costCenterCode: 'N200', name: 'NoSAP HR', responsible: 'Kim' });
  assert.equal(cc.status, 201);
  assert.deepEqual([cc.body.controllingArea, cc.body.editable, cc.body.assetCount], ['ALM', true, 0]);
  assert.equal((await call('mgr', 'POST', '/admin/cost-centers', { companyId: co2.id, costCenterCode: 'CC100', name: 'dup' })).status, 409, 'SAP 코스트센터와 같은 코드');
  const sapCo = await call('mgr', 'POST', '/admin/cost-centers', { companyId: ids.co, costCenterCode: 'X1', name: 'x' });
  assert.equal(sapCo.status, 409); assert.equal(sapCo.body.code, 'ALM-E322');
  assert.equal((await call('mgr', 'PATCH', `/admin/cost-centers/${ids.cc100}`, { name: 'x' })).status, 409, 'SAP 회사 코스트센터는 수정 불가');
  const [n100] = await q(`SELECT id FROM cost_center WHERE cost_center_code = 'N100'`);
  const inUse = await call('mgr', 'PATCH', `/admin/cost-centers/${n100.id}`, { isActive: false });
  assert.equal(inUse.status, 200, 'N100 자산은 모두 폐기·처분됨');
  const list = await call('mgr', 'GET', `/admin/cost-centers?companyId=${co2.id}`);
  assert.deepEqual(list.body.items.map((x: { costCenterCode: string; isActive: boolean }) => [x.costCenterCode, x.isActive]), [['N100', false], ['N200', true]]);

  const cls = await call('mgr', 'POST', '/admin/asset-classes', { classCode: 'ALM-IT', name: 'IT equipment', defaultUsefulLifeYears: 4 });
  assert.equal(cls.status, 201);
  assert.deepEqual([cls.body.isManual, cls.body.isCapitalized, cls.body.defaultUsefulLifeYears], [true, true, 4]);
  assert.equal((await call('mgr', 'POST', '/admin/asset-classes', { classCode: '00003200', name: 'dup' })).status, 409);
  assert.equal((await call('mgr', 'PATCH', `/admin/asset-classes/${ids.cls}`, { name: 'x' })).status, 409, 'SAP 클래스는 수정 불가');
  assert.equal((await call('mgr', 'PATCH', `/admin/asset-classes/${cls.body.id}`, { defaultUsefulLifeYears: 3 })).body.defaultUsefulLifeYears, 3);
  const lk = await call('mgr', 'GET', '/lookups?types=assetClasses');
  assert.equal(lk.body.assetClasses.find((x: { code: string }) => x.code === 'ALM-IT').extra.isManual, true);

  const [a] = await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, site_id, room_id, cost_center_id)
    VALUES (gen_random_uuid(), $1, 'AT-000300', 'SAP co laptop', $2, 'IN_STOCK', 'MANUAL', $3, $4, $5, $6) RETURNING id`, [tenantId, ids.cat, ids.co, ids.site, ids.room1, ids.cc100]);
  const na = await call('mgr', 'POST', '/asset-requests', { requestType: 'NEW_ASSET', assetId: a.id, reason: 'x', assetClassId: cls.body.id, targetCostCenterId: ids.cc100, acquisitionValue: 10 });
  assert.equal(na.status, 400); assert.equal(na.body.errors[0].field, 'assetClassId');
});
