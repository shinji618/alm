// 실사 캠페인(ALM-240, 4.4)·PDA 실사 API(4.8) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만. S3는 흉내 낸다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
const dbName = `alm_counts_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
const ids: Record<string, string> = {};
let wlIds: string[] = [];
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)], filesScanRequired: false,
};
const fakeCognito = {
  verifyAccess: async (t: string) => { const [, u, c] = t.split(':'); if (!u) throw new Error('bad'); return { sub: 's', username: u, client_id: c, token_use: 'access', exp: 0 }; },
};
const files: FileStore = {
  presignPut: async (key, o) => ({ url: `https://s3.test/${key}`, headers: { 'Content-Type': o.contentType, 'x-amz-checksum-sha256': o.sha256b64 } }),
  presignGet: async (key) => `https://s3.test/${key}?get`,
  head: async () => null, scanStatus: async () => undefined, remove: async () => undefined,
};
const DEV = { 'x-device-id': 'TC58-9' };

async function call(who: string, method: string, path: string, body?: unknown, client = 'web', extra: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-CNT_${who}:${client}`, 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const pda = (who: string, method: string, path: string, body?: unknown) => call(who, method, path, body, 'pda', DEV);

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'CNT', name: 'Counts', idpType: 'OIDC' }, domains: ['cnt.test'],
    users: [{ email: 'am@cnt.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'], locale: 'en' },
            { email: 'ac@cnt.test', displayName: 'Accountant', roles: ['ASSET_ACCOUNTANT'] },
            { email: 'c1@cnt.test', displayName: 'Counter One', roles: ['COUNTER'], locale: 'ko' },
            { email: 'c2@cnt.test', displayName: 'Counter Two', roles: ['COUNTER'] },
            { email: 'emp@cnt.test', displayName: 'Employee', roles: [] }] })).tenantId;
  for (const u of ['am', 'ac', 'c1', 'c2', 'emp']) ids[u] = (await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@cnt.test`])).rows[0].id;
  const q = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0]?.id as string;
  ids.co = await q(`INSERT INTO company (id, tenant_id, company_code, name, sap_enabled) VALUES (gen_random_uuid(), $1, '1000', 'BSG', true) RETURNING id`, [tenantId]);
  ids.s1 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [tenantId]);
  ids.s2 = await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'NYC', 'New York') RETURNING id`, [tenantId]);
  ids.r1 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-101', 'Office 101', 'RM-ATL-101') RETURNING id`, [tenantId, ids.s1]);
  ids.r2 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'ATL-102', 'Office 102', 'RM-ATL-102') RETURNING id`, [tenantId, ids.s1]);
  ids.r3 = await q(`INSERT INTO room (id, tenant_id, site_id, room_code, name, barcode) VALUES (gen_random_uuid(), $1, $2, 'NYC-201', 'NY Office', 'RM-NYC-201') RETURNING id`, [tenantId, ids.s2]);
  ids.cat = await q(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`, [tenantId]);
  await owner.query(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, zpl, is_default) VALUES (gen_random_uuid(), $1, 'STD', 'Standard', 'QR_CODE128', '^XA^XZ', true)`, [tenantId]);
  const asset = (tag: string, room: string, site: string, extra = '', vals: unknown[] = []) => q(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id, site_id, room_id${extra ? `, ${extra}` : ''})
    VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MANUAL', $5, $6, $7${vals.map((_, i) => `, $${8 + i}`).join('')}) RETURNING id`, [tenantId, tag, `Laptop ${tag}`, ids.cat, ids.co, site, room, ...vals]);
  ids.a1 = await asset('AT-000001', ids.r1, ids.s1, 'sap_asset_no, sap_sub_no, is_capitalized', ['1000001', '0', true]);
  ids.a2 = await asset('AT-000002', ids.r1, ids.s1);
  ids.a3 = await asset('AT-000003', ids.r2, ids.s1, 'status, status_before_missing', ['MISSING', 'IN_USE']);
  ids.a4 = await asset('AT-000004', ids.r2, ids.s1);
  ids.a5 = await asset('AT-000005', ids.r1, ids.s1, 'status', ['RETIRED']);
  ids.a6 = await asset('AT-000006', ids.r3, ids.s2);
  await owner.query(`INSERT INTO pda_device (id, tenant_id, device_serial, is_active) VALUES (gen_random_uuid(), $1, 'TC58-9', true)`, [tenantId]);
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

const scan = (o: Record<string, unknown>) => ({ clientScanId: randomUUID(), campaignId: ids.camp, inputMethod: 'TRIGGER', deviceResult: 'FOUND',
  scannedAt: new Date().toISOString(), ...o });

test('캠페인: 생성·검증·범위 미리보기·룸 배정(E316)·시작·권한', { skip }, async () => {
  const body = { campaignCode: 'pi26q4', name: 'Q4 2026 physical count', companyId: ids.co, keyDate: '2026-10-15', dueDate: '2026-10-31', scope: { siteIds: [ids.s1] } };
  assert.equal((await call('emp', 'POST', '/count-campaigns', body)).status, 403);
  const bad = await call('am', 'POST', '/count-campaigns', { ...body, dueDate: '2026-10-01', scope: { siteIds: [] } });
  assert.equal(bad.status, 400);
  const r = await call('am', 'POST', '/count-campaigns', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.campaign.campaignCode, 'PI26Q4');
  assert.equal(r.body.status, 'SCOPING');
  ids.camp = r.body.id;
  assert.equal((await call('am', 'POST', '/count-campaigns', body)).status, 409, '코드 중복');

  const pv = await call('am', 'POST', `/count-campaigns/${ids.camp}:preview-scope`);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.total, 4, 'RETIRED·다른 사이트 제외');
  const tasks = await call('am', 'GET', `/count-campaigns/${ids.camp}/tasks`);
  assert.deepEqual(tasks.body.rooms.map((x: { roomCode: string }) => x.roomCode), ['ATL-101', 'ATL-102']);
  const [t1, t2] = tasks.body.rooms;
  ids.t1 = t1.taskId; ids.t2 = t2.taskId;

  const st = await call('am', 'POST', `/count-campaigns/${ids.camp}:start`);
  assert.equal(st.status, 422); assert.equal(st.body.code, 'ALM-E316');
  assert.equal((await call('am', 'PATCH', `/count-tasks/${ids.t1}`, { assigneeId: ids.emp })).status, 400, 'COUNTER 아님');
  assert.equal((await call('am', 'PATCH', `/count-tasks/${ids.t1}`, { assigneeId: ids.c1 })).body.assigneeName, 'Counter One');
  await call('am', 'PATCH', `/count-tasks/${ids.t2}`, { assigneeId: ids.c2 });

  const g = await call('am', 'GET', `/count-campaigns/${ids.camp}`);
  assert.equal(g.headers.get('etag'), `"${g.body.version}"`);
  assert.equal((await call('am', 'PATCH', `/count-campaigns/${ids.camp}`, { name: 'Q4 count' }, 'web', { 'if-match': '"999"' })).status, 409);
  assert.equal((await call('am', 'PATCH', `/count-campaigns/${ids.camp}`, { name: 'Q4 count' }, 'web', { 'if-match': g.headers.get('etag')! })).body.campaign.name, 'Q4 count');

  const s2 = await call('am', 'POST', `/count-campaigns/${ids.camp}:start`);
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(s2.body.status, 'COUNTING');
  assert.equal(s2.body.progress.total, 4);
  assert.equal(s2.body.progress.pending, 4);
});

test('PDA: 내 작업·작업목록(델타·410)·룸·코드·색인', { skip }, async () => {
  assert.equal((await call('am', 'GET', '/pda/tasks', undefined, 'pda', DEV)).status, 403, 'COUNTER만');
  const tl = await pda('c1', 'GET', '/pda/tasks');
  assert.equal(tl.status, 200);
  assert.equal(tl.body.items.length, 1);
  assert.equal(tl.body.items[0].roomCode, 'ATL-101');
  assert.equal(tl.body.items[0].pendingCount, 2);

  const wl = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist`);
  assert.equal(wl.status, 200);
  assert.deepEqual(wl.body.items.map((x: { assetTag: string }) => x.assetTag).sort(), ['AT-000001', 'AT-000002']);
  assert.ok(wl.body.syncToken);
  const page = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist?limit=1`);
  assert.equal(page.body.items.length, 1); assert.ok(page.body.nextCursor);
  const p2 = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist?limit=1&cursor=${page.body.nextCursor}`);
  assert.equal(p2.body.items.length, 1); assert.equal(p2.body.nextCursor, undefined);
  assert.notEqual(p2.body.items[0].countItemId, page.body.items[0].countItemId);
  // 델타: 바뀐 것이 없으면 빈 목록
  const d = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist?since=${wl.body.syncToken}`);
  assert.equal(d.body.items.length, 0); assert.deepEqual(d.body.removed, []);
  const old = Buffer.from(JSON.stringify({ c: ids.camp, k: 'W', t: new Date(Date.now() - 8 * 86400_000).toISOString() })).toString('base64url');
  const gone = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist?since=${old}`);
  assert.equal(gone.status, 410); assert.equal(gone.body.code, 'ALM-E309');
  ids.token = wl.body.syncToken;
  wlIds = wl.body.items.map((x: { countItemId: string }) => x.countItemId);

  const rooms = await pda('c1', 'GET', `/pda/rooms?campaignId=${ids.camp}`);
  assert.deepEqual(rooms.body.items.map((x: { roomCode: string }) => x.roomCode), ['ATL-101', 'ATL-102']);
  const codes = await pda('c1', 'GET', '/pda/codes');
  assert.deepEqual(codes.body.conditions.map((x: { label: string }) => x.label), ['정상', '파손', '미사용']);
  assert.equal(codes.body.categories[0].label, 'Notebook');
  const ti = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/tag-index`);
  assert.deepEqual(ti.body.items.map((x: { assetTag: string }) => x.assetTag), ['AT-000005', 'AT-000006']);
  assert.equal((await pda('emp', 'GET', `/pda/campaigns/${ids.camp}/worklist`)).status, 403);
});

test('PDA-09 자산 조회: 실사 대상은 상세, 범위 밖은 태그·상태·사이트만, 없는 태그 404', { skip }, async () => {
  await owner.query(`UPDATE asset SET serial_no = 'SN-1', warranty_end_date = '2027-01-31', assigned_user_id = $2 WHERE id = $1`, [ids.a1, ids.emp]);
  await owner.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, actor_id) VALUES (gen_random_uuid(), $1, $2, 'ASSIGNED', 'UI', $3)`, [tenantId, ids.a1, ids.am]);
  const a = await pda('c1', 'GET', '/pda/assets/at-000001');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.assetTag, a.body.limited, a.body.description, a.body.serialNo, a.body.siteCode, a.body.roomCode, a.body.assignedUserName, a.body.sapAssetNo, a.body.warrantyEndDate],
    ['AT-000001', false, 'Laptop AT-000001', 'SN-1', 'ATL', 'ATL-101', 'Employee', '1000001', '2027-01-31']);
  assert.deepEqual(a.body.count, { campaignCode: 'PI26Q4', expectedRoomCode: 'ATL-101', result: 'PENDING' });
  assert.equal(a.body.acquisitionValue, undefined, '실사자는 금액 없음');
  assert.deepEqual(a.body.events.map((e: { eventType: string; actorName: string }) => [e.eventType, e.actorName]), [['ASSIGNED', 'Asset Mgr']]);
  const other = await pda('c1', 'GET', '/pda/assets/AT-000003');
  assert.equal(other.body.limited, false, '같은 캠페인의 다른 룸 자산도 상세');
  const nyc = await pda('c1', 'GET', '/pda/assets/AT-000006');
  assert.deepEqual(nyc.body, { assetTag: 'AT-000006', status: 'IN_STOCK', siteCode: 'NYC', limited: true });
  const none = await pda('c1', 'GET', '/pda/assets/NOPE-1');
  assert.deepEqual([none.status, none.body.code], [404, 'ALM-E404']);
  assert.equal((await call('am', 'GET', '/pda/assets/AT-000001', undefined, 'pda', DEV)).status, 403, 'COUNTER만');
});

test('PDA 스캔: 서버 판정 6종·멱등·MISSING 복원·라벨 재출력·사진 연결·범위·작업 완료(E305)', { skip }, async () => {
  const st = await pda('c1', 'PATCH', `/pda/tasks/${ids.t1}`, { action: 'START', at: new Date().toISOString() });
  assert.equal(st.status, 200); assert.equal(st.body.status, 'IN_PROGRESS');
  assert.equal((await pda('c1', 'PATCH', `/pda/tasks/${ids.t2}`, { action: 'START', at: new Date().toISOString() })).status, 403, '남의 룸');

  const photo = await pda('c1', 'POST', '/pda/attachments:presign', { fileName: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100,
    sha256: createHash('sha256').update('x').digest('hex'), kind: 'PHOTO' });
  assert.equal(photo.status, 200, JSON.stringify(photo.body));
  const t = (o: Record<string, unknown>) => scan({ taskId: ids.t1, roomId: ids.r1, ...o });
  const dupId = randomUUID();
  const batch = [
    t({ barcode: 'AT-000001', condition: 'DAMAGED', attachmentIds: [photo.body.attachmentId], needsRelabel: true }),
    t({ barcode: 'at-000003', clientScanId: dupId }),          // 다른 룸 자산 + MISSING
    t({ barcode: 'AT-000005' }), t({ barcode: 'AT-000006' }), t({ barcode: 'ZZ-UNKNOWN' }),
    t({ barcode: 'AT-000001' }),
    t({ barcode: 'AT-000002', taskId: ids.t2 }),               // 남의 작업
  ];
  const r = await pda('c1', 'POST', '/pda/scans:batch', { deviceId: randomUUID(), scans: batch });
  assert.equal(r.status, 207, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x: { status: string; serverResult?: string; code?: string }) => x.serverResult ?? x.code),
    ['FOUND', 'MISPLACED', 'RETIRED_ASSET', 'OUT_OF_SCOPE', 'UNREGISTERED', 'DUPLICATE', 'ALM-E203']);
  const again = await pda('c1', 'POST', '/pda/scans:batch', { deviceId: randomUUID(), scans: [t({ barcode: 'at-000003', clientScanId: dupId })] });
  assert.equal(again.status, 200);
  assert.equal(again.body.results[0].status, 'DUPLICATE'); assert.equal(again.body.results[0].serverResult, 'MISPLACED');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM count_scan WHERE client_scan_id = $1`, [dupId])).rows[0].n, 1);

  assert.equal((await owner.query('SELECT status FROM asset WHERE id = $1', [ids.a3])).rows[0].status, 'IN_USE', 'MISSING 복원');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM label_print_job WHERE asset_id = $1 AND source = 'PDA_REQUEST'`, [ids.a1])).rows[0].n, 1);
  assert.ok((await owner.query('SELECT linked_at FROM attachment WHERE id = $1', [photo.body.attachmentId])).rows[0].linked_at, '사진 연결');
  const att = await call('am', 'GET', `/assets/${ids.a1}/attachments`);
  assert.equal(att.body.items[0].source, 'COUNT');

  // 작업 완료: AT-000002가 남음 → E305, force면 완료. 완료 뒤 스캔하면 다시 진행 중
  const cp = await pda('c1', 'PATCH', `/pda/tasks/${ids.t1}`, { action: 'COMPLETE', at: new Date().toISOString() });
  assert.equal(cp.status, 409); assert.equal(cp.body.code, 'ALM-E305');
  assert.equal((await pda('c1', 'PATCH', `/pda/tasks/${ids.t1}`, { action: 'COMPLETE', at: new Date().toISOString(), force: true })).body.status, 'COMPLETED');
  await pda('c1', 'POST', '/pda/scans:batch', { deviceId: randomUUID(), scans: [t({ barcode: 'AT-000002' })] });
  assert.equal((await owner.query('SELECT status FROM count_task WHERE id = $1', [ids.t1])).rows[0].status, 'IN_PROGRESS');

  // 델타: 바뀐 대상만, 담당이 바뀐 룸의 대상은 removed
  await call('am', 'PATCH', `/count-tasks/${ids.t1}`, { assigneeId: ids.c2 });
  const d = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist?since=${ids.token}`);
  assert.equal(d.body.items.length, 0);
  const mine = wlIds;   // 담당이 바뀐 룸의 대상은 모두 removed(다른 룸의 id가 섞여도 기기는 모르는 id를 무시)
  assert.ok(mine.every((x) => d.body.removed.includes(x)), JSON.stringify(d.body.removed));
  await call('am', 'PATCH', `/count-tasks/${ids.t1}`, { assigneeId: ids.c1 });
  const d2 = await pda('c1', 'GET', `/pda/campaigns/${ids.camp}/worklist?since=${ids.token}`);
  assert.equal(d2.body.items.length, 2);
});

test('PDA 미등록: 사진 필수(E110)·UNREG 채번·멱등', { skip }, async () => {
  const item = (o: Record<string, unknown> = {}) => ({ clientScanId: randomUUID(), campaignId: ids.camp, roomId: ids.r2, provisionalNo: 'TC58-0001',
    description: 'Unknown monitor', categoryId: ids.cat, serialNo: 'SN1', attachmentIds: [], reportedAt: new Date().toISOString(), ...o });
  const ph = await pda('c2', 'POST', '/pda/attachments:presign', { ownerType: 'count_unregistered', fileName: 'm.jpg', contentType: 'image/jpeg', sizeBytes: 100,
    sha256: createHash('sha256').update('y').digest('hex'), kind: 'PHOTO' });
  const ok = item({ attachmentIds: [ph.body.attachmentId] });
  const r = await pda('c2', 'POST', '/pda/unregistered:batch', { deviceId: randomUUID(), items: [item(), ok] });
  assert.equal(r.status, 207, JSON.stringify(r.body));
  assert.equal(r.body.results[0].code, 'ALM-E110');
  assert.equal(r.body.results[1].tempNo, 'UNREG-0001');
  const again = await pda('c2', 'POST', '/pda/unregistered:batch', { deviceId: randomUUID(), items: [ok] });
  assert.deepEqual(again.body.results[0], { clientScanId: ok.clientScanId, status: 'DUPLICATE', tempNo: 'UNREG-0001' });
  const list = await call('am', 'GET', `/count-campaigns/${ids.camp}/unregistered`);
  assert.equal(list.body.items[0].photoCount, 1);
  ids.unreg = list.body.items[0].id;
});

test('차이 검토·전기·종료: 실사 종료 → 차이 처리(재실사 포함) → E317 → 전기(SAP COUNT_RESULT) → 종료', { skip }, async () => {
  const cc = await call('am', 'POST', `/count-campaigns/${ids.camp}:close-counting`);
  assert.equal(cc.status, 200); assert.equal(cc.body.status, 'REVIEW');
  assert.equal(cc.body.progress.notFound, 1, 'AT-000004');
  const scanLate = await pda('c2', 'POST', '/pda/scans:batch', { deviceId: randomUUID(), scans: [scan({ taskId: ids.t2, roomId: ids.r2, barcode: 'AT-000002' })] });
  assert.equal(scanLate.body.results[0].code, 'ALM-E204');

  const v = await call('am', 'GET', `/count-campaigns/${ids.camp}/items?variance=true`);
  const byTag = Object.fromEntries(v.body.items.map((x: { assetTag: string; id: string }) => [x.assetTag, x.id]));
  assert.deepEqual(Object.keys(byTag).sort(), ['AT-000001', 'AT-000003', 'AT-000004'], '파손·위치 불일치·미발견');

  // 재실사: AT-000004를 PENDING으로 되돌리고 PDA가 다시 스캔(REVIEW 중 허용)
  const rc = await call('am', 'POST', '/count-items:resolve', { items: [{ id: byTag['AT-000004'], action: 'RECOUNT' }, { id: byTag['AT-000001'], action: 'MARK_MISSING' }] });
  assert.equal(rc.status, 207);
  assert.equal(rc.body.results[0].status, 'OK'); assert.equal(rc.body.results[1].status, 'ERROR', '파손에는 MARK_MISSING 불가');
  assert.equal((await pda('c2', 'GET', '/pda/tasks')).body.items.length, 1, '재실사 작업이 보인다');
  const rs = await pda('c2', 'POST', '/pda/scans:batch', { deviceId: randomUUID(), scans: [scan({ taskId: ids.t2, roomId: ids.r2, barcode: 'AT-000004' })] });
  assert.equal(rs.body.results[0].serverResult, 'FOUND');

  const e317 = await call('ac', 'POST', `/count-campaigns/${ids.camp}:post-results`);
  assert.equal(e317.status, 409); assert.equal(e317.body.code, 'ALM-E317');
  const ok = await call('am', 'POST', '/count-items:resolve', { items: [{ id: byTag['AT-000001'], action: 'ACCEPT' }, { id: byTag['AT-000003'], action: 'ACCEPT', note: '이동 확인' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call('am', 'POST', `/count-unregistered/${ids.unreg}:resolve`, { action: 'NON_ASSET' })).status, 200);

  assert.equal((await call('am', 'POST', `/count-campaigns/${ids.camp}:post-results`)).status, 403, '전기는 자산회계');
  const post = await call('ac', 'POST', `/count-campaigns/${ids.camp}:post-results`);
  assert.equal(post.status, 202, JSON.stringify(post.body));
  assert.equal(post.body.status, 'POSTING');
  assert.deepEqual(post.body.postings, { READY: 1 }, 'SAP 자산(AT-000001)만 전기 건');
  assert.equal((await owner.query('SELECT last_count_note FROM asset WHERE id = $1', [ids.a3])).rows[0].last_count_note, 'PI26Q4-MV');

  const cl = await call('am', 'POST', `/count-campaigns/${ids.camp}:close`);
  assert.equal(cl.status, 409, '전기 미완료');
  await owner.query(`UPDATE sap_posting SET status = 'POSTED' WHERE posting_type = 'COUNT_RESULT'`);
  const done = await call('am', 'POST', `/count-campaigns/${ids.camp}:close`);
  assert.equal(done.status, 200); assert.equal(done.body.status, 'CLOSED');
  assert.equal((await pda('c1', 'GET', '/pda/tasks')).body.items.length, 0);
});
