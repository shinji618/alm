// 특성화 시험(WBS 3.9): 공통 엔진 분리(승인 워크플로 → 공유 라이브러리) 전에 "지금 동작"을 고정한다.
// 이 파일의 단언은 현재 코드의 실제 동작을 기록한 것이다(바람직한 동작의 주장이 아님). 리팩터링 중 값이 바뀌면 의도한 변경인지 먼저 확인한다.
// 범위: 요청 생명주기 가드(제출·수정·취소), 승인·반려 가드(직무 분리·순서·중복 결정), 승인함 규칙, 목록 필터·페이징, 최종 승인 뒤 전기 건 취소.
// 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
import { addRole } from './roleHelper';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_chr_${Date.now()}`;
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
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-CHR_${who}:web`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const step = async (reqId: string, no: number) => (await q('SELECT ws.id FROM workflow_step ws JOIN workflow_instance wi ON wi.id = ws.instance_id WHERE wi.subject_id = $1 AND ws.step_no = $2', [reqId, no]))[0].id as string;

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
  tenantId = (await seed(owner, { tenant: { code: 'CHR', name: 'Characterization', idpType: 'OIDC' }, domains: ['req.test'],
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
  const role = (u: string, r: string, ccId: string) => addRole(q, tenantId, ids[u], r, { costCenter: ccId });
  await role('dept1', 'DEPT_MANAGER', ids.cc100); await role('dept3', 'DEPT_MANAGER', ids.cc300); await role('both', 'DEPT_MANAGER', ids.cc300);
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

let seq = 0;
// 코스트센터 CC100 자산 하나를 새로 만든다(SAP 번호가 있으면 SAP 자산 → 최종 승인 시 전기 건)
async function newAsset(sap: boolean): Promise<string> {
  seq += 1;
  const tag = `${sap ? 'CS' : 'CL'}-${String(seq).padStart(4, '0')}`;
  return (await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, site_id, room_id, cost_center_id,
      sap_asset_no, sap_sub_no, is_capitalized) VALUES (gen_random_uuid(), $1, $2::varchar, $2::varchar || ' item', $3, 'IN_STOCK', 'MANUAL', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
  [tenantId, tag, ids.cat, ids.co, ids.site, ids.room1, ids.cc100, sap ? `0000020${String(seq).padStart(5, '0')}` : null, sap ? '0000' : null, sap]))[0].id as string;
}
const draft = async (who: string, assetId: string, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', '/asset-requests', { requestType: 'CHANGE', assetId, reason: '시험', targetRoomId: ids.room2, ...extra });

test('제출·수정·취소 가드: 요청자만 제출·수정, 제출 후 수정 불가, 이중 제출 409, 범위 밖은 404', { skip }, async () => {
  const a = await newAsset(true);
  const d = await draft('mgr', a);
  assert.equal(d.status, 201); assert.equal(d.body.status, 'DRAFT');
  assert.equal((await call('mgr2', 'POST', `/asset-requests/${d.body.id}:submit`)).status, 403, '자산 관리자라도 남의 초안은 제출 불가');
  assert.equal((await call('emp', 'POST', `/asset-requests/${d.body.id}:submit`)).status, 404, '범위 밖 직원에게는 존재를 숨김');
  assert.equal((await call('mgr2', 'PATCH', `/asset-requests/${d.body.id}`, { reason: 'x', targetRoomId: ids.room2 }, { 'if-match': '"1"' })).status, 403);
  const w = await call('mgr', 'PATCH', `/asset-requests/${d.body.id}`, { reason: '약한 ETag', targetRoomId: ids.room2 }, { 'if-match': 'W/"1"' });
  assert.equal(w.status, 200, 'W/"n" 형식 If-Match 허용'); assert.equal(w.body.version, 2);
  const get = await call('mgr', 'GET', `/asset-requests/${d.body.id}`);
  assert.equal(get.headers.get('etag'), '"2"');
  const sub = await call('mgr', 'POST', `/asset-requests/${d.body.id}:submit`);
  assert.equal(sub.status, 200); assert.equal(sub.body.status, 'SUBMITTED');
  const again = await call('mgr', 'POST', `/asset-requests/${d.body.id}:submit`);
  assert.equal(again.status, 409); assert.equal(again.body.code, 'ALM-E322');
  const edit = await call('mgr', 'PATCH', `/asset-requests/${d.body.id}`, { reason: 'y', targetRoomId: ids.room2 }, { 'if-match': `"${sub.body.version}"` });
  assert.equal(edit.status, 409); assert.equal(edit.body.code, 'ALM-E322', '제출한 요청은 수정 불가');
  assert.equal((await call('mgr', 'GET', `/asset-requests/${randomId()}`)).status, 404);
  await call('mgr', 'POST', `/asset-requests/${d.body.id}:cancel`);
});
const randomId = () => '00000000-0000-4000-8000-000000000999';

test('취소: 초안은 요청자·범위 안 자산 관리자만, 직원 아님, 이미 끝난 요청 409, 취소 뒤 같은 자산에 새 요청 가능', { skip }, async () => {
  const a = await newAsset(true);
  const d = await draft('mgr', a);
  assert.equal((await call('emp', 'POST', `/asset-requests/${d.body.id}:cancel`)).status, 404);
  const byOther = await call('mgr2', 'POST', `/asset-requests/${d.body.id}:cancel`);
  assert.equal(byOther.status, 200, '범위 안 자산 관리자는 남의 요청도 취소'); assert.equal(byOther.body.status, 'CANCELLED');
  const twice = await call('mgr', 'POST', `/asset-requests/${d.body.id}:cancel`);
  assert.equal(twice.status, 409); assert.equal(twice.body.code, 'ALM-E322');
  const next = await draft('mgr', a);
  assert.equal(next.status, 201, '취소된 요청은 진행 중 요청으로 세지 않음');
  await call('mgr', 'POST', `/asset-requests/${next.body.id}:cancel`);
});

test('승인 가드: 잘못된 id 404, 순서 위반·이중 결정 409, 요청자·앞 단계 승인자 직무 분리, 반려 의견 필수·길이 제한', { skip }, async () => {
  const a = await newAsset(true);
  const r = await draft('mgr', a, { submit: true });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'SUBMITTED');
  const s1 = await step(r.body.id, 1), s2 = await step(r.body.id, 2);
  assert.equal((await call('dept1', 'POST', '/approvals/not-a-uuid:approve', {})).status, 404);
  assert.equal((await call('dept1', 'POST', `/approvals/${randomId()}:approve`, {})).status, 404);
  const bySelf = await call('mgr', 'POST', `/approvals/${s1}:approve`, {});
  assert.equal(bySelf.status, 403, '요청자 본인(직무 분리)');
  const early = await call('acct', 'POST', `/approvals/${s2}:approve`, {});
  assert.equal(early.status, 409); assert.equal(early.body.code, 'ALM-E322', '앞 단계가 끝나지 않음');
  assert.equal((await call('dept1', 'POST', `/approvals/${s1}:reject`, {})).status, 400, '반려는 의견 필수');
  assert.equal((await call('dept1', 'POST', `/approvals/${s1}:approve`, { comment: 'x'.repeat(501) })).status, 400, '의견 500자 제한');
  assert.equal((await call('dept3', 'POST', `/approvals/${s1}:approve`, {})).status, 404, '다른 코스트센터 부서 관리자에게는 단계 존재를 숨김');
  const ok = await call('dept1', 'POST', `/approvals/${s1}:approve`, { comment: '확인' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.stepNo, ok.body.approverRole, ok.body.decision, ok.body.comment, ok.body.requestStatus], [1, 'DEPT_MANAGER', 'APPROVED', '확인', 'MGR_APPROVED']);
  const dup = await call('dept1', 'POST', `/approvals/${s1}:approve`, {});
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'ALM-E322', '이미 결정된 단계');
  const [row] = await q('SELECT status, current_step FROM asset_request WHERE id = $1', [r.body.id]);
  assert.deepEqual(row, { status: 'MGR_APPROVED', current_step: 2 });
  const rej = await call('acct', 'POST', `/approvals/${s2}:reject`, { comment: '증빙 부족' });
  assert.equal(rej.status, 200); assert.equal(rej.body.requestStatus, 'REJECTED');
  assert.equal((await q('SELECT count(*)::int AS n FROM sap_posting WHERE asset_request_id = $1', [r.body.id]))[0].n, 0, '반려는 전기 건을 만들지 않음');
  const after = await call('acct', 'POST', `/approvals/${s2}:approve`, {});
  assert.equal(after.status, 409, '반려된 요청의 단계는 다시 결정 불가');
  assert.equal((await call('mgr', 'POST', `/asset-requests/${r.body.id}:cancel`)).status, 409, '반려된 요청은 취소 불가');
});

test('승인 가드: 1단계 승인자는 2단계도 자격이 있어도 결정 불가(직무 분리)', { skip }, async () => {
  // both = ASSET_ACCOUNTANT + CC300 부서 관리자. CC300 이관 요청(보내는 쪽 CC100, 받는 쪽 CC300)은 CC100 → CC300 → 자산회계
  const a = await newAsset(true);
  const r = await call('mgr', 'POST', '/asset-requests', { requestType: 'TRANSFER', assetId: a, reason: '이관', targetCostCenterId: ids.cc300, effectiveDate: '2026-11-01', submit: true });
  assert.equal(r.status, 201);
  const steps = await q('SELECT ws.step_no, ws.resolver AS approver_role FROM workflow_step ws JOIN workflow_instance wi ON wi.id = ws.instance_id WHERE wi.subject_id = $1 ORDER BY ws.step_no', [r.body.id]);
  assert.deepEqual(steps.map((s) => s.approver_role), ['DEPT_MANAGER', 'DEPT_MANAGER', 'ASSET_ACCOUNTANT']);
  assert.equal((await call('dept1', 'POST', `/approvals/${await step(r.body.id, 1)}:approve`, {})).status, 200);
  // both는 2단계(CC300 부서 관리자)를 승인 → 3단계(자산회계) 자격도 있지만 같은 사람이 이어서 승인할 수 없다
  const two = await call('both', 'POST', `/approvals/${await step(r.body.id, 2)}:approve`, {});
  assert.equal(two.status, 200); assert.equal(two.body.requestStatus, 'MGR_APPROVED');
  assert.equal((await call('both', 'POST', `/approvals/${await step(r.body.id, 3)}:approve`, {})).status, 403);
  assert.equal((await call('dept1', 'POST', `/approvals/${await step(r.body.id, 3)}:approve`, {})).status, 403);
  assert.equal((await call('acct', 'POST', `/approvals/${await step(r.body.id, 3)}:approve`, {})).status, 200);
  const [row] = await q('SELECT status FROM asset_request WHERE id = $1', [r.body.id]);
  assert.equal(row.status, 'ACCT_APPROVED');
});

test('승인함: 지금 단계 승인자만, 요청자·앞 단계 승인자 제외, kind·페이징, 단계가 넘어가면 이동', { skip }, async () => {
  const before = (await call('dept1', 'GET', '/approvals/inbox')).body.total as number;
  const a = await newAsset(true), b = await newAsset(true);
  const r1 = await draft('mgr', a, { submit: true }), r2 = await draft('mgr', b, { submit: true });
  const inbox = await call('dept1', 'GET', '/approvals/inbox');
  assert.equal(inbox.body.total, before + 2);
  const it = inbox.body.items.find((x: { targetId: string }) => x.targetId === r1.body.id);
  assert.deepEqual([it.kind, it.requestType, it.stepNo, it.approverRole, it.proxy], ['ASSET_REQUEST', 'CHANGE', 1, 'DEPT_MANAGER', undefined]);
  assert.equal(it.approvalId, await step(r1.body.id, 1)); assert.equal(it.targetNo, r1.body.requestNo);
  assert.equal((await call('mgr', 'GET', '/approvals/inbox')).body.items.some((x: { targetId: string }) => x.targetId === r1.body.id), false, '요청자 본인 제외');
  assert.equal((await call('dept3', 'GET', '/approvals/inbox')).body.items.some((x: { targetId: string }) => x.targetId === r1.body.id), false, '다른 코스트센터 제외');
  assert.equal((await call('acct', 'GET', '/approvals/inbox')).body.items.some((x: { targetId: string }) => x.targetId === r1.body.id), false, '부서 관리자가 있으면 자산회계는 1단계를 보지 않음');
  assert.equal((await call('dept1', 'GET', '/approvals/inbox?kind=PURCHASE_REQUEST')).body.total, 0);
  assert.equal((await call('dept1', 'GET', '/approvals/inbox?kind=NOPE')).status, 400);
  const p2 = await call('dept1', 'GET', '/approvals/inbox?pageSize=1&page=2');
  assert.deepEqual([p2.body.items.length, p2.body.page, p2.body.pageSize, p2.body.total], [1, 2, 1, before + 2]);
  assert.equal((await call('emp', 'GET', '/approvals/inbox')).status, 403, '직원은 승인함 권한 없음');
  await call('dept1', 'POST', `/approvals/${await step(r1.body.id, 1)}:approve`, {});
  assert.equal((await call('dept1', 'GET', '/approvals/inbox')).body.total, before + 1, '승인한 건은 내 승인함에서 빠짐');
  const acct = await call('acct', 'GET', '/approvals/inbox');
  const mine = acct.body.items.find((x: { targetId: string }) => x.targetId === r1.body.id);
  assert.deepEqual([mine.stepNo, mine.approverRole], [2, 'ASSET_ACCOUNTANT']);
  await call('mgr', 'POST', `/asset-requests/${r1.body.id}:cancel`); await call('mgr', 'POST', `/asset-requests/${r2.body.id}:cancel`);
  assert.equal((await call('dept1', 'GET', '/approvals/inbox')).body.total, before, '취소하면 승인함에서 사라짐');
});

test('최종 승인 뒤 취소: 전기 건이 READY면 CANCELLED로, 승인 이력은 남고 자산은 그대로', { skip }, async () => {
  const a = await newAsset(true);
  const r = await draft('mgr', a, { submit: true });
  await call('dept1', 'POST', `/approvals/${await step(r.body.id, 1)}:approve`, {});
  const fin = await call('acct', 'POST', `/approvals/${await step(r.body.id, 2)}:approve`, {});
  assert.equal(fin.body.requestStatus, 'ACCT_APPROVED');
  assert.deepEqual((await q('SELECT status, posting_type FROM sap_posting WHERE asset_request_id = $1', [r.body.id]))[0], { status: 'READY', posting_type: 'ASSET_CHANGE' });
  const c = await call('mgr', 'POST', `/asset-requests/${r.body.id}:cancel`);
  assert.equal(c.status, 200); assert.equal(c.body.status, 'CANCELLED');
  assert.deepEqual((await q('SELECT status FROM sap_posting WHERE asset_request_id = $1', [r.body.id]))[0], { status: 'CANCELLED' });
  assert.deepEqual((await q('SELECT ws.status AS decision FROM workflow_step ws JOIN workflow_instance wi ON wi.id = ws.instance_id WHERE wi.subject_id = $1 ORDER BY ws.step_no', [r.body.id])).map((x) => x.decision), ['APPROVED', 'APPROVED']);
  assert.equal((await q('SELECT room_id FROM asset WHERE id = $1', [a]))[0].room_id, ids.room1, '자산 값은 바뀌지 않음');
});

test('ALM 전용 자산(SAP 번호 없음): 최종 승인 즉시 POSTED, 전기 건 없음, 자산 반영', { skip }, async () => {
  const a = await newAsset(false);
  const r = await draft('mgr', a, { submit: true });
  await call('dept1', 'POST', `/approvals/${await step(r.body.id, 1)}:approve`, {});
  const fin = await call('acct', 'POST', `/approvals/${await step(r.body.id, 2)}:approve`, {});
  assert.equal(fin.body.requestStatus, 'POSTED');
  assert.equal((await q('SELECT count(*)::int AS n FROM sap_posting WHERE asset_request_id = $1', [r.body.id]))[0].n, 0);
  assert.equal((await q('SELECT room_id FROM asset WHERE id = $1', [a]))[0].room_id, ids.room2);
});

test('목록: 필터(mine·assetId·type·status 복수)·검색어 이스케이프·페이징 상한·검증', { skip }, async () => {
  const all = await call('mgr', 'GET', '/asset-requests?pageSize=1000');
  assert.equal(all.body.pageSize, 200, 'pageSize 상한 200');
  assert.equal((await call('mgr', 'GET', '/asset-requests?pageSize=0')).body.pageSize, 50, '0·잘못된 값은 기본 50');
  assert.equal((await call('mgr', 'GET', '/asset-requests?page=-3')).body.page, 1);
  const total = all.body.total as number;
  assert.equal((await call('mgr', 'GET', '/asset-requests?mine=true')).body.total, total, 'mgr이 만든 요청만 있음');
  assert.equal((await call('mgr2', 'GET', '/asset-requests?mine=true')).body.total, 0);
  assert.equal((await call('mgr', 'GET', '/asset-requests?assetId=abc')).status, 400);
  assert.equal((await call('mgr', 'GET', '/asset-requests?type=NOPE')).status, 400);
  const both = await call('mgr', 'GET', '/asset-requests?status=CANCELLED,REJECTED&type=CHANGE');
  assert.ok(both.body.items.length > 0);
  assert.ok(both.body.items.every((x: { status: string; requestType: string }) => ['CANCELLED', 'REJECTED'].includes(x.status) && x.requestType === 'CHANGE'));
  assert.equal((await call('mgr', 'GET', '/asset-requests?q=%25')).body.total, 0, '% 는 와일드카드가 아니라 문자 그대로');
  const one = await call('mgr', 'GET', `/asset-requests?assetId=${ids.sapA}&pageSize=5`);
  assert.ok(one.body.items.every((x: { assetTag: string }) => x.assetTag === 'S1000000'));
  const sorted = (await call('mgr', 'GET', '/asset-requests?pageSize=200')).body.items.map((x: { requestNo: string }) => x.requestNo);
  assert.equal(sorted.length, total);
});
