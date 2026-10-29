// 워크플로 엔진 코어(WBS 4.10): 제출·승인·반려·취소·재시작·승인함. 저장소(Store)와 제품 훅(Hooks)만 알고 DB·HTTP·ALM은 모른다
//   규칙은 지금 ALM 승인(requests.ts)에서 그대로 읽어 옮겼다: 순서대로 한 단계씩, 요청자 본인 승인 불가, 앞 단계 승인자는 뒤 단계 결정 불가,
//   보정(재시작)한 사람은 다시 만든 단계를 결정 불가(설정), 같은 사람이 다음 단계 자격도 있으면 함께 승인(병합), 반려하면 남은 단계는 건너뜀
//   자격(역할 행 범위 등)은 제품이 hooks.canDecide로 판단한다. 이 파일은 같은 트랜잭션 안에서 부르는 것을 전제로 한다(잠금은 store.getInstance(…, true))
//   멀티 뱅크용(금액 구간·N명 중 M명·기한·재인증)은 단계 모델에 자리만 있고(minApprovals·dueAt) 지금은 1명 순차만 지원한다(결정 E-05)
import { PlannedStep } from './plan';

export type InstanceStatus = 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type StepStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';

export interface EngineRules { fixerCannotReapprove: boolean }
export const DEFAULT_RULES: EngineRules = { fixerCannotReapprove: true };

// 제출할 때 제품이 만드는 단계 계획
export interface StepPlan {
  key: string; label: string; resolver: string;
  params?: Record<string, unknown>;   // 제품이 담당자 판단에 쓰는 값(예: 코스트센터 id). 엔진은 열어 보지 않는다
  proxy?: boolean;                    // 담당자가 없어 대리 규칙으로 정한 단계(병합 대상 아님)
  mergeSame?: boolean;                // 앞 단계 승인자가 이 단계 자격도 있으면 함께 승인
  minApprovals?: number;              // N명 중 M명(지금은 1만)
  dueAt?: Date;                       // 승인 기한(지금은 기록만)
}

export interface StepState extends StepPlan {
  id: string; instanceId: string; stepNo: number; status: StepStatus;
  approverId?: string; comment?: string; decidedAt?: Date; createdBy?: string; createdAt: Date;
}

export interface InstanceState {
  id: string; tenantId: string; subjectType: string; subjectId: string; requesterId: string;
  status: InstanceStatus; currentStep: number; rules: EngineRules;
  submittedAt: Date; completedAt?: Date; version: number;
}

export type ErrorKind = 'NOT_FOUND' | 'CONFLICT' | 'SOD' | 'FORBIDDEN' | 'INVALID';
export class WorkflowError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly detail?: Record<string, unknown>) { super(message); }
}

// 저장소: 같은 트랜잭션에서 동작한다. getInstance(id, true)는 행 잠금
export interface Store {
  getInstance(id: string, lock?: boolean): Promise<InstanceState | undefined>;
  getStep(id: string): Promise<StepState | undefined>;
  getSteps(instanceId: string): Promise<StepState[]>;
  activeBySubject(subjectType: string, subjectId: string): Promise<InstanceState | undefined>;
  insertInstance(i: InstanceState): Promise<void>;
  updateInstance(id: string, patch: Partial<Pick<InstanceState, 'status' | 'currentStep' | 'completedAt' | 'submittedAt' | 'rules'>>): Promise<void>;
  insertSteps(steps: StepState[]): Promise<void>;
  deleteSteps(instanceId: string): Promise<void>;
  updateStep(id: string, patch: Partial<Pick<StepState, 'status' | 'approverId' | 'comment' | 'decidedAt'>>): Promise<void>;
  // 지금 단계가 PENDING인 진행 중 인스턴스와 그 단계(승인함 후보). 자격·직무 분리는 엔진이 거른다
  currentPending(): Promise<Array<{ instance: InstanceState; step: StepState }>>;
}

// 제품이 채우는 훅. 알림은 효과를 직접 보내지 않고 훅에서 모아 둔다(제품이 커밋 뒤 보낸다)
export interface Hooks {
  newId(): string;
  now?(): Date;
  canDecide(actorId: string, step: StepState, instance: InstanceState): Promise<boolean>;
  decorateComment?(step: StepState, comment: string | undefined): string | undefined;   // 대리 표시 등
  onStepArrived?(instance: InstanceState, step: StepState): Promise<void>;
  onDecided?(instance: InstanceState, step: StepState, decision: 'APPROVED' | 'REJECTED', comment: string | undefined): Promise<void>;
  onApproved?(instance: InstanceState, actorId: string): Promise<void>;     // 마지막 단계 승인. 던지면 결정 전체를 되돌린다(같은 트랜잭션)
  onRejected?(instance: InstanceState, actorId: string): Promise<void>;
  onCancelled?(instance: InstanceState, actorId: string): Promise<void>;
}

const now = (h: Hooks) => h.now?.() ?? new Date();
const MERGE_NOTE = (from: number) => `[동일 승인자] ${from}단계 승인으로 함께 승인`;

// 검사 결과의 PlannedStep(4.13 plan.ts)을 제출용 계획으로 바꾼다. 건너뛴·합쳐진 단계는 계획에서 뺀다
export function toPlan(steps: PlannedStep[], mergeFlags: Record<string, boolean> = {}): StepPlan[] {
  return steps.filter((s) => s.status === 'ACTIVE' && !s.missing).map((s) => ({ key: s.key, label: s.label, resolver: s.resolver, proxy: s.proxy, mergeSame: !!mergeFlags[s.key] }));
}

function checkPlan(plan: StepPlan[]) {
  if (!plan.length) throw new WorkflowError('INVALID', '승인 단계가 하나 이상 있어야 합니다');
  const keys = new Set<string>();
  for (const s of plan) {
    if (keys.has(s.key)) throw new WorkflowError('INVALID', `단계 키가 겹칩니다: ${s.key}`);
    keys.add(s.key);
    if ((s.minApprovals ?? 1) !== 1) throw new WorkflowError('INVALID', 'N명 중 M명 승인은 아직 지원하지 않습니다(멀티 뱅크 착수 때 구현)');
  }
}

function mkSteps(h: Hooks, instanceId: string, plan: StepPlan[], createdBy: string): StepState[] {
  return plan.map((p, i) => ({ ...p, id: h.newId(), instanceId, stepNo: i + 1, status: 'PENDING' as const, createdBy, createdAt: now(h) }));
}

// createdBy: 단계를 만든 사람(기본은 요청자). 보정 등으로 요청자가 아닌 사람이 제출·재상신할 때 그 사람을 적는다(직무 분리: 만든 사람은 그 단계를 결정 불가)
export interface SubmitInput { tenantId: string; subjectType: string; subjectId: string; requesterId: string; plan: StepPlan[]; rules?: EngineRules; createdBy?: string }

export async function submit(store: Store, h: Hooks, i: SubmitInput): Promise<{ instance: InstanceState; steps: StepState[] }> {
  checkPlan(i.plan);
  if (await store.activeBySubject(i.subjectType, i.subjectId)) throw new WorkflowError('CONFLICT', '이미 진행 중인 승인이 있습니다');
  const instance: InstanceState = { id: h.newId(), tenantId: i.tenantId, subjectType: i.subjectType, subjectId: i.subjectId, requesterId: i.requesterId,
    status: 'IN_PROGRESS', currentStep: 1, rules: i.rules ?? DEFAULT_RULES, submittedAt: now(h), version: 1 };
  const steps = mkSteps(h, instance.id, i.plan, i.createdBy ?? i.requesterId);
  await store.insertInstance(instance);
  await store.insertSteps(steps);
  await h.onStepArrived?.(instance, steps[0]);
  return { instance, steps };
}

// 전기 오류 보정 등으로 같은 인스턴스를 처음부터 다시 승인받는다. 단계를 새로 만들고 만든 사람(보정자)을 기록한다
export async function restart(store: Store, h: Hooks, instanceId: string, actorId: string, plan: StepPlan[], rules?: EngineRules): Promise<{ instance: InstanceState; steps: StepState[] }> {
  checkPlan(plan);
  const inst = await store.getInstance(instanceId, true);
  if (!inst) throw new WorkflowError('NOT_FOUND', '승인을 찾을 수 없습니다');
  if (inst.status === 'IN_PROGRESS') throw new WorkflowError('CONFLICT', '이미 진행 중인 승인입니다');
  if (inst.status === 'CANCELLED') throw new WorkflowError('CONFLICT', '취소된 승인은 다시 시작할 수 없습니다');
  await store.deleteSteps(inst.id);
  const steps = mkSteps(h, inst.id, plan, actorId);
  await store.insertSteps(steps);
  await store.updateInstance(inst.id, { status: 'IN_PROGRESS', currentStep: 1, completedAt: undefined, submittedAt: now(h), rules: rules ?? inst.rules });
  const next = (await store.getInstance(inst.id))!;
  await h.onStepArrived?.(next, steps[0]);
  return { instance: next, steps };
}

// 이 사람이 이 단계를 결정할 수 있는가(직무 분리만. 자격은 hooks.canDecide). 위반하면 던진다
function sod(inst: InstanceState, step: StepState, all: StepState[], actorId: string) {
  if (inst.requesterId === actorId) throw new WorkflowError('SOD', '본인 요청은 승인·반려할 수 없습니다(직무 분리)');
  if (inst.rules.fixerCannotReapprove && step.createdBy === actorId) throw new WorkflowError('SOD', '이 요청을 보정한 사람은 다시 만든 승인 단계를 결정할 수 없습니다(직무 분리)');
  if (all.some((s) => s.stepNo < step.stepNo && s.approverId === actorId)) throw new WorkflowError('SOD', '앞 단계를 승인한 사람은 다음 단계를 결정할 수 없습니다(직무 분리)');
}

async function decidable(store: Store, h: Hooks, stepId: string, actorId: string) {
  const s0 = await store.getStep(stepId);
  if (!s0) throw new WorkflowError('NOT_FOUND', '승인 단계를 찾을 수 없습니다');
  const inst = await store.getInstance(s0.instanceId, true);
  if (!inst) throw new WorkflowError('NOT_FOUND', '승인 단계를 찾을 수 없습니다');
  const all = await store.getSteps(inst.id);
  const step = all.find((s) => s.id === stepId)!;
  if (step.status !== 'PENDING' || inst.status !== 'IN_PROGRESS') throw new WorkflowError('CONFLICT', '이미 결정된 단계입니다');
  if (step.stepNo !== inst.currentStep) throw new WorkflowError('CONFLICT', '앞 단계 승인이 끝나지 않았습니다');
  sod(inst, step, all, actorId);
  if (!(await h.canDecide(actorId, step, inst))) throw new WorkflowError('FORBIDDEN', `이 단계(${step.key})의 승인 권한이 없습니다`);
  return { inst, step, all };
}

export async function approve(store: Store, h: Hooks, stepId: string, actorId: string, comment?: string): Promise<{ instance: InstanceState; step: StepState }> {
  const { inst, step, all } = await decidable(store, h, stepId, actorId);
  const text = h.decorateComment ? h.decorateComment(step, comment) : comment;
  await store.updateStep(step.id, { status: 'APPROVED', approverId: actorId, comment: text, decidedAt: now(h) });
  await h.onDecided?.(inst, step, 'APPROVED', text);
  let no = step.stepNo;
  for (;;) {
    const next = all.find((s) => s.stepNo === no + 1);
    if (!next) {
      await store.updateInstance(inst.id, { status: 'APPROVED', completedAt: now(h) });
      const done = (await store.getInstance(inst.id))!;
      await h.onApproved?.(done, actorId);
      break;
    }
    // 같은 사람이 다음 단계 자격도 있으면 함께 승인(대리 단계는 제외)
    if (next.mergeSame && !next.proxy && (await h.canDecide(actorId, next, inst))) {
      await store.updateStep(next.id, { status: 'APPROVED', approverId: actorId, comment: MERGE_NOTE(step.stepNo), decidedAt: now(h) });
      no = next.stepNo;
      continue;
    }
    await store.updateInstance(inst.id, { currentStep: next.stepNo });
    await h.onStepArrived?.({ ...inst, currentStep: next.stepNo }, next);
    break;
  }
  return { instance: (await store.getInstance(inst.id))!, step: (await store.getStep(step.id))! };
}

export async function reject(store: Store, h: Hooks, stepId: string, actorId: string, comment: string): Promise<{ instance: InstanceState; step: StepState }> {
  if (!comment || !comment.trim()) throw new WorkflowError('INVALID', '반려 의견은 필수입니다');
  const { inst, step, all } = await decidable(store, h, stepId, actorId);
  const text = (h.decorateComment ? h.decorateComment(step, comment) : comment)!;
  await store.updateStep(step.id, { status: 'REJECTED', approverId: actorId, comment: text, decidedAt: now(h) });
  for (const s of all) if (s.id !== step.id && s.status === 'PENDING') await store.updateStep(s.id, { status: 'SKIPPED' });
  await store.updateInstance(inst.id, { status: 'REJECTED', completedAt: now(h) });
  const done = (await store.getInstance(inst.id))!;
  await h.onDecided?.(done, step, 'REJECTED', text);
  await h.onRejected?.(done, actorId);
  return { instance: done, step: (await store.getStep(step.id))! };
}

// 취소 권한은 제품이 먼저 확인한다(요청자·범위 안 관리자 등). 엔진은 진행 중인 것만 취소한다. 승인 뒤 취소(전기 대기 중)는 도메인 몫
export async function cancel(store: Store, h: Hooks, instanceId: string, actorId: string): Promise<InstanceState> {
  const inst = await store.getInstance(instanceId, true);
  if (!inst) throw new WorkflowError('NOT_FOUND', '승인을 찾을 수 없습니다');
  if (inst.status !== 'IN_PROGRESS') throw new WorkflowError('CONFLICT', `${inst.status} 상태의 승인은 취소할 수 없습니다`);
  for (const s of await store.getSteps(inst.id)) if (s.status === 'PENDING') await store.updateStep(s.id, { status: 'SKIPPED' });
  await store.updateInstance(inst.id, { status: 'CANCELLED', completedAt: now(h) });
  const done = (await store.getInstance(inst.id))!;
  await h.onCancelled?.(done, actorId);
  return done;
}

// 승인함: 지금 단계가 내 차례이고 직무 분리·자격에 걸리지 않는 것. 오래 기다린 순
export async function inbox(store: Store, h: Hooks, actorId: string): Promise<Array<{ instance: InstanceState; step: StepState }>> {
  const out: Array<{ instance: InstanceState; step: StepState }> = [];
  for (const c of await store.currentPending()) {
    if (c.step.stepNo !== c.instance.currentStep || c.step.status !== 'PENDING') continue;
    try { sod(c.instance, c.step, await store.getSteps(c.instance.id), actorId); } catch { continue; }
    if (await h.canDecide(actorId, c.step, c.instance)) out.push(c);
  }
  return out.sort((a, b) => a.instance.submittedAt.getTime() - b.instance.submittedAt.getTime());
}
