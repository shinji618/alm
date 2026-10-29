// 워크플로 정의(WBS 4.13): 검사·정규화·단계 계획. DB 없이 돈다(담당자 풀이는 가짜 함수)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDefinition, planSteps, sameDefinition, toStored, validateDefinition, WorkflowDef } from '../src/platform/workflow';
import type { Person } from '../src/platform/workflow';
import { ALM_CATALOG, defaultDefinition, SimCtx, SUBJECTS } from '../src/admin/workflowAdapter';

const P = (id: string): Person => ({ id, name: id });
const fields = (d: WorkflowDef) => validateDefinition(d, ALM_CATALOG).map((i) => i.field);

test('기본 정의는 대상 유형 5종 모두 검사를 통과한다', () => {
  for (const s of SUBJECTS) assert.deepEqual(validateDefinition(defaultDefinition(s.code), ALM_CATALOG), [], s.code);
});

test('검사: 카탈로그·최종 단계·중복 규칙', () => {
  const d = defaultDefinition('NEW_ASSET');
  assert.deepEqual(fields({ ...d, steps: [] }), ['steps']);
  assert.ok(fields({ ...d, steps: [d.steps[0]] }).includes('steps[0].resolver'));                       // 마지막이 최종 규칙이 아님
  assert.ok(fields({ ...d, steps: [d.steps[1], d.steps[1]] }).includes('steps[1].resolver'));            // 같은 규칙 두 번
  assert.ok(fields({ ...d, steps: [{ ...d.steps[0], resolver: 'DEPT_MANAGER_SOURCE' }, d.steps[1]] }).includes('steps[0].resolver')); // 이관 전용 규칙
  assert.ok(fields({ ...d, steps: [{ ...d.steps[0], resolver: 'NOPE' }, d.steps[1]] }).includes('steps[0].resolver'));
  assert.ok(fields({ ...d, steps: [d.steps[0], { ...d.steps[1], fallback: 'SKIP' }] }).includes('steps[1].fallback'));
  assert.ok(fields({ ...d, steps: [d.steps[0], { ...d.steps[1], mergeSame: true }] }).includes('steps[1].mergeSame'));
  assert.ok(fields({ ...d, steps: [{ ...d.steps[0], fallback: 'WHO' }, d.steps[1]] }).includes('steps[0].fallback'));
  assert.ok(fields({ ...d, steps: [{ ...d.steps[0], key: 'Bad Key' }, d.steps[1]] }).includes('steps[0].key'));
  assert.ok(fields({ ...d, steps: [d.steps[0], { ...d.steps[1], key: d.steps[0].key }] }).includes('steps[1].key'));
  const many = Array.from({ length: 6 }, (_, i) => ({ ...d.steps[0], key: `s${i}`, resolver: i < 5 ? `R${i}` : 'ROLE_ASSET_ACCOUNTANT' }));
  assert.ok(fields({ ...d, steps: many }).includes('steps'));
});

test('모양 검사: 알 수 없는 설정·타입 오류를 모아 준다', () => {
  const { issues } = parseDefinition({ name: '', steps: [{ key: 1 }, 'x'], options: { nope: true, requesterNoStep: 'y' } }, 'CHANGE');
  const f = issues.map((i) => i.field);
  for (const x of ['name', 'steps[0].key', 'steps[1]', 'options.nope', 'options.requesterNoStep']) assert.ok(f.includes(x), x);
  assert.ok(parseDefinition({ name: 'a', steps: 'x' }, 'CHANGE').issues.some((i) => i.field === 'steps'));
});

test('정규화: 저장 모양이 고정되고 같은 정의는 같다', () => {
  const d = defaultDefinition('CHANGE');
  const { def, issues } = parseDefinition({ name: ` ${d.name} `, steps: d.steps.map((s) => ({ ...s })), options: {} }, 'CHANGE');
  assert.deepEqual(issues, []);
  assert.ok(sameDefinition(def, d));
  assert.equal(def.options.fixerCannotReapprove, true);
  assert.deepEqual(Object.keys(toStored(def).steps[0]), ['key', 'label', 'resolver', 'fallback', 'mergeSame']);
  assert.ok(!sameDefinition(def, { ...d, name: '다른 이름' }));
});

const resolver = (m: Record<string, Person[]>) => async (r: string) => m[r] ?? [];
const ctx: SimCtx = {};

test('계획: 부서 관리자 → 자산회계', async () => {
  const s = await planSteps(defaultDefinition('NEW_ASSET'), ALM_CATALOG, ctx, 'req',
    resolver({ DEPT_MANAGER_RESPONSIBLE: [P('m1')], ROLE_ASSET_ACCOUNTANT: [P('a1')] }));
  assert.deepEqual(s.map((x) => [x.key, x.status, x.proxy]), [['dept', 'ACTIVE', false], ['accounting', 'ACTIVE', false]]);
});

test('계획: 요청자가 유일한 부서 관리자면 자산회계가 대리(proxy)', async () => {
  const s = await planSteps(defaultDefinition('NEW_ASSET'), ALM_CATALOG, ctx, 'm1',
    resolver({ DEPT_MANAGER_RESPONSIBLE: [P('m1')], ROLE_ASSET_ACCOUNTANT: [P('a1')] }));
  assert.equal(s[0].proxy, true);
  assert.deepEqual(s[0].approvers.map((p) => p.id), ['a1']);
});

test('계획: 엄격 설정이면 요청자를 대리 담당자에서도 뺀다', async () => {
  const d = defaultDefinition('NEW_ASSET');
  d.options.requesterNoStep = true;
  const s = await planSteps(d, ALM_CATALOG, ctx, 'a1', resolver({ ROLE_ASSET_ACCOUNTANT: [P('a1')] }));
  assert.equal(s[0].missing, true);
  assert.equal(s[1].missing, true);
});

test('계획: 최종 담당자가 없으면 제출 불가 표시', async () => {
  const s = await planSteps(defaultDefinition('CHANGE'), ALM_CATALOG, ctx, 'req', resolver({ DEPT_MANAGER_RESPONSIBLE: [P('m1')] }));
  assert.equal(s[1].missing, true);
});

test('계획: 이관 — 같은 관리자면 두 번째 단계는 함께(MERGED)', async () => {
  const s = await planSteps(defaultDefinition('TRANSFER'), ALM_CATALOG, ctx, 'req',
    resolver({ DEPT_MANAGER_SOURCE: [P('m1')], DEPT_MANAGER_TARGET: [P('m1')], ROLE_ASSET_ACCOUNTANT: [P('a1')] }));
  assert.deepEqual(s.map((x) => x.status), ['ACTIVE', 'MERGED', 'ACTIVE']);
});

test('계획: 이관 — 양쪽 부서 관리자가 없으면 건너뛰고 첫 단계를 자산회계 대리로', async () => {
  const s = await planSteps(defaultDefinition('TRANSFER'), ALM_CATALOG, ctx, 'req', resolver({ ROLE_ASSET_ACCOUNTANT: [P('a1')] }));
  assert.equal(s[0].status, 'ACTIVE');
  assert.equal(s[0].proxy, true);
  assert.equal(s[1].status, 'SKIPPED');
  const off = defaultDefinition('TRANSFER');
  off.options.proxyIfAllSkipped = false;
  const s2 = await planSteps(off, ALM_CATALOG, ctx, 'req', resolver({ ROLE_ASSET_ACCOUNTANT: [P('a1')] }));
  assert.deepEqual(s2.map((x) => x.status), ['SKIPPED', 'SKIPPED', 'ACTIVE']);
});
