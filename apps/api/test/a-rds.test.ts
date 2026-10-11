// RDS 마스터와 같은 조건(슈퍼유저 아님, CREATEROLE, DB 소유자)에서 부트스트랩 + 0001 적용.
// 새 클러스터에서 역할이 아직 없을 때만 의미가 있어 파일 이름으로 먼저 실행한다. 이벤트 트리거 2줄은 로컬에서만 뺀다(RDS는 rds_superuser 허용)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);

test('RDS 조건: CREATEROLE 소유자로 부트스트랩·0001 적용, 감사 소유권 이전·SET 권한 회수', { skip: !host && 'TEST_PG_HOST 없음' }, async (t) => {
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect();
  if ((await su.query(`SELECT 1 FROM pg_roles WHERE rolname = 'alm_app'`)).rowCount) { await su.end(); t.skip('역할이 이미 있음(새 클러스터 필요)'); return; }
  const db = `alm_rds_${Date.now()}`;
  await su.query(`CREATE ROLE alm_owner LOGIN CREATEROLE PASSWORD 'x'`);
  await su.query(`CREATE DATABASE ${db} OWNER alm_owner`);
  const c = new Client({ host, port, user: 'alm_owner', password: 'x', database: db });
  await c.connect();
  try {
    const ms = loadMigrations(join(__dirname, '..', '..', 'migrations')).map((m) => ({ ...m, sql: m.sql.replace(/^CREATE EVENT TRIGGER .*$/gm, '') }));
    assert.deepEqual(await migrate(c, ms), ['0001_init.sql']);
    assert.deepEqual(await migrate(c, ms), []);
    const q = async (sql: string) => (await c.query(sql)).rows;
    assert.deepEqual(await q(`SELECT tableowner FROM pg_tables WHERE tablename IN ('audit_log', 'asset') ORDER BY tablename`),
      [{ tableowner: 'alm_owner' }, { tableowner: 'alm_audit_owner' }]);
    assert.deepEqual(await q(`SELECT pg_has_role('alm_owner', 'alm_audit_owner', 'SET') AS s`), [{ s: false }], 'SET 권한 회수');
    const members = await q(`SELECT r.rolname AS role, m.rolname AS member FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid
                               JOIN pg_roles m ON m.oid = a.member WHERE m.rolname LIKE 'alm\\_%\\_login' ORDER BY 2`);
    assert.deepEqual(members, [{ role: 'alm_app', member: 'alm_app_login' }, { role: 'alm_audit_owner', member: 'alm_archive_login' }]);
    // 앱 계정으로 감사 트리거가 동작하는지(감사 함수 소유자 = alm_audit_owner)
    await su.query(`ALTER ROLE alm_app_login PASSWORD 'y'`);
    const a = new Client({ host, port, user: 'alm_app_login', password: 'y', database: db });
    await a.connect();
    try {
      await c.query(`INSERT INTO tenant (id, code, name, idp_provider_name) VALUES ('00000000-0000-0000-0000-000000000001', 'T1', 't', 'T-T1')`);
      await a.query('BEGIN');
      await a.query(`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000001', true), set_config('app.actor_type', 'USER', true)`);
      await a.query(`INSERT INTO app_user (id, tenant_id, email, display_name) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'a@b.c', 'A')`);
      const n = (await a.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'app_user'`)).rows[0].n;
      await a.query('COMMIT');
      assert.equal(n, 1);
    } finally { await a.end(); }
  } finally {
    await c.end();
    await su.query(`DROP DATABASE ${db} WITH (FORCE)`);
    await su.end();
  }
});
