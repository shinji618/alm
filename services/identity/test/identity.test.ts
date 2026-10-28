// 중앙 ID 서비스(WBS 3.12) 시험: 로컬 PostgreSQL 16 + 가짜 Cognito
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, setup, teardown, host, ALM_CATALOG } from './helpers';
import { splitSql } from '../src/migrate';
import { toDataApi } from '../src/db';

const skip = !host && 'TEST_PG_HOST 없음';
let e: Env;
const ADMIN = 'tok:ops:admin';
let ALM = '', ALM_RO = '', ITSM = '';      // 제품 백엔드 토큰
const ids: Record<string, string> = {};
const body = (r: { body?: unknown }) => r.body as any;

before(async () => { if (!skip) e = await setup(); });
after(async () => { if (!skip) await teardown(e); });

test('단위: SQL 나누기($$ 본문·문자열 안의 ;), Data API 인자 변환', () => {
  assert.deepEqual(splitSql(`CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$; SELECT 'a;b'; -- 주석; x\nSELECT 2;`),
    [`CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$`, `SELECT 'a;b'`, 'SELECT 2']);
  const p = toDataApi('SELECT $1, $2, $10, $3, $4, $5, $6, $7, $8, $9', ['x', 1, 'ten', true, null, 'a5f1c0de-1111-4222-8333-444455556666', '2026-10-28', 1.5, { a: 1 }, 'n']);
  assert.equal(p.sql, 'SELECT :p1, :p2, :p10, :p3, :p4, :p5, :p6, :p7, :p8, :p9');
  assert.deepEqual(p.parameters.slice(1, 9).map((x: any) => x.typeHint ?? Object.keys(x.value)[0]),
    ['longValue', 'stringValue', 'booleanValue', 'isNull', 'UUID', 'DATE', 'doubleValue', 'JSON']);
});

test('인증: 토큰 없음 401, 모르는 클라이언트 403, /health는 인증 없음', { skip }, async () => {
  assert.equal((await e.call(undefined, 'GET', '/v1/tenants')).status, 401);
  assert.equal((await e.call('nope', 'GET', '/v1/tenants')).status, 401);
  assert.equal((await e.call('tok:unknown:read', 'GET', '/v1/tenants/X')).status, 403);
  assert.equal((await e.call(undefined, 'GET', '/health')).status, 200);
});

test('제품 등록: 카탈로그 검증, USER·MACHINE 클라이언트 생성(비밀은 한 번만), 다시 등록해도 클라이언트 그대로', { skip }, async () => {
  const bad = await e.call(ADMIN, 'POST', '/v1/products', { code: 'alm', name: 'ALM', catalog: { ...ALM_CATALOG, adminRole: 'NOPE' } });
  assert.equal(bad.status, 400); assert.ok(body(bad).errors.some((x: any) => x.field === 'catalog.adminRole'));
  const input = { code: 'alm', name: 'Asset Lifecycle Manager', catalog: ALM_CATALOG, userClients: [
    { name: 'alm-web', callbackUrls: ['https://alm-dev.example/api/v1/auth/callback'], logoutUrls: ['https://alm-dev.example/signed-out'], generateSecret: true },
    { name: 'alm-pda', callbackUrls: ['com.bsg.alm://auth'], logoutUrls: ['com.bsg.alm://signed-out'], accessMinutes: 60, refreshHours: 24 }] };
  const r = await e.call(ADMIN, 'POST', '/v1/products', input);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const made = body(r).createdClients;
  assert.deepEqual(made.map((c: any) => `${c.kind}:${c.name}`), ['USER:alm-web', 'USER:alm-pda', 'MACHINE:alm-backend']);
  assert.ok(made[0].clientSecret && !made[1].clientSecret && made[2].clientSecret);
  const machine = e.cognito.clients.get(made[2].clientId);
  assert.deepEqual(machine.AllowedOAuthFlows, ['client_credentials']);
  assert.deepEqual(machine.AllowedOAuthScopes, ['id-api/read', 'id-api/write']);
  ALM = `tok:${made[2].clientId}:read,write`; ALM_RO = `tok:${made[2].clientId}:read`;
  ids.almWeb = made[0].clientId;
  const again = await e.call(ADMIN, 'POST', '/v1/products', input);
  assert.equal(again.status, 201); assert.deepEqual(body(again).createdClients, []);
  const itsm = await e.call(ADMIN, 'POST', '/v1/products', { code: 'itsm', name: 'ITSM', catalog: { ...ALM_CATALOG, sodRules: [] },
    userClients: [{ name: 'itsm-web', callbackUrls: ['https://itsm.example/cb'], logoutUrls: ['https://itsm.example/out'] }] });
  ITSM = `tok:${body(itsm).createdClients.find((c: any) => c.kind === 'MACHINE').clientId}:read,write`;
  ids.itsmWeb = body(itsm).createdClients.find((c: any) => c.kind === 'USER').clientId;
  // 제품 백엔드는 제품 관리 불가
  assert.equal((await e.call(ALM, 'POST', '/v1/products', input)).status, 403);
  assert.equal((await e.call(ALM, 'GET', '/v1/products/alm')).status, 200);
  assert.equal((await e.call(ALM, 'GET', '/v1/products/itsm')).status, 404);
});

test('테넌트: 생성(도메인·제품), 중복 코드·도메인 409, 이메일로 찾기, 제품 클라이언트는 자기 제품 테넌트만', { skip }, async () => {
  const a = await e.call(ADMIN, 'POST', '/v1/tenants', { code: 'ACME', name: 'Acme', domains: ['Acme.com'], products: ['alm'], jitProvision: true });
  assert.equal(a.status, 201, JSON.stringify(a.body)); ids.acme = body(a).id;
  assert.deepEqual([body(a).domains, body(a).products], [['acme.com'], ['alm']]);
  const g = await e.call(ADMIN, 'POST', '/v1/tenants', { code: 'GLOBEX', name: 'Globex', domains: ['globex.com'], products: ['itsm'] });
  ids.globex = body(g).id;
  assert.equal((await e.call(ADMIN, 'POST', '/v1/tenants', { code: 'ACME', name: 'x' })).status, 409);
  assert.equal((await e.call(ADMIN, 'POST', '/v1/tenants', { code: 'NEW', name: 'x', domains: ['acme.com'] })).status, 409);
  assert.equal((await e.call(ADMIN, 'POST', '/v1/tenants', { code: 'bad_code', name: 'x' })).status, 400);
  assert.deepEqual(body(await e.call(ALM, 'GET', '/v1/tenants/lookup?email=kim@ACME.com')), { tenantCode: 'ACME', idpName: 'T-ACME' });
  assert.equal((await e.call(ALM, 'GET', '/v1/tenants/ACME')).status, 200);
  assert.equal((await e.call(ALM, 'GET', '/v1/tenants/GLOBEX')).status, 404, 'ALM을 쓰지 않는 테넌트는 보이지 않음');
  assert.equal((await e.call(ALM, 'GET', '/v1/tenants')).status, 403);
  assert.equal(e.events.filter((x) => x.type === 'tenant.updated').length, 2);
});

test('SSO 연결: IdP 등록 → 그 테넌트 제품의 USER 클라이언트에만 연결, 제품 추가 시 동기화, 삭제 시 분리', { skip }, async () => {
  const r = await e.call(ADMIN, 'PUT', '/v1/tenants/ACME/sso', { type: 'SAML', metadataUrl: 'https://login.microsoftonline.com/x/federationmetadata.xml' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(body(r).providerName, 'T-ACME'); assert.equal(body(r).acsUrl, 'https://auth.id-test.example/saml2/idpresponse');
  assert.deepEqual(e.cognito.clients.get(ids.almWeb).SupportedIdentityProviders, ['T-ACME']);
  assert.deepEqual(e.cognito.clients.get(ids.itsmWeb).SupportedIdentityProviders, ['COGNITO']);
  assert.equal((await e.call(ADMIN, 'PUT', '/v1/tenants/ACME/sso', { type: 'SAML', metadataUrl: 'http://insecure' })).status, 400);
  assert.equal(body(await e.call(ADMIN, 'GET', '/v1/tenants/ACME/sso')).type, 'SAML');
  await e.call(ADMIN, 'PATCH', '/v1/tenants/ACME', { products: ['alm', 'itsm'] });
  assert.deepEqual(e.cognito.clients.get(ids.itsmWeb).SupportedIdentityProviders, ['T-ACME'], '제품 추가 → 그 제품 클라이언트에도 연결');
  await e.call(ADMIN, 'PATCH', '/v1/tenants/ACME', { products: ['alm'] });
  assert.deepEqual(e.cognito.clients.get(ids.itsmWeb).SupportedIdentityProviders, ['COGNITO']);
  await e.call(ADMIN, 'PUT', '/v1/tenants/GLOBEX/sso', { type: 'OIDC', oidc: { issuer: 'https://accounts.google.com', clientId: 'g', clientSecret: 's' } });
  assert.equal((await e.call(ADMIN, 'DELETE', '/v1/tenants/GLOBEX/sso')).status, 200);
  assert.ok(!e.cognito.idps.has('T-GLOBEX'));
  assert.equal((await e.call(ADMIN, 'GET', '/v1/tenants/GLOBEX/sso')).status, 404);
});

test('사용자: 등록·목록·수정, 이메일 중복 409, 버전 충돌, H-10(미연결 사용자 이메일 변경 시 역할 삭제), 읽기 전용 토큰은 변경 불가', { skip }, async () => {
  const mk = async (email: string, displayName: string) => { const r = await e.call(ALM, 'POST', '/v1/tenants/ACME/users', { email, displayName }); assert.equal(r.status, 201, JSON.stringify(r.body)); return body(r).id as string; };
  ids.admin1 = await mk('Admin1@acme.com', 'Admin One');
  ids.admin2 = await mk('admin2@acme.com', 'Admin Two');
  ids.kim = await mk('kim@acme.com', 'Kim');
  assert.equal((await e.call(ALM, 'POST', '/v1/tenants/ACME/users', { email: 'kim@acme.com', displayName: 'dup' })).status, 409);
  assert.equal((await e.call(ALM_RO, 'POST', '/v1/tenants/ACME/users', { email: 'ro@acme.com', displayName: 'ro' })).status, 403);
  const list = body(await e.call(ALM_RO, 'GET', '/v1/tenants/ACME/users?sort=email'));
  assert.deepEqual(list.items.map((u: any) => u.email), ['admin1@acme.com', 'admin2@acme.com', 'kim@acme.com']);
  assert.equal(list.total, 3);
  const p = await e.call(ALM, 'PATCH', `/v1/tenants/ACME/users/${ids.kim}`, { displayName: 'Kim J', employeeNo: 'E1', version: 1 });
  assert.equal(p.status, 200); assert.equal(body(p).displayName, 'Kim J'); assert.equal(body(p).version, 2);
  assert.equal((await e.call(ALM, 'PATCH', `/v1/tenants/ACME/users/${ids.kim}`, { displayName: 'x', version: 1 })).status, 409);
  await e.call(ALM, 'PUT', `/v1/tenants/ACME/users/${ids.kim}/roles`, { roles: [{ role: 'COUNTER' }] });
  const h10 = await e.call(ALM, 'PATCH', `/v1/tenants/ACME/users/${ids.kim}`, { email: 'kim2@acme.com' });
  assert.equal(body(h10).rolesCleared, true); assert.deepEqual(body(h10).roles, []);
  assert.equal((await e.call(ITSM, 'GET', `/v1/tenants/ACME/users/${ids.kim}`)).status, 404, 'ITSM을 쓰지 않는 테넌트');
});

test('역할 부여: 범위·필수 범위·감사인 규칙, 자기 변경 금지(H-03), 마지막 관리자(H-04), SoD 경고, 변경 이벤트', { skip }, async () => {
  const put = (id: string, roles: unknown[], actor?: string) => e.call(ALM, 'PUT', `/v1/tenants/ACME/users/${id}/roles`, { roles }, actor ? { 'x-actor-id': actor } : {});
  assert.equal((await put(ids.admin1, [{ role: 'SYS_ADMIN' }])).status, 200);
  const dm = await put(ids.kim, [{ role: 'DEPT_MANAGER' }]);
  assert.equal(dm.status, 400); assert.ok(body(dm).errors.some((x: any) => x.field === 'roles[0].scope.costCenter' && /부서 관리자은\(는\) 코스트센터이\(가\) 필수/.test(x.message)));
  assert.equal((await put(ids.kim, [{ role: 'AUDITOR', validUntil: '2030-01-01' }])).status, 400, '감사인 최대 1년');
  assert.equal((await put(ids.kim, [{ role: 'AUDITOR', validUntil: '2026-12-31' }, { role: 'COUNTER' }])).status, 400, '배타 역할');
  assert.equal((await put(ids.kim, [{ role: 'COUNTER', scope: { plant: 'X' } }])).status, 400, '카탈로그에 없는 범위 차원');
  const ok = await put(ids.kim, [{ role: 'DEPT_MANAGER', scope: { costCenter: 'CC100' } }, { role: 'ASSET_ACCOUNTANT' }, { role: 'COUNTER', scope: { company: '1000', site: 'ATL' } }], ids.admin1);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.headers?.['x-sod-warning'], 'SOD-04');
  assert.match(body(ok).sod[0].description, /코스트센터 CC100/);
  assert.deepEqual(body(ok).roles.map((r: any) => r.role), ['DEPT_MANAGER', 'ASSET_ACCOUNTANT', 'COUNTER'], '카탈로그 순서');
  assert.deepEqual(body(ok).roles[2].scope, { company: '1000', site: 'ATL' });
  const ev = e.events.filter((x) => x.type === 'assignment.changed' && x.userId === ids.kim).pop();
  assert.deepEqual(ev, { type: 'assignment.changed', tenantId: ids.acme, tenantCode: 'ACME', userId: ids.kim, product: 'alm' });
  assert.equal((await put(ids.admin1, [{ role: 'COUNTER' }], ids.admin1)).status, 409, 'H-03');
  const last = await put(ids.admin1, [{ role: 'COUNTER' }], ids.admin2);
  assert.equal(last.status, 409); assert.equal(body(last).code, 'ID-E421', 'H-04');
  assert.equal((await e.call(ALM, 'PATCH', `/v1/tenants/ACME/users/${ids.admin1}`, { isActive: false }, { 'x-actor-id': ids.admin2 })).status, 409, '마지막 관리자 비활성화 금지');
  await put(ids.admin2, [{ role: 'SYS_ADMIN' }], ids.admin1);
  assert.equal((await put(ids.admin1, [{ role: 'COUNTER' }], ids.admin2)).status, 200, '다른 관리자가 있으면 회수 가능');
  const sod = body(await e.call(ALM_RO, 'GET', '/v1/tenants/ACME/sod-conflicts'));
  assert.deepEqual(sod.items.map((x: any) => `${x.displayName}:${x.rule}`), ['Kim J:SOD-04']);
  const valid = body(await e.call(ALM_RO, 'GET', `/v1/tenants/ACME/users/${ids.kim}/roles?valid=now`));
  assert.equal(valid.isActive, true); assert.equal(valid.roles.length, 3);
  // 변경 감사: 처리자 = 제품:사용자
  const log = (await e.owner.query(`SELECT DISTINCT actor FROM change_log WHERE table_name = 'role_assignment' AND (after->>'user_id') = $1`, [ids.kim])).rows;
  assert.ok(log.some((r) => r.actor === `alm:${ids.admin1}`));
});

test('로그인 완료: 테넌트·제품 확인, 미리 등록된 사용자 연결(SAML), 미검증 이메일 거부, JIT, 비활성, 감사인 만료, 보안 이벤트', { skip }, async () => {
  const login = (tok: string, b: object) => e.call(tok, 'POST', '/v1/login/complete', { idpType: 'SAML', emailVerified: false, ...b });
  assert.equal(body(await login(ALM, { username: 'T-NOPE_1', email: 'a@b.com' })).reason, 'NO_TENANT');
  assert.equal(body(await login(ITSM, { username: 'T-ACME_abc', email: 'admin2@acme.com' })).reason, 'PRODUCT_NOT_ENABLED');
  assert.equal(body(await login(ALM, { username: 'T-ACME_oidc1', email: 'admin2@acme.com', idpType: 'OIDC' })).reason, 'EMAIL_UNVERIFIED');
  const r = await login(ALM, { username: 'T-ACME_u-admin2', email: 'Admin2@acme.com', name: 'Admin Two' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(body(r).linked, true); assert.equal(body(r).user.id, ids.admin2); assert.deepEqual(body(r).roles.map((x: any) => x.role), ['SYS_ADMIN']);
  assert.equal(body(await login(ALM, { username: 'T-ACME_u-admin2', email: 'admin2@acme.com' })).linked, false, '두 번째부터는 idp_subject로');
  const jit = await login(ALM, { username: 'T-ACME_new', email: 'new@acme.com', name: 'New Person' });
  assert.equal(body(jit).created, true); assert.deepEqual(body(jit).roles, []);
  assert.ok(e.events.some((x) => x.type === 'user.created' && x.userId === body(jit).user.id));
  await e.call(ALM, 'PATCH', `/v1/tenants/ACME/users/${body(jit).user.id}`, { isActive: false });
  assert.equal(body(await login(ALM, { username: 'T-ACME_new', email: 'new@acme.com' })).reason, 'INACTIVE');
  // 감사인 만료 → 거부(직원으로 내려가지 않음)
  const aud = body(await e.call(ALM, 'POST', '/v1/tenants/ACME/users', { email: 'aud@acme.com', displayName: 'Auditor' })).id;
  await e.owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [ids.acme]);
  await e.owner.query(`INSERT INTO role_assignment (tenant_id, user_id, product_code, role, valid_until) VALUES ($1, $2, 'alm', 'AUDITOR', current_date - 1)`, [ids.acme, aud]);
  assert.equal(body(await login(ALM, { username: 'T-ACME_aud', email: 'aud@acme.com' })).reason, 'NO_VALID_ROLE');
  const evs = (await e.owner.query(`SELECT event_type, detail->>'reason' AS reason FROM security_event WHERE tenant_id = $1 ORDER BY occurred_at, event_type`, [ids.acme])).rows;
  assert.ok(evs.filter((x) => x.event_type === 'LOGIN').length >= 3);
  assert.deepEqual(evs.filter((x) => x.event_type === 'LOGIN_DENIED').map((x) => x.reason).sort(), ['EMAIL_UNVERIFIED', 'INACTIVE', 'NO_VALID_ROLE', 'PRODUCT_NOT_ENABLED']);
});

test('이관(3.13): 같은 ID로 사용자·역할 등록, 다시 실행하면 갱신, 이메일 충돌·규칙 위반은 건너뜀, 다른 제품·테넌트 불가', { skip }, async () => {
  const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333';
  const users: any[] = [
    { id: U1, email: 'Mig1@acme.com', displayName: 'Mig One', isActive: true, idpSubject: 'T-ACME_mig1', lastLoginAt: '2026-10-01T00:00:00.000Z',
      roles: [{ role: 'DEPT_MANAGER', scope: { costCenter: 'CC100' } }, { role: 'AUDITOR', validUntil: '2030-01-01' }] },
    { id: U2, email: 'mig2@acme.com', displayName: 'Mig Two', isActive: false, roles: [{ role: 'COUNTER', scope: { site: 'ATL' } }] },
    { id: U3, email: 'admin2@acme.com', displayName: 'dup email', roles: [] },
  ];
  const bad = await e.call(ALM, 'POST', '/v1/tenants/ACME/import', { users });
  assert.equal(bad.status, 200, JSON.stringify(bad.body));
  assert.deepEqual(body(bad).skipped.map((x: any) => x.id).sort(), [U1, U3], '배타 역할 위반·이메일 충돌');
  assert.equal(body(bad).created, 1);
  users[0].roles = [{ role: 'AUDITOR', validUntil: '2030-01-01' }];
  const r = await e.call(ALM, 'POST', '/v1/tenants/ACME/import', { users: users.slice(0, 2) });
  assert.deepEqual([body(r).created, body(r).updated, body(r).skipped.length], [1, 1, 0], JSON.stringify(body(r)));
  const u1 = body(await e.call(ALM_RO, 'GET', `/v1/tenants/ACME/users/${U1}`));
  assert.deepEqual([u1.email, u1.linked, u1.roles[0].role, u1.roles[0].validUntil], ['mig1@acme.com', true, 'AUDITOR', '2030-01-01'], '최대 1년 규칙은 이관에 적용 안 함');
  assert.equal(body(await e.call(ALM_RO, 'GET', `/v1/tenants/ACME/users/${U2}`)).isActive, false);
  const login = await e.call(ALM, 'POST', '/v1/login/complete', { username: 'T-ACME_mig1', email: 'mig1@acme.com', idpType: 'OIDC', emailVerified: true });
  assert.equal(body(login).user.id, U1, '이관한 사용자는 IdP 사용자 ID로 로그인 연결');
  assert.equal((await e.call(ITSM, 'POST', '/v1/tenants/ACME/import', { users })).status, 404, 'ACME는 ITSM을 쓰지 않음');
  assert.equal((await e.call(ALM_RO, 'POST', '/v1/tenants/ACME/import', { users })).status, 403);
});

test('RLS: 앱 계정은 설정한 테넌트의 행만 본다, 테넌트 없이 사용자 표를 읽으면 0건', { skip }, async () => {
  const c = await e.appPool.connect();
  try {
    const count = async (t: string) => { await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t]);
      const n = (await c.query(`SELECT count(*)::int AS n FROM app_user`)).rows[0].n; await c.query('ROLLBACK'); return n; };
    assert.ok((await count(ids.acme)) >= 4);
    assert.equal(await count(ids.globex), 0);
    assert.equal(await count(''), 0);
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.globex]);
    await assert.rejects(c.query(`INSERT INTO app_user (tenant_id, email, display_name) VALUES ($1, 'x@acme.com', 'x')`, [ids.acme]), /row-level security/);
    await c.query('ROLLBACK');
    await assert.rejects(c.query(`DELETE FROM change_log`), /permission denied/);
  } finally { c.release(); }
});
