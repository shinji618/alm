// DB·API 통합 시험. 로컬 PostgreSQL 16이 있을 때만(TEST_PG_HOST). 슈퍼유저 = RDS 마스터 대역
//   TEST_PG_HOST=/tmp TEST_PG_PORT=55432 npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { completeLogin } from '../src/auth/login';
import { tenantOf, PrincipalCache } from '../src/auth/principal';
import { catalog } from '../src/auth/permissions';
import { seal } from '../src/auth/crypto';
import { createApi } from '../src/main';
import type { Config } from '../src/config';
import { AuthGuard } from '../src/http/auth.guard';
import { TtlCache } from '../src/common/cache';
import { MemoryCounterStore, SharedLimiter } from '../src/common/shared';
import { OPERATION } from '../src/http/context';
import { AlmError } from '../src/common/errors';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_test_${Date.now()}`;
const migrations = join(__dirname, '..', '..', 'migrations');
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

let owner: Client;
let app: Db;
let tenantA: string;
const meta = { clientId: 'web', ip: '203.0.113.9', userAgent: 'test', correlationId: randomUUID() };

before(async () => {
  if (skip) return;
  const admin = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(migrations));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);       // 로컬은 IAM 토큰 대신 비밀번호
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantA = (await seed(owner, { tenant: { code: 'TEST', name: 'Okta 시험', idpType: 'OIDC' }, domains: ['example.com'],
    users: [{ email: 'Admin@example.com', displayName: '관리자', roles: ['SYS_ADMIN', 'ASSET_MANAGER'] },
            { email: 'aud@example.com', displayName: '감사', roles: ['AUDITOR'], validUntil: '2000-01-01' },
            { email: 'off@example.com', displayName: '퇴사', roles: [] }] })).tenantId;
  await owner.query(`UPDATE app_user SET is_active = false WHERE email = 'off@example.com'`);
  (await seed(owner, { tenant: { code: 'ACME', name: 'Acme', idpType: 'SAML', jitProvision: true }, domains: ['acme.com'] })).tenantId;
});

after(async () => {
  if (skip) return;
  await app?.close();
  await owner?.end();
  const admin = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

test('migrate: 두 번 실행해도 같은 결과, 적용된 파일 변경은 거부', { skip }, async () => {
  assert.deepEqual(await migrate(owner, loadMigrations(migrations)), []);
  const ms = loadMigrations(migrations);
  ms[0] = { ...ms[0], checksum: 'x'.repeat(64) };
  await assert.rejects(migrate(owner, ms), /내용이 바뀌었다/);
  const roles = (await owner.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'alm_%' ORDER BY 1`)).rows.map((r) => r.rolname);
  for (const r of ['alm_app', 'alm_app_login', 'alm_archive_login', 'alm_audit_owner', 'alm_readonly']) assert.ok(roles.includes(r), r);
  assert.ok(!roles.includes('alm_owner_iam'), 'alm_owner_iam은 만들지 않는다');
  const owner_ = (await owner.query(`SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log'`)).rows[0].tableowner;
  assert.equal(owner_, 'alm_audit_owner');
});

test('RLS·권한: 앱 계정은 다른 테넌트를 못 보고 tenant를 못 쓴다', { skip }, async () => {
  const seen = await app.withTx({ tenantId: tenantA, actorType: 'SYSTEM' }, async (c) => (await c.query('SELECT code FROM tenant')).rows.map((r) => r.code));
  assert.deepEqual(seen, ['TEST']);
  await assert.rejects(app.withTx({ tenantId: tenantA, actorType: 'SYSTEM' }, (c) => c.query(`UPDATE tenant SET name = 'x'`)), /permission denied/);
  // 처리자 없이 바꾸면 감사 트리거가 거부
  const c = await app.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await assert.rejects(c.query(`UPDATE app_user SET locale = 'en'`), /actor_type is not set/);
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('로그인: 미리 등록된 사용자 연결 → 다음부터 idp_subject로 찾음', { skip }, async () => {
  const t = await tenantOf(app, 'T-TEST_00uokta1');
  assert.ok(t && t.tenant_id === tenantA && t.idp_subject === '00uokta1' && t.jit_provision === false);
  const r = await completeLogin(app, t, { username: 'T-TEST_00uokta1', email: 'admin@example.com', emailVerified: true, name: '김관리', idpType: 'OIDC' }, meta);
  assert.ok(r.ok && r.linked && !r.created);
  if (!r.ok) return;
  assert.equal(r.principal.displayName, '김관리');
  assert.deepEqual(r.principal.effectiveRoles.sort(), ['ASSET_MANAGER', 'EMPLOYEE', 'SYS_ADMIN']);
  assert.ok(r.principal.permissions.has('admin.user'));
  const again = await completeLogin(app, t, { username: 'T-TEST_00uokta1', emailVerified: false, idpType: 'OIDC' }, meta);
  assert.ok(again.ok && !again.linked);
  const ev = (await owner.query(`SELECT event_type, count(*)::int AS n FROM security_event WHERE tenant_id = $1 GROUP BY 1`, [tenantA])).rows;
  assert.deepEqual(ev, [{ event_type: 'LOGIN', n: 2 }]);
  const audit = (await owner.query(`SELECT actor_type, actor_id, ip_address::text AS ip FROM audit_log WHERE table_name = 'app_user' AND action = 'UPDATE' ORDER BY occurred_at DESC LIMIT 1`)).rows[0];
  assert.equal(audit.actor_type, 'USER');
  assert.equal(audit.actor_id, r.principal.userId);
  assert.equal(audit.ip, '203.0.113.9/32');
});

test('로그인 거부: 미검증 이메일·미등록(JIT 꺼짐)·비활성·만료된 감사인', { skip }, async () => {
  const t = (u: string) => tenantOf(app, u).then((x) => x!);
  const deny = async (u: string, email: string, verified = true) =>
    completeLogin(app, await t(u), { username: u, email, emailVerified: verified, idpType: 'OIDC' }, meta);
  assert.deepEqual(await deny('T-TEST_x1', 'off@example.com', false), { ok: false, reason: 'EMAIL_UNVERIFIED' });
  assert.deepEqual(await deny('T-TEST_x2', 'nobody@example.com'), { ok: false, reason: 'NO_USER' });
  assert.deepEqual(await deny('T-TEST_x3', 'off@example.com'), { ok: false, reason: 'INACTIVE' });
  assert.deepEqual(await deny('T-TEST_x4', 'aud@example.com'), { ok: false, reason: 'NO_VALID_ROLE' });
  const denied = (await owner.query(`SELECT count(*)::int AS n FROM security_event WHERE event_type = 'LOGIN_DENIED'`)).rows[0].n;
  assert.equal(denied, 4);
  assert.equal(await tenantOf(app, 'T-NOPE_1'), undefined);
  assert.equal(await tenantOf(app, 'T-TESTX_1'), undefined, '접두어만 같은 다른 이름');
});

test('로그인: JIT 테넌트는 EMPLOYEE로 생성(SAML은 이메일 검증 간주)', { skip }, async () => {
  const t = (await tenantOf(app, 'T-ACME_oid-1'))!;
  const r = await completeLogin(app, t, { username: 'T-ACME_oid-1', email: 'new@acme.com', emailVerified: false, name: 'New', idpType: 'SAML' }, meta);
  assert.ok(r.ok && r.created);
  if (r.ok) assert.deepEqual(r.principal.effectiveRoles, ['EMPLOYEE']);
});

// ---- HTTP: 가짜 Cognito로 BFF 흐름 전체 ----
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0,
  db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'us-east-1_x', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 7)],
};
const fakeCognito = {
  base: 'https://auth.example.test',
  authorizeUrl: (p: { idp: string; state: string; challenge: string }) => `https://auth.example.test/oauth2/authorize?identity_provider=${p.idp}&state=${p.state}&code_challenge=${p.challenge}`,
  logoutUrl: () => 'https://auth.example.test/logout?client_id=web',
  exchangeCode: async (code: string) => ({ access_token: `at:${code}:web`, id_token: 'id', refresh_token: 'rt-1', expires_in: 900, token_type: 'Bearer' }),
  refresh: async (rt: string) => { if (rt !== 'rt-1') throw Object.assign(new Error('x'), {}); return { access_token: 'at:T-TEST_00uokta1:web', expires_in: 900, token_type: 'Bearer' }; },
  revoke: async () => undefined,
  verifyAccess: async (tok: string) => {
    const [, user, client] = tok.split(':');
    if (!user) throw new Error('bad');
    return { sub: 's', username: user, client_id: client, token_use: 'access', exp: 0 };
  },
  verifyId: async () => ({ sub: 's', 'cognito:username': 'T-TEST_00uokta1', email: 'admin@example.com', email_verified: 'true', name: '김관리' }),
};

test('HTTP: 로그인 → 콜백 → 갱신 → /me → 로그아웃', { skip }, async () => {
  const api = await createApi({ cfg, db: app, cognito: fakeCognito as never, principals: new PrincipalCache() });
  await api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(api.getHttpServer().address() as AddressInfo).port}/api/v1`;
  try {
    const live = await fetch(`${base}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok', build: 'local' });
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);

    const unknown = await fetch(`${base}/auth/login?email=a@unknown.com`, { redirect: 'manual' });
    assert.equal(unknown.status, 403);
    const prob = (await unknown.json()) as any;
    assert.equal(prob.code, 'ALM-E405');
    assert.equal(unknown.headers.get('content-type'), 'application/problem+json; charset=utf-8');
    assert.equal(prob.correlationId, unknown.headers.get('x-correlation-id'));

    const login = await fetch(`${base}/auth/login?email=admin@Example.com&returnTo=/assets`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const loc = new URL(login.headers.get('location')!);
    assert.equal(loc.searchParams.get('identity_provider'), 'T-TEST');
    const pkce = login.headers.get('set-cookie')!;
    assert.match(pkce, /alm_pkce=.*Path=\/api\/v1\/auth.*HttpOnly.*Secure.*SameSite=Lax/);
    const pkceCookie = pkce.split(';')[0];

    const badState = await fetch(`${base}/auth/callback?code=T-TEST_00uokta1&state=wrong`, { redirect: 'manual', headers: { cookie: pkceCookie } });
    assert.equal(badState.status, 400);

    const cb = await fetch(`${base}/auth/callback?code=T-TEST_00uokta1&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: pkceCookie } });
    assert.equal(cb.status, 302, JSON.stringify(await cb.clone().text()));
    assert.equal(cb.headers.get('location'), 'https://alm.example.test/assets');
    const rtSet = cb.headers.getSetCookie().find((c) => c.startsWith('alm_rt='))!;
    assert.match(rtSet, /Max-Age=28800.*Path=\/api\/v1\/auth.*HttpOnly.*Secure.*SameSite=Strict/);
    const rt = rtSet.split(';')[0];

    assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { cookie: rt } })).status, 403, 'CSRF 헤더 없음');
    assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { cookie: rt, 'x-alm-csrf': '1', origin: 'https://evil.test' } })).status, 403);
    const csrf = { 'x-alm-csrf': '1', origin: cfg.appOrigin };
    const ref = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { cookie: rt, ...csrf } });
    assert.equal(ref.status, 200);
    const tok = (await ref.json()) as any;
    assert.deepEqual(tok, { accessToken: 'at:T-TEST_00uokta1:web', expiresIn: 900, tokenType: 'Bearer' });
    assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { ...csrf } })).status, 401, '쿠키 없음');
    const forged = seal([Buffer.alloc(32, 9)], 'alm_rt', { rt: 'rt-1' }, 60);
    assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { cookie: `alm_rt=${forged}`, ...csrf } })).status, 401, '다른 키');

    assert.equal((await fetch(`${base}/me`)).status, 401);
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: 'Bearer at:T-TEST_00uokta1:pda' } })).status, 403, '채널');
    const me = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${tok.accessToken}` } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as any;
    assert.equal(body.tenantCode, 'TEST');
    assert.equal(body.email, 'admin@example.com');
    assert.deepEqual(body.roles.map((r: { role: string }) => r.role).sort(), ['ASSET_MANAGER', 'EMPLOYEE', 'SYS_ADMIN']);
    assert.ok(body.permissions.includes('admin.user') && body.permissions.includes('auth'));
    assert.equal(me.headers.get('cache-control'), 'no-store');

    const session = await fetch(`${base}/auth/session`, { headers: { cookie: rt } });
    assert.equal(session.status, 200);
    assert.equal(((await session.json()) as any).token.username, 'T-TEST_00uokta1');

    assert.equal((await fetch(`${base}/nope`)).status, 404);

    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie: rt, ...csrf } });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { logoutUrl: 'https://auth.example.test/logout?client_id=web' });
    assert.match(out.headers.getSetCookie()[0], /alm_rt=;.*Expires=Thu, 01 Jan 1970/);
    const ev = (await owner.query(`SELECT count(*)::int AS n FROM security_event WHERE event_type = 'LOGOUT'`)).rows[0].n;
    assert.equal(ev, 1);
  } finally {
    await api.close();
  }
});

test('가드: 권한 없는 작업은 403 ALM-E401 + ACCESS_DENIED 기록, 작업 ID 없는 경로는 기본 거부', { skip }, async () => {
  const t = (await tenantOf(app, 'T-ACME_oid-1'))!;
  assert.ok((await completeLogin(app, t, { username: 'T-ACME_oid-1', email: 'new@acme.com', emailVerified: true, idpType: 'SAML' }, meta)).ok);
  const guardFor = (meta: Record<string, unknown>) => new AuthGuard({ get: (k: string) => meta[k] } as never, cfg, app, fakeCognito as never, new PrincipalCache(), new TtlCache(),
    new SharedLimiter(new MemoryCounterStore()));
  const ctx = (path: string) => {
    const req = { path, method: 'GET', header: (h: string) => (h === 'authorization' ? 'Bearer at:T-ACME_oid-1:web' : undefined),
      alm: { correlationId: randomUUID(), ip: '198.51.100.1' } };
    return { getHandler: () => null, switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: () => undefined }) }) } as never;
  };
  assert.equal(await guardFor({ [OPERATION]: 'getMe' }).canActivate(ctx('/api/v1/me')), true);
  await assert.rejects(guardFor({ [OPERATION]: 'listUsers' }).canActivate(ctx('/api/v1/admin/users')), (e: AlmError) => e.code === 'ALM-E401');
  await assert.rejects(guardFor({}).canActivate(ctx('/api/v1/x')), (e: AlmError) => e.status === 403);
  const ev = (await owner.query(`SELECT detail->>'permission' AS p, target FROM security_event WHERE event_type = 'ACCESS_DENIED'`)).rows;
  assert.deepEqual(ev, [{ p: 'admin.user', target: 'GET /api/v1/admin/users' }]);
});
