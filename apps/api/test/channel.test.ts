// PDA·SAP 채널 인증 통합 시험(09 6.5·6.6·7장, ST03·ST13·ST21). 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
import { ipAllowed } from '../src/auth/sap';
import { RateLimiter } from '../src/common/cache';
import { createApi } from '../src/main';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_chan_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
const SAP = 'alm-api/sap.api';
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)],
};
const emails: Record<string, string> = { cnt1: 'counter@chan.test', emp1: 'emp@chan.test' };
const cognitoCalls: string[] = [];
// 토큰 형식: at:<username>:<client_id>[:<scope>]
const fakeCognito = {
  verifyAccess: async (t: string) => {
    const [, u, c, scope] = t.split('|');
    if (!u || !c) throw new Error('bad');
    return { sub: 's', username: u, client_id: c, token_use: 'access', scope: scope ?? 'openid email profile', exp: 0 };
  },
  userInfo: async (t: string) => {
    const sub = t.split('|')[1].replace(/^T-CHN_/, '');
    return { email: emails[sub], email_verified: 'true', name: sub.toUpperCase(), identities: '[{"providerType":"OIDC"}]' };
  },
  clientCredentials: async (id: string, secret: string) => {
    cognitoCalls.push(id);
    return secret === 'good' ? { ok: true, token: { access_token: `tok-${id}`, expires_in: 3600, token_type: 'Bearer' } } : { ok: false, status: 400, error: 'invalid_client' };
  },
};
const tok = (user: string, client: string, scope?: string) => `Bearer at|${user}|${client}${scope ? `|${scope}` : ''}`;

async function call(path: string, o: { method?: string; auth?: string; device?: string; body?: unknown; headers?: Record<string, string>; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.auth) headers.authorization = o.auth;
  if (o.device) headers['x-device-id'] = o.device;
  let body: string | undefined;
  if (o.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
  const r = await fetch(`${base}${path}`, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const events = async (type: string) => (await owner.query(`SELECT channel, actor_type, target, detail FROM security_event WHERE event_type = $1 ORDER BY occurred_at`, [type])).rows;

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'CHN', name: 'Channel test', idpType: 'OIDC' }, domains: ['chan.test'],
    users: [{ email: 'counter@chan.test', displayName: 'Counter', roles: ['COUNTER'] }, { email: 'emp@chan.test', displayName: 'Emp', roles: [] }] })).tenantId;
  const co = (await owner.query(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG US') RETURNING id`, [tenantId])).rows[0].id;
  await owner.query(`INSERT INTO sap_connection (id, tenant_id, system_id, company_id, oauth_client_id, allowed_cidrs) VALUES
    (gen_random_uuid(), $1, 'DEV-100', $2, 'sapclient1', '["127.0.0.1/32", "::1/128"]'),
    (gen_random_uuid(), $1, 'QAS-100', $2, 'sapclient2', '["10.0.0.0/8"]')`, [tenantId, co]);
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

test('허용 IP·호출 제한(단위)', () => {
  assert.equal(ipAllowed('10.1.2.3', []), true, '목록 없으면 WAF만');
  assert.equal(ipAllowed('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('11.1.2.3', ['10.0.0.0/8', '192.168.1.5']), false);
  assert.equal(ipAllowed('192.168.1.5', ['192.168.1.5']), true);
  assert.equal(ipAllowed('2001:db8::1', ['2001:db8::/32']), true);
  assert.equal(ipAllowed(undefined, ['10.0.0.0/8']), false);
  const rl = new RateLimiter(2, 1000);
  assert.deepEqual([rl.hit('a', 0), rl.hit('a', 10), rl.hit('a', 20), rl.hit('b', 20), rl.hit('a', 1000)], [0, 0, 1, 0, 0]);
});

test('PDA: 채널(ST03)·기기 헤더 필수', { skip }, async () => {
  assert.equal((await call('/pda/me', { auth: tok('T-CHN_cnt1', 'web'), device: 'TC58-001' })).body.code, 'ALM-E407');
  assert.equal((await call('/me', { auth: tok('T-CHN_cnt1', 'pda') })).body.code, 'ALM-E407');
  const noDev = await call('/pda/me', { auth: tok('T-CHN_cnt1', 'pda') });
  assert.equal(noDev.status, 400); assert.equal(noDev.body.code, 'ALM-E101');
});

test('PDA: 첫 로그인 연결(userInfo) → 기기 등록 → /pda/me', { skip }, async () => {
  const unreg = await call('/pda/me', { auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001' });
  assert.equal(unreg.status, 403); assert.equal(unreg.body.code, 'ALM-E406');   // 연결은 됐지만 기기 미등록
  const linked = (await owner.query(`SELECT idp_subject FROM app_user WHERE email = 'counter@chan.test'`)).rows[0].idp_subject;
  assert.equal(linked, 'cnt1');
  const mismatch = await call('/pda/devices/TC58-001', { method: 'PUT', auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001', body: { deviceSerial: 'OTHER', appVersion: '1.0.0' } });
  assert.equal(mismatch.status, 400);
  const reg = await call('/pda/devices/TC58-001', { method: 'PUT', auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001', body: { deviceSerial: 'TC58-001', model: 'TC58', appVersion: '1.0.0' } });
  assert.equal(reg.status, 200, JSON.stringify(reg.body)); assert.match(reg.body.deviceId, /^[0-9a-f-]{36}$/);
  const again = await call('/pda/devices/TC58-001', { method: 'PUT', auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001', body: { deviceSerial: 'TC58-001', appVersion: '1.0.1' } });
  assert.equal(again.body.deviceId, reg.body.deviceId, '같은 시리얼은 갱신(멱등)');
  const me = await call('/pda/me', { auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001' });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.roles.sort(), ['COUNTER', 'EMPLOYEE']);
  assert.equal(me.body.tenantCode, 'CHN'); assert.equal(me.body.offlineHours, 24); assert.equal(me.body.minAppVersion, '1.0.0');
  assert.ok(Math.abs(Date.parse(me.body.serverTime) - Date.now()) < 5000);
  const logins = await events('LOGIN');
  assert.ok(logins.length >= 2 && logins.every((e) => e.channel === 'PDA'));
  assert.deepEqual((await events('DEVICE_BLOCKED')).map((e) => e.detail.reason), ['NOT_REGISTERED']);
  const dev = (await owner.query(`SELECT app_version, model, is_active, last_user_id IS NOT NULL AS u FROM pda_device`)).rows;
  assert.deepEqual(dev, [{ app_version: '1.0.1', model: 'TC58', is_active: true, u: true }]);
});

test('PDA: 차단 기기 403 ALM-E406(ST13), COUNTER 아니면 403 ALM-E401, 승인제면 새 기기 대기', { skip }, async () => {
  await owner.query(`UPDATE pda_device SET is_active = false WHERE device_serial = 'TC58-001'`);
  const blocked = await call('/pda/me', { auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001' });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'ALM-E406');
  assert.equal((await call('/pda/devices/TC58-001', { method: 'PUT', auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-001', body: { deviceSerial: 'TC58-001', appVersion: '1' } })).body.code, 'ALM-E406');
  await owner.query(`UPDATE pda_device SET is_active = true`);
  const emp = await call('/pda/me', { auth: tok('T-CHN_emp1', 'pda'), device: 'TC58-001' });
  assert.equal(emp.status, 403); assert.equal(emp.body.code, 'ALM-E401');
  await owner.query(`INSERT INTO setting (id, tenant_id, key, value) VALUES (gen_random_uuid(), $1, 'pda.device_approval', 'true')`, [tenantId]);
  const pending = await call('/pda/devices/TC58-NEW', { method: 'PUT', auth: tok('T-CHN_cnt1', 'pda'), device: 'TC58-NEW', body: { deviceSerial: 'TC58-NEW', appVersion: '1.0.0' } });
  assert.equal(pending.status, 403); assert.equal(pending.body.code, 'ALM-E406');
  assert.deepEqual((await owner.query(`SELECT is_active FROM pda_device WHERE device_serial = 'TC58-NEW'`)).rows, [{ is_active: false }], '등록은 남음');
  assert.ok((await events('DEVICE_BLOCKED')).some((e) => e.detail.reason === 'APPROVAL_PENDING'));
});

test('SAP 토큰: 형식 오류·클라이언트 인증·허용 IP(ST21)·성공(Basic·본문)', { skip }, async () => {
  const basic = (id: string, s: string) => `Basic ${Buffer.from(`${id}:${s}`).toString('base64')}`;
  assert.equal((await call('/oauth/token', { form: { grant_type: 'password' } })).body.error, 'unsupported_grant_type');
  assert.equal((await call('/oauth/token', { form: { grant_type: 'client_credentials', scope: 'admin' }, auth: basic('sapclient1', 'good') })).body.error, 'invalid_scope');
  const none = await call('/oauth/token', { form: { grant_type: 'client_credentials' } });
  assert.equal(none.status, 401); assert.equal(none.body.error, 'invalid_client');
  const unknown = await call('/oauth/token', { form: { grant_type: 'client_credentials' }, auth: basic('nobody', 'good') });
  assert.equal(unknown.status, 401);
  const bad = await call('/oauth/token', { form: { grant_type: 'client_credentials', scope: 'sap.api' }, auth: basic('sapclient1', 'wrong') });
  assert.equal(bad.status, 401);
  const ipBad = await call('/oauth/token', { form: { grant_type: 'client_credentials' }, auth: basic('sapclient2', 'good') });
  assert.equal(ipBad.status, 403);
  assert.deepEqual((await events('SAP_AUTH_FAILED')).map((e) => [e.channel, e.actor_type, e.detail.reason]),
    [['SAP', 'SAP', 'COGNITO_REJECTED'], ['SAP', 'SAP', 'IP_NOT_ALLOWED']]);
  assert.ok(!cognitoCalls.includes('sapclient2'), '허용 IP 밖이면 Cognito를 부르지 않음');
  const ok = await call('/oauth/token', { form: { grant_type: 'client_credentials', scope: 'sap.api' }, auth: basic('sapclient1', 'good') });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { access_token: 'tok-sapclient1', token_type: 'Bearer', expires_in: 3600, scope: 'sap.api' });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const post = await call('/oauth/token', { form: { grant_type: 'client_credentials', client_id: 'sapclient1', client_secret: 'good' } });
  assert.equal(post.status, 200);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM sap_connection WHERE last_call_at IS NOT NULL`)).rows[0].n, 1);
});

test('SAP 토큰: 클라이언트당 분당 10회 제한 429', { skip }, async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('/oauth/token', { form: { grant_type: 'client_credentials' }, headers: { authorization: `Basic ${Buffer.from('limitme:x').toString('base64')}` } });
  assert.equal(last!.status, 429); assert.ok(Number(last!.headers.get('retry-after')) > 0);
});

test('SAP API: /sap/ping, 범위·연결·시스템 ID·회사코드·허용 IP, 채널 교차(E407)', { skip }, async () => {
  const sapTok = tok('sapclient1', 'sapclient1', SAP);
  const ping = await call('/sap/ping', { auth: sapTok, headers: { 'x-sap-system': 'DEV-100', 'x-company-code': '1000' } });
  assert.equal(ping.status, 200, JSON.stringify(ping.body));
  assert.equal(ping.body.status, 'UP'); assert.equal(ping.body.tenantCode, 'CHN'); assert.deepEqual(ping.body.companyCodes, ['1000']);
  assert.equal((await call('/sap/ping', { auth: sapTok, headers: { 'x-sap-system': 'PRD-100' } })).status, 403);
  assert.equal((await call('/sap/ping', { auth: sapTok, headers: { 'x-company-code': '2000' } })).status, 403);
  assert.equal((await call('/sap/ping', { auth: tok('sapclient1', 'sapclient1') })).body.code, 'ALM-E407', 'sap.api 범위 없음');
  assert.equal((await call('/sap/ping', { auth: tok('x', 'unknownclient', SAP) })).body.code, 'ALM-E407', '연결 없는 클라이언트');
  assert.equal((await call('/sap/ping', { auth: tok('T-CHN_cnt1', 'web') })).body.code, 'ALM-E407', '웹 토큰');
  assert.equal((await call('/me', { auth: sapTok })).body.code, 'ALM-E407', 'SAP 토큰으로 웹 API');
  const outside = await call('/sap/ping', { auth: tok('sapclient2', 'sapclient2', SAP) });
  assert.equal(outside.status, 403);
  // CloudFront가 붙인 접속 IP를 쓴다
  assert.equal((await call('/sap/ping', { auth: tok('sapclient2', 'sapclient2', SAP), headers: { 'cloudfront-viewer-address': '10.9.8.7:51234' } })).status, 200);
});
