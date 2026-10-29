// 워크플로 엔진 코어(WBS 4.10): 현재 ALM 승인 규칙(characterization-approval.test.ts)을 DB 없이 같은 모양으로 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, cancel, inbox, MemoryStore, reject, restart, submit, toPlan, WorkflowError } from '../src/platform/workflow';
import type { Hooks, InstanceState, PlannedStep, StepPlan, StepState } from '../src/platform/workflow';

// 가짜 제품: 사용자별로 결정할 수 있는 담당자 규칙 코드
function world(who: Record<string, string[]>) {
  let n = 0, t = 1_700_000_000_000;
  const log: string[] = [];
  const h: Hooks = {
    newId: () => `id${++n}`,
    now: () => new Date((t += 1000)),
    canDecide: async (actor, step) => (who[actor] ?? []).includes(step.resolver),
    decorateComment: (step, c) => (step.proxy ? `[대리]${c ? ` ${c}` : ''}` : c),
    onStepArrived: async (_i, s) => { log.push(`arrived ${s.key}`); },
    onDecided: async (_i, s, d) => { log.push(`${d} ${s.key}`); },
    onApproved: async () => { log.push('approved'); },
    onRejected: async () => { log.push('rejected'); },
    onCancelled: async () => { log.push('cancelled'); },
  };
  return { store: new MemoryStore(), h, log };
}
const PLAN: StepPlan[] = [
  { key: 'dept', label: '부서', resolver: 'DEPT', mergeSame: true },
  { key: 'acct', label: '회계', resolver: 'ACCT' },
];
const REQ = { tenantId: 't', subjectType: 'NEW_ASSET', subjectId: 'a1', requesterId: 'req' };
const kind = (e: unknown) => (e instanceof WorkflowError ? e.kind : String(e));
const rejects = async (p: Promise<unknown>, k: string) => { await assert.rejects(p, (e) => kind(e) === k); };
const stepOf = (steps: StepState[], key: string) => steps.find((s) => s.key === key)!;

test('순차 승인: 단계가 넘어가고 마지막 승인에서 완료 훅', async () => {
  const w = world({ m1: ['DEPT'], a1: ['ACCT'] });
  const { steps } = await submit(w.store, w.h, { ...REQ, plan: PLAN });
  assert.deepEqual(w.log, ['arrived dept']);
  const r1 = await approve(w.store, w.h, stepOf(steps, 'dept').id, 'm1', '확인');
  assert.equal(r1.instance.currentStep, 2);
  assert.equal(r1.instance.status, 'IN_PROGRESS');
  const r2 = await approve(w.store, w.h, stepOf(steps, 'acct').id, 'a1');
  assert.equal(r2.instance.status, 'APPROVED');
  assert.ok(r2.instance.completedAt);
  assert.deepEqual(w.log, ['arrived dept', 'APPROVED dept', 'arrived acct', 'APPROVED acct', 'approved']);
});

test('결정 가드: 순서 위반·이중 결정·권한 없음·없는 단계', async () => {
  const w = world({ m1: ['DEPT'], a1: ['ACCT'], x: [] });
  const { steps } = await submit(w.store, w.h, { ...REQ, plan: PLAN });
  await rejects(approve(w.store, w.h, stepOf(steps, 'acct').id, 'a1'), 'CONFLICT');      // 앞 단계가 끝나지 않음
  await rejects(approve(w.store, w.h, stepOf(steps, 'dept').id, 'x'), 'FORBIDDEN');
  await rejects(approve(w.store, w.h, 'nope', 'm1'), 'NOT_FOUND');
  await approve(w.store, w.h, stepOf(steps, 'dept').id, 'm1');
  await rejects(approve(w.store, w.h, stepOf(steps, 'dept').id, 'm1'), 'CONFLICT');       // 이중 결정
});

test('직무 분리: 요청자 본인·앞 단계 승인자는 결정 불가(자격이 있어도)', async () => {
  const w = world({ req: ['DEPT', 'ACCT'], both: ['DEPT', 'ACCT'], a1: ['ACCT'] });
  const { steps } = await submit(w.store, w.h, { ...REQ, plan: [{ ...PLAN[0], mergeSame: false }, PLAN[1]] });
  await rejects(approve(w.store, w.h, stepOf(steps, 'dept').id, 'req'), 'SOD');
  await rejects(reject(w.store, w.h, stepOf(steps, 'dept').id, 'req', '안 됨'), 'SOD');
  await approve(w.store, w.h, stepOf(steps, 'dept').id, 'both');
  await rejects(approve(w.store, w.h, stepOf(steps, 'acct').id, 'both'), 'SOD');
  await approve(w.store, w.h, stepOf(steps, 'acct').id, 'a1');
});

test('병합: 같은 사람이 다음 단계 자격도 있으면 함께 승인, 대리 단계·병합 안 하는 단계는 따로', async () => {
  const w = world({ both: ['DEPT', 'DEPT2', 'ACCT'], a1: ['ACCT'] });
  const plan: StepPlan[] = [{ key: 's1', label: '보내는', resolver: 'DEPT' }, { key: 's2', label: '받는', resolver: 'DEPT2', mergeSame: true }, { key: 'acct', label: '회계', resolver: 'ACCT' }];
  const { steps } = await submit(w.store, w.h, { ...REQ, plan });
  const r = await approve(w.store, w.h, stepOf(steps, 's1').id, 'both');
  assert.equal(r.instance.currentStep, 3);
  const after = await w.store.getSteps(r.instance.id);
  assert.equal(stepOf(after, 's2').status, 'APPROVED');
  assert.equal(stepOf(after, 's2').comment, '[동일 승인자] 1단계 승인으로 함께 승인');
  assert.equal(stepOf(after, 's2').approverId, 'both');

  const w2 = world({ both: ['DEPT', 'DEPT2'] });
  const px = await submit(w2.store, w2.h, { ...REQ, plan: [plan[0], { ...plan[1], proxy: true }, plan[2]] });
  const r2 = await approve(w2.store, w2.h, stepOf(px.steps, 's1').id, 'both');
  assert.equal(r2.instance.currentStep, 2);                                              // 대리 단계는 병합하지 않는다
  assert.equal((await w2.store.getSteps(r2.instance.id)).find((s) => s.key === 's2')!.status, 'PENDING');
});

test('병합으로 마지막 단계까지 승인되면 곧바로 완료', async () => {
  const w = world({ both: ['DEPT', 'DEPT2'] });
  const plan: StepPlan[] = [{ key: 's1', label: 'a', resolver: 'DEPT' }, { key: 's2', label: 'b', resolver: 'DEPT2', mergeSame: true }];
  const { steps } = await submit(w.store, w.h, { ...REQ, plan });
  const r = await approve(w.store, w.h, stepOf(steps, 's1').id, 'both');
  assert.equal(r.instance.status, 'APPROVED');
  assert.deepEqual(w.log.slice(-2), ['APPROVED s1', 'approved']);
});

test('대리 단계의 의견에는 표시가 붙는다', async () => {
  const w = world({ a1: ['ACCT'], a2: ['ACCT'] });
  const { steps } = await submit(w.store, w.h, { ...REQ, plan: [{ key: 'dept', label: '부서', resolver: 'ACCT', proxy: true }, { key: 'acct', label: '회계', resolver: 'ACCT' }] });
  const r = await approve(w.store, w.h, steps[0].id, 'a1', '문제 없음');
  assert.equal(r.step.comment, '[대리] 문제 없음');
});

test('반려: 의견 필수, 남은 단계는 건너뜀, 반려 훅', async () => {
  const w = world({ m1: ['DEPT'], a1: ['ACCT'] });
  const { steps } = await submit(w.store, w.h, { ...REQ, plan: PLAN });
  await rejects(reject(w.store, w.h, stepOf(steps, 'dept').id, 'm1', '  '), 'INVALID');
  const r = await reject(w.store, w.h, stepOf(steps, 'dept').id, 'm1', '자료 부족');
  assert.equal(r.instance.status, 'REJECTED');
  const after = await w.store.getSteps(r.instance.id);
  assert.deepEqual(after.map((s) => s.status), ['REJECTED', 'SKIPPED']);
  assert.deepEqual(w.log.slice(-2), ['REJECTED dept', 'rejected']);
  await rejects(approve(w.store, w.h, stepOf(steps, 'acct').id, 'a1'), 'CONFLICT');
});

test('취소: 진행 중만, 대기 단계는 건너뜀, 취소 뒤 같은 대상에 새 제출 가능', async () => {
  const w = world({ m1: ['DEPT'] });
  const { instance } = await submit(w.store, w.h, { ...REQ, plan: PLAN });
  await rejects(submit(w.store, w.h, { ...REQ, plan: PLAN }), 'CONFLICT');                // 이중 제출
  const c = await cancel(w.store, w.h, instance.id, 'req');
  assert.equal(c.status, 'CANCELLED');
  assert.deepEqual((await w.store.getSteps(instance.id)).map((s) => s.status), ['SKIPPED', 'SKIPPED']);
  await rejects(cancel(w.store, w.h, instance.id, 'req'), 'CONFLICT');
  await submit(w.store, w.h, { ...REQ, plan: PLAN });
  await rejects(cancel(w.store, w.h, 'nope', 'req'), 'NOT_FOUND');
});

test('재시작: 반려·승인 뒤 단계를 새로 만들고, 보정한 사람은 새 단계를 결정할 수 없다(설정)', async () => {
  const w = world({ fix: ['DEPT'], m1: ['DEPT'], a1: ['ACCT'] });
  const first = await submit(w.store, w.h, { ...REQ, plan: [{ ...PLAN[0], mergeSame: false }, PLAN[1]] });
  await rejects(restart(w.store, w.h, first.instance.id, 'fix', PLAN), 'CONFLICT');          // 진행 중에는 불가
  await reject(w.store, w.h, stepOf(first.steps, 'dept').id, 'm1', '수정 필요');
  const again = await restart(w.store, w.h, first.instance.id, 'fix', [{ ...PLAN[0], mergeSame: false }, PLAN[1]]);
  assert.equal(again.instance.status, 'IN_PROGRESS');
  assert.equal(again.instance.currentStep, 1);
  assert.equal(again.instance.completedAt, undefined);
  assert.ok(again.steps.every((s) => s.createdBy === 'fix'));
  await rejects(approve(w.store, w.h, stepOf(again.steps, 'dept').id, 'fix'), 'SOD');
  await approve(w.store, w.h, stepOf(again.steps, 'dept').id, 'm1');

  const w2 = world({ fix: ['DEPT'], m1: ['DEPT'] });
  const f2 = await submit(w2.store, w2.h, { ...REQ, plan: [PLAN[0]], rules: { fixerCannotReapprove: false } });
  await reject(w2.store, w2.h, f2.steps[0].id, 'm1', 'x');
  const a2 = await restart(w2.store, w2.h, f2.instance.id, 'fix', [PLAN[0]]);
  assert.equal((await approve(w2.store, w2.h, a2.steps[0].id, 'fix')).instance.status, 'APPROVED');
  await rejects(restart(w2.store, w2.h, 'nope', 'fix', PLAN), 'NOT_FOUND');
});

test('승인함: 지금 단계가 내 차례인 것만, 요청자·앞 단계 승인자·자격 없음 제외, 오래된 순', async () => {
  const w = world({ m1: ['DEPT'], both: ['DEPT', 'ACCT'], a1: ['ACCT'] });
  const x = await submit(w.store, w.h, { ...REQ, subjectId: 'x', plan: [{ ...PLAN[0], mergeSame: false }, PLAN[1]] });
  const y = await submit(w.store, w.h, { ...REQ, subjectId: 'y', requesterId: 'm1', plan: [{ ...PLAN[0], mergeSame: false }, PLAN[1]] });
  assert.deepEqual((await inbox(w.store, w.h, 'm1')).map((i) => i.instance.subjectId), ['x']);          // y는 본인 요청
  assert.deepEqual((await inbox(w.store, w.h, 'both')).map((i) => i.instance.subjectId), ['x', 'y']);   // 오래된 순
  assert.deepEqual(await inbox(w.store, w.h, 'a1'), []);                                                // 아직 회계 차례 아님
  await approve(w.store, w.h, stepOf(x.steps, 'dept').id, 'both');
  assert.deepEqual((await inbox(w.store, w.h, 'both')).map((i) => i.instance.subjectId), ['y']);        // x의 다음 단계는 앞 단계 승인자라 제외
  assert.deepEqual((await inbox(w.store, w.h, 'a1')).map((i) => i.instance.subjectId), ['x']);
  assert.equal(y.instance.currentStep, 1);
});

test('제출 검사: 빈 계획·키 중복·N명 중 M명은 거절', async () => {
  const w = world({});
  await rejects(submit(w.store, w.h, { ...REQ, plan: [] }), 'INVALID');
  await rejects(submit(w.store, w.h, { ...REQ, plan: [PLAN[0], { ...PLAN[1], key: 'dept' }] }), 'INVALID');
  await rejects(submit(w.store, w.h, { ...REQ, plan: [{ ...PLAN[0], minApprovals: 2 }] }), 'INVALID');
});

test('toPlan: 건너뛴·합쳐진·담당자 없는 단계는 계획에서 빠지고 대리 표시는 유지', () => {
  const ps = (key: string, status: PlannedStep['status'], extra: Partial<PlannedStep> = {}): PlannedStep => ({ key, label: key, resolver: 'R', status, proxy: false, approvers: [], ...extra });
  const plan = toPlan([ps('a', 'SKIPPED'), ps('b', 'ACTIVE', { proxy: true }), ps('c', 'MERGED'), ps('d', 'ACTIVE', { missing: true }), ps('e', 'ACTIVE')], { e: true });
  assert.deepEqual(plan.map((p) => [p.key, p.proxy, p.mergeSame]), [['b', true, false], ['e', false, true]]);
});

test('엔진 상태 한눈에: 인스턴스 버전은 변경마다 오른다(메모리 저장소)', async () => {
  const w = world({ m1: ['DEPT'], a1: ['ACCT'] });
  const { instance, steps } = await submit(w.store, w.h, { ...REQ, plan: PLAN });
  const v0 = instance.version;
  await approve(w.store, w.h, stepOf(steps, 'dept').id, 'm1');
  const now: InstanceState = (await w.store.getInstance(instance.id))!;
  assert.ok(now.version > v0);
});

test('제출: createdBy로 보정자처럼 요청자가 아닌 사람이 만든 단계는 그 사람이 결정할 수 없다', async () => {
  const w = world({ fx: ['ACCT'], a2: ['ACCT'], m1: ['DEPT'] });
  const { steps } = await submit(w.store, w.h, { ...REQ, plan: PLAN, createdBy: 'fx' });
  assert.deepEqual(steps.map((s) => s.createdBy), ['fx', 'fx']);
  await approve(w.store, w.h, stepOf(steps, 'dept').id, 'm1');
  await rejects(approve(w.store, w.h, stepOf(steps, 'acct').id, 'fx'), 'SOD');
  assert.equal((await approve(w.store, w.h, stepOf(steps, 'acct').id, 'a2')).instance.status, 'APPROVED');
});
