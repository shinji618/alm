// PgStore의 SQL 모양·행 변환 확인(DB 없이 가짜 클라이언트). 실제 동작은 DB 환경에서 별도로 시험한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgStore } from '../src/platform/workflow';
import type { StepState } from '../src/platform/workflow';

function fake(results: Array<{ rows: any[] }> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const c = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return results.shift() ?? { rows: [] }; } };
  return { c: c as never, calls };
}

test('updateInstance: 키가 있으면 undefined도 NULL, 변경자·버전을 함께 올린다', async () => {
  const { c, calls } = fake();
  await new PgStore(c, 'actor').updateInstance('i1', { status: 'IN_PROGRESS', currentStep: 1, completedAt: undefined });
  assert.equal(calls[0].sql, 'UPDATE workflow_instance SET status = $3, current_step = $4, completed_at = $5, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1');
  assert.deepEqual(calls[0].params, ['i1', 'actor', 'IN_PROGRESS', 1, null]);
});

test('updateStep: 결정 필드만 바꾸고, 빈 패치도 올바른 SQL', async () => {
  const { c, calls } = fake();
  const d = new Date('2026-10-29T00:00:00Z');
  const s = new PgStore(c, 'actor');
  await s.updateStep('s1', { status: 'APPROVED', approverId: 'u1', comment: '확인', decidedAt: d });
  assert.equal(calls[0].sql, 'UPDATE workflow_step SET status = $3, approver_id = $4, comment = $5, decided_at = $6, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1');
  assert.deepEqual(calls[0].params, ['s1', 'actor', 'APPROVED', 'u1', '확인', d]);
  await s.updateStep('s2', {});
  assert.equal(calls[1].sql, 'UPDATE workflow_step SET updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1');
});

test('activeBySubject: 대상별 잠금을 먼저 잡고 진행 중만 찾는다', async () => {
  const { c, calls } = fake([{ rows: [] }, { rows: [] }]);
  assert.equal(await new PgStore(c, 'a').activeBySubject('NEW_ASSET', 'x1'), undefined);
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].params, ['wf:NEW_ASSET:x1']);
  assert.match(calls[1].sql, /status = 'IN_PROGRESS'/);
});

test('insertSteps: 테넌트는 인스턴스에서 가져오고 만든 사람을 기록한다', async () => {
  const { c, calls } = fake();
  const step: StepState = { id: 's1', instanceId: 'i1', stepNo: 1, key: 'dept', label: '부서', resolver: 'R', params: { cc: 'x' }, proxy: true, mergeSame: false, status: 'PENDING', createdBy: 'fixer', createdAt: new Date() };
  await new PgStore(c, 'actor').insertSteps([step]);
  assert.match(calls[0].sql, /SELECT \$1, i\.tenant_id, i\.id, .* FROM workflow_instance i WHERE i\.id = \$2/);
  assert.deepEqual(calls[0].params, ['s1', 'i1', 1, 'dept', '부서', 'R', '{"cc":"x"}', true, false, 1, null, 'PENDING', 'fixer']);
});

test('행 변환: 인스턴스·단계(문자열 날짜, 기본값 보정)', async () => {
  const { c } = fake([
    { rows: [{ id: 'i1', tenant_id: 't', subject_type: 'X', subject_id: 's', requester_id: 'r', status: 'IN_PROGRESS', current_step: 2, rules: {}, submitted_at: '2026-10-29T10:00:00Z', completed_at: null, version: 3 }] },
    { rows: [{ id: 's1', instance_id: 'i1', step_no: 2, step_key: 'acct', label: 'L', resolver: 'R', params: null, proxy: false, merge_same: true, min_approvals: 1,
      due_at: null, status: 'PENDING', approver_id: null, comment: null, decided_at: null, created_by: 'u', created_at: '2026-10-29T10:00:00Z' }] },
  ]);
  const st = new PgStore(c, 'a');
  const i = (await st.getInstance('i1', true))!;
  assert.deepEqual([i.currentStep, i.rules.fixerCannotReapprove, i.completedAt, i.submittedAt.getTime(), i.version], [2, true, undefined, Date.parse('2026-10-29T10:00:00Z'), 3]);
  const s = (await st.getSteps('i1'))[0];
  assert.deepEqual([s.key, s.stepNo, s.mergeSame, s.proxy, s.approverId, s.params], ['acct', 2, true, false, undefined, undefined]);
});
