// 첨부 URL·메일 알림·공유 호출 제한(HTTP) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만. S3·SES·SQS는 흉내 낸다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { Mailer, MailSender, queueEmail, SendEmailJob } from '../src/notify/mail';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_files_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>, assetId: string;
const ids: Record<string, string> = {};
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)], filesScanRequired: true,
};
const fakeCognito = {
  verifyAccess: async (t: string) => { const [, u, c] = t.split(':'); if (!u) throw new Error('bad'); return { sub: 's', username: u, client_id: c, token_use: 'access', exp: 0 }; },
};
// S3 흉내: 올라간 객체·검사 태그를 직접 정한다
const objects = new Map<string, { sha256b64: string; scan?: string }>();
const files: FileStore = {
  presignPut: async (key, o) => ({ url: `https://s3.test/${key}?put&ttl=${o.expiresSec}&len=${o.size}`, headers: { 'Content-Type': o.contentType, 'x-amz-checksum-sha256': o.sha256b64 } }),
  presignGet: async (key, o) => `https://s3.test/${key}?get&name=${encodeURIComponent(o.fileName)}`,
  head: async (key) => (objects.has(key) ? { size: 1, sha256b64: objects.get(key)!.sha256b64 } : null),
  scanStatus: async (key) => objects.get(key)?.scan,
};
const limiter = new SharedLimiter(new MemoryCounterStore());
const sha = createHash('sha256').update('hello').digest('hex');

async function call(who: string, method: string, path: string, body?: unknown, client = 'web', extra: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-FIL_${who}:${client}`, 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
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
  tenantId = (await seed(owner, { tenant: { code: 'FIL', name: 'Files', idpType: 'OIDC' }, domains: ['fil.test'],
    users: [{ email: 'am@fil.test', displayName: 'Asset Mgr', roles: ['ASSET_MANAGER'], locale: 'en' },
            { email: 'emp@fil.test', displayName: 'Employee', roles: [] },
            { email: 'cnt@fil.test', displayName: 'Counter', roles: ['COUNTER'] }] })).tenantId;
  for (const u of ['am', 'emp', 'cnt']) ids[u] = (await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@fil.test`])).rows[0].id;
  const co = (await owner.query(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [tenantId])).rows[0].id;
  const cat = (await owner.query(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'NB', 'Notebook') RETURNING id`, [tenantId])).rows[0].id;
  assetId = (await owner.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, source, company_id)
    VALUES (gen_random_uuid(), $1, 'NB-0001', 'ThinkPad', $2, 'MANUAL', $3) RETURNING id`, [tenantId, cat, co])).rows[0].id;
  await owner.query(`INSERT INTO pda_device (id, tenant_id, device_serial, is_active) VALUES (gen_random_uuid(), $1, 'TC58-1', true)`, [tenantId]);
  const api = await createApi({ cfg, db: app, cognito: fakeCognito as never, principals: new PrincipalCache(), limiter, files });
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

const presignBody = (o: Record<string, unknown> = {}) => ({ ownerType: 'asset', ownerId: assetId, fileName: '보증서.pdf', contentType: 'application/pdf',
  sizeBytes: 1000, sha256: sha, kind: 'DOCUMENT', ...o });

test('첨부 올리기: 검증(형식·크기·실행 파일·이미지 종류), 쓰기 권한, 대상 존재', { skip }, async () => {
  const bad = await call('am', 'POST', '/attachments:presign', presignBody({ fileName: 'x.exe', contentType: 'application/x-msdownload', sha256: 'zz' }));
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: { field: string }) => e.field).sort(), ['contentType', 'fileName', 'sha256']);
  assert.equal((await call('am', 'POST', '/attachments:presign', presignBody({ kind: 'PHOTO' }))).status, 400, 'PHOTO는 이미지만');
  assert.equal((await call('am', 'POST', '/attachments:presign', presignBody({ sizeBytes: 26 * 1024 * 1024 }))).status, 413);
  assert.equal((await call('emp', 'POST', '/attachments:presign', presignBody())).status, 403, '자산 쓰기 권한 없음');
  assert.equal((await call('am', 'POST', '/attachments:presign', presignBody({ ownerId: '00000000-0000-0000-0000-000000000000' }))).status, 404);
});

test('첨부 올리기 → 내려받기: 업로드 전 409, 검사 전 409, 악성 403, 통과 후 URL(5분)', { skip }, async () => {
  const r = await call('am', 'POST', '/attachments:presign', presignBody());
  assert.equal(r.status, 200);
  const key = `tenant/${tenantId}/asset/${r.body.attachmentId}`;
  assert.ok(r.body.uploadUrl.startsWith(`https://s3.test/${key}?put&ttl=300&len=1000`));
  assert.deepEqual(r.body.headers, { 'Content-Type': 'application/pdf', 'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64') });
  assert.ok(Math.abs(Date.parse(r.body.expiresAt) - Date.now() - 300_000) < 5_000);
  const row = (await owner.query('SELECT owner_type, owner_id, linked_at, s3_key, created_by FROM attachment WHERE id = $1', [r.body.attachmentId])).rows[0];
  assert.equal(row.owner_id, assetId); assert.ok(row.linked_at); assert.equal(row.s3_key, key); assert.equal(row.created_by, ids.am);

  const dl = () => call('am', 'GET', `/attachments/${r.body.attachmentId}:download`);
  assert.equal((await dl()).body.code, 'ALM-E111', '아직 안 올라감');
  objects.set(key, { sha256b64: Buffer.from(sha, 'hex').toString('base64') });
  assert.equal((await dl()).status, 409, '검사 전');
  objects.get(key)!.scan = 'THREATS_FOUND';
  assert.equal((await dl()).status, 403);
  objects.get(key)!.scan = 'NO_THREATS_FOUND';
  const ok = await dl();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.url, `https://s3.test/${key}?get&name=${encodeURIComponent('보증서.pdf')}`);
  assert.equal((await call('cnt', 'GET', `/attachments/${r.body.attachmentId}:download`)).status, 403, '본인 범위(OWN) 조회는 ScopeService 전까지 거부');
  assert.equal((await call('am', 'GET', '/attachments/not-a-uuid:download')).status, 404);
});

test('PDA 사진: 대상 없이 발급(연결 대기), 15분, 이미지·5 MB만, 기기 헤더 필수', { skip }, async () => {
  const h = { 'x-device-id': 'TC58-1' };
  const body = { fileName: 'p.jpg', contentType: 'image/jpeg', sizeBytes: 2000, sha256: sha, ownerType: 'count_unregistered' };
  const r = await call('cnt', 'POST', '/pda/attachments:presign', body, 'pda', h);
  assert.equal(r.status, 200);
  assert.ok(r.body.uploadUrl.includes('ttl=900'));
  const row = (await owner.query('SELECT owner_type, owner_id, linked_at, kind FROM attachment WHERE id = $1', [r.body.attachmentId])).rows[0];
  assert.deepEqual(row, { owner_type: 'count_unregistered', owner_id: null, linked_at: null, kind: 'PHOTO' });
  assert.equal((await call('cnt', 'POST', '/pda/attachments:presign', { ...body, contentType: 'application/pdf' }, 'pda', h)).status, 400);
  assert.equal((await call('cnt', 'POST', '/pda/attachments:presign', { ...body, sizeBytes: 6 * 1024 * 1024 }, 'pda', h)).status, 413);
  assert.equal((await call('am', 'POST', '/pda/attachments:presign', body, 'pda', h)).status, 403, 'COUNTER가 아님');
  assert.equal((await call('am', 'GET', `/attachments/${r.body.attachmentId}:download`)).status, 404, '연결 전 첨부는 내려받을 수 없다');
});

test('호출 제한: 사용자 분당 한도를 넘으면 429 + Retry-After(ALM-E429)', { skip }, async () => {
  assert.equal((await call('am', 'GET', '/me')).status, 200);
  while ((await limiter.hit(`u:web:${ids.emp}`, 600)) === 0) { /* 같은 창의 공유 카운터를 한도까지 채운다(다른 작업이 센 것과 같다) */ }
  const last = await call('emp', 'GET', '/me');
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'ALM-E429');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});

test('메일: 알림 행 + 작업 → 발송 SENT, 같은 키는 한 번, 영구 오류·반송은 FAILED', { skip }, async () => {
  const sent: unknown[] = [];
  const queued: string[] = [];
  const mailer = new Mailer({ send: async (cmd: { input: { MessageBody?: string } }) => { queued.push(cmd.input.MessageBody!); return {}; } } as never, 'q');
  const job = await app.withTx({ tenantId, actorType: 'SYSTEM' }, (c) => queueEmail(c, tenantId,
    { recipientId: ids.am, template: 'EXPIRY', params: { kind: 'CONTRACT', name: 'MS EA', days: 30, date: '2026-11-11', path: '/contracts/1' }, dedupeKey: 'CONTRACT_EXPIRY_30:1' },
    cfg.appOrigin));
  assert.ok(job);
  assert.equal(job.subject, '[ALM] Contract expires in 30 days: MS EA', '받는 사람 언어(en)');
  await mailer.enqueue(job);
  assert.equal(JSON.parse(queued[0]).type, 'send-email');
  const again = await app.withTx({ tenantId, actorType: 'SYSTEM' }, (c) => queueEmail(c, tenantId,
    { recipientId: ids.am, template: 'EXPIRY', params: { kind: 'CONTRACT', name: 'MS EA', days: 30, date: '2026-11-11' }, dedupeKey: 'CONTRACT_EXPIRY_30:1' }, cfg.appOrigin));
  assert.equal(again, undefined, '같은 dedupe 키');

  const ses = { send: async (cmd: { input: unknown }) => { sent.push(cmd.input); return { MessageId: 'm-1' }; } };
  const sender = new MailSender(ses as never, app, { from: 'no-reply@alm-dev.test', configSet: 'alm-dev', env: 'dev', appOrigin: cfg.appOrigin });
  await sender.handlers()['send-email'](job);
  await sender.handlers()['send-email'](job);      // 같은 메시지가 다시 와도 한 번만
  assert.equal(sent.length, 1);
  const input = sent[0] as { ConfigurationSetName: string; Destination: { ToAddresses: string[] }; EmailTags: { Name: string; Value: string }[] };
  assert.equal(input.ConfigurationSetName, 'alm-dev');
  assert.deepEqual(input.Destination.ToAddresses, ['am@fil.test']);
  assert.deepEqual(input.EmailTags.map((t) => t.Name), ['env', 'tenant', 'notification']);
  const st = async (id: string) => (await owner.query('SELECT status, error_message, sent_at FROM notification WHERE id = $1', [id])).rows[0];
  assert.equal((await st(job.notificationId)).status, 'SENT');

  // 반송 이벤트 → FAILED
  await sender.onEvent({ type: 'ses-event', event: { eventType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General',
    bouncedRecipients: [{ diagnosticCode: 'smtp; 550 user unknown' }] }, mail: { tags: { tenant: [tenantId], notification: [job.notificationId] }, destination: ['am@fil.test'] } } });
  assert.match((await st(job.notificationId)).error_message, /^Bounce: Permanent\/General smtp; 550/);

  // 영구 오류(주소 거절)는 재시도하지 않고 FAILED, 일시 오류는 다시 던진다(SQS 재시도)
  const j2 = (await app.withTx({ tenantId, actorType: 'SYSTEM' }, (c) => queueEmail(c, tenantId, { email: 'x@fil.test', template: 'TEST', params: {} }, cfg.appOrigin))) as SendEmailJob;
  const reject = new MailSender({ send: async () => { throw Object.assign(new Error('Email address is not verified'), { name: 'MessageRejected' }); } } as never, app,
    { from: 'f@x.test', env: 'dev', appOrigin: '' });
  await reject.handlers()['send-email'](j2);
  assert.equal((await st(j2.notificationId)).status, 'FAILED');
  const j3 = (await app.withTx({ tenantId, actorType: 'SYSTEM' }, (c) => queueEmail(c, tenantId, { email: 'y@fil.test', template: 'TEST', params: {} }, cfg.appOrigin))) as SendEmailJob;
  const throttled = new MailSender({ send: async () => { throw Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' }); } } as never, app,
    { from: 'f@x.test', env: 'dev', appOrigin: '' });
  await assert.rejects(throttled.handlers()['send-email'](j3), /slow down/);
  assert.equal((await st(j3.notificationId)).status, 'QUEUED');
  // 비활성 사용자에게는 보내지 않는다
  await owner.query(`UPDATE app_user SET is_active = false WHERE id = $1`, [ids.emp]);
  assert.equal(await app.withTx({ tenantId, actorType: 'SYSTEM' }, (c) => queueEmail(c, tenantId, { recipientId: ids.emp, template: 'TEST', params: {} }, '')), undefined);
});
