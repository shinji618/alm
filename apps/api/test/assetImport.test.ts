// 자산 일괄 업로드(ADM-060) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
const dbName = `alm_import_${Date.now()}`;
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
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-IMP_${who}:web`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await raw(who, method, path, body);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

import { buildXlsx } from '../src/common/xlsx';
import { readXlsx, readCsv } from '../src/common/xlsxRead';

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'IMP', name: 'Import', idpType: 'OIDC' }, domains: ['imp.test'],
    users: [{ email: 'am@imp.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'atl@imp.test', displayName: 'ATL Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'ac@imp.test', displayName: 'Accountant', roles: ['ASSET_ACCOUNTANT'] },
            { email: 'kim@imp.test', displayName: 'Kim', roles: [] }] })).tenantId;
  for (const u of ['am', 'atl', 'ac', 'kim']) await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2`, [u, `${u}@imp.test`]);
  const q = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0]?.id as string;
  ids.co = await q(`INSERT INTO company (id, tenant_id, company_code, name, sap_enabled) VALUES (gen_random_uuid(), $1, '1000', 'BSG', true) RETURNING id`, [tenantId]);
  ids.s1 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]);
  ids.s2 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'NYC', 'New York') RETURNING id`, [tenantId]);
  await owner.query(`UPDATE user_role SET site_id = $1 WHERE user_id = (SELECT id FROM app_user WHERE email = 'atl@imp.test')`, [ids.s1]);
  ids.r1 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-101', 'Office 101', 'RM-1') RETURNING id`, [tenantId, ids.s1]);
  ids.r2 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-102', 'Office 102', 'RM-2') RETURNING id`, [tenantId, ids.s1]);
  ids.r3 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'NYC-201', 'NY', 'RM-3') RETURNING id`, [tenantId, ids.s2]);
  ids.cc = await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [tenantId, ids.co]);
  ids.nb = await q(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`, [tenantId]);
  ids.m1 = await q(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name, part_no) VALUES (gen_random_uuid(), $1, $2, 'Dell', 'Latitude 7440', 'LAT7440') RETURNING id`, [tenantId, ids.nb]);
  ids.m2 = await q(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name) VALUES (gen_random_uuid(), $1, $2, 'Lenovo', 'T14') RETURNING id`, [tenantId, ids.nb]);
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

const HEAD = ['assetTag', 'description', 'categoryCode', 'model', 'serialNo', 'companyCode', 'roomCode', 'costCenterCode', 'status', 'assignedUserEmail', 'purchaseDate', 'purchaseCost', 'warrantyEndDate', 'notes', 'printLabel'];
const file = (rows: (string | number | null)[][]) => ({ fileName: 'assets.xlsx',
  contentBase64: buildXlsx([{ name: 'Assets', rows: [HEAD, ...rows] }]).toString('base64') });

test('xlsx·CSV 읽기: 공유 문자열·빈 칸·따옴표·구분자', () => {
  const x = readXlsx(buildXlsx([{ name: 'Other', rows: [['a']] }, { name: 'Assets', rows: [['h1', 'h2', 'h3'], ['x', null, 3.5]] }]), 'Assets');
  assert.deepEqual(x.rows, [['h1', 'h2', 'h3'], ['x', '', '3.5']]);
  assert.deepEqual(readCsv('\uFEFFa;b\n"x;1";"he said ""hi"""\r\n').rows, [['a', 'b'], ['x;1', 'he said "hi"']]);
});

test('일괄 업로드: 미리보기는 아무것도 바꾸지 않고, 적용은 오류 없는 행만', { skip }, async () => {
  assert.equal((await call('ac', 'POST', '/admin/asset-import:preview', file([]))).status, 403, 'asset.write 필요');
  const rows = [
    [null, 'New laptop', 'NB', 'LAT7440', 'SN-9', '1000', 'ATL-102', 'CC100', 'IN_USE', 'kim@imp.test', '2026-10-01', '1,200', 46000, 'from upload', 'Y'],  // 2: 신규 자동 채번, 날짜 일련번호
    ['LEGACY-77', 'Kept tag', 'NB', 'Lenovo T14', null, '1000', 'ATL-101', 'CC100', null, null, '10/05/2026', null, null, null, null],                   // 3: 적힌 태그로 신규
    ['at-000001', 'Renamed', null, 'T14', 'SN-1', '9999', 'ATL-102', null, null, null, null, null, '2027-12-31', null, null],                          // 4: 수정(회사 무시 경고)
    [null, 'Broken', 'XX', 'LAT7440', null, '1000', 'NOPE', 'CC100', 'BROKEN', null, 'yesterday', 'abc', null, null, null],                          // 5: 오류 여러 개
    ['AT-000001', 'Again', null, null, null, null, null, null, null, null, null, null, null, null, null],                                            // 6: 중복 태그
    ['AT-000002', 'NY laptop', null, null, null, null, null, null, null, null, null, null, null, null, null],                                        // 7: 변경 없음
  ];
  const pv = await call('am', 'POST', '/admin/asset-import:preview', file(rows));
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.deepEqual(pv.body.summary, { rows: 6, create: 2, update: 1, unchanged: 1, errors: 2, warnings: 1 });
  const r = (n: number) => pv.body.rows.find((x: { rowNo: number }) => x.rowNo === n);
  assert.deepEqual([r(2).action, r(2).status], ['CREATE', 'OK']);
  assert.deepEqual([r(3).action, r(3).assetTag], ['CREATE', 'LEGACY-77']);
  assert.deepEqual([r(4).action, r(4).status, r(4).changes], ['UPDATE', 'WARN', ['description', 'serialNo', 'warrantyEndDate', 'model', 'roomCode']]);
  assert.equal(r(4).warnings[0].code, 'IGNORED_ON_UPDATE');
  assert.deepEqual(r(5).errors.map((e: { code: string }) => e.code).sort(), ['BAD_DATE', 'BAD_NUMBER', 'BAD_STATUS', 'UNKNOWN_CATEGORY', 'UNKNOWN_ROOM']);
  assert.equal(r(6).errors[0].code, 'DUPLICATE_TAG');
  assert.equal(r(7).action, 'UNCHANGED');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset`)).rows[0].n, 2, '미리보기는 바꾸지 않음');
  assert.equal((await owner.query(`SELECT description FROM asset WHERE id = $1`, [ids.a1])).rows[0].description, 'Old name');

  const ap = await call('am', 'POST', '/admin/asset-import:apply', file(rows));
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.applied, true);
  const created = ap.body.rows.find((x: { rowNo: number }) => x.rowNo === 2);
  assert.match(created.assetTag, /^AT-\d{6}$/);
  const a = (await owner.query(`SELECT a.*, r.room_code, u.email FROM asset a JOIN room r ON r.id = a.room_id LEFT JOIN app_user u ON u.id = a.assigned_user_id WHERE a.asset_tag = $1`, [created.assetTag])).rows[0];
  assert.deepEqual([a.status, a.email, a.room_code, a.serial_no, Number(a.purchase_cost), a.warranty_end_date.toISOString().slice(0, 10)],
    ['IN_USE', 'kim@imp.test', 'ATL-102', 'SN-9', 1200, '2025-12-09']);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM label_print_job WHERE asset_id = $1`, [a.id])).rows[0].n, 1, 'printLabel=Y');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset_request WHERE asset_id = $1`, [a.id])).rows[0].n, 0, 'SAP 요청 없음');
  const kept = (await owner.query(`SELECT a.purchase_date, e.changes FROM asset a JOIN asset_event e ON e.asset_id = a.id AND e.event_type = 'CREATED' WHERE a.asset_tag = 'LEGACY-77'`)).rows[0];
  assert.equal(kept.changes.assetTag, 'LEGACY-77');
  assert.equal(kept.purchase_date.toISOString().slice(0, 10), '2026-10-05', 'MM/DD/YYYY');
  const u = (await owner.query(`SELECT a.description, a.serial_no, m.model_name, r.room_code FROM asset a JOIN model m ON m.id = a.model_id JOIN room r ON r.id = a.room_id WHERE a.id = $1`, [ids.a1])).rows[0];
  assert.deepEqual(u, { description: 'Renamed', serial_no: 'SN-1', model_name: 'T14', room_code: 'ATL-102' });
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM asset`)).rows[0].n, 4, '오류 행은 건너뜀');
});

test('일괄 업로드: 사이트 범위·CSV·템플릿(현재 자산 포함)', { skip }, async () => {
  const csv = 'assetTag,description,categoryCode,model,companyCode,roomCode,costCenterCode\nAT-000002,Rename NY,,,,,\n,New NY,NB,LAT7440,1000,NYC-201,CC100\n';
  const pv = await call('atl', 'POST', '/admin/asset-import:preview', { fileName: 'a.csv', contentBase64: Buffer.from(csv).toString('base64') });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.rows[0].errors[0].code, 'OUT_OF_SCOPE', 'ATL 관리자는 NYC 자산 수정 불가');
  assert.equal(pv.body.rows[1].errors[0].code, 'ALM-E401', 'NYC 룸에 등록 불가');
  assert.equal((await call('am', 'POST', '/admin/asset-import:preview', { fileName: 'x.xlsx', contentBase64: Buffer.from('hello').toString('base64') })).status, 400);
  const t = await raw('am', 'GET', '/admin/asset-import/template?withAssets=true');
  assert.equal(t.status, 200);
  const sheet = readXlsx(Buffer.from(await t.arrayBuffer()), 'Assets');
  assert.deepEqual(sheet.rows[0].slice(0, 3), ['assetTag', 'description', 'categoryCode']);
  assert.ok(sheet.rows.some((r) => r[0] === 'LEGACY-77'));
  const codes = readXlsx(Buffer.from(await (await raw('am', 'GET', '/admin/asset-import/template')).arrayBuffer()), 'Codes');
  assert.ok(codes.rows.some((r) => r[0] === 'Model' && r[1] === 'LAT7440'));
});
