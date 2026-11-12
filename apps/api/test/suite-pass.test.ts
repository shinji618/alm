// 통행증 모드(SUITE_AUTH=1, 통합 WBS 5.4): 웹 채널은 플랫폼이 서명한 통행증 쿠키로 인증한다. PDA 등 다른 채널은 그대로 토큰이다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { catalog } from '../src/platform/identity/permissions';
import { PrincipalCache } from '../src/platform/identity/principal';
import { createApi } from '../src/main';
import type { Config } from '../src/config';
import { PASS_COOKIE, PassError, SuitePassVerifier, suiteAuthConfig } from '../src/auth/suitePass';

const ISS = 'https://app.example.test';
const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const k1 = keyPair(), k2 = keyPair();
const jwk = (kid: string, pub: KeyObject) => ({ ...pub.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' });
let jwksCalls = 0;
const fakeFetch = (async () => { jwksCalls++; return new Response(JSON.stringify({ keys: [jwk('k1', k1.publicKey)] }), { status: 200 }); }) as typeof fetch;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const CT = '9b713b63-5074-4c82-9a91-58aab684d859', SUB = '5d3c2f0e-6a1b-4a53-9c1e-0c5a3f6e7a11';
const claims = (over: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISS, aud: 'alm', sub: SUB, sid: 'sid-1', tid: CT, tcd: 'TEST', email: 'admin@example.com', name: '관리자', roles: [{ role: 'SYS_ADMIN', scope: {} }, { role: 'EMPLOYEE', scope: {} }],
    csrf: 'csrf-token-1', iat: now, exp: now + 300, ...over };
};
const pass = (c: Record<string, unknown> = claims(), head: object = { alg: 'ES256', kid: 'k1', typ: 'JWT' }, key = k1.privateKey) => {
  const body = `${b64(head)}.${b64(c)}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof PassError ? e.code : `?${e}`));

test('통행증 검증: 서명·알고리즘·발급자·대상·만료·내용', async () => {
  const v = new SuitePassVerifier({ issuer: ISS, jwksUrl: `${ISS}/auth/jwks.json` }, fakeFetch);
  const ok = await v.verify(pass());
  assert.deepEqual([ok.sub, ok.tid, ok.tcd, ok.csrf, ok.roles.length], [SUB, CT, 'TEST', 'csrf-token-1', 2]);
  assert.equal(await codeOf(v.verify(undefined)), 'NO_PASS');
  assert.equal(await codeOf(v.verify('a.b')), 'FORMAT');
  assert.equal(await codeOf(v.verify(pass(claims(), { alg: 'none', kid: 'k1' }))), 'ALG');
  assert.equal(await codeOf(v.verify(pass(claims(), { alg: 'HS256', kid: 'k1' }))), 'ALG');
  assert.equal(await codeOf(v.verify(pass(claims(), { alg: 'ES256', kid: 'k1' }, k2.privateKey))), 'SIGNATURE', '다른 키로 서명');
  assert.equal(await codeOf(v.verify(pass(claims({ iss: 'https://evil.example.test' })))), 'ISS');
  assert.equal(await codeOf(v.verify(pass(claims({ aud: 'portal' })))), 'AUD', '다른 제품의 통행증');
  assert.equal(await codeOf(v.verify(pass(claims({ exp: Math.floor(Date.now() / 1000) - 1 })))), 'EXPIRED');
  assert.equal(await codeOf(v.verify(pass(claims({ sub: 'not-a-uuid' })))), 'CLAIMS');
  const tampered = pass().split('.'); tampered[1] = b64(claims({ tcd: 'ACME' }));
  assert.equal(await codeOf(v.verify(tampered.join('.'))), 'SIGNATURE', '내용을 바꿈');
  // 모르는 kid: 키 목록을 다시 읽되 30초에 한 번까지만
  const n = jwksCalls;
  assert.equal(await codeOf(v.verify(pass(claims(), { alg: 'ES256', kid: 'zz' }, k2.privateKey))), 'KID');
  assert.equal(await codeOf(v.verify(pass(claims(), { alg: 'ES256', kid: 'zz' }, k2.privateKey))), 'KID');
  assert.equal(jwksCalls, n, '방금 읽었으면 다시 읽지 않는다');
  const down = new SuitePassVerifier({ issuer: ISS, jwksUrl: `${ISS}/auth/jwks.json` }, (async () => { throw new Error('net'); }) as typeof fetch);
  assert.equal(await codeOf(down.verify(pass())), 'JWKS');
});

test('설정: SUITE_AUTH=1이면 SUITE_ORIGIN이 꼭 있어야 한다', () => {
  assert.equal(suiteAuthConfig({}), undefined);
  assert.deepEqual(suiteAuthConfig({ SUITE_AUTH: '1', SUITE_ORIGIN: 'https://app-dev.pasapps.com/' }), { issuer: 'https://app-dev.pasapps.com', jwksUrl: 'https://app-dev.pasapps.com/auth/jwks.json' });
  assert.throws(() => suiteAuthConfig({ SUITE_AUTH: '1' }), /SUITE_ORIGIN/);
  assert.throws(() => suiteAuthConfig({ SUITE_AUTH: '1', SUITE_ORIGIN: 'http://app' }), /SUITE_ORIGIN/);
});

// ---- HTTP: 실제 가드 + DB ----
const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_pass_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));
let owner: Client, app: Db, tenantId: string, adminId: string;

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'TEST', name: '시험', idpType: 'OIDC' }, domains: ['example.com'],
    users: [{ email: 'admin@example.com', displayName: '관리자', roles: ['SYS_ADMIN', 'ASSET_MANAGER'] }] })).tenantId;
  await seed(owner, { tenant: { code: 'ACME', name: 'Acme', idpType: 'OIDC' }, domains: ['acme.com'] });
  await owner.query('SELECT auth_link_central_tenant($1, $2)', [tenantId, CT]);
  adminId = (await owner.query(`SELECT id FROM app_user WHERE email = 'admin@example.com'`)).rows[0].id;
});
after(async () => {
  if (skip) return;
  await app?.close(); await owner?.end();
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

const cfg = (): Config => ({
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'us-east-1_x', webClientId: '', webClientSecret: '', pdaClientId: 'pda', domain: 'auth.example.test' },
  suite: { issuer: ISS, jwksUrl: `${ISS}/auth/jwks.json` }, appOrigin: `${ISS}/alm`, cookieKeys: [],
});
const fakeCognito = {
  base: 'https://auth.example.test',
  verifyAccess: async (tok: string) => { const [, user, client] = tok.split(':'); if (!user) throw new Error('bad'); return { sub: 's', username: user, client_id: client, token_use: 'access', exp: 0 }; },
};

test('HTTP: 통행증으로 웹 API, CSRF, 다른 채널·토큰은 그대로, 자체 로그인 경로는 닫힘', { skip }, async () => {
  const central = { calls: 0, getUser: async (tcd: string, id: string) => { central.calls++;
    return tcd === 'TEST' && id === NEW ? { id, email: 'new@example.com', displayName: '새 사용자', isActive: true, linked: true, version: 1, roles: [{ role: 'ASSET_MANAGER', scope: {} }] } : undefined; } };
  const NEW = randomUUID();
  const api = await createApi({ cfg: cfg(), db: app, cognito: fakeCognito as never, principals: new PrincipalCache(), central: central as never,
    pass: new SuitePassVerifier({ issuer: ISS, jwksUrl: `${ISS}/auth/jwks.json` }, fakeFetch) });
  await api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(api.getHttpServer().address() as AddressInfo).port}/api/v1`;
  const call = (path: string, token?: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { ...(token ? { cookie: `${PASS_COOKIE}=${token}` } : {}), ...init.headers } });
  try {
    // 사본(미러)이 있는 사용자: 통행증의 sub = app_user.id
    const me = await call('/me', pass(claims({ sub: adminId })));
    assert.equal(me.status, 200);
    const body = (await me.json()) as any;
    assert.equal(body.email, 'admin@example.com');
    assert.ok(body.roles.some((r: any) => (r.role ?? r) === 'SYS_ADMIN'), JSON.stringify(body.roles));   // 역할은 ALM DB에서 읽는다

    // 통행증 없음·만료·위조 → 401(화면이 통행증을 갱신하고 다시 부른다)
    assert.equal((await call('/me')).status, 401);
    assert.equal((await call('/me', pass(claims({ sub: adminId, exp: Math.floor(Date.now() / 1000) - 5 })))).status, 401);
    assert.equal((await call('/me', pass(claims({ sub: adminId }), { alg: 'ES256', kid: 'k1' }, k2.privateKey))).status, 401);
    assert.equal((await call('/me', pass(claims({ sub: adminId, aud: 'portal' })))).status, 401);

    // 변경 요청: X-Suite-Csrf가 통행증의 csrf와 같아야 한다
    const post = (headers: Record<string, string>) => call('/assets', pass(claims({ sub: adminId })), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...headers } });
    const noCsrf = await post({});
    assert.equal(noCsrf.status, 403);
    assert.match(((await noCsrf.json()) as any).detail, /요청 출처/);
    assert.equal((await post({ 'x-suite-csrf': 'wrong' })).status, 403);
    const withCsrf = await post({ 'x-suite-csrf': 'csrf-token-1' });
    assert.notEqual(withCsrf.status, 403, 'CSRF 통과(본문 검증 오류는 400)');
    assert.notEqual(withCsrf.status, 401);

    // 연결되지 않은 테넌트(중앙 테넌트 ID 매핑 없음) → 403
    const other = await call('/me', pass(claims({ sub: adminId, tid: randomUUID(), tcd: 'ACME' })));
    assert.equal(other.status, 403);
    assert.equal(((await other.json()) as any).code, 'ALM-E405');

    // 사본이 없는 사용자: 중앙의 값으로 사본을 만든다(첫 사용). 중앙에 없는 사용자는 거부
    const first = await call('/me', pass(claims({ sub: NEW, email: 'new@example.com', name: '새 사용자', roles: [{ role: 'ASSET_MANAGER', scope: {} }, { role: 'EMPLOYEE', scope: {} }] })));
    assert.equal(first.status, 200);
    assert.equal(central.calls, 1);
    const roles = (await owner.query('SELECT role FROM user_role WHERE user_id = $1 ORDER BY 1', [NEW])).rows.map((r) => r.role);
    assert.deepEqual(roles, ['ASSET_MANAGER'], '암묵 역할은 사본에 넣지 않는다');
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM security_event WHERE actor_id = $1 AND event_type = 'LOGIN'`, [NEW])).rows[0].n, 1);
    await call('/me', pass(claims({ sub: NEW })));
    assert.equal(central.calls, 1, '주체 캐시(60초)');
    assert.equal((await call('/me', pass(claims({ sub: randomUUID() })))).status, 403);

    // 웹 채널에 액세스 토큰(예전 방식): 웹 클라이언트가 없으므로 거절. PDA 채널은 그대로 토큰(통행증으로는 못 부른다)
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: 'Bearer at:T-TEST_x:web' } })).status, 403);
    assert.equal((await call('/pda/me', pass(claims({ sub: adminId })))).status, 401, 'PDA 경로는 통행증을 받지 않는다');

    // 자체 로그인(BFF) 경로: 로그인은 플랫폼 화면으로, 나머지는 404
    const login = await call('/auth/login?email=admin@example.com&returnTo=/assets');
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), `${ISS}/login?returnTo=${encodeURIComponent('/alm/assets')}`);
    assert.equal((await call('/auth/refresh', undefined, { method: 'POST' })).status, 404);
    assert.equal((await call('/auth/logout', undefined, { method: 'POST' })).status, 404);
    assert.equal((await call('/auth/session')).status, 404);
    assert.equal((await call('/auth/callback?code=x&state=y')).status, 404);
  } finally { await api.close(); }
});
