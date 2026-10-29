// 승인 단계 계획(시험 실행·실행 엔진 공용). 담당자 규칙은 제품이 resolve 함수로 풀이한다(코스트센터·역할 범위 등은 제품 몫)
//   단계 상태: ACTIVE 승인 대기 대상 · SKIPPED 담당자가 없어 건너뜀 · MERGED 앞 단계와 같은 담당자라 함께 승인
//   요청자는 항상 담당자에서 뺀다(요청자 본인 승인 불가). requesterNoStep을 켜면 대리 규칙 담당자에서도 뺀다(엄격)
import { Catalog, NONE, SKIP, WorkflowDef } from './types';

export interface Person { id: string; name: string; detail?: string }
export type PlanStepStatus = 'ACTIVE' | 'SKIPPED' | 'MERGED';
export interface PlannedStep {
  key: string; label: string; resolver: string; status: PlanStepStatus;
  proxy: boolean;               // 담당자가 없어 대리 규칙으로 정한 단계
  missing?: boolean;            // 담당자가 없는데 건너뛸 수 없는 단계(제출할 수 없음)
  approvers: Person[];
}
// resolve(규칙 코드, 문맥) → 그 규칙의 담당자들(요청자 제외 전, 유효한 사람만). 문맥은 제품이 정한다
export type ResolveFn<Ctx> = (resolver: string, ctx: Ctx) => Promise<Person[]>;

const same = (a: Person[], b: Person[]) => a.length === b.length && a.map((x) => x.id).sort().join() === b.map((x) => x.id).sort().join();

export async function planSteps<Ctx>(def: WorkflowDef, cat: Catalog, ctx: Ctx, requesterId: string | undefined, resolve: ResolveFn<Ctx>): Promise<PlannedStep[]> {
  const notRequester = (l: Person[]) => l.filter((p) => p.id !== requesterId);
  const out: PlannedStep[] = [];
  let prev: Person[] = [];
  for (const [i, s] of def.steps.entries()) {
    const last = i === def.steps.length - 1;
    let approvers = notRequester(await resolve(s.resolver, ctx));
    let proxy = false;
    if (!approvers.length && s.fallback !== SKIP && s.fallback !== NONE) {
      const fb = cat.fallbacks.find((f) => f.code === s.fallback);
      if (fb) {
        approvers = await resolve(fb.resolver, ctx);
        if (def.options.requesterNoStep) approvers = notRequester(approvers);
        proxy = true;
      }
    }
    if (!approvers.length) {
      const missing = s.fallback !== SKIP;      // NONE이거나 대리 규칙으로도 담당자를 못 찾음
      out.push({ key: s.key, label: s.label, resolver: s.resolver, status: missing ? 'ACTIVE' : 'SKIPPED', proxy: false, approvers: [], ...(missing ? { missing } : {}) });
      continue;
    }
    const merged = !last && s.mergeSame && prev.length > 0 && same(prev, approvers);
    out.push({ key: s.key, label: s.label, resolver: s.resolver, status: merged ? 'MERGED' : 'ACTIVE', proxy, approvers });
    prev = approvers;
  }
  // 최종 단계 앞이 모두 비면 첫 단계를 대리 규칙으로 처리(아무도 검토하지 않고 회계로 넘어가지 않게)
  const mid = out.slice(0, -1);
  if (def.options.proxyIfAllSkipped && mid.length && mid.every((x) => x.status === 'SKIPPED' || x.missing)) {
    const s = def.steps[0];
    const fb = cat.fallbacks.find((f) => f.code === s.fallback) ?? cat.fallbacks[0];
    if (fb) {
      let approvers = await resolve(fb.resolver, ctx);
      if (def.options.requesterNoStep) approvers = notRequester(approvers);
      if (approvers.length) out[0] = { key: s.key, label: s.label, resolver: s.resolver, status: 'ACTIVE', proxy: true, approvers };
    }
  }
  return out;
}
