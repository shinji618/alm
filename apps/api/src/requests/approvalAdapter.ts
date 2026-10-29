// ALM 승인 어댑터(WBS 4.11): 공유 워크플로 엔진(platform/workflow)과 ALM 요청 도메인 사이의 변환만 맡는다.
//   - 대상: subject_type 'ASSET_REQUEST', subject_id = asset_request.id (승인 1건 = 요청 1건). 단계 id는 승인함·화면이 쓰는 approvalId
//   - 단계 계획(부서 관리자 → 자산회계)을 엔진 단계 계획으로 옮긴다. 단계 키: dept1·dept2·acct, 역할 코드가 resolver, 코스트센터는 params.ccId
//   - 엔진 오류(WorkflowError)를 API 오류 코드로 바꾼다(409 ALM-E322 · 403 ALM-E403 · 403 ALM-E401 · 404 · 400)
//   - 상태 매핑(E-04): asset_request.status(SUBMITTED·MGR_APPROVED·…)는 그대로 두고 훅(requests.ts)이 엔진 상태에 맞춰 갱신한다
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import * as wf from '../platform/workflow';

export const SUBJECT = 'ASSET_REQUEST';
export type AlmRole = 'DEPT_MANAGER' | 'ASSET_ACCOUNTANT';
export interface AlmStep { role: AlmRole; ccId: string | null; proxy?: boolean }

const LABEL: Record<AlmRole, string> = { DEPT_MANAGER: '부서 관리자 승인', ASSET_ACCOUNTANT: '자산회계 승인' };

// 부서 관리자 단계는 앞 단계와 같은 승인자면 함께 승인(mergeSame). 담당자가 없어 대리로 정한 단계(proxy)는 병합 대상이 아니다
export function toStepPlans(steps: AlmStep[]): wf.StepPlan[] {
  let dept = 0;
  return steps.map((s) => ({
    key: s.role === 'DEPT_MANAGER' ? `dept${++dept}` : 'acct', label: LABEL[s.role], resolver: s.role,
    params: s.ccId ? { ccId: s.ccId } : undefined, proxy: !!s.proxy, mergeSame: s.role === 'DEPT_MANAGER',
  }));
}

export function toAlmError(e: wf.WorkflowError): AlmError {
  switch (e.kind) {
    case 'NOT_FOUND': return E.notFound(e.message);
    case 'SOD': return E.sod(e.message);
    case 'FORBIDDEN': return E.forbidden(e.message);
    case 'INVALID': return E.badRequest(e.message);
    default: return new AlmError(409, 'ALM-E322', e.message);
  }
}

export async function wfCall<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw e instanceof wf.WorkflowError ? toAlmError(e) : e; }
}

// 자격 판단이 필요 없는 호출(할당·등록 화면이 만든 요청, 전기 취소)에서 쓰는 최소 훅
const plainHooks = (): wf.Hooks => ({ newId: randomUUID, canDecide: async () => false });

// 승인 시작: 요청자가 곧바로 제출 상태로 만드는 화면(ALM-111 할당, ALM-112 등록) — 단계 코스트센터는 요청의 책임 코스트센터를 따른다
export async function startDefaultFlow(c: PoolClient, p: { tenantId: string; userId: string }, requestId: string): Promise<void> {
  const plan = toStepPlans([{ role: 'DEPT_MANAGER', ccId: null }, { role: 'ASSET_ACCOUNTANT', ccId: null }]);
  await wfCall(() => wf.submit(new wf.PgStore(c, p.userId), plainHooks(), { tenantId: p.tenantId, subjectType: SUBJECT, subjectId: requestId, requesterId: p.userId, plan }));
}

// 진행 중인 승인이 있으면 취소(대기 단계는 건너뜀). 없으면 아무것도 하지 않는다(이미 끝난 승인은 도메인이 다룬다, 결정 2)
export async function cancelActiveFlow(c: PoolClient, actorId: string, requestId: string): Promise<void> {
  const store = new wf.PgStore(c, actorId);
  const inst = await store.activeBySubject(SUBJECT, requestId);
  if (inst) await wfCall(() => wf.cancel(store, plainHooks(), inst.id, actorId));
}

// 같은 요청의 가장 최근 인스턴스 id(보정 뒤 재승인에서 다시 시작할 대상)
export async function latestFlowId(c: PoolClient, requestId: string): Promise<string | undefined> {
  return (await c.query(`SELECT id FROM workflow_instance WHERE subject_type = $1 AND subject_id = $2 ORDER BY submitted_at DESC LIMIT 1`, [SUBJECT, requestId])).rows[0]?.id;
}
