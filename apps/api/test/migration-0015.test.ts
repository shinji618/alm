// 0015 사용자 관리 결합 해소: 0014 상태의 옛 데이터(역할 enum·회사/사이트/코스트센터 FK·app_user.부서)가 새 구조로 옮겨지는지
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_m15_${Date.now()}`;
let su: Client | undefined;
after(async () => {
  if (skip) return;
  su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

test('0015: 역할 범위·프로필 이관, enum 제거, 유일 키·뷰·RLS·감사 트리거', { skip }, async () => {
  su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  const o = new Client({ host, port, user: 'postgres', database: dbName });
  await o.connect();
  try {
    const all = loadMigrations(join(__dirname, '..', '..', 'migrations'));
    const idx = all.findIndex((m) => m.file.startsWith('0015_'));
    assert.ok(idx > 0, '0015 파일이 있다');
    await migrate(o, all.slice(0, idx));
    const q = async (sql: string, a: unknown[] = []) => (await o.query(sql, a)).rows;
    const T = '00000000-0000-0000-0000-0000000000a1';
    await q(`INSERT INTO tenant (id, code, name, idp_provider_name) VALUES ($1, 'M15', 't', 'T-M15')`, [T]);
    const co = (await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [T]))[0].id;
    const st = (await q(`INSERT INTO site (id, tenant_id, site_code, name) VALUES (gen_random_uuid(), $1, 'ATL', 'Atlanta') RETURNING id`, [T]))[0].id;
    const cc = (await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [T, co]))[0].id;
    const user = async (e: string, dept?: string, ccId?: string) => (await q(
      `INSERT INTO app_user (id, tenant_id, email, display_name, department, cost_center_id) VALUES (gen_random_uuid(), $1, $2, $2, $3, $4) RETURNING id`,
      [T, e, dept ?? null, ccId ?? null]))[0].id as string;
    const u1 = await user('u1@m15.test', 'IT', cc), u2 = await user('u2@m15.test'), u3 = await user('u3@m15.test', undefined, cc);
    const role = (u: string, r: string, c?: string, s?: string, k?: string) => q(
      `INSERT INTO user_role (id, tenant_id, user_id, role, company_id, site_id, cost_center_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [T, u, r, c ?? null, s ?? null, k ?? null]);
    await role(u1, 'ASSET_MANAGER', co, st); await role(u1, 'DEPT_MANAGER', undefined, undefined, cc);
    await role(u2, 'ASSET_ACCOUNTANT', co); await role(u2, 'COUNTER'); await role(u3, 'SYS_ADMIN');

    assert.deepEqual((await migrate(o, all)).map((f) => f.slice(0, 4)), all.slice(idx).map((m) => m.file.slice(0, 4)));
    assert.deepEqual(await migrate(o, all), [], '다시 적용해도 변화 없음');

    const roles = await q(`SELECT u.email, r.role, r.scope_key FROM user_role r JOIN app_user u ON u.id = r.user_id ORDER BY u.email, r.role`);
    assert.deepEqual(roles, [
      { email: 'u1@m15.test', role: 'ASSET_MANAGER', scope_key: 'company=1000|site=ATL' },
      { email: 'u1@m15.test', role: 'DEPT_MANAGER', scope_key: 'costCenter=CC100' },
      { email: 'u2@m15.test', role: 'ASSET_ACCOUNTANT', scope_key: 'company=1000' },
      { email: 'u2@m15.test', role: 'COUNTER', scope_key: '' },
      { email: 'u3@m15.test', role: 'SYS_ADMIN', scope_key: '' }]);
    assert.deepEqual(await q(`SELECT u.email, r.role, s.dimension, s.value FROM user_role_scope s JOIN user_role r ON r.id = s.user_role_id JOIN app_user u ON u.id = r.user_id
                               ORDER BY 1, 2, 3`), [
      { email: 'u1@m15.test', role: 'ASSET_MANAGER', dimension: 'company', value: '1000' },
      { email: 'u1@m15.test', role: 'ASSET_MANAGER', dimension: 'site', value: 'ATL' },
      { email: 'u1@m15.test', role: 'DEPT_MANAGER', dimension: 'costCenter', value: 'CC100' },
      { email: 'u2@m15.test', role: 'ASSET_ACCOUNTANT', dimension: 'company', value: '1000' }]);
    assert.deepEqual(await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_role' AND column_name IN ('company_id', 'site_id', 'cost_center_id')`), []);
    assert.deepEqual(await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'app_user' AND column_name IN ('department', 'cost_center_id')`), []);
    assert.deepEqual(await q(`SELECT e.email, p.department, c.cost_center_code FROM alm_user_profile p JOIN app_user e ON e.id = p.user_id LEFT JOIN cost_center c ON c.id = p.cost_center_id ORDER BY 1`), [
      { email: 'u1@m15.test', department: 'IT', cost_center_code: 'CC100' }, { email: 'u3@m15.test', department: null, cost_center_code: 'CC100' }]);
    assert.deepEqual(await q(`SELECT 1 FROM pg_type WHERE typname = 'role_code'`), [], 'role_code enum 제거');
    assert.deepEqual(await q(`SELECT data_type, character_maximum_length AS n FROM information_schema.columns WHERE (table_name, column_name) IN (('user_role', 'role'), ('approval', 'approver_role')) ORDER BY table_name`),
      [{ data_type: 'character varying', n: 40 }, { data_type: 'character varying', n: 40 }]);
    // 유일 키: 같은 사용자·역할·범위는 한 번만(범위 없는 행은 scope_key '')
    await assert.rejects(q(`INSERT INTO user_role (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'COUNTER')`, [T, u2]), /duplicate key|unique/);
    // 뷰: 범위 값을 열로 풀고 코스트센터 id까지 푼다
    assert.deepEqual(await q(`SELECT role, company_code, site_code, cost_center_code, cost_center_id = $2 AS cc FROM v_alm_user_role WHERE user_id = $1 ORDER BY role`, [u1, cc]), [
      { role: 'ASSET_MANAGER', company_code: '1000', site_code: 'ATL', cost_center_code: null, cc: null },
      { role: 'DEPT_MANAGER', company_code: null, site_code: null, cost_center_code: 'CC100', cc: true }]);
    // RLS·감사 트리거·FK
    assert.deepEqual(await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('user_role_scope', 'alm_user_profile') ORDER BY 1`),
      [{ relname: 'alm_user_profile', relrowsecurity: true }, { relname: 'user_role_scope', relrowsecurity: true }]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('tr_user_role_scope_audit', 'tr_alm_user_profile_audit') AND tgenabled = 'O'`))[0].n, 2);
    assert.equal((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('user_role_scope'::regclass, 'alm_user_profile'::regclass)`))[0].n, 5);
  } finally { await o.end(); }
});
