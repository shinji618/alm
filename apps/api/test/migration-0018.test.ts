// 0018 ALM 승인 이관: 0017 상태의 옛 approval 행이 workflow_instance·workflow_step으로 옮겨지는지(id 보존·상태 매핑·코스트센터·생성자)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_m18_${Date.now()}`;
let su: Client | undefined;
after(async () => {
  if (skip) return;
  su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

test('0018: approval → workflow_instance·step 이관(상태 매핑, id·코스트센터·생성자·결정 보존, DRAFT 제외, 다시 적용해도 그대로)', { skip }, async () => {
  su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  const o = new Client({ host, port, user: 'postgres', database: dbName });
  await o.connect();
  try {
    const all = loadMigrations(join(__dirname, '..', '..', 'migrations'));
    const idx = all.findIndex((m) => m.file.startsWith('0018_'));
    assert.ok(idx > 0, '0018 파일이 있다');
    await migrate(o, all.slice(0, idx));
    const q = async (sql: string, a: unknown[] = []) => (await o.query(sql, a)).rows;
    const T = '00000000-0000-0000-0000-0000000000b1';
    await q(`INSERT INTO tenant (id, code, name, idp_provider_name) VALUES ($1, 'M18', 't', 'T-M18')`, [T]);
    const co = (await q(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`, [T]))[0].id;
    const cc = (await q(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id) VALUES (gen_random_uuid(), $1, 'A000', 'CC100', 'IT', $2) RETURNING id`, [T, co]))[0].id;
    const user = async (e: string) => (await q(`INSERT INTO app_user (id, tenant_id, email, display_name) VALUES (gen_random_uuid(), $1, $2, $2) RETURNING id`, [T, e]))[0].id as string;
    const req = await user('req@m18.test'), mgr = await user('mgr@m18.test'), acc = await user('acc@m18.test');
    let n = 0;
    const request = async (status: string, step: number) => (await q(
      `INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, requester_id, reason, current_step, submitted_at, completed_at)
       VALUES (gen_random_uuid(), $1, $2, 'CHANGE', $3::request_status, 'USER', $4, 'r', $5, now() - interval '2 days', CASE WHEN $3 IN ('POSTED', 'REJECTED', 'CANCELLED') THEN now() END) RETURNING id`,
      [T, `R${++n}`, status, req, step]))[0].id as string;
    const step = async (r: string, no: number, role: string, decision: string, approver: string | null, ccId: string | null, by: string, comment?: string) => (await q(
      `INSERT INTO approval (id, tenant_id, asset_request_id, step_no, approver_role, cost_center_id, approver_id, decision, comment, decided_at, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::approval_decision, $8, CASE WHEN $7 = 'PENDING' THEN NULL ELSE now() END, $9) RETURNING id`,
      [T, r, no, role, ccId, approver, decision, comment ?? null, by]))[0].id as string;

    const rOpen = await request('MGR_APPROVED', 2);
    const o1 = await step(rOpen, 1, 'DEPT_MANAGER', 'APPROVED', mgr, cc, req, '확인'); const o2 = await step(rOpen, 2, 'ASSET_ACCOUNTANT', 'PENDING', null, null, req);
    const rRej = await request('REJECTED', 1);
    const j1 = await step(rRej, 1, 'DEPT_MANAGER', 'REJECTED', mgr, cc, req, '사유'); await step(rRej, 2, 'ASSET_ACCOUNTANT', 'SKIPPED', null, null, req);
    const rDone = await request('POSTED', 2);
    await step(rDone, 1, 'DEPT_MANAGER', 'APPROVED', mgr, cc, req); await step(rDone, 2, 'ASSET_ACCOUNTANT', 'APPROVED', acc, null, mgr);   // 2단계는 보정자(mgr)가 만든 단계
    const rCan = await request('CANCELLED', 1);
    await step(rCan, 1, 'DEPT_MANAGER', 'SKIPPED', null, cc, req); await step(rCan, 2, 'ASSET_ACCOUNTANT', 'SKIPPED', null, null, req);
    await request('DRAFT', 1);   // 승인 행 없음

    assert.deepEqual((await migrate(o, all)).map((f) => f.slice(0, 4)), all.slice(idx).map((m) => m.file.slice(0, 4)));
    assert.deepEqual(await migrate(o, all), [], '다시 적용해도 변화 없음');

    const inst = await q(`SELECT r.request_no, i.status, i.current_step, i.requester_id = r.requester_id AS same_req, i.rules->>'fixerCannotReapprove' AS fx, i.completed_at IS NOT NULL AS done
      FROM workflow_instance i JOIN asset_request r ON r.id = i.subject_id WHERE i.subject_type = 'ASSET_REQUEST' ORDER BY r.request_no`);
    assert.deepEqual(inst, [
      { request_no: 'R1', status: 'IN_PROGRESS', current_step: 2, same_req: true, fx: 'true', done: false },
      { request_no: 'R2', status: 'REJECTED', current_step: 1, same_req: true, fx: 'true', done: true },
      { request_no: 'R3', status: 'APPROVED', current_step: 2, same_req: true, fx: 'true', done: true },
      { request_no: 'R4', status: 'CANCELLED', current_step: 1, same_req: true, fx: 'true', done: true }], 'DRAFT(R5)는 인스턴스가 없다');
    const steps = await q(`SELECT s.id, r.request_no, s.step_no, s.step_key, s.resolver, s.status, s.params->>'ccId' AS cc, s.merge_same, s.proxy, s.comment, s.created_by
      FROM workflow_step s JOIN workflow_instance i ON i.id = s.instance_id JOIN asset_request r ON r.id = i.subject_id ORDER BY r.request_no, s.step_no`);
    assert.equal(steps.length, 8);
    assert.deepEqual(steps.filter((s) => s.request_no === 'R1').map((s) => [s.id, s.step_key, s.resolver, s.status, s.cc, s.merge_same, s.comment]), [
      [o1, 'dept1', 'DEPT_MANAGER', 'APPROVED', cc, true, '확인'], [o2, 'acct', 'ASSET_ACCOUNTANT', 'PENDING', null, false, null]], '단계 id(approvalId)는 그대로');
    assert.equal(steps.find((s) => s.id === j1)!.status, 'REJECTED');
    assert.deepEqual(steps.filter((s) => s.request_no === 'R3').map((s) => s.created_by), [req, mgr], '단계 생성자(보정자 판단)가 보존된다');
    assert.deepEqual(steps.filter((s) => s.request_no === 'R4').map((s) => s.status), ['SKIPPED', 'SKIPPED']);
    assert.equal((await q(`SELECT count(*)::int AS n FROM approval`))[0].n, 8, 'approval 원본은 그대로 남는다');
  } finally { await o.end(); }
});

test('0018: 구매요청 승인 행이 있으면 이관을 거절한다', { skip }, async () => {
  const name = `${dbName}_p`;
  su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${name}`); await su.end();
  const o = new Client({ host, port, user: 'postgres', database: name });
  await o.connect();
  try {
    const all = loadMigrations(join(__dirname, '..', '..', 'migrations'));
    const idx = all.findIndex((m) => m.file.startsWith('0018_'));
    await migrate(o, all.slice(0, idx));
    const T = '00000000-0000-0000-0000-0000000000b2';
    await o.query(`INSERT INTO tenant (id, code, name, idp_provider_name) VALUES ($1, 'M18P', 't', 'T-M18P')`, [T]);
    const cols = (await o.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_request' AND is_nullable = 'NO' AND column_default IS NULL`)).rows.map((r) => r.column_name);
    assert.ok(cols.length > 0);   // 구매요청 행을 만들기 어려우면 FK를 잠시 끄고 approval만 넣는다
    await o.query(`SET session_replication_role = replica`);
    await o.query(`INSERT INTO approval (id, tenant_id, purchase_request_id, step_no, approver_role) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 1, 'DEPT_MANAGER')`, [T]);
    await o.query(`SET session_replication_role = origin`);
    await assert.rejects(migrate(o, all), /구매요청 승인 행/);
  } finally { await o.end(); su = new Client({ host, port, user: 'postgres', database: 'postgres' }); await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await su.end(); }
});
