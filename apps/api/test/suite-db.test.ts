// 공유 플랫폼(suite) 모드의 마이그레이션(통합 WBS 5.4): 소유자가 슈퍼유저가 아닌 조건(공유 RDS의 alm_owner)에서 모든 파일이 적용된다.
// 이벤트 트리거(감사 보호)는 건너뛰고 플랫폼이 대신 만든다(pas-suite db-bootstrap privileged-setup). 기존 방식(슈퍼유저 소유자)은 그대로다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations, skipEventTriggers } from '../src/ops/migrate';
import { parseSeed, seed } from '../src/ops/seed';
import { catalog } from '../src/platform/identity/permissions';

catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));   // seed가 역할 이름을 확인한다
const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const tag = Date.now();
const dbName = `alm_suite_${tag}`, OWNER = `alm_suite_owner_${tag}`;
const dir = join(__dirname, '..', '..', 'migrations');
const su = async <R>(database: string, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = new Client({ host, port, user: 'postgres', database }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};
after(async () => {
  if (skip) return;
  await su('postgres', async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.query(`DROP OWNED BY ${OWNER}`).catch(() => undefined);
    await c.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => undefined);
  });
});

test('skipEventTriggers: 0001의 두 문장만 빠지고 체크섬(원본 기준)은 그대로다', () => {
  const ms = loadMigrations(dir);
  const all = ms.map((m) => ({ file: m.file, ...skipEventTriggers(m.sql) }));
  assert.deepEqual(all.flatMap((x) => x.skipped), ['et_guard_audit_ddl', 'et_guard_audit_drop']);
  assert.deepEqual(all.filter((x) => x.skipped.length).map((x) => x.file), ['0001_init.sql']);
  for (const x of all) assert.ok(!/CREATE\s+EVENT\s+TRIGGER/i.test(x.sql), x.file);
  assert.match(all[0].sql, /CREATE FUNCTION guard_audit_ddl\(\) RETURNS event_trigger/);   // 함수는 남는다(플랫폼이 이 함수에 연결한다)
  assert.deepEqual(loadMigrations(dir).map((m) => m.checksum), ms.map((m) => m.checksum));
  assert.deepEqual(skipEventTriggers('CREATE EVENT TRIGGER x ON sql_drop\n  EXECUTE FUNCTION f();').skipped, ['x']);
  // 놓치면 조용히 넘어가지 않고 멈춘다
  assert.throws(() => skipEventTriggers("DO $$ BEGIN EXECUTE 'create event trigger x ON sql_drop EXECUTE FUNCTION f()'; END $$;"), /건너뛰지 못한/);
});

test('공유 플랫폼 모드: 슈퍼유저가 아닌 소유자로 전부 적용된다. 서비스 계정은 접속 권한을 받는다', { skip }, async () => {
  // 공유 RDS와 같은 조건: 소유자 = LOGIN CREATEROLE(슈퍼유저 아님), PUBLIC 접속 권한 없음.
  // 로컬 서버에는 다른 시험이 만든 역할(alm_app 등, 서버 단위)이 있을 수 있어 그 관리 권한만 준다(공유 RDS에서는 소유자가 직접 만들어 가진다)
  await su('postgres', async (c) => {
    await c.query(`CREATE ROLE ${OWNER} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD 'test'`);
    await c.query(`CREATE DATABASE ${dbName} OWNER ${OWNER}`);
    await c.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    for (const r of ['alm_app', 'alm_readonly', 'alm_audit_owner', 'alm_app_login', 'alm_archive_login', 'rds_iam'])
      if ((await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r])).rowCount) await c.query(`GRANT ${r} TO ${OWNER} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
  });
  const o = new Client({ host, port, user: OWNER, password: 'test', database: dbName });
  await o.connect();
  try {
    // 기존 방식 그대로면 이벤트 트리거에서 멈춘다(소유자는 만들 수 없다) — 아무것도 적용되지 않는다
    await assert.rejects(migrate(o, loadMigrations(dir)), /permission denied to create event trigger/);
    assert.equal((await o.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0);
    const ms = loadMigrations(dir);
    assert.deepEqual(await migrate(o, ms, { suite: true }), ms.map((m) => m.file));
    assert.deepEqual(await migrate(o, ms, { suite: true }), [], '다시 실행하면 적용할 것이 없다');
    assert.equal((await o.query('SELECT count(*)::int AS n FROM pg_event_trigger')).rows[0].n, 0);
    // 플랫폼이 연결할 함수: public, 소유자 = 이 DB의 소유자, 인자 없는 event_trigger
    const f = (await o.query(`SELECT r.rolname AS owner, p.prorettype::regtype::text AS ret, p.pronargs::int AS n FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'guard_audit_ddl' AND p.pronamespace = 'public'::regnamespace`)).rows;
    assert.deepEqual(f, [{ owner: OWNER, ret: 'event_trigger', n: 0 }]);
    const stored = (await o.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(stored.map((r) => r.checksum), ms.map((m) => m.checksum), '체크섬은 기존 환경과 같다');
  } finally { await o.end(); }
  // 서비스 계정: 접속되고 업무 표 권한이 있다
  await su('postgres', (c) => c.query(`ALTER ROLE alm_app_login PASSWORD 'test'`));
  const a = new Client({ host, port, user: 'alm_app_login', password: 'test', database: dbName });
  await a.connect();
  try { assert.deepEqual((await a.query(`SELECT current_database() AS d, has_table_privilege('asset', 'SELECT') AS can`)).rows[0], { d: dbName, can: true }); } finally { await a.end(); }
  // 플랫폼(관리 계정)이 대신 만든 뒤: 감사 표를 지우는 DDL이 거부된다
  await su(dbName, async (c) => {
    await c.query('CREATE EVENT TRIGGER et_guard_audit_ddl ON ddl_command_end EXECUTE FUNCTION guard_audit_ddl()');
    await c.query('CREATE EVENT TRIGGER et_guard_audit_drop ON sql_drop EXECUTE FUNCTION guard_audit_ddl()');
  });
  const o2 = new Client({ host, port, user: OWNER, password: 'test', database: dbName });
  await o2.connect();
  try {
    assert.deepEqual(await migrate(o2, loadMigrations(dir), { suite: true }), []);
    const t = (await o2.query(`SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE 'tr\\_%\\_audit' AND c.relname <> 'audit_log' ORDER BY 1 LIMIT 1`)).rows[0];
    assert.ok(t, '감사 트리거가 붙은 표');
    await assert.rejects(o2.query(`ALTER TABLE ${t.relname} DISABLE TRIGGER ${t.tgname}`), /audit triggers must stay enabled/);
    await assert.rejects(o2.query(`DROP TRIGGER ${t.tgname} ON ${t.relname}`), /is not allowed/);
    // 테넌트·SAP 연결 등록(런북 13 6·7장, db-seed.sh suite): 슈퍼유저가 아닌 소유자로도 되고, 다시 실행해도 같은 결과다
    const input = parseSeed(JSON.stringify({ tenant: { code: 'NEWCO', name: 'New Co', idpType: 'OIDC' }, domains: [`newco-${tag}.example.com`],
      users: [{ email: `admin@newco-${tag}.example.com`, displayName: 'Admin', roles: ['SYS_ADMIN'] }], companies: [{ code: '1000', name: 'New Co US' }],
      sapConnections: [{ systemId: 'S4P-100', companyCode: '1000', clientId: 'client-id-0001', clientAlias: 'NEWCO-S4P', allowedCidrs: ['203.0.113.10/32'] }] }));
    await seed(o2, input); await seed(o2, input);
    const got = (await o2.query(`SELECT t.code, (SELECT count(*)::int FROM tenant_domain d WHERE d.tenant_id = t.id) AS domains, (SELECT count(*)::int FROM app_user u WHERE u.tenant_id = t.id) AS users,
      (SELECT count(*)::int FROM company c WHERE c.tenant_id = t.id) AS companies, (SELECT count(*)::int FROM sap_connection s WHERE s.tenant_id = t.id AND s.client_alias = 'NEWCO-S4P') AS conns
      FROM tenant t WHERE t.code = 'NEWCO'`)).rows;
    assert.deepEqual(got, [{ code: 'NEWCO', domains: 1, users: 1, companies: 1, conns: 1 }]);
  } finally { await o2.end(); }
});
