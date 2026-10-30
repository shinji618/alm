// 워크플로(4.10·4.13) DB 통합 시험: 마이그레이션 0016·0017, PgStore(엔진), /admin/workflows API, RLS·감사·동시성
// 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
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
import { addRole } from './roleHelper';
import { approve, cancel, inbox, PgStore, reject, restart, submit, WorkflowError } from '../src/platform/workflow';
import type { Hooks, StepPlan } from '../src/platform/workflow';
import type { Config } from '../src/config';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_wf_${Date.now()}`;
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
async function call(who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer at:T-WFT_${who}:web`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}
const q = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows;
const tx = <T>(who: string, fn: (c: import('pg').PoolClient) => Promise<T>) => app.withTx({ tenantId, userId: ids[who], actorType: 'USER' }, fn);

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await owner.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  app = new Db(new Pool({ host, port, user: 'alm_app_login', password: 'test', database: dbName, max: 8 }));
  const users = ['adm', 'mgr', 'emp', 'dept1', 'dept3', 'acct', 'm1', 'a1'];
  tenantId = (await seed(owner, { tenant: { code: 'WFT', name: 'Workflow', idpType: 'OIDC' }, domains: ['wf.test'],
    users: users.map((u) => ({ email: `${u}@wf.test`, displayName: u === 'dept1' ? 'Dept One' : u === 'dept3' ? 'Dept Three' : u === 'acct' ? 'Acct One' : u,
      roles: u === 'adm' ? ['SYS_ADMIN'] : u === 'mgr' ? ['ASSET_MANAGER'] : u === 'acct' ? ['ASSET_ACCOUNTANT'] : [] })) })).tenantId;
  for (const u of users) ids[u] = (await q(`UPDATE app_user SET idp_subject = $1 WHERE email = $2 RETURNING id`, [u, `${u}@wf.test`]))[0].id;
  const ins = async (sql: string, p: unknown[] = []) => (await q(sql, [tenantId, ...p]))[0].id as string;
  ids.co = await ins(`INSERT INTO company (id, tenant_id, company_code, name) VALUES (gen_random_uuid(), $1, '1000', 'BSG') RETURNING id`);
  ids.pc = await ins(`INSERT INTO profit_center (id, tenant_id, controlling_area, profit_center_code, name, segment) VALUES (gen_random_uuid(), $1, 'A000', 'P1', 'Corp', 'S1') RETURNING id`);
  const cc = (code: string) => ins(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id, profit_center_id)
    VALUES (gen_random_uuid(), $1, 'A000', $2, $2, $3, $4) RETURNING id`, [code, ids.co, ids.pc]);
  ids.cc100 = await cc('CC100'); ids.cc300 = await cc('CC300');
  await addRole(q, tenantId, ids.dept1, 'DEPT_MANAGER', { costCenter: ids.cc100 });
  await addRole(q, tenantId, ids.dept3, 'DEPT_MANAGER', { costCenter: ids.cc300 });
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

// ---------------- 엔진 + PgStore ----------------
const can = (who: Record<string, string[]>): Hooks => ({
  newId: () => randomUUID(),
  canDecide: async (actor, step) => (who[actor] ?? []).includes(step.resolver),
  decorateComment: (step, c) => (step.proxy ? `[대리]${c ? ` ${c}` : ''}` : c),
});
const PLAN: StepPlan[] = [{ key: 'dept', label: '부서', resolver: 'DEPT', mergeSame: true }, { key: 'acct', label: '회계', resolver: 'ACCT' }];
const subject = () => ({ tenantId, subjectType: 'NEW_ASSET', subjectId: randomUUID(), requesterId: ids.emp });
const rows = (sql: string, p: unknown[] = []) => q(sql, p);

test('엔진(PgStore): 제출 → 순차 승인 → 완료가 DB에 남고, 감사 행이 쌓인다', { skip }, async () => {
  const who = { [ids.m1]: ['DEPT'], [ids.a1]: ['ACCT'] };
  const h = can(who);
  const s = subject();
  const sub = await tx('emp', (c) => submit(new PgStore(c, ids.emp), h, { ...s, plan: PLAN }));
  assert.equal(sub.instance.status, 'IN_PROGRESS');
  const dept = sub.steps[0], acct = sub.steps[1];
  assert.deepEqual((await rows('SELECT step_no, status FROM workflow_step WHERE instance_id = $1 ORDER BY step_no', [sub.instance.id])).map((r) => `${r.step_no}:${r.status}`), ['1:PENDING', '2:PENDING']);
  const r1 = await tx('m1', (c) => approve(new PgStore(c, ids.m1), h, dept.id, ids.m1, '확인'));
  assert.equal(r1.instance.currentStep, 2);
  const r2 = await tx('a1', (c) => approve(new PgStore(c, ids.a1), h, acct.id, ids.a1));
  assert.equal(r2.instance.status, 'APPROVED');
  assert.ok(r2.instance.completedAt);
  const inst = (await rows('SELECT status, current_step, version, updated_by FROM workflow_instance WHERE id = $1', [sub.instance.id]))[0];
  assert.equal(inst.status, 'APPROVED');
  assert.equal(inst.updated_by, ids.a1);
  assert.ok(inst.version >= 3);
  const steps = await rows('SELECT status, approver_id, comment FROM workflow_step WHERE instance_id = $1 ORDER BY step_no', [sub.instance.id]);
  assert.deepEqual(steps.map((r) => [r.status, r.approver_id]), [['APPROVED', ids.m1], ['APPROVED', ids.a1]]);
  const audit = await rows(`SELECT table_name, action FROM audit_log WHERE row_id = $1 OR row_id = ANY($2)`, [sub.instance.id, [dept.id, acct.id]]);
  assert.ok(audit.some((a) => a.table_name === 'workflow_instance' && a.action === 'INSERT'));
  assert.ok(audit.some((a) => a.table_name === 'workflow_step' && a.action === 'UPDATE'));
});

test('엔진(PgStore): 직무 분리·순서·이중 결정·병합이 DB에서도 같다', { skip }, async () => {
  const h = can({ [ids.emp]: ['DEPT'], [ids.m1]: ['DEPT', 'DEPT2', 'ACCT'], [ids.a1]: ['ACCT'] });
  const sod = (p: Promise<unknown>) => assert.rejects(p, (e) => e instanceof WorkflowError && e.kind === 'SOD');
  const kind = (k: string) => (e: unknown) => e instanceof WorkflowError && e.kind === k;
  const sub = await tx('emp', (c) => submit(new PgStore(c, ids.emp), h, { ...subject(), plan: [{ ...PLAN[0], mergeSame: false }, PLAN[1]] }));
  await sod(tx('emp', (c) => approve(new PgStore(c, ids.emp), h, sub.steps[0].id, ids.emp)));
  await assert.rejects(tx('a1', (c) => approve(new PgStore(c, ids.a1), h, sub.steps[1].id, ids.a1)), kind('CONFLICT'));
  await tx('m1', (c) => approve(new PgStore(c, ids.m1), h, sub.steps[0].id, ids.m1));
  await sod(tx('m1', (c) => approve(new PgStore(c, ids.m1), h, sub.steps[1].id, ids.m1)));
  await assert.rejects(tx('m1', (c) => approve(new PgStore(c, ids.m1), h, sub.steps[0].id, ids.m1)), kind('CONFLICT'));

  const merged = await tx('m1', (c) => submit(new PgStore(c, ids.m1), h, { ...subject(), requesterId: ids.emp, plan: [{ key: 's1', label: 'a', resolver: 'DEPT' }, { key: 's2', label: 'b', resolver: 'DEPT2', mergeSame: true }, PLAN[1]] }));
  const r = await tx('m1', (c) => approve(new PgStore(c, ids.m1), h, merged.steps[0].id, ids.m1));
  assert.equal(r.instance.currentStep, 3);
  const s2 = (await rows('SELECT status, comment FROM workflow_step WHERE id = $1', [merged.steps[1].id]))[0];
  assert.deepEqual([s2.status, s2.comment], ['APPROVED', '[동일 승인자] 1단계 승인으로 함께 승인']);
});

test('엔진(PgStore): 반려·취소·재시작, 진행 중 이중 제출은 하나만(동시 제출 포함)', { skip }, async () => {
  const h = can({ [ids.m1]: ['DEPT'], [ids.a1]: ['ACCT'], [ids.mgr]: ['DEPT'] });
  const s = subject();
  const sub = await tx('emp', (c) => submit(new PgStore(c, ids.emp), h, { ...s, plan: PLAN }));
  await assert.rejects(tx('emp', (c) => submit(new PgStore(c, ids.emp), h, { ...s, plan: PLAN })), (e) => e instanceof WorkflowError && e.kind === 'CONFLICT');
  const rej = await tx('m1', (c) => reject(new PgStore(c, ids.m1), h, sub.steps[0].id, ids.m1, '자료 부족'));
  assert.equal(rej.instance.status, 'REJECTED');
  assert.deepEqual((await rows('SELECT status FROM workflow_step WHERE instance_id = $1 ORDER BY step_no', [sub.instance.id])).map((r) => r.status), ['REJECTED', 'SKIPPED']);
  const again = await tx('mgr', (c) => restart(new PgStore(c, ids.mgr), h, sub.instance.id, ids.mgr, PLAN));
  assert.equal(again.instance.status, 'IN_PROGRESS');
  assert.equal((await rows('SELECT count(*)::int AS n FROM workflow_step WHERE instance_id = $1', [sub.instance.id]))[0].n, 2);
  assert.equal((await rows('SELECT completed_at FROM workflow_instance WHERE id = $1', [sub.instance.id]))[0].completed_at, null);
  const c = await tx('emp', (cx) => cancel(new PgStore(cx, ids.emp), h, sub.instance.id, ids.emp));
  assert.equal(c.status, 'CANCELLED');

  const s2 = subject();
  const res = await Promise.allSettled([1, 2, 3].map(() => tx('emp', (cx) => submit(new PgStore(cx, ids.emp), h, { ...s2, plan: PLAN }))));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM workflow_instance WHERE subject_id = $1 AND status = 'IN_PROGRESS'`, [s2.subjectId]))[0].n, 1);
});

test('엔진(PgStore): 완료 훅이 던지면 결정 전체가 되돌려진다(같은 트랜잭션)', { skip }, async () => {
  const h = can({ [ids.m1]: ['DEPT'] });
  const sub = await tx('emp', (c) => submit(new PgStore(c, ids.emp), h, { ...subject(), plan: [{ key: 'only', label: '하나', resolver: 'DEPT' }] }));
  const boom: Hooks = { ...h, onApproved: async () => { throw new Error('후처리 실패'); } };
  await assert.rejects(tx('m1', (c) => approve(new PgStore(c, ids.m1), boom, sub.steps[0].id, ids.m1)), /후처리 실패/);
  const st = (await rows('SELECT i.status AS istatus, s.status AS sstatus FROM workflow_instance i JOIN workflow_step s ON s.instance_id = i.id WHERE i.id = $1', [sub.instance.id]))[0];
  assert.deepEqual([st.istatus, st.sstatus], ['IN_PROGRESS', 'PENDING']);
});

test('엔진(PgStore): 승인함은 지금 단계·자격·직무 분리를 DB에서도 거른다', { skip }, async () => {
  const h = can({ [ids.m1]: ['DEPT'], [ids.a1]: ['ACCT'] });
  const sub = await tx('emp', (c) => submit(new PgStore(c, ids.emp), h, { ...subject(), plan: [{ ...PLAN[0], mergeSame: false }, PLAN[1]] }));
  const mine = async (who: string) => (await tx(who, (c) => inbox(new PgStore(c, ids[who]), h, ids[who]))).map((i) => i.instance.id);
  assert.ok((await mine('m1')).includes(sub.instance.id));
  assert.ok(!(await mine('a1')).includes(sub.instance.id));
  assert.ok(!(await mine('emp')).includes(sub.instance.id));
  await tx('m1', (c) => approve(new PgStore(c, ids.m1), h, sub.steps[0].id, ids.m1));
  assert.ok(!(await mine('m1')).includes(sub.instance.id));
  assert.ok((await mine('a1')).includes(sub.instance.id));
});

test('RLS: 테넌트 설정 없이는 새 테이블을 읽을 수 없고, 다른 테넌트 값으로는 0행', { skip }, async () => {
  await assert.rejects(app.pool.query('SELECT count(*) FROM workflow_instance'));
  await assert.rejects(app.pool.query('SELECT count(*) FROM workflow_definition'));
  const n = await app.withTx({ tenantId: randomUUID(), actorType: 'SYSTEM' }, async (c) => (await c.query('SELECT count(*)::int AS n FROM workflow_instance')).rows[0].n);
  assert.equal(n, 0);
});

// ---------------- /admin/workflows API ----------------
const WF = '/admin/workflows';

test('API: 시험 실행(simulate) — 기본 정의로 부서 관리자·자산회계를 찾고, 요청자는 뺀다', { skip }, async () => {
  const r = await call('adm', 'POST', `${WF}/NEW_ASSET:simulate`, { sourceCostCenterId: ids.cc100, companyId: ids.co });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, 'DEFAULT');
  assert.equal(r.body.canSubmit, true);
  assert.deepEqual(r.body.steps.map((s: any) => [s.key, s.status, s.proxy]), [['dept', 'ACTIVE', false], ['accounting', 'ACTIVE', false]]);
  assert.equal(r.body.steps[0].approvers[0].name, 'Dept One');
  assert.equal(r.body.steps[1].approvers[0].name, 'Acct One');
  // 요청자가 유일한 부서 관리자면 자산회계가 대리
  const px = await call('adm', 'POST', `${WF}/NEW_ASSET:simulate`, { sourceCostCenterId: ids.cc100, requesterId: ids.dept1 });
  assert.equal(px.body.steps[0].proxy, true);
  assert.equal(px.body.steps[0].approvers[0].name, 'Acct One');
  // 이관: 보내는·받는 부서 관리자 → 자산회계
  const tr = await call('adm', 'POST', `${WF}/TRANSFER:simulate`, { sourceCostCenterId: ids.cc100, targetCostCenterId: ids.cc300 });
  assert.deepEqual(tr.body.steps.map((s: any) => [s.key, s.status, s.approvers[0]?.name]), [['source_dept', 'ACTIVE', 'Dept One'], ['target_dept', 'ACTIVE', 'Dept Three'], ['accounting', 'ACTIVE', 'Acct One']]);
  // 편집 중인 값(본문)으로
  const inp = await call('adm', 'POST', `${WF}/NEW_ASSET:simulate`, { sourceCostCenterId: ids.cc100, name: '시험', options: {},
    steps: [{ key: 'accounting', label: '자산회계', resolver: 'ROLE_ASSET_ACCOUNTANT', fallback: 'NONE', mergeSame: false }] });
  assert.equal(inp.body.source, 'INPUT');
  assert.equal(inp.body.steps.length, 1);
  assert.equal((await call('adm', 'POST', `${WF}/NEW_ASSET:simulate`, {})).status, 400);
  assert.equal((await call('adm', 'POST', `${WF}/NOPE:simulate`, { sourceCostCenterId: ids.cc100 })).status, 404);
});

test('API: 목록·선택값·상세, 권한(시스템 관리자만)', { skip }, async () => {
  const list = await call('adm', 'GET', WF);
  assert.equal(list.status, 200);
  assert.equal(list.body.appliedToApprovals, true);
  assert.deepEqual(list.body.fixedFlows.map((f: any) => [f.code, f.steps.map((s: any) => s.resolver)]),
    [['ALM-111', ['DEPT_MANAGER_RESPONSIBLE', 'ROLE_ASSET_ACCOUNTANT']], ['ALM-112', ['DEPT_MANAGER_RESPONSIBLE', 'ROLE_ASSET_ACCOUNTANT']]], '고정 흐름은 읽기 전용으로 목록에 실린다');
  assert.deepEqual(list.body.items.map((i: any) => [i.subjectType, i.usesDefault, i.hasDraft]), ['NEW_ASSET', 'CHANGE', 'TRANSFER', 'RETIRE', 'SALE'].map((t) => [t, true, false]));
  const cat = await call('adm', 'GET', `${WF}/catalog`);
  assert.equal(cat.body.maxSteps, 5);
  assert.deepEqual(cat.body.mandatoryRules.map((r: any) => r.code), ['H-01', 'H-02']);
  const d = await call('adm', 'GET', `${WF}/TRANSFER`);
  assert.equal(d.body.defaultDefinition.steps.length, 3);
  assert.equal((await call('adm', 'GET', `${WF}/NOPE`)).status, 404);
  for (const who of ['mgr', 'acct', 'emp']) assert.equal((await call(who, 'GET', WF)).status, 403, who);
  assert.equal((await call('mgr', 'PUT', `${WF}/NEW_ASSET/draft`, {})).status, 403);
});

test('API: 초안 저장(생성·If-Match)·검증 오류·게시·보관·되돌리기·버리기와 감사', { skip }, async () => {
  const dflt = (await call('adm', 'GET', `${WF}/CHANGE`)).body.defaultDefinition;
  const body = { name: dflt.name, steps: dflt.steps, options: dflt.options, changeNote: '첫 초안' };
  const p1 = await call('adm', 'PUT', `${WF}/CHANGE/draft`, body);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.deepEqual([p1.body.status, p1.body.versionNo, p1.body.version, p1.headers.get('etag')], ['DRAFT', 1, 1, '"1"']);
  assert.equal((await call('adm', 'PUT', `${WF}/CHANGE/draft`, body)).status, 428);
  const stale = await call('adm', 'PUT', `${WF}/CHANGE/draft`, body, { 'if-match': '"9"' });
  assert.deepEqual([stale.status, stale.body.code], [409, 'ALM-E310']);
  const p2 = await call('adm', 'PUT', `${WF}/CHANGE/draft`, { ...body, name: '변경 승인(수정)' }, { 'if-match': '"1"' });
  assert.deepEqual([p2.status, p2.body.version, p2.body.name], [200, 2, '변경 승인(수정)']);

  // 검증 오류: 마지막이 최종 규칙이 아님 + 필수 값
  const bad = await call('adm', 'PUT', `${WF}/CHANGE/draft`, { name: '', steps: [{ ...dflt.steps[0], resolver: 'DEPT_MANAGER_SOURCE' }] }, { 'if-match': '"2"' });
  assert.equal(bad.status, 400);
  const fields = bad.body.detail?.errors?.map((e: any) => e.field) ?? bad.body.errors?.map((e: any) => e.field);
  assert.ok(fields.includes('name'), JSON.stringify(bad.body));

  const noMatch = await call('adm', 'POST', `${WF}/CHANGE/draft:publish`);
  assert.equal(noMatch.status, 428);
  const pub = await call('adm', 'POST', `${WF}/CHANGE/draft:publish`, undefined, { 'if-match': '"2"' });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.status, 'PUBLISHED');
  assert.ok(pub.body.publishedAt && pub.body.publishedByName);
  let det = (await call('adm', 'GET', `${WF}/CHANGE`)).body;
  assert.deepEqual([det.published.versionNo, det.draft], [1, undefined]);
  const item = (await call('adm', 'GET', WF)).body.items.find((i: any) => i.subjectType === 'CHANGE');
  assert.deepEqual([item.usesDefault, item.publishedVersion, item.name], [false, 1, '변경 승인(수정)']);

  // 게시본과 같은 초안은 게시할 수 없다
  const same = await call('adm', 'PUT', `${WF}/CHANGE/draft`, { name: '변경 승인(수정)', steps: dflt.steps, options: dflt.options });
  assert.equal(same.body.versionNo, 2);
  const dup = await call('adm', 'POST', `${WF}/CHANGE/draft:publish`, undefined, { 'if-match': '"1"' });
  assert.deepEqual([dup.status, dup.body.code], [409, 'ALM-E321']);
  // 이전 버전 되돌리기는 초안이 있으면 막힌다. 버린 뒤에는 새 초안
  assert.equal((await call('adm', 'POST', `${WF}/CHANGE/versions/1:restore`)).status, 409);
  assert.equal((await call('adm', 'DELETE', `${WF}/CHANGE/draft`)).status, 204);
  assert.equal((await call('adm', 'DELETE', `${WF}/CHANGE/draft`)).status, 404);

  // 두 번째 게시: 이전 게시본은 보관
  await call('adm', 'PUT', `${WF}/CHANGE/draft`, { name: '변경 승인 v3', steps: dflt.steps, options: { ...dflt.options, requesterNoStep: true } });
  const pub2 = await call('adm', 'POST', `${WF}/CHANGE/draft:publish`, undefined, { 'if-match': '"1"' });
  assert.equal(pub2.status, 200, JSON.stringify(pub2.body));
  det = (await call('adm', 'GET', `${WF}/CHANGE`)).body;
  assert.deepEqual(det.versions.map((v: any) => [v.versionNo, v.status]), [[2, 'PUBLISHED'], [1, 'ARCHIVED']]);   // 버린 초안의 번호는 다시 쓴다
  assert.equal(det.versions.filter((v: any) => v.status === 'PUBLISHED').length, 1);

  const rs = await call('adm', 'POST', `${WF}/CHANGE/versions/1:restore`);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.deepEqual([rs.body.status, rs.body.changeNote], ['DRAFT', 'v1에서 되돌림']);
  assert.equal((await call('adm', 'POST', `${WF}/CHANGE/versions/99:restore`)).status, 409);   // 초안이 있어 먼저 막힘
  await call('adm', 'DELETE', `${WF}/CHANGE/draft`);
  assert.equal((await call('adm', 'POST', `${WF}/CHANGE/versions/99:restore`)).status, 404);

  const audit = await rows(`SELECT action, actor_id FROM audit_log WHERE table_name = 'workflow_definition'`);
  assert.ok(audit.length >= 8);
  assert.ok(audit.every((a) => a.actor_id === ids.adm));
  assert.ok(audit.some((a) => a.action === 'DELETE'));
});

test('API: 게시 동시 실행 — 게시본은 항상 하나', { skip }, async () => {
  const dflt = (await call('adm', 'GET', `${WF}/SALE`)).body.defaultDefinition;
  await call('adm', 'PUT', `${WF}/SALE/draft`, { name: '매각 A', steps: dflt.steps, options: dflt.options });
  const res = await Promise.all([1, 2, 3].map(() => call('adm', 'POST', `${WF}/SALE/draft:publish`, undefined, { 'if-match': '"1"' })));
  assert.equal(res.filter((r) => r.status === 200).length, 1, JSON.stringify(res.map((r) => r.status)));
  assert.equal((await rows(`SELECT count(*)::int AS n FROM workflow_definition WHERE subject_type = 'SALE' AND status = 'PUBLISHED'`))[0].n, 1);
});
