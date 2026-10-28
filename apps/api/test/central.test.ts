// 중앙 ID 전환(WBS 3.13): 로그인 위임·미러, 관리 변경 위임, 부서 관리자, 변경 이벤트, 이관 내보내기, 중앙 클라이언트
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { PrincipalCache, tenantOf } from '../src/platform/identity/principal';
import { catalog } from '../src/platform/identity/permissions';
import { createApi } from '../src/main';
import { Central, CentralClient, CentralRole, CentralUser, CentralLogin } from '../src/auth/central';
import { centralLogin } from '../src/auth/centralLogin';
import { exportUsers, identityEventHandlers, refreshUser } from '../src/admin/identitySync';
import { E } from '../src/common/errors';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_central_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

// 중앙 ID 서비스 가짜(메모리). 규칙은 중앙 시험에서 따로 검증했다
class FakeCentral implements Central {
  users = new Map<string, CentralUser>();
  calls: string[] = [];
  nextLogin?: CentralLogin;
  failRoles?: Error;
  async login() { this.calls.push('login'); return this.nextLogin!; }
  async getUser(_t: string, id: string) { this.calls.push(`get:${id}`); const u = this.users.get(id); return u && JSON.parse(JSON.stringify(u)); }
  async createUser(_t: string, _a: string, b: { email: string; displayName: string; employeeNo?: string }) {
    this.calls.push('create');
    if ([...this.users.values()].some((u) => u.email === b.email.toLowerCase())) throw E.duplicate('같은 이메일의 사용자가 이미 있습니다');
    const u: CentralUser = { id: randomUUID(), email: b.email.toLowerCase(), displayName: b.displayName, employeeNo: b.employeeNo, isActive: true, linked: false, version: 1, roles: [] };
    this.users.set(u.id, u); return JSON.parse(JSON.stringify(u));
  }
  async patchUser(_t: string, id: string, _a: string, b: Record<string, unknown>) {
    this.calls.push('patch');
    const u = this.users.get(id)!; Object.assign(u, b); u.version++;
    return { ...JSON.parse(JSON.stringify(u)), rolesCleared: false };
  }
  async putRoles(_t: string, id: string, actor: string, roles: CentralRole[]) {
    this.calls.push(`put:${id}`);
    if (this.failRoles) throw this.failRoles;
    if (id === actor) throw E.sod('자기 자신의 역할은 바꿀 수 없습니다(다른 관리자가 처리)');
    this.users.get(id)!.roles = roles;
    const sod = roles.some((r) => r.role === 'ASSET_MANAGER') && roles.some((r) => r.role === 'ASSET_ACCOUNTANT')
      ? [{ rule: 'SOD-01', roles: ['ASSET_MANAGER', 'ASSET_ACCOUNTANT'], description: 'x' }] : [];
    return { roles, sod };
  }
  async importUsers() { return { created: 0, updated: 0, skipped: [] }; }
}

let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
const central = new FakeCentral();
const ids: Record<string, string> = {};
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)],
};
const fakeCognito = { verifyAccess: async (t: string) => { const [, u, c] = t.split(':'); if (!u) throw new Error('bad'); return { sub: 's', username: u, client_id: c, token_use: 'access', exp: 0 }; } };
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-CEN_${who}:web`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const meta = { clientId: 'web', correlationId: randomUUID() };

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'CEN', name: 'Central test', idpType: 'OIDC' }, domains: ['cen.test'], users: [] })).tenantId;
  const co = (await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [tenantId]))[0].id;
  ids.cc = (await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [tenantId, co]))[0].id;
  await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta')`, [tenantId]);
  const api = await createApi({ cfg, db: app, cognito: fakeCognito as never, principals: new PrincipalCache(0), central });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.getHttpServer().address() as AddressInfo).port}/api/v1`;
  close = () => api.close();
});
after(async () => {
  if (skip) return;
  await close?.(); await (app as any)?.pool?.end?.(); await owner?.end();
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

test('로그인 위임: 중앙 판정 결과를 미러(같은 ID·IdP 연결·역할 범위)에 반영하고 principal, 거부는 ALM 보안 이벤트', { skip }, async () => {
  const admin: CentralUser = { id: randomUUID(), email: 'admin@cen.test', displayName: 'Admin', isActive: true, linked: true, version: 1,
    roles: [{ role: 'SYS_ADMIN', scope: {} }] };
  central.users.set(admin.id, admin); ids.admin = admin.id;
  central.nextLogin = { ok: true, tenant: { id: randomUUID(), code: 'CEN' }, user: { id: admin.id, email: admin.email, displayName: 'Admin' },
    roles: admin.roles, created: false, linked: true };
  const t = (await tenantOf(app, 'T-CEN_admin'))!;
  const r = await centralLogin(app, central, t, { username: 'T-CEN_admin', email: 'admin@cen.test', emailVerified: true, idpType: 'OIDC' }, meta);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.principal.roles.map((x) => x.role), ['SYS_ADMIN']);
  assert.deepEqual(await q(`SELECT id, idp_subject, last_login_at IS NOT NULL AS logged FROM app_user WHERE email = 'admin@cen.test'`), [{ id: admin.id, idp_subject: 'admin', logged: true }]);
  // 두 번째 사용자: 범위 있는 역할
  const mgr: CentralUser = { id: randomUUID(), email: 'mgr@cen.test', displayName: 'Mgr', isActive: true, linked: true, version: 1,
    roles: [{ role: 'ASSET_MANAGER', scope: { company: '1000', site: 'ATL' } }] };
  central.users.set(mgr.id, mgr); ids.mgr = mgr.id;
  central.nextLogin = { ok: true, tenant: { id: randomUUID(), code: 'CEN' }, user: { id: mgr.id, email: mgr.email, displayName: 'Mgr' }, roles: mgr.roles, created: true, linked: false };
  const r2 = await centralLogin(app, central, (await tenantOf(app, 'T-CEN_mgr'))!, { username: 'T-CEN_mgr', email: 'mgr@cen.test', emailVerified: true, idpType: 'OIDC' }, meta);
  assert.deepEqual(r2.ok && r2.principal.roles[0].scope, { company: '1000', site: 'ATL' });
  assert.deepEqual(await q(`SELECT company_code, site_code FROM v_alm_user_role WHERE user_id = $1`, [mgr.id]), [{ company_code: '1000', site_code: 'ATL' }]);
  // 거부: 중앙 사유가 ALM에 없는 것(PRODUCT_NOT_ENABLED)은 NO_USER
  central.nextLogin = { ok: false, reason: 'PRODUCT_NOT_ENABLED' };
  const d = await centralLogin(app, central, t, { username: 'T-CEN_x', email: 'x@cen.test', emailVerified: true, idpType: 'OIDC' }, meta);
  assert.deepEqual(d, { ok: false, reason: 'NO_USER' });
  // 다른 테넌트 코드 결과는 받지 않음
  central.nextLogin = { ok: true, tenant: { id: randomUUID(), code: 'OTHER' }, user: { id: randomUUID(), email: 'o@cen.test', displayName: 'O' }, roles: [], created: false, linked: false };
  assert.equal((await centralLogin(app, central, t, { username: 'T-CEN_o', email: 'o@cen.test', emailVerified: true, idpType: 'OIDC' }, meta)).ok, false);
  const ev = await q(`SELECT event_type, detail->>'centralReason' AS r FROM security_event WHERE tenant_id = $1 AND event_type = 'LOGIN_DENIED' ORDER BY occurred_at`, [tenantId]);
  assert.equal(ev[0].r, 'PRODUCT_NOT_ENABLED');
});

test('관리 위임: 사용자 등록·수정·역할 교체는 중앙 → 미러, 프로필은 ALM에만, 중앙 오류(H-03)는 ALM 코드로', { skip }, async () => {
  const c = await call('admin', 'POST', '/admin/users', { email: 'Kim@cen.test', displayName: 'Kim', department: 'IT', costCenterId: ids.cc });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  ids.kim = c.body.id;
  assert.ok(central.users.has(ids.kim), '중앙에 먼저 생성(같은 ID)');
  assert.deepEqual([c.body.email, c.body.department, c.body.costCenterCode], ['kim@cen.test', 'IT', 'CC100']);
  const p = await call('admin', 'PATCH', `/admin/users/${ids.kim}`, { displayName: 'Kim J', department: 'Finance' });
  assert.deepEqual([p.status, p.body.displayName, p.body.department], [200, 'Kim J', 'Finance']);
  assert.equal(central.users.get(ids.kim)!.displayName, 'Kim J');
  const before = central.calls.length;
  await call('admin', 'PATCH', `/admin/users/${ids.kim}`, { department: 'Ops' });
  assert.equal(central.calls.length, before, '프로필만 바꾸면 중앙 호출 없음');
  const put = await call('admin', 'PUT', `/admin/users/${ids.kim}/roles`, { roles: [{ role: 'ASSET_MANAGER', siteCode: 'ATL' }, { role: 'ASSET_ACCOUNTANT' }] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.headers.get('x-sod-warning'), 'SOD-01');
  assert.deepEqual(central.users.get(ids.kim)!.roles.map((r) => r.role), ['ASSET_MANAGER', 'ASSET_ACCOUNTANT']);
  assert.deepEqual(put.body.roles.map((r: any) => `${r.role}${r.siteCode ? `@${r.siteCode}` : ''}`), ['ASSET_MANAGER@ATL', 'ASSET_ACCOUNTANT']);
  assert.equal((await call('admin', 'PUT', `/admin/users/${ids.kim}/roles`, { roles: [{ role: 'COUNTER', siteCode: 'NOPE' }] })).status, 400, 'ALM 마스터에 없는 범위 값은 중앙 호출 전에 거부');
  const self = await call('admin', 'PUT', `/admin/users/${ids.admin}/roles`, { roles: [] });
  assert.deepEqual([self.status, self.body.code], [403, 'ALM-E403'], 'H-03(중앙 판정) → ALM 코드');
  central.failRoles = E.lastAdmin();
  assert.equal((await call('admin', 'PUT', `/admin/users/${ids.kim}/roles`, { roles: [] })).body.code, 'ALM-E319');
  central.failRoles = undefined;
});

test('부서 관리자: 지정·기간 변경·해제를 중앙 역할로, 지정 행 ID는 기간을 바꿔도 유지', { skip }, async () => {
  const a = await call('admin', 'POST', '/admin/dept-managers', { costCenterId: ids.cc, email: 'dm@cen.test', displayName: 'Dept M', phone: '404-555-0100' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const u = [...central.users.values()].find((x) => x.email === 'dm@cen.test')!;
  assert.deepEqual(u.roles, [{ role: 'DEPT_MANAGER', scope: { costCenter: 'CC100' } }]);
  assert.equal(a.body.phone, '404-555-0100', '전화는 ALM에만');
  const p = await call('admin', 'PATCH', `/admin/dept-managers/${a.body.id}`, { validUntil: '2027-12-31' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.id, a.body.id, '행 ID 유지');
  assert.equal(central.users.get(u.id)!.roles[0].validUntil, '2027-12-31');
  assert.equal((await call('admin', 'DELETE', `/admin/dept-managers/${a.body.id}`)).status, 204);
  assert.deepEqual(central.users.get(u.id)!.roles, []);
  assert.deepEqual(await q(`SELECT 1 FROM user_role WHERE user_id = $1`, [u.id]), []);
});

test('변경 이벤트: 중앙에서 다시 읽어 미러 갱신, 다른 제품 역할 이벤트는 무시, 중앙에 없으면 비활성화, ALM 미사용 테넌트는 건너뜀', { skip }, async () => {
  central.users.get(ids.kim)!.roles = [{ role: 'COUNTER', scope: {} }];
  central.users.get(ids.kim)!.displayName = 'Kim (renamed)';
  const changed: string[] = [];
  const h = identityEventHandlers(app, central, (id) => changed.push(id));
  await h['assignment.changed']({ type: 'assignment.changed', tenantCode: 'CEN', userId: ids.kim, product: 'itsm' });
  assert.notDeepEqual(await q(`SELECT role FROM user_role WHERE user_id = $1`, [ids.kim]), [{ role: 'COUNTER' }], 'itsm 역할 이벤트는 무시');
  await h['assignment.changed']({ type: 'assignment.changed', tenantCode: 'CEN', userId: ids.kim, product: 'alm' });
  assert.deepEqual(await q(`SELECT role FROM user_role WHERE user_id = $1`, [ids.kim]), [{ role: 'COUNTER' }]);
  assert.equal((await q(`SELECT display_name FROM app_user WHERE id = $1`, [ids.kim]))[0].display_name, 'Kim (renamed)');
  assert.deepEqual(changed, [ids.kim]);
  central.users.delete(ids.kim);
  assert.equal(await refreshUser(app, central, 'CEN', ids.kim), 'deactivated');
  assert.equal(await refreshUser(app, central, 'NOTALM', ids.kim), 'skipped');
});

test('이관 내보내기: IdP 사용자 ID는 전체 사용자명(T-<테넌트>_…)으로, 역할·범위 포함', { skip }, async () => {
  const c = await owner;
  const users = await exportUsers(c, tenantId);
  const m = users.find((u) => u.email === 'mgr@cen.test')!;
  assert.equal(m.idpSubject, 'T-CEN_mgr');
  assert.deepEqual(m.roles, [{ role: 'ASSET_MANAGER', scope: { company: '1000', site: 'ATL' } }]);
  assert.ok(users.every((u) => typeof u.isActive === 'boolean'));
});

test('중앙 클라이언트: 토큰은 만료 전까지 재사용, 401이면 한 번 새로 받아 재시도, 오류 코드 변환, 로그인 거부는 사유로', async () => {
  const seen: string[] = [];
  let tokens = 0, fail401 = true;
  const http = (async (url: string, init: any) => {
    seen.push(`${init.method} ${url.replace('https://id.test', '')}`);
    if (url.endsWith('/oauth2/token')) { tokens++; return new Response(JSON.stringify({ access_token: `t${tokens}`, expires_in: 3600 }), { status: 200 }); }
    if (url.includes('/users/') && fail401) { fail401 = false; return new Response('{"code":"ID-E401"}', { status: 401 }); }
    if (url.endsWith('/roles')) return new Response(JSON.stringify({ code: 'ID-E421', message: 'x' }), { status: 409 });
    if (url.endsWith('/login/complete')) return new Response(JSON.stringify({ code: 'ID-E403', message: 'no', reason: 'INACTIVE' }), { status: 403 });
    return new Response(JSON.stringify({ id: 'u1', roles: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const cc = new CentralClient({ url: 'https://id.test', tokenUrl: 'https://id.test/oauth2/token', clientId: 'c', clientSecret: 's' }, http);
  assert.equal((await cc.getUser('CEN', 'u1'))?.id, 'u1');
  await cc.getUser('CEN', 'u1');
  assert.equal(tokens, 2, '401 뒤 한 번 새로');
  await assert.rejects(cc.putRoles('CEN', 'u1', 'a', []), (e: any) => e.code === 'ALM-E319');
  assert.deepEqual(await cc.login({ username: 'T-CEN_x', emailVerified: true, idpType: 'SAML' }), { ok: false, reason: 'INACTIVE' });
  assert.equal(tokens, 2);
});
