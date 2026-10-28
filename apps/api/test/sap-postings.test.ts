// SAP 전기 claim·result, 수동 실행 요청 통합 시험(08 4.2·6장, WBS 4.7). 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
import type { Config } from '../src/config';
import type { Mailer, SendEmailJob } from '../src/notify/mail';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_sappost_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
let co: string, acct: string, asset1: string, asset3: string, req1: string, req3: string, req0: string, pr2: string;
const jobs: SendEmailJob[] = [];
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)],
};
const fakeCognito = {
  verifyAccess: async (t: string) => {
    const [, u, c, scope] = t.split('|');
    return { sub: 's', username: u, client_id: c, token_use: 'access', scope: scope ?? 'openid', exp: 0 };
  },
  userInfo: async () => ({}),
  clientCredentials: async () => ({ ok: false, status: 400, error: 'invalid_client' }),
};
const AUTH = 'Bearer at|sappost1|sappost1|alm-api/sap.api';

let seq = 0;
async function call(path: string, body?: unknown, key: string | null = `k-${++seq}`) {
  const headers: Record<string, string> = { authorization: AUTH, 'x-sap-system': 'DEV-100' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const posting = (id: string, type: string, o: { asset?: string; req?: string; pr?: string; attempt?: number; payload?: unknown } = {}) =>
  owner.query(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, company_id, asset_id, asset_request_id, purchase_request_id, posting_date,
      payload, approved_by, approved_at, attempt_count) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, '2026-10-12', $8, $9, '2026-10-12T15:00:00Z', $10)`,
  [tenantId, id, type, co, o.asset ?? null, o.req ?? null, o.pr ?? null, JSON.stringify(o.payload ?? { k: id }), acct, o.attempt ?? 0]);

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'SPO', name: 'SAP posting', idpType: 'OIDC' }, domains: ['sappost.test'],
    users: [{ email: 'acct@sappost.test', displayName: 'Acct', roles: ['ASSET_ACCOUNTANT'] }, { email: 'emp@sappost.test', displayName: 'Emp', roles: [] }] })).tenantId;
  acct = (await q(`SELECT id FROM app_user WHERE email = 'acct@sappost.test'`))[0].id;
  const emp = (await q(`SELECT id FROM app_user WHERE email = 'emp@sappost.test'`))[0].id;
  co = (await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [tenantId]))[0].id;
  await owner.query(`INSERT INTO sap_connection (id, tenant_id, system_id, company_id, oauth_client_id, allowed_cidrs)
    VALUES (gen_random_uuid(), $1, 'DEV-100', $2, 'sappost1', '[]')`, [tenantId, co]);
  const cat = (await q(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'NB') RETURNING id`, [tenantId]))[0].id;
  const cc = (await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC1', 'IT', $2) RETURNING id`, [tenantId, co]))[0].id;
  const mk = async (tag: string) => (await q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id)
    VALUES (gen_random_uuid(), $1, $2, 'NB', $3, 'IN_USE', 'MANUAL', $4) RETURNING id`, [tenantId, tag, cat, co]))[0].id;
  asset1 = await mk('BSG-1'); asset3 = await mk('BSG-3');
  const rq = async (no: string, type: string, a: string) => (await q(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, asset_id, requester_id)
    VALUES (gen_random_uuid(), $1, $2, $3, 'ACCT_APPROVED', $4, $5) RETURNING id`, [tenantId, no, type, a, emp]))[0].id;
  req1 = await rq('AR-1', 'NEW_ASSET', asset1); req3 = await rq('AR-3', 'RETIRE', asset3); req0 = await rq('AR-0', 'CHANGE', asset1);
  pr2 = (await q(`INSERT INTO purchase_request (id, tenant_id, pr_no, title, requester_id, company_id, cost_center_id, status)
    VALUES (gen_random_uuid(), $1, 'PR-2', 'Laptops', $2, $3, $4, 'PO_REQUESTED') RETURNING id`, [tenantId, emp, co, cc]))[0].id;
  await posting('AR-0', 'ASSET_CHANGE', { asset: asset1, req: req0, attempt: 5 });
  await posting('AR-1', 'ASSET_CREATE', { asset: asset1, req: req1, payload: { assetClass: '3100', inventoryNo: 'BSG-1' } });
  await posting('AR-3', 'ASSET_RETIRE', { asset: asset3, req: req3 });
  await posting('PR-2', 'PO_CREATE', { pr: pr2 });
  const mailer = { enqueue: async (j: SendEmailJob | undefined) => { if (j) jobs.push(j); } } as unknown as Mailer;
  const api = await createApi({ cfg, db: app, cognito: fakeCognito as never, principals: new PrincipalCache(), mailer });
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

test('claim: 마감 기간이면 빈 목록, 시도 초과는 E306, 대상은 postingId 순·15분 잠금, 같은 키는 같은 응답', { skip }, async () => {
  await owner.query(`INSERT INTO setting (id, tenant_id, key, value) VALUES (gen_random_uuid(), $1, 'sap.posting_blackout', $2)`,
    [tenantId, JSON.stringify({ from: new Date(Date.now() - 3600e3).toISOString(), to: new Date(Date.now() + 3600e3).toISOString() })]);
  const blk = await call('/sap/postings:claim', { batchId: 'POST-0' });
  assert.equal(blk.status, 200); assert.deepEqual(blk.body.items, []);
  await owner.query(`UPDATE setting SET value = '{}' WHERE key = 'sap.posting_blackout'`);

  assert.equal((await call('/sap/postings:claim', { batchId: 'POST-X', maxItems: 500 })).body.code, 'ALM-E100');
  const a = await call('/sap/postings:claim', { batchId: 'POST-1' }, 'POST-1');
  assert.equal(a.status, 200);
  assert.equal(a.body.leaseSeconds, 900);
  assert.deepEqual(a.body.items.map((i: { postingId: string }) => i.postingId), ['AR-1', 'AR-3', 'PR-2']);
  const i1 = a.body.items[0];
  assert.deepEqual({ ...i1, leaseUntil: undefined }, { postingId: 'AR-1', type: 'ASSET_CREATE', companyCode: '1000', postingDate: '2026-10-12',
    asset: { inventoryNo: 'BSG-1' }, payload: { assetClass: '3100', inventoryNo: 'BSG-1' }, approvedBy: 'acct@sappost.test',
    approvedAt: '2026-10-12T15:00:00.000Z', attempt: 1, leaseUntil: undefined });
  assert.equal(a.body.items[2].asset, undefined, 'PO에는 자산 없음');

  const again = await call('/sap/postings:claim', { batchId: 'POST-1' }, 'POST-1');
  assert.deepEqual(again.body, a.body, '같은 batchId 재시도는 같은 목록');
  assert.deepEqual((await call('/sap/postings:claim', { batchId: 'POST-2' })).body.items, [], '잠긴 건은 내주지 않음');

  assert.deepEqual(await q(`SELECT status, messages->0->>'number' AS n FROM sap_posting WHERE posting_id = 'AR-0'`), [{ status: 'FAILED', n: '306' }]);
  assert.equal((await q(`SELECT status FROM asset_request WHERE id = $1`, [req0]))[0].status, 'POST_ERROR');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].to, 'acct@sappost.test'); assert.match(jobs[0].subject, /AR-0/);

  // 잠금이 지나면 다시 대상(attempt 2)
  await owner.query(`UPDATE sap_posting SET lease_until = now() - interval '1 minute' WHERE posting_id = 'PR-2'`);
  const re = await call('/sap/postings:claim', { batchId: 'POST-3', types: ['PO_CREATE'] });
  assert.deepEqual(re.body.items.map((i: { postingId: string; attempt: number }) => [i.postingId, i.attempt]), [['PR-2', 2]]);
});

test('result: POSTED 반영·멱등·충돌 E302, FAILED → POST_ERROR·메일, E306 뒤 POSTED 수용', { skip }, async () => {
  assert.equal((await call('/sap/postings/AR-1/result', { postingId: 'AR-1', status: 'POSTED' })).body.code, 'ALM-E101', '자산 생성은 자산번호 필수');
  assert.equal((await call('/sap/postings/AR-1/result', { postingId: 'AR-9', status: 'POSTED' })).status, 400, '경로와 다른 id');
  assert.equal((await call('/sap/postings/NOPE/result', { postingId: 'NOPE', status: 'POSTED' })).status, 404);

  const ok = { postingId: 'AR-1', status: 'POSTED', asset: { assetNo: '000000100001', subNo: '0000' } };
  const r1 = await call('/sap/postings/AR-1/result', ok, 'AR-1-1');
  assert.deepEqual(r1.body, { postingId: 'AR-1', status: 'POSTED', requestStatus: 'POSTED' });
  assert.deepEqual(await q(`SELECT sap_asset_no, sap_sub_no FROM asset WHERE id = $1`, [asset1]), [{ sap_asset_no: '000000100001', sap_sub_no: '0000' }]);
  assert.deepEqual((await q(`SELECT event_type, channel, changes->>'postingId' AS p FROM asset_event WHERE asset_id = $1`, [asset1])),
    [{ event_type: 'SAP_POSTED', channel: 'SAP', p: 'AR-1' }]);
  assert.equal((await call('/sap/postings/AR-1/result', ok, 'AR-1-2')).status, 200, '같은 결과 재회신');
  const diff = await call('/sap/postings/AR-1/result', { ...ok, asset: { assetNo: '000000100002', subNo: '0000' } }, 'AR-1-3');
  assert.equal(diff.status, 409); assert.equal(diff.body.code, 'ALM-E302');

  assert.equal((await call('/sap/postings/AR-3/result', { postingId: 'AR-3', status: 'FAILED', messages: [{ type: 'W', id: 'AA', number: '1', text: 'w' }] })).body.code,
    'ALM-E101', 'FAILED는 E·A 메시지 필요');
  const fail = await call('/sap/postings/AR-3/result', { postingId: 'AR-3', status: 'FAILED',
    messages: [{ type: 'E', id: 'AAPO', number: '176', text: 'Posting period 010 2026 is not open' }] }, 'AR-3-1');
  assert.deepEqual(fail.body, { postingId: 'AR-3', status: 'FAILED', requestStatus: 'POST_ERROR' });
  assert.equal(jobs.length, 2); assert.match(jobs[1].text, /AAPO 176/);
  const run = (await q(`SELECT interface_id, direction, status, http_status FROM sap_if_run WHERE batch_id = 'AR-3'`))[0];
  assert.deepEqual(run, { interface_id: 'IF-AA-06', direction: 'ALM_TO_SAP', status: 'FAILED', http_status: 200 });
  assert.equal((await call('/sap/postings/AR-3/result', { postingId: 'AR-3', status: 'POSTED', sapDocument: { belnr: '0100000001', gjahr: '2026' } })).status,
    409, 'SAP 실패 뒤 다른 결과는 충돌');

  const po = await call('/sap/postings/PR-2/result', { postingId: 'PR-2', status: 'POSTED', poNo: '4500000123' });
  assert.deepEqual(po.body, { postingId: 'PR-2', status: 'POSTED', requestStatus: 'PO_CREATED' });
  assert.equal((await q(`SELECT sap_po_no FROM purchase_request WHERE id = $1`, [pr2]))[0].sap_po_no, '4500000123');

  const late = await call('/sap/postings/AR-0/result', { postingId: 'AR-0', status: 'POSTED' });
  assert.deepEqual(late.body, { postingId: 'AR-0', status: 'POSTED', requestStatus: 'POSTED' }, 'E306 뒤 POSTED는 받음(SAP 기준)');
});

test('폐기 POSTED: 전표 저장, 자산 RETIRED', { skip }, async () => {
  await owner.query(`UPDATE sap_posting SET status = 'CLAIMED', result_at = NULL, messages = NULL WHERE posting_id = 'AR-3'`);   // 자산회계가 고쳐 재전기한 상황
  const r = await call('/sap/postings/AR-3/result', { postingId: 'AR-3', status: 'POSTED', sapDocument: { belnr: '0100000001', gjahr: '2026' } });
  assert.equal(r.status, 200);
  assert.equal((await q(`SELECT status FROM asset WHERE id = $1`, [asset3]))[0].status, 'RETIRED');
  assert.deepEqual((await q(`SELECT event_type, sap_document_no, sap_fiscal_year FROM asset_event WHERE asset_id = $1 ORDER BY event_type`, [asset3])),
    [{ event_type: 'SAP_POSTED', sap_document_no: '0100000001', sap_fiscal_year: 2026 }, { event_type: 'RETIRED', sap_document_no: '0100000001', sap_fiscal_year: 2026 }]);
});

test('수동 실행 요청: PENDING → PICKED → 실행 로그(batchId -REQ…)로 DONE', { skip }, async () => {
  const emp = (await q(`SELECT id FROM app_user WHERE email = 'emp@sappost.test'`))[0].id;
  const id = (await q(`INSERT INTO sap_run_request (id, tenant_id, interface_id, params, requested_by) VALUES (gen_random_uuid(), $1, 'IF-AA-02', '{"isClosing": true}', $2) RETURNING id`,
    [tenantId, emp]))[0].id as string;
  const r = await call('/sap/run-requests');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((i: Record<string, unknown>) => [i.id, i.interfaceId, i.isClosing, i.status]), [[id, 'IF-AA-02', true, 'PICKED']]);
  assert.deepEqual((await call('/sap/run-requests')).body.items, [], '한 번만 내줌');
  await call('/sap/asset-values', { batchId: `AA02-20261012-REQ${id.slice(0, 8)}`, isClosing: true, records: [] });
  assert.deepEqual((await q(`SELECT status, sap_if_run_id IS NOT NULL AS linked FROM sap_run_request WHERE id = $1`, [id]))[0], { status: 'DONE', linked: true });
});
