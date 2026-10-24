// SAP 수신 통합 시험: IF-MD-01·IF-AA-01·IF-AA-02(08 4.3·5.1~5.3, WBS 4.7). 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
const dbName = `alm_sapin_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
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
const AUTH = 'Bearer at|sapin1|sapin1|alm-api/sap.api';

let seq = 0;
async function post(path: string, body: unknown, key: string | null = `k-${++seq}`) {
  const headers: Record<string, string> = { authorization: AUTH, 'content-type': 'application/json', 'x-sap-system': 'DEV-100' };
  if (key) headers['idempotency-key'] = key;
  const r = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
const md = (type: string, records: unknown[], o: { batchId?: string; chunkNo?: number; isLast?: boolean } = {}) =>
  post('/sap/master-data', { batchId: o.batchId ?? `MD-${type}-${++seq}`, type, chunkNo: o.chunkNo ?? 1, isLast: o.isLast ?? true, records });
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;

const asset = (no: string, o: Record<string, unknown> = {}) => ({ companyCode: '1000', assetNo: no, subNo: '0000', assetClass: '3100',
  description: `Notebook ${no}`, costCenter: 'CC100', capDate: '2026-01-15', changedAt: '2026-10-01T10:00:00Z', ...o });

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'SIN', name: 'SAP inbound', idpType: 'OIDC' }, domains: ['sapin.test'], users: [] })).tenantId;
  const co = (await owner.query(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'old') RETURNING id`, [tenantId])).rows[0].id;
  await owner.query(`INSERT INTO sap_connection (id, tenant_id, system_id, company_id, oauth_client_id, allowed_cidrs)
    VALUES (gen_random_uuid(), $1, 'DEV-100', $2, 'sapin1', '[]')`, [tenantId, co]);
  // ALM에서 먼저 등록한 자산(SAP 번호 없음) → inventoryNo로 연결되어야 함
  const cat = (await owner.query(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`, [tenantId])).rows[0].id;
  await owner.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, serial_no, status, source, company_id)
    VALUES (gen_random_uuid(), $1, 'BSG-0001', 'ALM 등록 노트북', $2, 'SN-ALM-1', 'IN_USE', 'MANUAL', $3)`, [tenantId, cat, co]);
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

test('IF-MD-01: 회사·코스트센터 업서트, 다른 회사코드 SKIPPED, 같은 값 SKIPPED, 기록', { skip }, async () => {
  const r = await md('COMPANY', [{ companyCode: '1000', name: 'BSG America', currency: 'USD' }, { companyCode: '2000', name: 'Other', currency: 'EUR' }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, [{ key: '2000', status: 'SKIPPED', message: '연결(1000)의 회사코드가 아님' }]);
  assert.equal(r.body.succeeded, 2);
  assert.deepEqual(await q(`SELECT company_code, name, currency FROM company`), [{ company_code: '1000', name: 'BSG America', currency: 'USD' }]);

  await md('PROFIT_CENTER', [{ controllingArea: 'A000', profitCenter: 'PC1', name: 'IT' }]);
  const cc = await md('COST_CENTER', [
    { controllingArea: 'A000', costCenter: 'CC100', name: 'IT Ops', companyCode: '1000', profitCenter: 'PC1' },
    { controllingArea: 'A000', costCenter: 'CC200', name: 'Finance', companyCode: '1000', validFrom: '2026-13-01' },
    { controllingArea: 'A000', name: 'no key', companyCode: '1000' }]);
  assert.equal(cc.status, 207, '오류가 있으면 207');
  assert.deepEqual(cc.body.results.map((x: { key: string; code: string }) => [x.key, x.code]), [['A000/CC200', 'ALM-E100'], ['?', 'ALM-E101']]);
  assert.equal(cc.body.failed, 2);
  const run = (await q(`SELECT status, record_count, error_count, http_status, sap_system FROM sap_if_run WHERE interface_id = 'IF-MD-01' AND batch_id = $1`, [cc.body.batchId]))[0];
  assert.deepEqual(run, { status: 'PARTIAL', record_count: 3, error_count: 2, http_status: 207, sap_system: 'DEV-100' });
  const msg = await q(`SELECT result, error_code, payload FROM sap_if_message m JOIN sap_if_run r ON r.id = m.run_id WHERE r.batch_id = $1 ORDER BY result, error_code`, [cc.body.batchId]);
  assert.deepEqual(msg.map((m) => [m.result, m.error_code]), [['CHUNK', null], ['ERROR', 'ALM-E100'], ['ERROR', 'ALM-E101']]);
  assert.equal(msg[1].payload.costCenter, 'CC200', '오류 건은 원문 보관');

  const again = await md('COMPANY', [{ companyCode: '1000', name: 'BSG America', currency: 'USD' }]);
  assert.deepEqual(again.body.results, [{ key: '1000', status: 'SKIPPED' }], '같은 값이면 갱신하지 않음');
});

test('IF-MD-01: 분할 순서(E303)·isLast 비활성(모든 분할 합산)', { skip }, async () => {
  await md('ASSET_CLASS', [{ assetClass: '3100', name: 'IT HW', usefulLifeYears: 3 }, { assetClass: '9999', name: 'old' }]);
  const b = `MD-AC-${Date.now()}`;
  assert.equal((await md('ASSET_CLASS', [{ assetClass: '3100', name: 'IT HW', usefulLifeYears: 3 }], { batchId: b, chunkNo: 2, isLast: false })).body.code, 'ALM-E303', '1번 없이 2번');
  assert.equal((await md('ASSET_CLASS', [{ assetClass: '3100', name: 'IT HW', usefulLifeYears: 3 }], { batchId: b, chunkNo: 1, isLast: false })).status, 200);
  const dup = await md('ASSET_CLASS', [], { batchId: b, chunkNo: 1, isLast: false });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'ALM-E303', '같은 분할 번호를 다른 키로');
  const last = await md('ASSET_CLASS', [{ assetClass: '3200', name: 'Furniture', isLowValue: true }], { batchId: b, chunkNo: 2, isLast: true });
  assert.deepEqual(last.body.results, [{ key: 'ASSET_CLASS:9999', status: 'SKIPPED', message: '이번 전체 전송에 없어 비활성 처리' }]);
  assert.deepEqual(await q(`SELECT class_code, is_active FROM asset_class ORDER BY class_code`),
    [{ class_code: '3100', is_active: true }, { class_code: '3200', is_active: true }, { class_code: '9999', is_active: false }], '1번 분할의 3100은 유지');
});

test('Idempotency-Key: 같은 본문 → 같은 응답, 다른 본문 → E301, 키 없음 → E101', { skip }, async () => {
  const body = { batchId: 'MD-IDEM-1', type: 'PROFIT_CENTER', chunkNo: 1, isLast: false, records: [{ controllingArea: 'A000', profitCenter: 'PC2', name: 'HR' }] };
  const a = await post('/sap/master-data', body, 'idem-1');
  const b = await post('/sap/master-data', body, 'idem-1');
  assert.equal(b.status, a.status); assert.deepEqual(b.body, a.body);
  assert.equal((await q(`SELECT count(*)::int AS n FROM sap_if_run WHERE batch_id = 'MD-IDEM-1'`))[0].n, 1, '두 번째는 처리하지 않음');
  const c = await post('/sap/master-data', { ...body, records: [] }, 'idem-1');
  assert.equal(c.status, 409); assert.equal(c.body.code, 'ALM-E301');
  const d = await post('/sap/master-data', body, null);
  assert.equal(d.status, 400); assert.equal(d.body.code, 'ALM-E101');
  const e = await post('/sap/master-data', { batchId: 'X', type: 'COMPANY', chunkNo: 1, records: Array(5001).fill({}) });
  assert.equal(e.body.code, 'ALM-E106');
});

test('IF-AA-01: 새로 만들기·태그로 연결·변경 이력·비활성·E104 → MD-01 후 자동 재처리', { skip }, async () => {
  const r = await post('/sap/assets:upsert', { batchId: 'AA-1', records: [
    asset('100001', { location: 'R1' }),
    asset('100002', { inventoryNo: 'BSG-0001', serialNo: 'SN-SAP' }),
    asset('100003', { costCenter: 'CC300' }),
    asset('100004', { companyCode: '2000' }),
  ] });
  assert.equal(r.status, 207);
  assert.deepEqual(r.body.results.map((x: { key: string; code: string }) => [x.key, x.code]),
    [['1000/100003/0000', 'ALM-E104'], ['2000/100004/0000', 'ALM-E401']]);

  const rows = await q(`SELECT a.asset_tag, a.sap_asset_no, a.serial_no, a.source, a.status, a.is_capitalized, c.category_code
    FROM asset a JOIN category c ON c.id = a.category_id ORDER BY a.asset_tag`);
  assert.deepEqual(rows, [
    { asset_tag: 'BSG-0001', sap_asset_no: '100002', serial_no: 'SN-ALM-1', source: 'MANUAL', status: 'IN_USE', is_capitalized: true, category_code: 'NB' },
    { asset_tag: 'S100001', sap_asset_no: '100001', serial_no: null, source: 'SAP', status: 'IN_USE', is_capitalized: true, category_code: 'SAP-UNCLASSIFIED' },
  ], 'ALM 기준 필드(시리얼)는 덮지 않음');

  // 같은 값 → SKIPPED, 비활성일 → RETIRED + 이벤트
  const s = await post('/sap/assets:upsert', { batchId: 'AA-2', records: [asset('100001'), asset('100002', { deactDate: '2026-10-01', inventoryNo: 'BSG-0001' })] });
  assert.deepEqual(s.body.results, [{ key: '1000/100001/0000', status: 'SKIPPED' }]);
  assert.equal((await q(`SELECT status FROM asset WHERE asset_tag = 'BSG-0001'`))[0].status, 'RETIRED');
  assert.deepEqual((await q(`SELECT e.event_type FROM asset_event e JOIN asset a ON a.id = e.asset_id WHERE a.asset_tag = 'BSG-0001' ORDER BY e.created_at, e.event_type`))
    .map((e) => e.event_type), ['SAP_SYNCED', 'SAP_SYNCED', 'RETIRED']);

  // 사이트가 없는 SAP 자산: 룸이 없어도 site.sap_location이 같은 사이트로 채운다(ALM에서 정한 사이트는 덮지 않음)
  await q(`INSERT INTO site (id, tenant_id, site_code, name, sap_location) VALUES (gen_random_uuid(), $1, 'SAV', 'Savannah', 'R1')`, [tenantId]);
  const loc = await post('/sap/assets:upsert', { batchId: 'AA-3', records: [asset('100001', { location: 'R1' })] });
  assert.deepEqual(loc.body.results, []);
  assert.equal((await q(`SELECT s.site_code FROM asset a JOIN site s ON s.id = a.site_id WHERE a.asset_tag = 'S100001'`))[0].site_code, 'SAV');
  assert.deepEqual((await post('/sap/assets:upsert', { batchId: 'AA-4', records: [asset('100001', { location: 'R1' })] })).body.results,
    [{ key: '1000/100001/0000', status: 'SKIPPED' }], '사이트가 있으면 다시 바꾸지 않음');

  // 코스트센터가 들어오면 E104 건 자동 재처리(한 번만)
  await md('COST_CENTER', [{ controllingArea: 'A000', costCenter: 'CC100', name: 'IT Ops', companyCode: '1000', profitCenter: 'PC1' },
    { controllingArea: 'A000', costCenter: 'CC300', name: 'Plant', companyCode: '1000' }]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM asset WHERE sap_asset_no = '100003'`))[0].n, 1, '재처리로 생성');
  const retry = await q(`SELECT r.batch_id, m.result FROM sap_if_run r JOIN sap_if_message m ON m.run_id = r.id WHERE r.batch_id LIKE 'RETRY-%'`);
  assert.deepEqual(retry.map((x) => x.result), ['RETRIED']);
  await md('COST_CENTER', [{ controllingArea: 'A000', costCenter: 'CC100', name: 'IT Ops', companyCode: '1000', profitCenter: 'PC1' },
    { controllingArea: 'A000', costCenter: 'CC300', name: 'Plant', companyCode: '1000' }]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM sap_if_run WHERE batch_id LIKE 'RETRY-%'`))[0].n, 1, '다시 재처리하지 않음');
});

test('IF-AA-02: 금액 업서트, 없는 자산 E201, 마감 기간 잠금', { skip }, async () => {
  const v = (no: string, o: Record<string, unknown> = {}) => ({ companyCode: '1000', assetNo: no, subNo: '0000', fiscalYear: 2026, period: 9, depArea: '01',
    acquisitionValue: 1500, accumDepreciation: 375.556, netBookValue: 1124.444, usefulLifeYears: 3, ...o });
  const a = await post('/sap/asset-values', { batchId: 'AV-1', records: [v('100001'), v('999999')] });
  assert.equal(a.status, 207);
  assert.deepEqual(a.body.results.map((x: { code: string }) => x.code), ['ALM-E201']);
  assert.deepEqual(await q(`SELECT accum_depreciation::text AS d, is_closed FROM asset_value`), [{ d: '375.56', is_closed: false }]);
  assert.equal((await post('/sap/asset-values', { batchId: 'AV-2', records: [v('100001')] })).body.results[0].status, 'SKIPPED', '같은 값');
  await post('/sap/asset-values', { batchId: 'AV-3', isClosing: true, records: [v('100001', { accumDepreciation: 400, netBookValue: 1100 })] });
  const daily = await post('/sap/asset-values', { batchId: 'AV-4', records: [v('100001', { accumDepreciation: 410, netBookValue: 1090 })] });
  assert.deepEqual(daily.body.results, [{ key: '1000/100001/0000/2026/9', status: 'SKIPPED', message: '마감된 기간(마감 실행 값 유지)' }]);
  assert.deepEqual(await q(`SELECT accum_depreciation::text AS d, is_closed FROM asset_value`), [{ d: '400.00', is_closed: true }]);
});

test('IF-AA-02: 취득 출처(PO·AuC) 교체 저장, 같으면 SKIPPED, 키 없으면 유지, 오류 검증', { skip }, async () => {
  const v = (o: Record<string, unknown> = {}) => ({ companyCode: '1000', assetNo: '100001', subNo: '0000', fiscalYear: 2026, period: 10, depArea: '01',
    acquisitionValue: 900, accumDepreciation: 0, netBookValue: 900, ...o });
  const direct = { sourceType: 'DIRECT', poNo: '4500000001', poItem: '00010', vendorCode: 'V100', vendorName: 'Dell', poDate: '2026-09-01' };
  const auc = { sourceType: 'AUC', aucAssetNo: '000900000001', aucSubNo: '0000', poNo: '4500000002', poItem: '00020', vendorName: 'Cisco' };
  const rows = () => q(`SELECT source_type, po_no, po_item, auc_asset_no, vendor_name FROM asset_origin ORDER BY source_type, po_no`);
  const a = await post('/sap/asset-values', { batchId: 'OR-1', records: [v({ origins: [direct, auc] })] });
  assert.equal(a.status, 200);
  assert.equal((await rows()).length, 2);
  assert.equal((await post('/sap/asset-values', { batchId: 'OR-2', records: [v({ origins: [direct, auc] })] })).body.results[0].status, 'SKIPPED', '같은 출처·같은 값');
  assert.equal((await post('/sap/asset-values', { batchId: 'OR-3', records: [v()] })).body.results[0].status, 'SKIPPED');
  assert.equal((await rows()).length, 2, 'origins 키가 없으면 유지');
  await post('/sap/asset-values', { batchId: 'OR-4', records: [v({ origins: [direct] })] });
  assert.deepEqual(await rows(), [{ source_type: 'DIRECT', po_no: '4500000001', po_item: '00010', auc_asset_no: '', vendor_name: 'Dell' }]);
  await post('/sap/asset-values', { batchId: 'OR-5', records: [v({ origins: [{ ...direct, vendorName: 'Dell Inc' }] })] });
  assert.equal((await rows())[0].vendor_name, 'Dell Inc');
  const bad = await post('/sap/asset-values', { batchId: 'OR-6', records: [v({ origins: [{ sourceType: 'AUC' }] }), v({ assetNo: '100001', period: 11, origins: [{ sourceType: 'X' }] })] });
  assert.deepEqual(bad.body.results.map((x: { code: string }) => x.code), ['ALM-E101', 'ALM-E100']);
  await post('/sap/asset-values', { batchId: 'OR-7', records: [v({ origins: [] })] });
  assert.equal((await rows()).length, 0, '빈 배열이면 비움');
});
