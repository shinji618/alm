// 엔진 저장소의 Postgres 구현(WBS 4.10): workflow_instance·workflow_step. 호출하는 쪽이 연 트랜잭션(SET LOCAL app.tenant_id 된 상태) 안에서 쓴다
//   actorId는 변경자(updated_by·created_by)로 기록된다. 감사는 DB 트리거가 남긴다
//   주의: 이 구현은 DB 환경에서 시험해야 한다(이 저장소의 단위 시험은 SQL 모양만 본다)
import type { PoolClient } from 'pg';
import { InstanceState, StepState, Store } from './engine';

const iso = (d: unknown): Date | undefined => (d instanceof Date ? d : d ? new Date(String(d)) : undefined);

const toInstance = (r: Record<string, any>): InstanceState => ({
  id: r.id, tenantId: r.tenant_id, subjectType: r.subject_type, subjectId: r.subject_id, requesterId: r.requester_id, status: r.status,
  currentStep: Number(r.current_step), rules: { fixerCannotReapprove: true, ...(r.rules ?? {}) }, submittedAt: iso(r.submitted_at)!,
  completedAt: iso(r.completed_at), version: Number(r.version),
});

const toStep = (r: Record<string, any>): StepState => ({
  id: r.id, instanceId: r.instance_id, stepNo: Number(r.step_no), key: r.step_key, label: r.label, resolver: r.resolver,
  params: r.params ?? undefined, proxy: !!r.proxy, mergeSame: !!r.merge_same, minApprovals: Number(r.min_approvals),
  dueAt: iso(r.due_at), status: r.status, approverId: r.approver_id ?? undefined, comment: r.comment ?? undefined,
  decidedAt: iso(r.decided_at), createdBy: r.created_by ?? undefined, createdAt: iso(r.created_at)!,
});

const INST_COLS: Record<string, string> = { status: 'status', currentStep: 'current_step', completedAt: 'completed_at', submittedAt: 'submitted_at', rules: 'rules' };
const STEP_COLS: Record<string, string> = { status: 'status', approverId: 'approver_id', comment: 'comment', decidedAt: 'decided_at' };

// 패치 객체 → SET 절. 키가 있으면 undefined도 NULL로 쓴다
function setClause(patch: Record<string, unknown>, cols: Record<string, string>, first: number): { sql: string; values: unknown[] } {
  const sets: string[] = [], values: unknown[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if (!(k in patch)) continue;
    values.push(k === 'rules' && patch[k] ? JSON.stringify(patch[k]) : patch[k] ?? null);
    sets.push(`${col} = $${first + values.length - 1}`);
  }
  return { sql: sets.join(', '), values };
}

export class PgStore implements Store {
  constructor(private readonly c: PoolClient, private readonly actorId: string) {}

  async getInstance(id: string, lock = false) {
    const r = (await this.c.query(`SELECT * FROM workflow_instance WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    return r ? toInstance(r) : undefined;
  }
  async getStep(id: string) {
    const r = (await this.c.query('SELECT * FROM workflow_step WHERE id = $1', [id])).rows[0];
    return r ? toStep(r) : undefined;
  }
  async getSteps(instanceId: string) {
    return (await this.c.query('SELECT * FROM workflow_step WHERE instance_id = $1 ORDER BY step_no', [instanceId])).rows.map(toStep);
  }
  // 같은 대상에 동시에 제출하는 것을 막기 위해 대상별 잠금을 먼저 잡는다(트랜잭션 끝에 풀림)
  async activeBySubject(subjectType: string, subjectId: string) {
    await this.c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wf:${subjectType}:${subjectId}`]);
    const r = (await this.c.query(`SELECT * FROM workflow_instance WHERE subject_type = $1 AND subject_id = $2 AND status = 'IN_PROGRESS'`, [subjectType, subjectId])).rows[0];
    return r ? toInstance(r) : undefined;
  }
  async insertInstance(i: InstanceState) {
    await this.c.query(`INSERT INTO workflow_instance (id, tenant_id, subject_type, subject_id, requester_id, status, current_step, rules, submitted_at, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [i.id, i.tenantId, i.subjectType, i.subjectId, i.requesterId, i.status, i.currentStep, JSON.stringify(i.rules), i.submittedAt, this.actorId]);
  }
  async updateInstance(id: string, patch: Partial<Pick<InstanceState, 'status' | 'currentStep' | 'completedAt' | 'submittedAt' | 'rules'>>) {
    const { sql, values } = setClause(patch, INST_COLS, 3);
    await this.c.query(`UPDATE workflow_instance SET ${sql ? `${sql}, ` : ''}updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, this.actorId, ...values]);
  }
  async insertSteps(steps: StepState[]) {
    for (const s of steps) {
      await this.c.query(`INSERT INTO workflow_step (id, tenant_id, instance_id, step_no, step_key, label, resolver, params, proxy, merge_same, min_approvals, due_at, status, created_by, updated_by)
        SELECT $1, i.tenant_id, i.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13 FROM workflow_instance i WHERE i.id = $2`,
      [s.id, s.instanceId, s.stepNo, s.key, s.label, s.resolver, s.params ? JSON.stringify(s.params) : null, !!s.proxy, !!s.mergeSame, s.minApprovals ?? 1,
        s.dueAt ?? null, s.status, s.createdBy ?? this.actorId]);
    }
  }
  async deleteSteps(instanceId: string) { await this.c.query('DELETE FROM workflow_step WHERE instance_id = $1', [instanceId]); }
  async updateStep(id: string, patch: Partial<Pick<StepState, 'status' | 'approverId' | 'comment' | 'decidedAt'>>) {
    const { sql, values } = setClause(patch, STEP_COLS, 3);
    await this.c.query(`UPDATE workflow_step SET ${sql ? `${sql}, ` : ''}updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, this.actorId, ...values]);
  }
  async currentPending() {
    const rows = (await this.c.query(`SELECT row_to_json(i) AS inst, row_to_json(s) AS step FROM workflow_instance i
      JOIN workflow_step s ON s.instance_id = i.id AND s.step_no = i.current_step AND s.status = 'PENDING'
      WHERE i.status = 'IN_PROGRESS' ORDER BY i.submitted_at`)).rows;
    return rows.map((r) => ({ instance: toInstance(r.inst), step: toStep(r.step) }));
  }
}
