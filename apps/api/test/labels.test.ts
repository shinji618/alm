// 라벨 출력(ALM-250, WBS 4.5) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
const dbName = `alm_label_${Date.now()}`;
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
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-LBL_${who}:web`, 'content-type': 'application/json' },
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
  tenantId = (await seed(owner, { tenant: { code: 'LBL', name: 'Label', idpType: 'OIDC' }, domains: ['lbl.test'],
    users: [{ email: 'sa@lbl.test', displayName: 'Admin', roles: ['SYS_ADMIN'] },
            { email: 'am@lbl.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'atl@lbl.test', displayName: 'ATL Mgr', roles: ['ASSET_MANAGER'] },
            { email: 'ac@lbl.test', displayName: 'Accountant', roles: ['ASSET_ACCOUNTANT'] }] })).tenantId;
  for (const u of ['sa', 'am', 'atl', 'ac']) await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2`, [u, `${u}@lbl.test`]);
  const q = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0]?.id as string;
  ids.co = await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG America') RETURNING id`, [tenantId]);
  ids.s1 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]);
  ids.s2 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'NYC', 'New York') RETURNING id`, [tenantId]);
  await owner.query(`UPDATE user_role SET site_id = $1 WHERE user_id = (SELECT id FROM app_user WHERE email = 'atl@lbl.test')`, [ids.s1]);
  ids.room = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'R101', 'Room 101', 'RM-R101') RETURNING id`, [tenantId, ids.s1]);
  ids.cat = await q(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`, [tenantId]);
  ids.model = await q(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name) VALUES (gen_random_uuid(), $1, $2, 'Dell', 'Latitude 7440') RETURNING id`, [tenantId, ids.cat]);
  const asset = (tag: string, site: string, cols: Record<string, unknown> = {}) => {
    const ks = Object.keys(cols);
    return q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id, site_id${ks.map((k) => `, ${k}`).join('')})
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MANUAL', $5, $6${ks.map((_, i) => `, $${7 + i}`).join('')}) RETURNING id`,
    [tenantId, tag, `Laptop ${tag}`, ids.cat, ids.co, site, ...Object.values(cols)]);
  };
  ids.a1 = await asset('AT-000001', ids.s1, { sap_asset_no: '000001000000', sap_sub_no: '0000', model_id: ids.model, room_id: ids.room });
  ids.a2 = await asset('AT-000002', ids.s1);
  ids.a3 = await asset('AT-000003', ids.s2);
  ids.a4 = await asset('AT-000004', ids.s1, { status: 'RETIRED' });
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

test('라벨: 기본 템플릿 3종·템플릿·프린터 설정 권한', { skip }, async () => {
  assert.equal((await call('ac', 'GET', '/label-templates')).status, 403, '자산회계는 라벨 권한 없음');
  const t = await call('am', 'GET', '/label-templates');
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual(t.body.items.map((x: { templateCode: string }) => x.templateCode), ['STD', 'C128', 'QR']);
  assert.equal(t.body.items[0].isDefault, true);
  ids.tplStd = t.body.items[0].id;
  ids.tplQr = t.body.items.find((x: { layout: string }) => x.layout === 'QR_ONLY').id;
  assert.equal((await call('am', 'POST', '/label-templates', { templateCode: 'X', name: 'X', layout: 'QR_ONLY', zpl: '^XA^XZ' })).status, 403, '설정은 시스템 관리자');
  assert.equal((await call('sa', 'POST', '/label-templates', { templateCode: 'BAD', name: 'Bad', layout: 'QR_ONLY', zpl: 'hello' })).status, 400, '^XA…^XZ');
  const nt = await call('sa', 'POST', '/label-templates', { templateCode: 'big', name: 'Big', layout: 'QR_ONLY', zpl: '^XA^FO1,1^FD{assetTag}^FS^XZ', isDefault: true });
  assert.equal(nt.status, 201, JSON.stringify(nt.body));
  assert.equal(nt.body.templateCode, 'BIG');
  const after = (await call('am', 'GET', '/label-templates')).body.items;
  assert.deepEqual(after.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { templateCode: string }) => x.templateCode), ['BIG'], '기본은 하나');
  assert.equal((await call('sa', 'PATCH', `/label-templates/${nt.body.id}`, { isActive: false })).status, 409, '기본 템플릿은 끌 수 없음');
  assert.equal((await call('sa', 'PATCH', `/label-templates/${ids.tplStd}`, { isDefault: true })).status, 200);
  assert.equal((await call('sa', 'PATCH', `/label-templates/${nt.body.id}`, { isActive: false })).status, 200);
  assert.equal((await call('sa', 'PATCH', '/label-templates/nope', { name: 'x' })).status, 404);

  assert.equal((await call('am', 'POST', '/printers', { name: 'P1', dpi: 300 })).status, 403);
  const p1 = await call('sa', 'POST', '/printers', { name: 'ATL ZD421', siteId: ids.s1, deviceName: 'ZD421-203dpi', connection: 'USB', dpi: 300 });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.body.siteCode, 'ATL');
  ids.prn = p1.body.id;
  assert.equal((await call('sa', 'POST', '/printers', { name: 'ATL ZD421' })).status, 409);
  assert.equal((await call('am', 'GET', `/printers?siteId=${ids.s1}`)).body.items.length, 1);
  const test = await call('am', 'GET', `/printers/${ids.prn}/test-label`);
  assert.equal(test.status, 200);
  assert.match(test.body.zpl, /^\^XA\^MUd,200,300/, '203 dpi 템플릿 → 300 dpi 프린터 변환');
  assert.match(test.body.zpl, /AT-TEST01/);
});

test('라벨: 대기열 → ZPL 발급 → 출력 결과 회신 → 이력', { skip }, async () => {
  // 태그로 추가(대소문자 무시), 폐기 자산·없는 태그는 전체 거절
  assert.equal((await call('am', 'POST', '/label-jobs', { assetTags: ['AT-000004'] })).status, 400, '폐기 자산');
  assert.equal((await call('am', 'POST', '/label-jobs', { assetTags: ['NOPE'] })).status, 400);
  assert.equal((await call('am', 'POST', '/label-jobs', {})).status, 400);
  const add = await call('am', 'POST', '/label-jobs', { assetTags: ['at-000001'], assetIds: [ids.a2], copies: 2 });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.deepEqual(add.body.items.map((x: { assetTag: string; source: string; copies: number }) => [x.assetTag, x.source, x.copies]), [['AT-000001', 'BULK', 2], ['AT-000002', 'BULK', 2]]);
  const j1 = add.body.items[0];
  assert.deepEqual([j1.model, j1.sapAssetNo, j1.roomCode, j1.companyName, j1.layout], ['Dell Latitude 7440', '1000000', 'R101', 'BSG AMERICA', 'QR_CODE128']);
  // 같은 자산을 다시 넣으면 새로 만들지 않고 템플릿·매수만 바꾼다
  const again = await call('am', 'POST', '/label-jobs', { assetIds: [ids.a1], templateId: ids.tplQr });
  assert.equal(again.body.items[0].id, j1.id);
  assert.deepEqual([again.body.items[0].templateName, again.body.items[0].copies, again.body.items[0].source], ['QR only', 1, 'BULK']);
  // 사이트 범위: ATL 관리자는 NYC 자산을 넣지도, 보지도 못한다
  assert.equal((await call('atl', 'POST', '/label-jobs', { assetIds: [ids.a3] })).status, 400);
  const nyc = await call('am', 'POST', '/label-jobs', { assetIds: [ids.a3] });
  assert.equal(nyc.body.items[0].source, 'ASSET_DETAIL', '한 건이면 자산 상세 출처');
  assert.equal((await call('atl', 'GET', '/label-jobs')).body.total, 2);
  assert.equal((await call('ac', 'GET', '/label-jobs')).status, 403);
  const q = await call('am', 'GET', '/label-jobs');
  assert.equal(q.body.total, 3);
  assert.deepEqual(q.body.counts, { QUEUED: 3 });

  // ZPL 발급: 변수 치환·매수·해상도 변환, RENDERED·시도 1
  const zp = await call('am', 'GET', `/label-jobs/${j1.id}/zpl`);
  assert.match(zp.body.zpl, /\^FDMA,AT-000001\^FS/);
  const r = await call('am', 'POST', '/label-jobs:render', { jobIds: [j1.id, add.body.items[1].id], printerId: ids.prn });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.deviceName, 'ZD421-203dpi');
  assert.equal(r.body.items.length, 2);
  const z1 = r.body.items.find((x: { assetTag: string }) => x.assetTag === 'AT-000001').zpl as string;
  assert.match(z1, /\^MUd,200,300/);
  assert.match(z1, /BSG AMERICA/);
  assert.match(z1, /1000000  R101/);
  assert.match(z1, /\^PQ1\n\^XZ$/);
  assert.match(r.body.items.find((x: { assetTag: string }) => x.assetTag === 'AT-000002').zpl, /\^PQ2/);
  assert.equal((await call('atl', 'POST', '/label-jobs:render', { jobIds: [nyc.body.items[0].id], printerId: ids.prn })).status, 404, '범위 밖 작업');

  // 결과 회신: 다른 renderId는 건별 409, PRINTED → 이력, FAILED → 다시 출력 가능
  const wrong = await call('am', 'POST', '/label-jobs:report', { renderId: nyc.body.items[0].id, results: [{ jobId: j1.id, status: 'PRINTED' }] });
  assert.equal(wrong.status, 207);
  assert.equal(wrong.body.results[0].code, 'ALM-E320');
  const rep = await call('am', 'POST', '/label-jobs:report', { renderId: r.body.renderId, clientInfo: 'BrowserPrint 1.3 / ZD421',
    results: [{ jobId: j1.id, status: 'PRINTED' }, { jobId: add.body.items[1].id, status: 'FAILED', error: 'Paper out' }] });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const hist = await call('am', 'GET', '/label-jobs?status=ALL');
  const byTag = Object.fromEntries(hist.body.items.map((x: { assetTag: string }) => [x.assetTag, x]));
  assert.deepEqual([byTag['AT-000001'].status, byTag['AT-000001'].attemptCount, byTag['AT-000001'].printerName, byTag['AT-000001'].renderedByName], ['PRINTED', 1, 'ATL ZD421', 'Asset Mgr']);
  assert.deepEqual([byTag['AT-000002'].status, byTag['AT-000002'].error], ['FAILED', 'Paper out']);
  const ev = await owner.query(`SELECT changes FROM asset_event WHERE asset_id = $1 AND event_type = 'LABEL_PRINTED'`, [ids.a1]);
  assert.equal(ev.rowCount, 1);
  assert.equal(ev.rows[0].changes.printer, 'ATL ZD421');
  assert.equal((await call('am', 'POST', '/label-jobs:render', { jobIds: [j1.id], printerId: ids.prn })).status, 409, '출력 끝난 작업');
  const retry = await call('am', 'POST', '/label-jobs:render', { jobIds: [add.body.items[1].id], printerId: ids.prn });
  assert.equal(retry.status, 200, '실패 작업은 다시 출력');
  // 30분 넘게 회신이 없으면 확인 필요
  await owner.query(`UPDATE label_print_job SET rendered_at = now() - interval '31 minutes' WHERE id = $1`, [add.body.items[1].id]);
  const chk = (await call('am', 'GET', '/label-jobs')).body.items.find((x: { id: string }) => x.id === add.body.items[1].id);
  assert.deepEqual([chk.status, chk.attemptCount, chk.needsCheck], ['RENDERED', 2, true]);
  // 빼기: 대기·실패·발급만
  assert.equal((await call('am', 'POST', '/label-jobs:cancel', { jobIds: [j1.id] })).status, 409);
  const cn = await call('am', 'POST', '/label-jobs:cancel', { jobIds: [add.body.items[1].id, nyc.body.items[0].id] });
  assert.equal(cn.status, 200);
  assert.deepEqual((await call('am', 'GET', '/label-jobs')).body.total, 0);
  assert.deepEqual((await call('am', 'GET', '/label-jobs?status=ALL')).body.counts, { PRINTED: 1, CANCELLED: 2 });
});

test('라벨: 쓸 수 있는 템플릿이 없으면 기본 템플릿을 다시 켜서 쓴다(자산 등록·입고·PDA 재출력 요청)', { skip }, async () => {
  await owner.query(`UPDATE label_print_job SET template_id = (SELECT id FROM label_template WHERE template_code = 'STD')`);
  await owner.query(`DELETE FROM label_template WHERE template_code <> 'STD'`);
  await owner.query(`UPDATE label_template SET is_active = false`);
  const { defaultTemplateId } = await import('../src/labels/labels');
  const id = await app.withTx({ tenantId, actorType: 'SYSTEM' } as never, (c) => defaultTemplateId(c, tenantId));
  const t = await owner.query(`SELECT template_code, is_active FROM label_template WHERE id = $1`, [id]);
  assert.deepEqual(t.rows[0], { template_code: 'STD', is_active: true }, '없으면 기본 템플릿을 다시 쓴다');
});
