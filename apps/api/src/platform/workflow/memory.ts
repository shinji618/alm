// 메모리 저장소: 엔진 단위 시험과 다른 제품의 시험용. DB 없이 같은 규칙을 확인한다(잠금은 없음, 한 번에 하나씩 부른다)
import { InstanceState, StepState, Store } from './engine';

const copyI = (i: InstanceState): InstanceState => ({ ...i, rules: { ...i.rules } });
const copyS = (s: StepState): StepState => ({ ...s, params: s.params ? { ...s.params } : undefined });

export class MemoryStore implements Store {
  instances = new Map<string, InstanceState>();
  steps = new Map<string, StepState>();

  async getInstance(id: string) { const i = this.instances.get(id); return i && copyI(i); }
  async getStep(id: string) { const s = this.steps.get(id); return s && copyS(s); }
  async getSteps(instanceId: string) {
    return [...this.steps.values()].filter((s) => s.instanceId === instanceId).sort((a, b) => a.stepNo - b.stepNo).map(copyS);
  }
  async activeBySubject(subjectType: string, subjectId: string) {
    const i = [...this.instances.values()].find((x) => x.subjectType === subjectType && x.subjectId === subjectId && x.status === 'IN_PROGRESS');
    return i && copyI(i);
  }
  async insertInstance(i: InstanceState) { this.instances.set(i.id, copyI(i)); }
  async updateInstance(id: string, patch: Parameters<Store['updateInstance']>[1]) {
    const i = this.instances.get(id)!;
    Object.assign(i, patch);                 // 키가 있으면 undefined도 덮어쓴다(완료 일시 지우기)
    i.version += 1;
  }
  async insertSteps(steps: StepState[]) { for (const s of steps) this.steps.set(s.id, copyS(s)); }
  async deleteSteps(instanceId: string) { for (const [k, s] of this.steps) if (s.instanceId === instanceId) this.steps.delete(k); }
  async updateStep(id: string, patch: Parameters<Store['updateStep']>[1]) { Object.assign(this.steps.get(id)!, patch); }
  async currentPending() {
    const out: Array<{ instance: InstanceState; step: StepState }> = [];
    for (const i of this.instances.values()) {
      if (i.status !== 'IN_PROGRESS') continue;
      const s = [...this.steps.values()].find((x) => x.instanceId === i.id && x.stepNo === i.currentStep && x.status === 'PENDING');
      if (s) out.push({ instance: copyI(i), step: copyS(s) });
    }
    return out;
  }
}
