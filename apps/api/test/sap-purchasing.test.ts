// SAP 구매오더·입고·대사 수신 통합 시험(IF-MM-01·MM-03·RC-01, 08 5.4~5.7, WBS 4.7). 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
const dbName = `alm_sappur_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
let co: string, cat: string, cc1: string, r1: string, pr1: string;
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
const AUTH = 'Bearer at|sappur1|sappur1|alm-api/sap.api';
let seq = 0;
async function post(path: string, body: unknown, key = `k-${++seq}`) {
  const r = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { authorization: AUTH, 'x-sap-system': 'DEV-100', 'content-type': 'application/json', 'idempotency-key': key } });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const po = (o: Record<string, unknown> = {}) => ({ poNo: '4500000001', item: '00010', companyCode: '1000', vendor: '0000100001', vendorName: 'Dell',
  description: 'Latitude 7450', quantity: 3, unitPrice: 1450.5, costCenter: 'CC1', assets: [{ assetNo: '000000200001', subNo: '0000' }], almRequestNo: 'PR-1', ...o });
const gr = (o: Record<string, unknown> = {}) => ({ materialDoc: '5000000001', docYear: '2026', docItem: '0001', poNo: '4500000001', poItem: '00010',
  movementType: '101', quantity: 2, postingDate: '2026-10-12', ...o });

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'SPU', name: 'SAP purchasing', idpType: 'OIDC' }, domains: ['sappur.test'],
    users: [{ email: 'mgr@sappur.test', displayName: 'Mgr', roles: ['ASSET_MANAGER'] }, { email: 'emp@sappur.test', displayName: 'Emp', roles: [] }] })).tenantId;
  const emp = (await q(`SELECT id FROM app_user WHERE email = 'emp@sappur.test'`))[0].id;
  co = (await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [tenantId]))[0].id;
  await owner.query(`INSERT INTO sap_connection (id, tenant_id, system_id, company_id, oauth_client_id, allowed_cidrs) VALUES (gen_random_uuid(), $1, 'DEV-100', $2, 'sappur1', '[]')`, [tenantId, co]);
  cat = (await q(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'NB') RETURNING id`, [tenantId]))[0].id;
  const ccIns = (code: string) => q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', $2, $2, $3) RETURNING id`, [tenantId, code, co]);
  cc1 = (await ccIns('CC1'))[0].id; await ccIns('CC2');
  const site = (await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]))[0].id;
  r1 = (await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'R1', 'R1', 'RM-R1') RETURNING id`, [tenantId, site]))[0].id;
  pr1 = (await q(`INSERT INTO purchase_request (id, tenant_id, pr_no, title, requester_id, company_id, cost_center_id, status)
    VALUES (gen_random_uuid(), $1, 'PR-1', 'Laptops', $2, $3, $4, 'PO_REQUESTED') RETURNING id`, [tenantId, emp, co, cc1]))[0].id;
  await owner.query(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, zpl, is_default) VALUES (gen_random_uuid(), $1, 'STD', 'Std', 'QR_CODE128', '^XA^XZ', true)`, [tenantId]);
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

test('입고가 PO보다 먼저 오면 E202 → IF-MM-01 뒤 자동 재처리: 자산 IN_STOCK·태그 채번·SAP 번호 연결·라벨 대기열', { skip }, async () => {
  const early = await post('/sap/goods-receipts', { batchId: 'GR-1', records: [gr()] });
  assert.equal(early.status, 207);
  assert.equal(early.body.results[0].code, 'ALM-E202');

  const p = await post('/sap/purchase-orders', { batchId: 'PO-1', records: [po(), po({ item: '00020', companyCode: '2000' })] });
  assert.equal(p.status, 207);
  assert.deepEqual(p.body.results.map((r: { key: string; code: string }) => [r.key, r.code]), [['4500000001/00020', 'ALM-E401']]);
  assert.deepEqual(await q(`SELECT p.description, p.quantity::text, p.unit_price::text, v.vendor_no, v.name, p.cost_center_id = $1 AS cc, p.purchase_request_id = $2 AS pr
    FROM po_item p JOIN vendor v ON v.id = p.vendor_id`, [cc1, pr1]),
    [{ description: 'Latitude 7450', quantity: '3.000', unit_price: '1450.50', vendor_no: '0000100001', name: 'Dell', cc: true, pr: true }]);
  assert.deepEqual(await q(`SELECT status, sap_po_no FROM purchase_request WHERE id = $1`, [pr1]), [{ status: 'PO_CREATED', sap_po_no: '4500000001' }]);

  const assets = await q(`SELECT asset_tag, status, source, sap_asset_no, purchase_cost::text, cost_center_id = $1 AS cc, goods_receipt_id IS NOT NULL AS gr
    FROM asset ORDER BY asset_tag`, [cc1]);
  assert.deepEqual(assets, [
    { asset_tag: 'AT-000001', status: 'IN_STOCK', source: 'GOODS_RECEIPT', sap_asset_no: '000000200001', purchase_cost: '1450.50', cc: true, gr: true },
    { asset_tag: 'AT-000002', status: 'IN_STOCK', source: 'GOODS_RECEIPT', sap_asset_no: null, purchase_cost: '1450.50', cc: true, gr: true },
  ]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM label_print_job WHERE source = 'GOODS_RECEIPT'`))[0].n, 2);
  assert.equal((await q(`SELECT gr_quantity::text AS q FROM po_item`))[0].q, '2.000');
  assert.equal((await q(`SELECT count(*)::int AS n FROM sap_if_run WHERE interface_id = 'IF-MM-03' AND batch_id LIKE 'RETRY-%'`))[0].n, 1);

  assert.deepEqual((await post('/sap/purchase-orders', { batchId: 'PO-2', records: [po()] })).body.results, [{ key: '4500000001/00010', status: 'SKIPPED' }], '같은 값');
  assert.deepEqual((await post('/sap/goods-receipts', { batchId: 'GR-2', records: [gr()] })).body.results,
    [{ key: '5000000001/2026/0001', status: 'SKIPPED', message: '이미 받은 입고 행' }], '겹침 송신');
});

test('입고: IF-AA-01이 먼저 만든 SAP 자산은 새로 만들지 않고 연결, 102 취소는 최근 자산부터 표시 + 자산 관리자 메일', { skip }, async () => {
  await post('/sap/purchase-orders', { batchId: 'PO-3', records: [po({ assets: [{ assetNo: '000000200001', subNo: '0000' }, { assetNo: '000000200002', subNo: '0000' }] })] });
  await owner.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, sap_asset_no, sap_sub_no)
    VALUES (gen_random_uuid(), $1, 'S200002', 'from AA-01', $2, 'ON_ORDER', 'SAP', $3, '000000200002', '0000')`, [tenantId, cat, co]);
  const r = await post('/sap/goods-receipts', { batchId: 'GR-3', records: [gr({ materialDoc: '5000000002', quantity: 1 })] });
  assert.equal(r.status, 200);
  assert.deepEqual(await q(`SELECT asset_tag, status, goods_receipt_id IS NOT NULL AS gr FROM asset WHERE sap_asset_no = '000000200002'`),
    [{ asset_tag: 'S200002', status: 'IN_STOCK', gr: true }]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM asset`))[0].n, 3, '새 자산 없음');

  const x = await post('/sap/goods-receipts', { batchId: 'GR-4', records: [gr({ materialDoc: '5000000003', movementType: '102', quantity: 1 })] });
  assert.equal(x.status, 200);
  assert.deepEqual(await q(`SELECT asset_tag FROM asset WHERE is_gr_cancelled`), [{ asset_tag: 'S200002' }]);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].to, 'mgr@sappur.test'); assert.match(jobs[0].text, /S200002/);
  assert.equal((await q(`SELECT gr_quantity::text AS q FROM po_item WHERE item_no = '00010'`))[0].q, '2.000');
  assert.equal((await post('/sap/goods-receipts', { batchId: 'GR-5', records: [gr({ materialDoc: '5000000004', quantity: 1.5 })] })).body.results[0].code, 'ALM-E100', '소수 수량');
});

test('대사: 분할 순서 E303, 마지막 분할에서 차이 7유형 계산(202), 위치는 설명 2행, 빈 INVNR은 TAG 비교 안 함', { skip }, async () => {
  const mk = (tag: string, no: string, o: Record<string, unknown> = {}) => owner.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source,
      company_id, sap_asset_no, sap_sub_no, serial_no, cost_center_id, room_id) VALUES (gen_random_uuid(), $1, $2, 'x', $3, $4, 'SAP', $5, $6, '0000', $7, $8, $9)`,
    [tenantId, tag, cat, o.status ?? 'IN_USE', co, no, o.serial ?? null, o.cc ?? cc1, o.room ?? r1]);
  await mk('BSG-A', '000000300001', { serial: 'SN1' });
  await mk('BSG-B', '000000300002');
  await mk('BSG-C', '000000300003');
  await mk('BSG-D', '000000300004');
  await mk('BSG-E', '000000300005', { serial: 'sn5' }); // SAP은 시리얼을 대문자로 저장 → 대소문자만 다르면 차이 아님
  const rec = (no: string, o: Record<string, unknown> = {}) => ({ companyCode: '1000', assetNo: no, subNo: '0000', costCenter: 'CC1', description2: 'Location: ATL | Room: R1', ...o });
  const snap = { batchId: 'RC-1', runType: 'WEEKLY', snapshotAt: '2026-10-12T12:00:00Z' };

  const bad = await post('/sap/reconciliation', { ...snap, chunkNo: 2, records: [] });
  assert.equal(bad.status, 409); assert.equal(bad.body.code, 'ALM-E303');
  const c1 = await post('/sap/reconciliation', { ...snap, chunkNo: 1, records: [
    rec('000000300001', { inventoryNo: 'BSG-A', serialNo: 'SNX', costCenter: 'CC2', description2: 'Location: ATL | Room: R2' }),
    rec('000000300002', { inventoryNo: 'BSG-B', deactDate: '2026-10-01' }),
  ] });
  assert.equal(c1.status, 200); assert.equal(c1.body.status, 'RECEIVING');
  const c2 = await post('/sap/reconciliation', { ...snap, chunkNo: 2, isLast: true, records: [
    rec('000000300004', { inventoryNo: 'OLD' }), rec('000000300005', { serialNo: 'SN5' }), rec('000000399999', { inventoryNo: 'X' }), rec('000000400000', { deactDate: '2026-01-01' }),
  ] });
  assert.equal(c2.status, 202);
  assert.deepEqual({ ...c2.body, runId: undefined }, { batchId: 'RC-1', runId: undefined, received: 4, status: 'PROCESSING' });
  assert.equal((await post('/sap/reconciliation', { ...snap, chunkNo: 3, records: [] })).body.code, 'ALM-E303', '끝난 배치');

  const diffs = await q(`SELECT d.diff_type, d.sap_asset_no, d.alm_value, d.sap_value, d.action FROM recon_diff d
    WHERE d.sap_asset_no LIKE '0000003%' OR d.sap_asset_no LIKE '0000004%' ORDER BY d.sap_asset_no, d.diff_type`);
  assert.deepEqual(diffs.map((d) => [d.diff_type, d.sap_asset_no.slice(-6), d.alm_value, d.sap_value, d.action]), [
    ['COST_CENTER', '300001', 'CC1', 'CC2', 'SAP_TO_ALM'],
    ['LOCATION', '300001', 'Location: ATL | Room: R1', 'Location: ATL | Room: R2', 'ALM_TO_SAP'],
    ['SERIAL', '300001', 'SN1', 'SNX', 'ALM_TO_SAP'],
    ['RETIRED', '300002', 'IN_USE', '2026-10-01', 'SAP_TO_ALM'],
    ['ALM_ONLY', '300003', 'BSG-C', null, 'REVIEW'],
    ['TAG', '300004', 'BSG-D', 'OLD', 'ALM_TO_SAP'],
    ['SAP_ONLY', '399999', null, 'X', 'SAP_TO_ALM'],
  ]);
  const run = (await q(`SELECT status, sap_count, diff_count FROM recon_run WHERE batch_id = 'RC-1'`))[0];
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(run.sap_count, 6);
  assert.equal(run.diff_count, (await q(`SELECT count(*)::int AS n FROM recon_diff`))[0].n);
  assert.equal((await post('/sap/reconciliation', { ...snap, batchId: 'RC-2', chunkNo: 1, records: [rec('1', { companyCode: '2000' })] })).body.code, 'ALM-E401');
});
