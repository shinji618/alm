// SAP 연계 화면 API 통합 시험(ALM-310, WBS 4.6): 상태·실행 로그, 전기 큐 재전기·취소, 수동 실행 요청, 대사 차이 처리, 전기 오류 보정(:fix).
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
const dbName = `alm_sapweb_${Date.now()}`;
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
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-SAPW_${who}:web`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;

// 전기 오류 상태의 요청 + 실패한 전기 건
async function failedRequest(no: string, type: string, o: { cc?: string; messages?: unknown[]; reqType?: string; retire?: string } = {}) {
  const [r] = await q(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, asset_id, requester_id, submitted_at, reason, target_cost_center_id,
      retire_type, effective_date) VALUES (gen_random_uuid(), $1, $2, $3, 'POST_ERROR', 'USER', $4, $5, now(), '시험', $6, $7, '2026-10-01') RETURNING id`,
  [tenantId, no, o.reqType ?? 'TRANSFER', ids.asset, ids.mgr, o.cc ?? null, o.retire ?? null]);
  const [p] = await q(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, status, company_id, asset_request_id, asset_id, posting_date, payload, attempt_count, messages, approved_by, approved_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'FAILED', $4, $5, $6, current_date, '{"old":true}', 3, $7, $8, now()) RETURNING id`,
  [tenantId, no, type, ids.co, r.id, ids.asset, JSON.stringify(o.messages ?? [{ type: 'E', id: 'AA', number: '123', text: '기간 마감' }]), ids.acct]);
  return { req: r.id as string, posting: p.id as string };
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
  tenantId = (await seed(owner, { tenant: { code: 'SAPW', name: 'SAP web', idpType: 'OIDC' }, domains: ['sapw.test'],
    users: [{ email: 'mgr@sapw.test', displayName: 'Mgr', roles: ['ASSET_MANAGER'] }, { email: 'acct@sapw.test', displayName: 'Acct', roles: ['ASSET_ACCOUNTANT'] },
      { email: 'acct2@sapw.test', displayName: 'Acct2', roles: ['ASSET_ACCOUNTANT'] }, { email: 'adm@sapw.test', displayName: 'Adm', roles: ['SYS_ADMIN'] },
      { email: 'dept@sapw.test', displayName: 'Dept', roles: [] }] })).tenantId;
  for (const u of ['mgr', 'acct', 'acct2', 'adm', 'dept']) ids[u] = (await q(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@sapw.test`]))[0].id;
  const ins = async (sql: string, p: unknown[] = []) => (await q(sql, [tenantId, ...p]))[0].id as string;
  ids.co = await ins(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`);
  ids.site = await ins(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`);
  ids.room1 = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-101', 'Office', 'R1') RETURNING id`, [ids.site]);
  ids.room2 = await ins(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-201', 'IT', 'R2') RETURNING id`, [ids.site]);
  ids.pc = await ins(`INSERT INTO profit_center (id, tenant_id, controlling_area, profit_center_code, name) VALUES (gen_random_uuid(), $1, 'A000', 'P1', 'P1') RETURNING id`);
  ids.cc1 = await ins(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id, profit_center_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2, $3) RETURNING id`, [ids.co, ids.pc]);
  ids.cc2 = await ins(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id, profit_center_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC200', 'HR', $2, $3) RETURNING id`, [ids.co, ids.pc]);
  ids.cat = await ins(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`);
  const asset = (tag: string, sap: string, serial: string) => ins(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, site_id, room_id,
      cost_center_id, sap_asset_no, sap_sub_no, serial_no, is_capitalized) VALUES (gen_random_uuid(), $1, $2::varchar, 'Laptop', $3, 'IN_USE', 'SAP', $4, $5, $6, $7, $8, '0000', $9, true) RETURNING id`,
  [tag, ids.cat, ids.co, ids.site, ids.room1, ids.cc1, sap, serial]);
  ids.asset = await asset('S1', '000001000001', 'SN-1');
  ids.asset2 = await asset('S2', '000001000002', 'SN-2');
  ids.asset3 = await asset('S3', '000001000003', 'SN-3');
  await addRole(q, tenantId, ids.dept, 'DEPT_MANAGER', { costCenter: ids.cc2 });
  await q(`INSERT INTO sap_connection (id, tenant_id, system_id, company_id, oauth_client_id, last_call_at) VALUES (gen_random_uuid(), $1, 'S4H-100', $2, 'cid', now() - interval '5 minutes')`, [tenantId, ids.co]);
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

test('상태·실행 로그: IF별 마지막 실행·지연, 건별 결과', { skip }, async () => {
  const [run] = await q(`INSERT INTO sap_if_run (id, tenant_id, interface_id, direction, batch_id, record_count, success_count, error_count, status, started_at, finished_at)
    VALUES (gen_random_uuid(), $1, 'IF-MD-01', 'SAP_TO_ALM', 'B-1', 3, 2, 1, 'PARTIAL', now() - interval '1 hour', now()) RETURNING id`, [tenantId]);
  await q(`INSERT INTO sap_if_message (id, tenant_id, run_id, record_key, result, error_code, message, payload) VALUES
    (gen_random_uuid(), $1, $2, 'CC/X', 'ERROR', 'ALM-E104', '없는 코드', '{"x":1}'), (gen_random_uuid(), $1, $2, 'CC/Y', 'OK', NULL, NULL, '{"y":1}')`, [tenantId, run.id]);
  assert.equal((await call('mgr', 'GET', '/integration/sap/runs')).status, 403, '자산 관리자는 상태만');
  const st = await call('mgr', 'GET', '/integration/sap/status');
  assert.equal(st.status, 200);
  assert.deepEqual([st.body.systemId, st.body.companyCodes], ['S4H-100', ['1000']]);
  const md = st.body.interfaces.find((x: { interfaceId: string }) => x.interfaceId === 'IF-MD-01');
  assert.deepEqual([md.lastStatus, md.lastRecordCount, md.isOverdue, md.runnable], ['PARTIAL', 3, false, true]);
  assert.equal(st.body.interfaces.find((x: { interfaceId: string }) => x.interfaceId === 'IF-AA-01').isOverdue, true, '실행 기록 없음');
  assert.equal(st.body.interfaces.find((x: { interfaceId: string }) => x.interfaceId === 'IF-AA-03').isOverdue, false, '전기 IF는 마지막 호출(5분 전) 기준');
  const runs = await call('acct', 'GET', '/integration/sap/runs?interfaceId=IF-MD-01');
  assert.deepEqual(runs.body.items.map((x: { batchId: string; errorCount: number }) => [x.batchId, x.errorCount]), [['B-1', 1]]);
  const msgs = await call('acct', 'GET', `/integration/sap/runs/${run.id}/messages?result=ERROR`);
  assert.deepEqual(msgs.body.items, [{ recordKey: 'CC/X', result: 'ERROR', errorCode: 'ALM-E104', message: '없는 코드', payload: { x: 1 } }]);
});

test('전기 큐: 재전기(요청 값으로 payload 재생성)·시도 초과는 SAP 확인 필요·취소', { skip }, async () => {
  const a = await failedRequest('AR-00001', 'ASSET_CHANGE', { cc: ids.cc2, reqType: 'TRANSFER' });
  const list = await call('acct', 'GET', '/integration/sap/postings');
  assert.deepEqual(list.body.items.map((x: { postingId: string; status: string; lastMessage: string }) => [x.postingId, x.status, x.lastMessage]), [['AR-00001', 'FAILED', 'AA 123: 기간 마감']]);
  const d = await call('acct', 'GET', `/integration/sap/postings/${a.posting}`);
  assert.deepEqual([d.body.requestNo, d.body.requestStatus, d.body.payload], ['AR-00001', 'POST_ERROR', { old: true }]);
  const r = await call('acct', 'POST', `/integration/sap/postings/${a.posting}:retry`, {});
  assert.equal(r.status, 200); assert.deepEqual([r.body.status, r.body.attemptCount], ['READY', 0]);
  const [pp] = await q('SELECT payload FROM sap_posting WHERE id = $1', [a.posting]);
  assert.deepEqual(pp.payload, { fields: { costCenter: 'CC200' }, costCenterValidFrom: '2026-10-01' }, '손익센터가 같아 AS02 코스트센터 변경');
  assert.equal((await q('SELECT status FROM asset_request WHERE id = $1', [a.req]))[0].status, 'ACCT_APPROVED');
  assert.equal((await call('acct', 'POST', `/integration/sap/postings/${a.posting}:retry`, {})).status, 409, 'READY는 재전기 불가');

  const b = await failedRequest('AR-00002', 'ASSET_RETIRE', { reqType: 'RETIRE', retire: 'SCRAP', messages: [{ type: 'E', id: 'ALM', number: '306', text: '시도 초과' }] });
  const need = await call('acct', 'POST', `/integration/sap/postings/${b.posting}:retry`, {});
  assert.equal(need.status, 409); assert.equal(need.body.needsConfirm, true);
  assert.equal((await call('acct', 'POST', `/integration/sap/postings/${b.posting}:retry`, { confirmSapChecked: true })).body.status, 'READY');
  const cx = await call('acct', 'POST', `/integration/sap/postings/${b.posting}:cancel`);
  assert.equal(cx.body.status, 'CANCELLED');
  assert.equal((await q('SELECT status FROM asset_request WHERE id = $1', [b.req]))[0].status, 'CANCELLED');
  assert.equal((await call('adm', 'POST', `/integration/sap/postings/${a.posting}:cancel`)).status, 403, '취소는 sap.finance');

  // SAP 잡이 가져간 뒤 회신이 없는 건: 잠금 중이면 409, 잠금이 끝나면 SAP 확인 체크와 함께 취소
  const c = await failedRequest('AR-00003', 'ASSET_RETIRE', { reqType: 'RETIRE', retire: 'LOSS' });
  await q(`UPDATE sap_posting SET status = 'CLAIMED', lease_until = now() + interval '10 minutes' WHERE id = $1`, [c.posting]);
  assert.equal((await call('acct', 'POST', `/integration/sap/postings/${c.posting}:cancel`, { confirmSapChecked: true })).status, 409, '잠금 중');
  // 선점 취소(잠금 해제): 잠금 중이어도 confirmed와 함께 READY로, 시도 1 감소
  await q(`UPDATE sap_posting SET attempt_count = 2, claim_batch_id = 'B-9' WHERE id = $1`, [c.posting]);
  assert.equal((await call('mgr', 'POST', `/integration/sap/postings/${c.posting}:release`, { confirmed: true })).status, 403, '해제는 sap.operate(자산 관리자는 없음)');
  const nr = await call('acct', 'POST', `/integration/sap/postings/${c.posting}:release`, {});
  assert.equal(nr.status, 409); assert.equal(nr.body.needsConfirm, true);
  const rl = await call('acct', 'POST', `/integration/sap/postings/${c.posting}:release`, { confirmed: true });
  assert.equal(rl.status, 200); assert.deepEqual([rl.body.status, rl.body.attemptCount], ['READY', 1]);
  const [rr] = await q('SELECT lease_until, claim_batch_id FROM sap_posting WHERE id = $1', [c.posting]);
  assert.deepEqual([rr.lease_until, rr.claim_batch_id], [null, null]);
  assert.equal((await call('acct', 'POST', `/integration/sap/postings/${c.posting}:release`, { confirmed: true })).status, 409, 'READY는 해제 대상이 아님');
  await q(`UPDATE sap_posting SET status = 'CLAIMED', lease_until = now() + interval '10 minutes' WHERE id = $1`, [c.posting]);
  await q(`UPDATE sap_posting SET lease_until = now() - interval '1 minute' WHERE id = $1`, [c.posting]);
  const cn = await call('acct', 'POST', `/integration/sap/postings/${c.posting}:cancel`, {});
  assert.equal(cn.status, 409); assert.equal(cn.body.needsConfirm, true);
  assert.equal((await call('acct', 'POST', `/integration/sap/postings/${c.posting}:cancel`, { confirmSapChecked: true })).body.status, 'CANCELLED');
  assert.equal((await q('SELECT status FROM asset_request WHERE id = $1', [c.req]))[0].status, 'CANCELLED');
  await q(`UPDATE sap_posting SET status = 'POSTED' WHERE id = $1`, [a.posting]);
  await q(`UPDATE asset_request SET status = 'POSTED' WHERE id = $1`, [a.req]);
});

test('수동 실행 요청: 대기 중 중복 409, 마감 실행은 sap.finance', { skip }, async () => {
  const r = await call('adm', 'POST', '/integration/sap/run-requests', { interfaceId: 'IF-AA-01' });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'PENDING');
  assert.equal((await call('adm', 'POST', '/integration/sap/run-requests', { interfaceId: 'IF-AA-01' })).status, 409);
  assert.equal((await call('adm', 'POST', '/integration/sap/run-requests', { interfaceId: 'IF-AA-02', isClosing: true })).status, 403);
  assert.equal((await call('acct', 'POST', '/integration/sap/run-requests', { interfaceId: 'IF-AA-02', isClosing: true })).status, 201);
  assert.equal((await call('acct', 'POST', '/integration/sap/run-requests', { interfaceId: 'IF-AA-03' })).status, 400, '수신 IF만');
  assert.equal((await call('acct', 'POST', '/integration/sap/run-requests', { interfaceId: 'IF-RC-01', runType: 'CAMPAIGN' })).status, 400);
  const list = await call('acct', 'GET', '/integration/sap/run-requests');
  assert.deepEqual(list.body.items.map((x: { interfaceId: string; isClosing?: boolean }) => [x.interfaceId, x.isClosing ?? false]), [['IF-AA-02', true], ['IF-AA-01', false]]);
  const st = await call('acct', 'GET', '/integration/sap/status');
  assert.equal(st.body.interfaces.find((x: { interfaceId: string }) => x.interfaceId === 'IF-AA-01').runPending, true);
});

test('대사 차이 처리: SAP→ALM·ALM→SAP(변경 요청+전기)·무시, 허용되지 않은 처리와 진행 중 요청은 건별 오류(207)', { skip }, async () => {
  const [run] = await q(`INSERT INTO recon_run (id, tenant_id, run_type, batch_id, status, snapshot_at, sap_count, alm_count, diff_count)
    VALUES (gen_random_uuid(), $1, 'WEEKLY', 'RC-1', 'SUCCEEDED', now(), 3, 3, 5) RETURNING id`, [tenantId]);
  await q(`INSERT INTO recon_snapshot (id, tenant_id, run_id, company_code, sap_asset_no, sap_sub_no) VALUES (gen_random_uuid(), $1, $2, '1000', '000001000001', '0000'),
    (gen_random_uuid(), $1, $2, '1000', '000001000002', '0000'), (gen_random_uuid(), $1, $2, '1000', '000001000003', '0000'), (gen_random_uuid(), $1, $2, '1000', '000001000009', '0000')`, [tenantId, run.id]);
  const diff = async (type: string, asset: string | null, sapNo: string, alm: string | null, sap: string | null, action: string) => (await q(`INSERT INTO recon_diff
    (id, tenant_id, run_id, diff_type, asset_id, sap_asset_no, sap_sub_no, alm_value, sap_value, action) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '0000', $6, $7, $8) RETURNING id`,
  [tenantId, run.id, type, asset, sapNo, alm, sap, action]))[0].id as string;
  const dCc = await diff('COST_CENTER', ids.asset, '000001000001', 'CC100', 'CC200', 'SAP_TO_ALM');
  const dSer = await diff('SERIAL', ids.asset2, '000001000002', 'SN-2', 'SN-X', 'ALM_TO_SAP');
  const dTag = await diff('TAG', ids.asset3, '000001000003', 'S3', 'OLD3', 'ALM_TO_SAP');
  const dOnly = await diff('SAP_ONLY', null, '000001000009', null, null, 'SAP_TO_ALM');
  const dRet = await diff('RETIRED', ids.asset3, '000001000003', 'IN_USE', '2026-09-30', 'SAP_TO_ALM');
  const runs = await call('acct', 'GET', '/integration/sap/reconciliation/runs');
  assert.deepEqual([runs.body.items[0].openDiffs, runs.body.items[0].batchId], [5, 'RC-1']);
  const diffs = await call('acct', 'GET', `/integration/sap/reconciliation/runs/${run.id}/diffs?diffType=TAG`);
  assert.deepEqual(diffs.body.items[0].allowedActions, ['ALM_TO_SAP', 'IGNORE']);

  await q(`UPDATE sap_run_request SET status = 'DONE'`);
  const r = await call('acct', 'POST', '/integration/sap/reconciliation/diffs:resolve', { items: [
    { id: dCc, action: 'SAP_TO_ALM' }, { id: dSer, action: 'ALM_TO_SAP' }, { id: dTag, action: 'SAP_TO_ALM' }, { id: dOnly, action: 'SAP_TO_ALM' }, { id: dRet, action: 'IGNORE', note: '확인 중' }] });
  assert.equal(r.status, 207);
  assert.deepEqual(r.body.results.map((x: { status: string; code?: string }) => [x.status, x.code]), [['OK', undefined], ['OK', undefined], ['ERROR', 'ALM-E100'], ['OK', undefined], ['OK', undefined]]);
  assert.equal((await q('SELECT cost_center_id FROM asset WHERE id = $1', [ids.asset]))[0].cost_center_id, ids.cc2);
  const [chg] = await q(`SELECT ar.request_type, ar.status, ar.source, p.posting_type, p.payload FROM asset_request ar JOIN sap_posting p ON p.asset_request_id = ar.id WHERE ar.asset_id = $1`, [ids.asset2]);
  assert.deepEqual(chg, { request_type: 'CHANGE', status: 'ACCT_APPROVED', source: 'RECONCILIATION', posting_type: 'ASSET_CHANGE', payload: { fields: { serialNo: 'SN-2' } } });
  assert.equal((await q(`SELECT count(*)::int AS n FROM sap_run_request WHERE interface_id = 'IF-AA-01' AND status = 'PENDING'`))[0].n, 1, 'SAP_ONLY → AA-01 실행 요청');
  assert.equal((await q('SELECT status FROM recon_diff WHERE id = $1', [dRet]))[0].status, 'IGNORED');
  assert.equal((await q('SELECT status FROM recon_diff WHERE id = $1', [dTag]))[0].status, 'OPEN');
  const again = await call('acct', 'POST', '/integration/sap/reconciliation/diffs:resolve', { items: [{ id: dTag, action: 'ALM_TO_SAP' }] });
  assert.equal(again.status, 200);
  const busy = await call('acct', 'POST', '/integration/sap/reconciliation/diffs:resolve', { items: [{ id: dCc, action: 'IGNORE' }] });
  assert.equal(busy.body.results[0].code, 'ALM-E322', '이미 처리됨');
});

test('전기 오류 보정(:fix): 기술 필드는 바로 READY, 회계 필드는 재승인(보정한 사람은 결정 불가)', { skip }, async () => {
  await q(`UPDATE asset_request SET status = 'POSTED' WHERE asset_id = ANY($1)`, [[ids.asset, ids.asset2, ids.asset3]]);
  const a = await failedRequest('AR-00010', 'ASSET_RETIRE', { reqType: 'RETIRE', retire: 'SCRAP' });
  const [r0] = await q('SELECT version FROM asset_request WHERE id = $1', [a.req]);
  assert.equal((await call('mgr', 'POST', `/asset-requests/${a.req}:fix`, { comment: 'x', effectiveDate: '2026-10-31' }, { 'if-match': `"${r0.version}"` })).status, 403);
  assert.equal((await call('acct', 'POST', `/asset-requests/${a.req}:fix`, { effectiveDate: '2026-10-31' }, { 'if-match': `"${r0.version}"` })).status, 400, '사유 필수');
  const t1 = await call('acct', 'POST', `/asset-requests/${a.req}:fix`, { comment: '마감 기간 → 10월 말', effectiveDate: '2026-10-31' }, { 'if-match': `"${r0.version}"` });
  assert.equal(t1.status, 200); assert.equal(t1.body.status, 'ACCT_APPROVED');
  const [p1] = await q('SELECT status, attempt_count, value_date::text AS vd FROM sap_posting WHERE id = $1', [a.posting]);
  assert.deepEqual(p1, { status: 'READY', attempt_count: 0, vd: '2026-10-31' });

  await q(`UPDATE sap_posting SET status = 'FAILED' WHERE id = $1`, [a.posting]);
  await q(`UPDATE asset_request SET status = 'POST_ERROR' WHERE id = $1`, [a.req]);
  const [r1] = await q('SELECT version FROM asset_request WHERE id = $1', [a.req]);
  const t2 = await call('acct', 'POST', `/asset-requests/${a.req}:fix`, { comment: '분실로 정정', changes: { retireType: 'LOSS' } }, { 'if-match': `"${r1.version}"` });
  assert.equal(t2.status, 200); assert.equal(t2.body.status, 'SUBMITTED');
  assert.equal((await q('SELECT status FROM sap_posting WHERE id = $1', [a.posting]))[0].status, 'CANCELLED');
  const [s1] = await q('SELECT id FROM approval WHERE asset_request_id = $1 AND step_no = 1', [a.req]);
  // 자산 S1은 앞 시험(대사)에서 CC200이 되어 CC200 부서 관리자가 1단계
  assert.equal((await call('dept', 'POST', `/approvals/${s1.id}:approve`, {})).status, 200);
  const [s2] = await q('SELECT id FROM approval WHERE asset_request_id = $1 AND step_no = 2', [a.req]);
  const sod = await call('acct', 'POST', `/approvals/${s2.id}:approve`, {});
  assert.equal(sod.status, 403); assert.equal(sod.body.code, 'ALM-E403', '보정한 사람은 다시 만든 단계를 결정할 수 없음');
  const fin = await call('acct2', 'POST', `/approvals/${s2.id}:approve`, {});
  assert.equal(fin.body.requestStatus, 'ACCT_APPROVED');
  const [p2] = await q('SELECT status, attempt_count, payload FROM sap_posting WHERE id = $1', [a.posting]);
  assert.deepEqual([p2.status, p2.attempt_count, p2.payload.retireType], ['READY', 0, 'LOSS'], '같은 번호로 다시 READY');
});

test('필드 매핑(기본값 seed)·연결 목록', { skip }, async () => {
  const m = await call('acct', 'GET', '/integration/sap/field-mappings');
  assert.equal(m.body.items.length, 20);
  const tag = m.body.items.find((x: { almField: string }) => x.almField === 'asset.asset_tag');
  assert.deepEqual([tag.sapTable, tag.sapField, tag.masterSystem], ['ANLA', 'INVNR', 'ALM']);
  assert.equal((await call('acct', 'PATCH', `/integration/sap/field-mappings/${tag.id}`, { description: 'x' })).status, 403);
  assert.equal((await call('adm', 'PATCH', `/integration/sap/field-mappings/${tag.id}`, { description: '재고번호(라벨)' })).body.description, '재고번호(라벨)');
  const cn = await call('adm', 'GET', '/integration/sap/connections');
  assert.deepEqual(cn.body.items.map((x: { systemId: string; companyCode: string; companySapEnabled: boolean }) => [x.systemId, x.companyCode, x.companySapEnabled]), [['S4H-100', '1000', true]]);
});
