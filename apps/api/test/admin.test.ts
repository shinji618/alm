// 관리 API(사용자·역할·직무 충돌·코드·설정) 통합 시험. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { seed } from '../src/ops/seed';
import { Db } from '../src/db/pool';
import { PrincipalCache } from '../src/platform/identity/principal';
import { catalog } from '../src/platform/identity/permissions';
import { createApi } from '../src/main';
import { putUserRoles, parseRoles } from '../src/platform/identity/users';
import { sodConflicts } from '../src/platform/identity/sod';
import { almIdentity } from '../src/admin/identityAdapter';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_admin_${Date.now()}`;
catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

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

// 사용자 이름(Cognito username = T-ADM_<sub>)으로 호출
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-ADM_${who}:web`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
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
  tenantId = (await seed(owner, { tenant: { code: 'ADM', name: 'Admin test', idpType: 'OIDC' }, domains: ['adm.test'],
    users: [{ email: 'a1@adm.test', displayName: 'Admin One', roles: ['SYS_ADMIN'] },
            { email: 'a2@adm.test', displayName: 'Admin Two', roles: ['SYS_ADMIN'] },
            { email: 'emp@adm.test', displayName: 'Employee', roles: [] }] })).tenantId;
  // 로그인한 것처럼 IdP 연결(idp_subject = 이름 앞부분)
  for (const u of ['a1', 'a2', 'emp']) {
    ids[u] = (await owner.query(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@adm.test`])).rows[0].id;
  }
  const co = (await owner.query(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG US') RETURNING id`, [tenantId])).rows[0].id;
  await owner.query(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id)
                     VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2)`, [tenantId, co]);
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

test('직무 충돌 규칙(단위)', () => {
  assert.deepEqual(sodConflicts([{ role: 'ASSET_MANAGER', scope: {} }, { role: 'ASSET_ACCOUNTANT', scope: {} }]).map((h) => h.rule), ['SOD-01']);
  assert.deepEqual(sodConflicts([{ role: 'SYS_ADMIN', scope: {} }, { role: 'ASSET_MANAGER', scope: {} }, { role: 'ASSET_ACCOUNTANT', scope: {} }]).map((h) => h.rule), ['SOD-01', 'SOD-02', 'SOD-03']);
  assert.deepEqual(sodConflicts([{ role: 'DEPT_MANAGER', scope: { costCenter: 'C1' } }, { role: 'ASSET_ACCOUNTANT', scope: { costCenter: 'C2' } }]), []);
  assert.deepEqual(sodConflicts([{ role: 'DEPT_MANAGER', scope: { costCenter: 'C1' } }, { role: 'ASSET_ACCOUNTANT', scope: {} }]).map((h) => h.rule), ['SOD-04']);
  assert.throws(() => parseRoles({ roles: [{ role: 'AUDITOR', validUntil: '2027-10-12' }] }, almIdentity, '2026-10-11'), /최대 1년/);
  assert.doesNotThrow(() => parseRoles({ roles: [{ role: 'AUDITOR', validUntil: '2027-10-11' }] }, almIdentity, '2026-10-11'));
});

test('권한: 일반 사용자는 관리 API 403 ALM-E401, 관리자는 200', { skip }, async () => {
  const r = await call('emp', 'GET', '/admin/users');
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ALM-E401');
  const ok = await call('a1', 'GET', '/admin/users?sort=email');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.total, 3);
  assert.deepEqual(ok.body.items.map((u: { email: string }) => u.email), ['a1@adm.test', 'a2@adm.test', 'emp@adm.test']);
});

test('사용자 등록: 검증 오류 목록, 이메일 중복 409 ALM-E321', { skip }, async () => {
  const bad = await call('a1', 'POST', '/admin/users', { email: 'nope', displayName: '' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: { field: string }) => e.field).sort(), ['displayName', 'email']);
  const notJson = await call('a1', 'POST', '/admin/users', '{bad json');
  assert.equal(notJson.status, 400); assert.equal(notJson.body.code, 'ALM-E100');
  const c = await call('a1', 'POST', '/admin/users', { email: 'New.Person@Adm.test', displayName: '새 사람', department: 'IT' });
  assert.equal(c.status, 201);
  assert.equal(c.body.email, 'new.person@adm.test');
  assert.deepEqual(c.body.roles, []);
  ids.new = c.body.id;
  const dup = await call('a1', 'POST', '/admin/users', { email: 'new.person@adm.test', displayName: 'x' });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'ALM-E321');
  const search = await call('a1', 'GET', '/admin/users?q=new.per&pageSize=1');
  assert.equal(search.body.total, 1); assert.equal(search.body.pageSize, 1);
});

test('역할 지정: H-03 자기 자신, H-05 감사인 단독, DEPT_MANAGER 코스트센터, 없는 코드', { skip }, async () => {
  const self = await call('a1', 'PUT', `/admin/users/${ids.a1}/roles`, { roles: [] });
  assert.equal(self.status, 403); assert.equal(self.body.code, 'ALM-E403');
  const mixed = await call('a1', 'PUT', `/admin/users/${ids.new}/roles`, { roles: [{ role: 'AUDITOR', validUntil: '2027-01-31' }, { role: 'ASSET_MANAGER' }] });
  assert.equal(mixed.status, 400);
  const dm = await call('a1', 'PUT', `/admin/users/${ids.new}/roles`, { roles: [{ role: 'DEPT_MANAGER' }] });
  assert.equal(dm.status, 400); assert.equal(dm.body.errors[0].field, 'roles[0].costCenterCode');
  const unknown = await call('a1', 'PUT', `/admin/users/${ids.new}/roles`, { roles: [{ role: 'DEPT_MANAGER', costCenterCode: 'NOPE' }] });
  assert.equal(unknown.status, 400);
  assert.equal((await call('a1', 'PUT', `/admin/users/${randomUUID()}/roles`, { roles: [] })).status, 404);
});

test('역할 지정: 저장 + X-SoD-Warning, 직무 충돌 목록, 감사 로그', { skip }, async () => {
  const r = await call('a1', 'PUT', `/admin/users/${ids.new}/roles`, { roles: [
    { role: 'ASSET_MANAGER' }, { role: 'ASSET_ACCOUNTANT' }, { role: 'DEPT_MANAGER', costCenterCode: 'CC100' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('x-sod-warning'), 'SOD-01, SOD-04');
  assert.deepEqual(r.body.roles.map((x: { role: string }) => x.role).sort(), ['ASSET_ACCOUNTANT', 'ASSET_MANAGER', 'DEPT_MANAGER']);
  assert.equal(r.body.roles.find((x: { role: string }) => x.role === 'DEPT_MANAGER').costCenterCode, 'CC100');
  const sod = await call('a1', 'GET', '/admin/sod-conflicts');
  assert.deepEqual(sod.body.items.filter((i: { userId: string }) => i.userId === ids.new).map((i: { rule: string }) => i.rule), ['SOD-01', 'SOD-04']);
  const audit = (await owner.query(`SELECT count(*)::int AS n, min(actor_type) AS t, min(actor_id::text) AS a FROM audit_log
                                    WHERE table_name = 'user_role' AND action = 'INSERT' AND (after->>'user_id') = $1`, [ids.new])).rows[0];
  assert.deepEqual(audit, { n: 3, t: 'USER', a: ids.a1 });
  // 다시 지정하면 전체 교체
  const again = await call('a1', 'PUT', `/admin/users/${ids.new}/roles`, { roles: [{ role: 'COUNTER', validUntil: '2026-12-31' }] });
  assert.deepEqual(again.body.roles, [{ role: 'COUNTER', validUntil: '2026-12-31' }]);
  assert.equal(again.headers.get('x-sod-warning'), null);
});

test('H-04 마지막 시스템 관리자(함수 단위, API로는 호출자가 항상 관리자라 방어용)', { skip }, async () => {
  await assert.rejects(app.withTx({ tenantId, userId: ids.emp, actorType: 'USER' }, async (c) => {
    await c.query(`DELETE FROM user_role_scope WHERE user_role_id IN (SELECT id FROM user_role WHERE user_id = $1)`, [ids.a2]);
    await c.query(`DELETE FROM user_role WHERE user_id = $1`, [ids.a2]);    // a2를 먼저 빼서 a1만 남김
    return putUserRoles(c, almIdentity, tenantId, ids.a1, ids.emp, { roles: [] });
  }), (e: { code: string }) => e.code === 'ALM-E319');
});

test('사용자 수정: 미연결 이메일 변경은 역할 삭제(H-10), 연결 사용자 이메일 400, 자기 비활성 403, 비활성 사용자는 403 ALM-E405', { skip }, async () => {
  const p = await call('a1', 'PATCH', `/admin/users/${ids.new}`, { email: 'renamed@adm.test' });
  assert.equal(p.status, 200); assert.equal(p.body.email, 'renamed@adm.test'); assert.deepEqual(p.body.roles, []);
  const linked = await call('a1', 'PATCH', `/admin/users/${ids.emp}`, { email: 'x@adm.test' });
  assert.equal(linked.status, 400);
  const self = await call('a1', 'PATCH', `/admin/users/${ids.a1}`, { isActive: false });
  assert.equal(self.status, 403);
  assert.equal((await call('emp', 'GET', '/me')).status, 200);
  const off = await call('a1', 'PATCH', `/admin/users/${ids.emp}`, { isActive: false, department: '퇴사' });
  assert.equal(off.status, 200); assert.equal(off.body.isActive, false); assert.equal(off.body.department, '퇴사');
  const me = await call('emp', 'GET', '/me');   // 같은 인스턴스 캐시는 바로 지움
  assert.equal(me.status, 403); assert.equal(me.body.code, 'ALM-E405');
});

test('공통 코드: 그룹 교체, 빠진 코드는 비활성, 경로·본문 그룹 불일치 400', { skip }, async () => {
  const put = (codes: unknown[]) => call('a1', 'PUT', '/admin/codes/DISPOSAL_REASON', { group: 'DISPOSAL_REASON', codes });
  assert.equal((await put([{ code: 'BROKEN', labelEn: 'Broken', labelKo: '고장' }, { code: 'LOST', labelEn: 'Lost' }])).status, 200);
  const r = await put([{ code: 'BROKEN', labelEn: 'Broken (beyond repair)', labelKo: '고장', sortOrder: 1 }]);
  assert.deepEqual(r.body, { group: 'DISPOSAL_REASON', codes: [
    { code: 'BROKEN', labelEn: 'Broken (beyond repair)', labelKo: '고장', sortOrder: 1, isActive: true },
    { code: 'LOST', labelEn: 'Lost', sortOrder: 20, isActive: false }] });
  assert.equal((await call('a1', 'PUT', '/admin/codes/X', { group: 'Y', codes: [] })).status, 400);
  assert.equal((await call('a1', 'GET', '/admin/codes')).body.items.length, 1);
  assert.equal((await call('emp', 'GET', '/admin/codes')).status, 403);
});

test('설정: 키별 형식 검사, 모르는 키 400, 라이선스 준수 뷰가 읽는 형식(숫자)', { skip }, async () => {
  assert.equal((await call('a1', 'PUT', '/admin/settings/nope', { key: 'nope', value: 1 })).status, 400);
  assert.equal((await call('a1', 'PUT', '/admin/settings/license.over_threshold', { key: 'license.over_threshold', value: 1.5 })).status, 400);
  assert.equal((await call('a1', 'PUT', '/admin/settings/license.over_threshold', { key: 'license.over_threshold', value: { x: 1 } })).status, 400);
  const ok = await call('a1', 'PUT', '/admin/settings/license.over_threshold', { key: 'license.over_threshold', value: 0.7 });
  assert.equal(ok.status, 200); assert.equal(ok.body.value, 0.7);
  const b = await call('a1', 'PUT', '/admin/settings/sap.posting_blackout', { key: 'sap.posting_blackout', value: { from: '2026-10-31T18:00:00-04:00', to: '2026-10-30T00:00:00-04:00' } });
  assert.equal(b.status, 400);
  assert.equal((await call('a1', 'PUT', '/admin/settings/sap.posting_blackout', { key: 'sap.posting_blackout', value: {} })).status, 200);
  const list = await call('a1', 'GET', '/admin/settings');
  assert.deepEqual(list.body.items.map((i: { key: string }) => i.key), ['license.over_threshold', 'sap.posting_blackout']);
  const n = (await owner.query(`SELECT (value #>> '{}')::numeric AS v FROM setting WHERE key = 'license.over_threshold'`)).rows[0].v;
  assert.equal(Number(n), 0.7);
});
