// 워크플로 정의 관리(관리 > 워크플로, ADM-070, WBS 4.13, 결정 E-11). 권한: admin.config(시스템 관리자만)
//   대상 유형(자산 요청 5종)마다 정의를 버전으로 쌓는다. 초안(DRAFT) 최대 1개, 게시(PUBLISHED) 최대 1개, 이전 게시는 ARCHIVED.
//   게시한 정의는 승인 실행(requests.ts planSteps → approvalAdapter stepsFromDefinition)이 읽는다. 새로 제출·재승인하는 건부터 적용되고 진행 중인 승인은 그대로다
//   예외: 회사 승인 단계가 2보다 작으면(SAP 끈 회사가 줄임) 회사 설정이 우선해 내장 규칙을 쓴다
//   변경 이력은 감사 트리거(audit_row)가 남긴다. 직무 분리 필수 규칙(H-01·H-02)은 정의로 끌 수 없다
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../platform/identity/principal';
import { parseDefinition, planSteps, sameDefinition, toStored, validateDefinition, WorkflowDef } from '../platform/workflow';
import { ALM_CATALOG, almResolver, defaultDefinition, SimCtx, SUBJECTS } from './workflowAdapter';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const subjectOf = (code: string) => {
  const s = SUBJECTS.find((x) => x.code === code);
  if (!s) throw E.notFound('알 수 없는 대상 유형입니다');
  return s;
};

// applied: 게시한 정의가 승인 실행에 쓰이는가(4.11 마무리부터 true)
export const APPLIED_TO_APPROVALS = true;

const COLS = `d.id, d.subject_type, d.version_no, d.status, d.name, d.steps, d.options, d.change_note, d.published_at, d.updated_at, d.version,
  pu.display_name AS published_by_name, uu.display_name AS updated_by_name`;
const FROM = `FROM workflow_definition d LEFT JOIN app_user pu ON pu.id = d.published_by LEFT JOIN app_user uu ON uu.id = d.updated_by`;

const defOf = (r: Record<string, any>): WorkflowDef => ({
  subjectType: r.subject_type, name: r.name, steps: (r.steps as WorkflowDef['steps']) ?? [],
  options: { fixerCannotReapprove: true, requesterNoStep: false, proxyIfAllSkipped: true, ...(r.options ?? {}) },
});

const row = (r: Record<string, any>) => clean({
  id: r.id as string, subjectType: r.subject_type as string, versionNo: Number(r.version_no), status: r.status as string,
  name: r.name as string, ...toStored(defOf(r)), changeNote: r.change_note ?? undefined,
  publishedAt: iso(r.published_at), publishedByName: r.published_by_name ?? undefined,
  updatedAt: iso(r.updated_at), updatedByName: r.updated_by_name ?? undefined, version: Number(r.version),
});

export const catalog = () => ({ ...ALM_CATALOG, appliedToApprovals: APPLIED_TO_APPROVALS });

export async function listWorkflows(c: PoolClient) {
  const rows = (await c.query(`SELECT ${COLS} ${FROM} WHERE d.status IN ('DRAFT', 'PUBLISHED')`)).rows;
  return {
    appliedToApprovals: APPLIED_TO_APPROVALS,
    items: SUBJECTS.map((s) => {
      const pub = rows.find((r) => r.subject_type === s.code && r.status === 'PUBLISHED');
      const draft = rows.find((r) => r.subject_type === s.code && r.status === 'DRAFT');
      const current = pub ? defOf(pub) : defaultDefinition(s.code);
      return clean({
        subjectType: s.code, label: s.label, name: current.name, steps: toStored(current).steps,
        publishedVersion: pub ? Number(pub.version_no) : undefined, hasDraft: !!draft, draftVersion: draft ? Number(draft.version_no) : undefined,
        usesDefault: !pub, updatedAt: iso((draft ?? pub)?.updated_at),
      });
    }),
  };
}

export async function getWorkflow(c: PoolClient, subjectType: string) {
  const s = subjectOf(subjectType);
  const rows = (await c.query(`SELECT ${COLS} ${FROM} WHERE d.subject_type = $1 ORDER BY d.version_no DESC`, [subjectType])).rows;
  const pub = rows.find((r) => r.status === 'PUBLISHED'), draft = rows.find((r) => r.status === 'DRAFT');
  const dflt = defaultDefinition(subjectType);
  return clean({
    subjectType: s.code, label: s.label, appliedToApprovals: APPLIED_TO_APPROVALS,
    published: pub ? row(pub) : undefined, draft: draft ? row(draft) : undefined,
    defaultDefinition: { name: dflt.name, ...toStored(dflt) },
    versions: rows.map((r) => clean({ versionNo: Number(r.version_no), status: r.status as string, name: r.name as string, changeNote: r.change_note ?? undefined,
      publishedAt: iso(r.published_at), publishedByName: r.published_by_name ?? undefined, updatedAt: iso(r.updated_at), updatedByName: r.updated_by_name ?? undefined })),
  });
}

// 본문 → 정의. 모양·카탈로그 위반은 모두 모아 400
function readDefinition(subjectType: string, body: unknown): WorkflowDef {
  const k = new Check(body);
  const b = k.obj();
  const { def, issues } = parseDefinition({ name: b.name, steps: b.steps, options: b.options }, subjectType);
  for (const i of issues) k.fail(i.field, i.message);
  if (!issues.length) for (const i of validateDefinition(def, ALM_CATALOG)) k.fail(i.field, i.message);
  k.done();
  return def;
}

const checkVersion = (r: Record<string, any>, ifMatch: string | undefined) => {
  if (!ifMatch) throw new AlmError(428, 'ALM-E101', 'If-Match 헤더(version)가 필요합니다');
  if (String(r.version) !== ifMatch.replace(/^W\//, '').replace(/"/g, '')) {
    throw new AlmError(409, 'ALM-E310', '다른 사람이 먼저 바꿨습니다. 새로 고친 뒤 다시 시도하세요', { currentVersion: r.version });
  }
};

const lock = (c: PoolClient, subjectType: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`workflow:${subjectType}`]);

async function draftRow(c: PoolClient, subjectType: string) {
  return (await c.query(`SELECT ${COLS} ${FROM} WHERE d.subject_type = $1 AND d.status = 'DRAFT'`, [subjectType])).rows[0];
}

// 초안 저장(없으면 새 버전). 이미 초안이 있으면 If-Match로 바꾼다
export async function saveDraft(c: PoolClient, p: Principal, subjectType: string, ifMatch: string | undefined, body: unknown) {
  subjectOf(subjectType);
  const def = readDefinition(subjectType, body);
  const note = typeof (body as Record<string, unknown>)?.changeNote === 'string' ? ((body as Record<string, string>).changeNote.trim().slice(0, 200) || null) : null;
  await lock(c, subjectType);
  const cur = await draftRow(c, subjectType);
  const stored = toStored(def);
  if (cur) {
    checkVersion(cur, ifMatch);
    await c.query(`UPDATE workflow_definition SET name = $2, steps = $3, options = $4, change_note = $5, updated_at = now(), updated_by = $6, version = version + 1 WHERE id = $1`,
      [cur.id, def.name, JSON.stringify(stored.steps), JSON.stringify(stored.options), note, p.userId]);
  } else {
    const no = Number((await c.query('SELECT coalesce(max(version_no), 0) + 1 AS n FROM workflow_definition WHERE subject_type = $1', [subjectType])).rows[0].n);
    await c.query(`INSERT INTO workflow_definition (id, tenant_id, subject_type, version_no, status, name, steps, options, change_note, created_by, updated_by)
      VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $9)`,
    [randomUUID(), p.tenantId, subjectType, no, def.name, JSON.stringify(stored.steps), JSON.stringify(stored.options), note, p.userId]);
  }
  return row(await draftRow(c, subjectType));
}

export async function discardDraft(c: PoolClient, subjectType: string) {
  subjectOf(subjectType);
  await lock(c, subjectType);
  const cur = await draftRow(c, subjectType);
  if (!cur) throw E.notFound('버릴 초안이 없습니다');
  await c.query('DELETE FROM workflow_definition WHERE id = $1', [cur.id]);
}

// 게시: 초안을 다시 검사하고, 이전 게시본은 보관(ARCHIVED)으로 바꾼다
export async function publishDraft(c: PoolClient, p: Principal, subjectType: string, ifMatch: string | undefined) {
  subjectOf(subjectType);
  await lock(c, subjectType);
  const cur = await draftRow(c, subjectType);
  if (!cur) throw E.notFound('게시할 초안이 없습니다');
  checkVersion(cur, ifMatch);
  const k = new Check({});
  for (const i of validateDefinition(defOf(cur), ALM_CATALOG)) k.fail(i.field, i.message);
  k.done();
  const pub = (await c.query(`SELECT ${COLS} ${FROM} WHERE d.subject_type = $1 AND d.status = 'PUBLISHED'`, [subjectType])).rows[0];
  if (pub && sameDefinition(defOf(pub), defOf(cur))) throw new AlmError(409, 'ALM-E321', '게시 중인 정의와 같습니다. 바꾼 내용이 없습니다');
  await c.query(`UPDATE workflow_definition SET status = 'ARCHIVED', updated_at = now(), updated_by = $2, version = version + 1
    WHERE subject_type = $1 AND status = 'PUBLISHED'`, [subjectType, p.userId]);
  await c.query(`UPDATE workflow_definition SET status = 'PUBLISHED', published_at = now(), published_by = $2, updated_at = now(), updated_by = $2, version = version + 1
    WHERE id = $1`, [cur.id, p.userId]);
  return row((await c.query(`SELECT ${COLS} ${FROM} WHERE d.id = $1`, [cur.id])).rows[0]);
}

// 이전 버전(또는 게시본)을 새 초안으로 되돌린다. 초안이 이미 있으면 거절
export async function restoreVersion(c: PoolClient, p: Principal, subjectType: string, versionNo: number) {
  subjectOf(subjectType);
  if (!Number.isInteger(versionNo) || versionNo < 1) throw E.badRequest('버전 번호가 올바르지 않습니다');
  await lock(c, subjectType);
  if (await draftRow(c, subjectType)) throw E.duplicate('초안이 이미 있습니다. 먼저 게시하거나 버린 뒤 되돌리세요');
  const src = (await c.query(`SELECT ${COLS} ${FROM} WHERE d.subject_type = $1 AND d.version_no = $2`, [subjectType, versionNo])).rows[0];
  if (!src) throw E.notFound('버전을 찾을 수 없습니다');
  const no = Number((await c.query('SELECT max(version_no) + 1 AS n FROM workflow_definition WHERE subject_type = $1', [subjectType])).rows[0].n);
  await c.query(`INSERT INTO workflow_definition (id, tenant_id, subject_type, version_no, status, name, steps, options, change_note, created_by, updated_by)
    VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $9)`,
  [randomUUID(), p.tenantId, subjectType, no, src.name, JSON.stringify(src.steps), JSON.stringify(src.options), `v${versionNo}에서 되돌림`, p.userId]);
  return row(await draftRow(c, subjectType));
}

// 시험 실행: 요청을 만들지 않고 승인자만 계산한다. 정의는 본문(편집 중인 값)이 우선, 없으면 초안 → 게시본 → 기본 정의
export async function simulate(c: PoolClient, subjectType: string, body: unknown) {
  subjectOf(subjectType);
  const k = new Check(body);
  const b = k.obj();
  const ctx: SimCtx = {
    sourceCostCenterId: k.uuid(b, 'sourceCostCenterId'), targetCostCenterId: k.uuid(b, 'targetCostCenterId'), companyId: k.uuid(b, 'companyId'),
  };
  const requesterId = k.uuid(b, 'requesterId');
  k.done();
  if (!ctx.sourceCostCenterId && !ctx.targetCostCenterId) throw E.required('sourceCostCenterId');
  let def: WorkflowDef;
  let source: 'INPUT' | 'DRAFT' | 'PUBLISHED' | 'DEFAULT';
  if (b.steps !== undefined) { def = readDefinition(subjectType, b); source = 'INPUT'; }
  else {
    const rows = (await c.query(`SELECT ${COLS} ${FROM} WHERE d.subject_type = $1 AND d.status IN ('DRAFT', 'PUBLISHED')`, [subjectType])).rows;
    const r = rows.find((x) => x.status === 'DRAFT') ?? rows.find((x) => x.status === 'PUBLISHED');
    def = r ? defOf(r) : defaultDefinition(subjectType);
    source = r ? (r.status as 'DRAFT' | 'PUBLISHED') : 'DEFAULT';
  }
  if (requesterId && !UUID.test(requesterId)) throw E.badRequest('requesterId가 올바르지 않습니다');
  const steps = await planSteps(def, ALM_CATALOG, ctx, requesterId, almResolver(c));
  return { subjectType, source, steps, canSubmit: !steps.some((s) => s.missing) };
}
