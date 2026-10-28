// 특성화 시험(WBS 3.9): 공통 엔진 분리(사용자 관리·권한 → 중앙 ID 서비스) 전에 "지금 동작"을 고정한다.
// 이 파일의 단언은 현재 코드의 실제 동작을 기록한 것이다(바람직한 동작의 주장이 아님). 리팩터링 중 값이 바뀌면 의도한 변경인지 먼저 확인한다.
// 범위: 권한 카탈로그(유효 역할·권한 합산), 범위 SQL(assetScope·allowsPlace), PrincipalCache, parseRoles 검증, 사용자 목록·등록·수정·역할 지정 API.
// 앞부분(단위)은 DB 없이, 뒷부분(API)은 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { PrincipalCache } from '../src/platform/identity/principal';
import type { Principal } from '../src/platform/identity/principal';
import { catalog, effectiveRoles, permissionsOf, permissionFor } from '../src/platform/identity/permissions';
import { Params, assetScope, allowsPlace, scopeRows, can } from '../src/auth/scope';
import { createApi } from '../src/main';
import { parseRoles } from '../src/platform/identity/users';
import { almIdentity } from '../src/admin/identityAdapter';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_chu_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

// ---------- 단위: 권한 카탈로그 ----------
test('유효 역할: 암묵 EMPLOYEE 추가, 감사인은 배타(그것만), 중복 제거', () => {
  assert.deepEqual(effectiveRoles([]), ['EMPLOYEE']);
  assert.deepEqual(effectiveRoles(['ASSET_MANAGER']).sort(), ['ASSET_MANAGER', 'EMPLOYEE']);
  assert.deepEqual(effectiveRoles(['AUDITOR']), ['AUDITOR'], '감사인이면 EMPLOYEE도 붙지 않음');
  assert.deepEqual(effectiveRoles(['AUDITOR', 'ASSET_MANAGER']), ['AUDITOR'], '배타 역할이 다른 역할을 가림');
  assert.deepEqual(effectiveRoles(['EMPLOYEE', 'EMPLOYEE']), ['EMPLOYEE']);
  assert.deepEqual(catalog().exclusiveRoles, ['AUDITOR']);
  assert.deepEqual(catalog().implicit, { role: 'EMPLOYEE', excludedIf: ['AUDITOR'] });
});

test('권한 합산: auth는 항상 있음, 같은 키에 ALL이 있으면 ALL 하나로, 역할별 권한 보유', () => {
  assert.deepEqual(permissionsOf(['EMPLOYEE']).get('auth'), ['-']);
  assert.ok(permissionsOf(['EMPLOYEE']).has('request.create') && !permissionsOf(['EMPLOYEE']).has('admin.user'));
  assert.deepEqual([...permissionsOf([]).keys()], ['auth'], '역할이 없으면 auth만');
  const g = catalog().grants;
  const allWins = Object.keys(g.ASSET_MANAGER).find((k) => g.ASSET_MANAGER[k] === 'ALL' && g.EMPLOYEE[k] && g.EMPLOYEE[k] !== 'ALL');
  if (allWins) assert.deepEqual(permissionsOf(['EMPLOYEE', 'ASSET_MANAGER']).get(allWins), ['ALL']);
  assert.ok(permissionsOf(['ASSET_ACCOUNTANT']).has('sap.finance') && permissionsOf(['ASSET_ACCOUNTANT']).has('approval.decide'));
  assert.ok(!permissionsOf(['SYS_ADMIN']).has('sap.finance'), '시스템 관리자는 전기 보정 권한 없음');
  assert.ok(permissionsOf(['SYS_ADMIN']).has('admin.user') && !permissionsOf(['ASSET_MANAGER']).has('admin.user'));
});

test('작업 → 권한 키: 로그인 단계는 null, 모르는 작업은 undefined, 승인·보정·승인함 키', () => {
  assert.deepEqual(permissionFor('approve'), ['approval.decide', 'asset.write'], '배열이면 둘 중 하나(OR)');
  assert.deepEqual(permissionFor('reject'), ['approval.decide', 'asset.write']);
  assert.equal(permissionFor('fixAssetRequest'), 'sap.finance');
  assert.equal(permissionFor('no-such-operation'), undefined);
  assert.equal(permissionFor('createAssetRequest'), 'request.create');
  assert.deepEqual(permissionFor('listApprovalInbox'), ['approval.decide', 'asset.write']);
  assert.ok(Object.values(catalog().operations).some((v) => v === null), '인증 없이 호출하는 작업(로그인 단계)이 있음');
});

// ---------- 단위: 범위 SQL ----------
const DIM: Record<string, string> = { companyCode: 'company', siteCode: 'site', costCenterCode: 'costCenter' };
const who = (rows: Record<string, string>[]): Principal => {
  const roles = rows.map((r) => ({ role: r.role, scope: Object.fromEntries(Object.entries(r).filter(([k]) => DIM[k]).map(([k, v]) => [DIM[k], v])) }));
  const eff = effectiveRoles(roles.map((r) => r.role));
  return { tenantId: 't', tenantCode: 'T', userId: 'u-1', email: 'u@x.test', displayName: 'U', locale: 'ko', roles, effectiveRoles: eff, permissions: permissionsOf(eff) } as unknown as Principal;
};
test('범위 SQL: ALL(범위 없음)=true, 회사·사이트 제한, CC는 코스트센터 행, OWN은 본인 할당, 행들은 OR, 권한 없으면 false', () => {
  const mgr = who([{ role: 'ASSET_MANAGER' }]);
  assert.equal(assetScope(mgr, 'asset.read', new Params()), 'true');
  const scoped = who([{ role: 'ASSET_MANAGER', companyCode: '1000', siteCode: 'ATL' }]);
  const ps = new Params();
  assert.match(assetScope(scoped, 'asset.read', ps), /company_id IN .*company_code = \$1.*AND.*site_id IN .*site_code = \$2/s);
  assert.deepEqual(ps.values, ['1000', 'ATL', 'u-1'], '역할 행 범위 + 암묵 직원(OWN) 행의 본인 id 순서로 파라미터가 쌓임');
  assert.equal(allowsPlace(scoped, 'asset.write', '1000', 'ATL'), true);
  assert.equal(allowsPlace(scoped, 'asset.write', '1000', 'DAL'), false);
  assert.equal(allowsPlace(scoped, 'asset.write', '2000', 'ATL'), false);
  assert.equal(allowsPlace(mgr, 'asset.write', '9999', null), true);
  const emp = who([]);
  const pe = new Params();
  assert.match(assetScope(emp, 'asset.read', pe), /assigned_user_id = \$1/);
  assert.deepEqual(pe.values, ['u-1'], '직원은 본인 할당 자산만');
  const dm = who([{ role: 'DEPT_MANAGER', costCenterCode: 'CC100' }]);
  const dsql = assetScope(dm, 'asset.read', new Params());
  assert.match(dsql, /cost_center_id IN .*cost_center_code = \$1/s);
  assert.equal(assetScope(emp, 'admin.user', new Params()), 'false');
  assert.equal(can(emp, 'admin.user'), false); assert.equal(can(mgr, 'asset.read'), true);
  assert.deepEqual(scopeRows(emp, 'admin.user'), []);
});

// ---------- 단위: PrincipalCache ----------
test('PrincipalCache: TTL 안에서는 로더 1회, 없는 사용자도 캐시, 용량 초과 시 오래된 것 제거, clearUser·clear', async () => {
  const c = new PrincipalCache(50, 2);
  let n = 0;
  const mk = (id: string) => async () => { n += 1; return { userId: id } as Principal; };
  const none = async () => { n += 1; return undefined; };
  assert.equal((await c.get('k1', mk('u1')))?.userId, 'u1');
  assert.equal((await c.get('k1', mk('u1')))?.userId, 'u1'); assert.equal(n, 1);
  assert.equal(await c.get('missing', none), undefined);
  assert.equal(await c.get('missing', none), undefined); assert.equal(n, 2, '부재(null)도 TTL 동안 캐시');
  await c.get('k3', mk('u3')); assert.equal(n, 3);
  await c.get('k1', mk('u1')); assert.equal(n, 4, '용량 초과 시 가장 오래된 항목부터 제거');
  c.clearUser('u1'); await c.get('k1', mk('u1')); assert.equal(n, 5);
  c.clear('k1'); await c.get('k1', mk('u1')); assert.equal(n, 6);
  await new Promise((r) => setTimeout(r, 70));
  await c.get('k1', mk('u1')); assert.equal(n, 7, 'TTL 지나면 다시 로드');
  c.clear(); await c.get('k3', mk('u3')); assert.equal(n, 8);
});

// ---------- 단위: parseRoles ----------
const rolesErr = (b: unknown, now = '2026-10-27') => { try { parseRoles(b, almIdentity, now); return []; } catch (e) { return ((e as { detail?: { errors?: { field: string }[] } }).detail?.errors ?? []).map((x) => x.field); } };
test('parseRoles 검증: 필수·형식·기간·중복·감사인 규칙', () => {
  assert.deepEqual(parseRoles({ roles: [] }, almIdentity), []);
  assert.deepEqual(rolesErr({}), ['roles'], 'roles 필수');
  assert.deepEqual(rolesErr({ roles: [{ role: 'NOPE' }] }), ['roles[0].role']);
  assert.deepEqual(rolesErr({ roles: [{ role: 'COUNTER', validFrom: '2026-12-31', validUntil: '2026-01-01' }] }), ['roles[0].validUntil']);
  assert.equal(rolesErr({ roles: [{ role: 'COUNTER', validFrom: '2026-13-01' }] }).length, 1, '날짜 형식 검사');
  assert.deepEqual(rolesErr({ roles: [{ role: 'DEPT_MANAGER' }] }), ['roles[0].costCenterCode']);
  assert.deepEqual(rolesErr({ roles: [{ role: 'AUDITOR' }] }), ['roles[0].validUntil'], '감사인은 종료일 필수');
  assert.deepEqual(rolesErr({ roles: [{ role: 'COUNTER' }, { role: 'COUNTER' }] }), ['roles'], '같은 역할·범위 중복');
  assert.doesNotThrow(() => parseRoles({ roles: [{ role: 'COUNTER', siteCode: 'ATL' }, { role: 'COUNTER', siteCode: 'DAL' }] }, almIdentity), '범위가 다르면 같은 역할 허용');
  assert.ok(rolesErr({ roles: Array.from({ length: 51 }, () => ({ role: 'COUNTER' })) }).length > 0, '최대 50행');
  assert.deepEqual(rolesErr({ roles: [{ role: 'AUDITOR', validUntil: '2027-10-27' }, { role: 'COUNTER' }] }), ['roles'], 'H-05');
  assert.equal(parseRoles({ roles: [{ role: 'AUDITOR', validUntil: '2027-10-27' }] }, almIdentity, '2026-10-27')[0].validUntil, '2027-10-27', '정확히 1년은 허용');
  assert.deepEqual(rolesErr({ roles: [{ role: 'AUDITOR', validUntil: '2027-10-28' }] }), ['roles[0].validUntil']);
});

// ---------- 통합: 사용자 관리 API ----------
let owner: Client, app: Db, tenantId: string, base: string, close: () => Promise<unknown>;
const ids: Record<string, string> = {};
const cfg: Config = {
  env: 'dev', region: 'us-east-1', port: 0, db: { host: host ?? '', port, name: dbName, user: 'alm_app_login', ssl: false },
  cognito: { userPoolId: 'p', webClientId: 'web', webClientSecret: 's', pdaClientId: 'pda', domain: 'auth.example.test' },
  appOrigin: 'https://alm.example.test', cookieKeys: [Buffer.alloc(32, 1)],
};
const fakeCognito = {
  verifyAccess: async (t: string) => { const [, u, c] = t.split(':'); if (!u) throw new Error('bad'); return { sub: 's', username: u, client_id: c, token_use: 'access', exp: 0 }; },
};
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-CHU_${who}:web`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const NOID = '00000000-0000-4000-8000-000000000001';

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 4 }));
  tenantId = (await seed(owner, { tenant: { code: 'CHU', name: 'Characterization users', idpType: 'OIDC' }, domains: ['chu.test'],
    users: [{ email: 'a1@chu.test', displayName: 'Alice Admin', roles: ['SYS_ADMIN'] }, { email: 'a2@chu.test', displayName: 'Bob Admin', roles: ['SYS_ADMIN'] },
      { email: 'emp@chu.test', displayName: 'Carol Employee', roles: [] }, { email: 'mgr@chu.test', displayName: 'Dave Manager', roles: ['ASSET_MANAGER'] }] })).tenantId;
  for (const u of ['a1', 'a2', 'emp', 'mgr']) ids[u] = (await q(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@chu.test`]))[0].id;
  const co = (await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG US') RETURNING id`, [tenantId]))[0].id;
  ids.cc = (await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [tenantId, co]))[0].id;
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

test('사용자 목록: 이름순 기본, 정렬·내림차순·검증, 검색(이메일·이름, % 이스케이프), 역할 필터, 페이징', { skip }, async () => {
  const d = await call('a1', 'GET', '/admin/users');
  assert.deepEqual(d.body.items.map((u: { displayName: string }) => u.displayName), ['Alice Admin', 'Bob Admin', 'Carol Employee', 'Dave Manager']);
  assert.deepEqual([d.body.page, d.body.pageSize, d.body.total], [1, 50, 4]);
  assert.ok(['id', 'email', 'displayName', 'isActive', 'roles'].every((k) => k in d.body.items[0]), '응답 필드');
  assert.deepEqual((await call('a1', 'GET', '/admin/users?sort=-email')).body.items.map((u: { email: string }) => u.email),
    ['mgr@chu.test', 'emp@chu.test', 'a2@chu.test', 'a1@chu.test']);
  assert.equal((await call('a1', 'GET', '/admin/users?sort=password')).status, 400);
  assert.equal((await call('a1', 'GET', '/admin/users?role=NOPE')).status, 400);
  assert.deepEqual((await call('a1', 'GET', '/admin/users?role=ASSET_MANAGER')).body.items.map((u: { email: string }) => u.email), ['mgr@chu.test']);
  assert.equal((await call('a1', 'GET', '/admin/users?role=SYS_ADMIN')).body.total, 2);
  assert.equal((await call('a1', 'GET', '/admin/users?q=carol')).body.total, 1, '이름 검색(대소문자 무시)');
  assert.equal((await call('a1', 'GET', '/admin/users?q=chu.test')).body.total, 4, '이메일 검색');
  assert.equal((await call('a1', 'GET', '/admin/users?q=%25')).body.total, 0, '% 는 문자 그대로');
  assert.equal((await call('a1', 'GET', '/admin/users?pageSize=999')).body.pageSize, 200);
  assert.equal((await call('a1', 'GET', '/admin/users?pageSize=0')).body.pageSize, 50);
  const p2 = await call('a1', 'GET', '/admin/users?pageSize=3&page=2');
  assert.deepEqual([p2.body.items.length, p2.body.total], [1, 4]);
});

test('사용자 등록·수정: 이메일 소문자·중복(대소문자 무시), 코스트센터 검증, 권한, 부분 갱신, 없는 id 404', { skip }, async () => {
  const ok = await call('a1', 'POST', '/admin/users', { email: 'Erin@CHU.test', displayName: 'Erin', employeeNo: 'E-100', department: 'IT', costCenterId: ids.cc });
  assert.equal(ok.status, 201); assert.equal(ok.body.email, 'erin@chu.test'); assert.equal(ok.body.costCenterCode, 'CC100'); assert.equal(ok.body.employeeNo, undefined, '사번·IdP subject는 응답에 싣지 않음'); assert.equal(ok.body.isActive, true);
  ids.erin = ok.body.id;
  assert.equal((await call('a1', 'POST', '/admin/users', { email: 'x@chu.test', displayName: 'X', costCenterId: NOID })).status, 400, '없는 코스트센터');
  assert.equal((await call('a1', 'POST', '/admin/users', { email: 'x@chu.test', displayName: 'X', costCenterId: 'abc' })).status, 400);
  assert.equal((await call('a1', 'POST', '/admin/users', { email: 'ERIN@chu.test', displayName: 'dup' })).body.code, 'ALM-E321');
  assert.equal((await call('a1', 'POST', '/admin/users', { email: 'long'.padEnd(250, 'a') + '@chu.test', displayName: 'L' })).status, 400, '이메일 254자 제한');
  assert.equal((await call('emp', 'POST', '/admin/users', { email: 'z@chu.test', displayName: 'Z' })).status, 403);
  assert.equal((await call('mgr', 'GET', '/admin/users')).status, 403, '자산 관리자도 사용자 관리 불가');
  const p = await call('a1', 'PATCH', `/admin/users/${ids.erin}`, { department: 'Finance' });
  assert.equal(p.status, 200); assert.equal(p.body.department, 'Finance'); assert.equal(p.body.displayName, 'Erin', '안 보낸 필드는 그대로');
  assert.equal((await call('a1', 'PATCH', `/admin/users/${ids.erin}`, { email: 'dup@x', displayName: '' })).status, 400);
  assert.equal((await call('a1', 'PATCH', `/admin/users/${NOID}`, { department: 'x' })).status, 404);
  assert.equal((await call('a1', 'PATCH', `/admin/users/${ids.erin}`, { email: 'erin@chu.test' })).status, 200, '같은 이메일로 수정은 허용');
});

test('역할 지정: 전체 교체, 기간 지난 역할은 역할 필터에서 제외, 범위 코드 해석, 검증 실패 시 저장값 유지', { skip }, async () => {
  const put = await call('a1', 'PUT', `/admin/users/${ids.erin}/roles`, { roles: [
    { role: 'COUNTER', validUntil: '2020-01-01' }, { role: 'DEPT_MANAGER', costCenterCode: 'CC100' }] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.roles.length, 2);
  assert.equal((await call('a1', 'GET', '/admin/users?role=COUNTER')).body.total, 0, '유효기간이 지난 역할은 필터에서 제외');
  assert.deepEqual((await call('a1', 'GET', '/admin/users?role=DEPT_MANAGER')).body.items.map((u: { email: string }) => u.email), ['erin@chu.test']);
  assert.equal((await call('a1', 'PUT', `/admin/users/${ids.erin}/roles`, { roles: [{ role: 'COUNTER', companyCode: '9999' }] })).status, 400, '없는 회사 코드');
  assert.equal((await call('a1', 'PUT', `/admin/users/${ids.erin}/roles`, { roles: [{ role: 'COUNTER' }, { role: 'COUNTER' }] })).status, 400, '중복 역할');
  assert.equal((await call('emp', 'PUT', `/admin/users/${ids.erin}/roles`, { roles: [] })).status, 403);
  assert.deepEqual((await q(`SELECT role::text AS role FROM user_role WHERE user_id = $1`, [ids.erin])).map((r) => r.role).sort(), ['COUNTER', 'DEPT_MANAGER'], '검증 실패는 저장값을 바꾸지 않음');
  const clear = await call('a1', 'PUT', `/admin/users/${ids.erin}/roles`, { roles: [] });
  assert.equal(clear.status, 200); assert.deepEqual(clear.body.roles, []);
});

test('권한 변경은 같은 인스턴스에서 바로 반영: 역할 부여 → 관리 API 200, 회수 → 403', { skip }, async () => {
  assert.equal((await call('emp', 'GET', '/admin/users')).status, 403);
  assert.equal((await call('a1', 'PUT', `/admin/users/${ids.emp}/roles`, { roles: [{ role: 'SYS_ADMIN' }] })).status, 200);
  assert.equal((await call('emp', 'GET', '/admin/users')).status, 200, '캐시가 바로 지워져 즉시 반영');
  assert.equal((await call('a1', 'PUT', `/admin/users/${ids.emp}/roles`, { roles: [] })).status, 200);
  assert.equal((await call('emp', 'GET', '/admin/users')).status, 403);
  assert.equal((await call('emp', 'GET', '/me')).status, 200);
});
