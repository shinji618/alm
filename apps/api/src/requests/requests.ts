// 자산 요청·승인(ALM-230, openapi listAssetRequests~reject). WBS 4.3. 01 기능정의서 7.1, 09 설계서 2장 S-14·5.2
//
//   유형  : NEW_ASSET(AS01) · CHANGE(AS02) · TRANSFER(AS02 시간종속, 손익센터·세그먼트가 바뀌면 ABUMN) · RETIRE(ABAVN) · SALE(ABAON)
//   상태  : DRAFT → SUBMITTED(1 부서 관리자 대기) → MGR_APPROVED(2 자산회계 대기) → ACCT_APPROVED(전기 대기) → POSTED | POST_ERROR
//           반려 REJECTED, 취소 CANCELLED. 같은 자산에 진행 중인 요청은 하나만(409 ALM-E315)
//   승인자: 부서 관리자 단계 = 책임 코스트센터(신규·코스트센터 변경은 대상, 그 외는 자산의 현재 값)의 부서 관리자 역할 행.
//           이관(TRANSFER)은 보내는 부서(현재) → 받는 부서(대상) 두 단계(2026-10-15 결정). 부서 관리자가 없는 쪽은 건너뛰고,
//           두 쪽 관리자가 같으면 한 단계. 앞 단계를 승인한 사람이 다음 부서 단계에도 자격이 있으면 함께 승인한다.
//           어느 쪽에도 (요청자 말고) 유효한 부서 관리자가 없으면 자산회계가 대리 승인한다(2026-10-13 결정, 의견 앞에 [대리] 표시)
//           마지막 단계 = 자산회계(역할 행에 회사코드·사이트·코스트센터가 있으면 그 범위)
//           요청자 본인 승인 불가, 1단계 승인자는 2단계를 승인할 수 없다(403 ALM-E403, 직무 분리)
//   최종 승인: SAP 자산(또는 NEW_ASSET)은 sap_posting(READY)을 만들고 ACCT_APPROVED → SAP 결과가 오면 postings.applyPosted가 자산에 반영.
//              SAP 자산번호가 없는 자산(ALM 전용)은 SAP에 보낼 것이 없으므로 바로 반영하고 POSTED
//   회사 설정(company.sap_enabled·approval_steps, 2026-10-13 결정):
//           SAP 연계를 끈 회사는 SAP 신규 등록(NEW_ASSET)을 받지 않고, 모든 요청을 최종 승인 즉시 ALM에만 반영한다.
//           승인 단계 2(부서 관리자 → 자산회계) · 1(부서 관리자) · 0(승인 없음, 범위 안의 자산 관리자가 제출하면 바로 반영).
//           1단계만 쓰는 회사에서 부서 관리자가 없으면 자산 관리자가 대리한다. 단계 1·0은 SAP 연계를 끈 회사만(DB CHECK)
//   금액  : 취득가·매각금액은 amount.read, 요청자 본인, 지금 단계의 승인자에게만 보인다(09 4.2)
import { cascadeBundle } from '../assets/bundles';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';
import type { Principal } from '../auth/principal';
import { assetScope, can, Params, scopeRows } from '../auth/scope';
import type { MailRequest } from '../notify/mail';
import { nextNumbers } from '../assets/tags';

export const TYPES = ['NEW_ASSET', 'CHANGE', 'TRANSFER', 'RETIRE', 'SALE'] as const;
export const REQ_STATUSES = ['DRAFT', 'SUBMITTED', 'MGR_APPROVED', 'ACCT_APPROVED', 'POSTED', 'POST_ERROR', 'REJECTED', 'CANCELLED'] as const;
const OPEN = ['DRAFT', 'SUBMITTED', 'MGR_APPROVED', 'ACCT_APPROVED', 'POST_ERROR'];
const STEP_ROLES = ['DEPT_MANAGER', 'ASSET_ACCOUNTANT'] as const;
const CHANGE_FIELDS = ['description', 'serialNo'] as const;
type ReqType = (typeof TYPES)[number];

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const path = (id: string) => `/requests/${id}`;

// ---------------- 범위 ----------------
// request.read 범위: 전체(회사·사이트 제한은 자산 기준), 코스트센터(대상 또는 현재), 본인. 요청자 본인 요청은 항상 보인다
function requestScope(p: Principal, ps: Params): string {
  const rows = scopeRows(p, 'request.read');
  if (rows.some((x) => (x.scope === 'ALL' || x.scope === '-') && !x.companyCode && !x.siteCode)) return 'true';
  const parts = [`r.requester_id = ${ps.add(p.userId)}`];
  for (const row of rows) {
    if (row.scope === 'ALL' || row.scope === '-') {
      const c: string[] = [];
      if (row.companyCode) c.push(`a.company_id IN (SELECT id FROM company WHERE company_code = ${ps.add(row.companyCode)})`);
      if (row.siteCode) c.push(`a.site_id IN (SELECT id FROM site WHERE site_code = ${ps.add(row.siteCode)})`);
      parts.push(`(${c.join(' AND ')})`);
    } else if (row.scope === 'CC' && row.costCenterCode) {
      const cc = ps.add(row.costCenterCode);
      parts.push(`(r.target_cost_center_id IN (SELECT id FROM cost_center WHERE cost_center_code = ${cc})
        OR a.cost_center_id IN (SELECT id FROM cost_center WHERE cost_center_code = ${cc}))`);
    }
  }
  return `(${parts.join(' OR ')})`;
}

// 1단계 책임 코스트센터: 신규·이관·코스트센터 변경은 대상, 그 외는 자산의 현재 값
const responsibleCc = (r: Record<string, any>) => r.target_cost_center_id ?? r.asset_cost_center_id ?? null;

// 이 사람이 이 단계를 승인할 수 있는가(역할 행 범위). 직무 분리는 따로 본다
// 부서 관리자가 없을 때 1단계를 대리하는 역할: 2단계 회사는 자산회계, 1단계만 쓰는 회사는 자산 관리자
const proxyRole = (r: Record<string, any>) => (Number(r.approval_steps ?? 2) >= 2 ? 'ASSET_ACCOUNTANT' : 'ASSET_MANAGER');

// 유효한(요청자 말고) 부서 관리자가 있는가. cc·요청자는 SQL 식
const deptExistsSql = (cc: string, requester: string) => `EXISTS (SELECT 1 FROM user_role ur JOIN app_user du ON du.id = ur.user_id
             WHERE ur.role = 'DEPT_MANAGER' AND ur.cost_center_id = ${cc}
               AND du.is_active AND du.id <> ${requester}
               AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date))`;

// 단계의 코스트센터와 부서 관리자 유무. 단계에 코스트센터가 없으면(0005 이전 요청) 요청의 책임 코스트센터
const stepCc = (s: Record<string, any> | undefined, r: Record<string, any>) => (s?.step_cc_id
  ? { code: s.step_cc_code as string, exists: !!s.step_dept_exists } : { code: r.responsible_cc_code as string, exists: !!r.dept_exists });

// s: 승인 단계 행(approver_role, step_cc_id·step_cc_code·step_dept_exists)
function eligible(p: Principal, s: Record<string, any>, r: Record<string, any>): boolean {
  const cc = stepCc(s, r);
  let role = s.approver_role as string;
  if (role === 'DEPT_MANAGER' && !cc.exists) role = proxyRole(r);   // 부서 관리자 없음 → 대리
  if (!p.effectiveRoles.includes(role)) return false;
  if (role !== 'ASSET_MANAGER' && !can(p, 'approval.decide')) return false;
  const rows = p.roles.filter((x) => x.role === role);
  if (role === 'DEPT_MANAGER') return rows.some((x) => !!x.costCenterCode && x.costCenterCode === cc.code);
  return rows.some((x) => (!x.companyCode || x.companyCode === r.company_code) && (!x.siteCode || x.siteCode === r.site_code)
    && (!x.costCenterCode || x.costCenterCode === cc.code));
}

// 요청 1건 + 판단에 필요한 코드들
const BASE = `SELECT r.*, a.asset_tag, a.description AS asset_description, a.status AS asset_status, a.sap_asset_no, a.sap_sub_no, a.company_id,
    a.cost_center_id AS asset_cost_center_id, a.room_id AS asset_room_id, a.serial_no AS asset_serial_no, a.version AS asset_version,
    co.company_code, co.sap_enabled, co.approval_steps, s.site_code, coalesce(tcc.cost_center_code, acc.cost_center_code) AS responsible_cc_code,
    u.display_name AS requester_name, u.email AS requester_email,
    ${deptExistsSql('coalesce(r.target_cost_center_id, a.cost_center_id)', 'r.requester_id')} AS dept_exists
  FROM asset_request r
  LEFT JOIN asset a ON a.id = r.asset_id
  LEFT JOIN company co ON co.id = a.company_id
  LEFT JOIN site s ON s.id = a.site_id
  LEFT JOIN cost_center tcc ON tcc.id = r.target_cost_center_id
  LEFT JOIN cost_center acc ON acc.id = a.cost_center_id
  JOIN app_user u ON u.id = r.requester_id`;

async function load(c: PoolClient, id: string, lock = false): Promise<Record<string, any>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw E.notFound('요청을 찾을 수 없습니다');
  if (lock) await c.query('SELECT 1 FROM asset_request WHERE id = $1 FOR UPDATE', [id]);
  const r = (await c.query(`${BASE} WHERE r.id = $1`, [id])).rows[0];
  if (!r) throw E.notFound('요청을 찾을 수 없습니다');
  return r;
}

const STEP_COLS = `ap.cost_center_id AS step_cc_id, scc.cost_center_code AS step_cc_code, scc.name AS step_cc_name,
      ${deptExistsSql('ap.cost_center_id', 'r.requester_id')} AS step_dept_exists`;

async function steps(c: PoolClient, id: string) {
  return (await c.query(`SELECT ap.*, u.display_name AS approver_name, ${STEP_COLS}
     FROM approval ap JOIN asset_request r ON r.id = ap.asset_request_id
     LEFT JOIN app_user u ON u.id = ap.approver_id LEFT JOIN cost_center scc ON scc.id = ap.cost_center_id
     WHERE ap.asset_request_id = $1 ORDER BY ap.step_no`, [id])).rows;
}

// 승인 단계 계획(제출·재승인): 부서 관리자 단계(코스트센터별) + 자산회계(2단계 회사)
async function deptManagerIds(c: PoolClient, ccId: string, requesterId: string): Promise<string> {
  return (await c.query(`SELECT string_agg(DISTINCT ur.user_id::text, ',' ORDER BY ur.user_id::text) AS ids FROM user_role ur JOIN app_user du ON du.id = ur.user_id
     WHERE ur.role = 'DEPT_MANAGER' AND ur.cost_center_id = $1 AND du.is_active AND du.id <> $2
       AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)`,
  [ccId, requesterId])).rows[0]?.ids ?? '';
}

async function planSteps(c: PoolClient, r: Record<string, any>): Promise<{ role: string; ccId: string | null }[]> {
  const from = r.asset_cost_center_id ?? null, to = r.target_cost_center_id ?? null;
  const ccs: string[] = r.request_type === 'TRANSFER' && from && to && from !== to ? [from, to] : [responsibleCc(r)];
  const dept: { role: string; ccId: string | null }[] = [];
  let prev = '';
  for (const cc of ccs) {
    const ids = await deptManagerIds(c, cc, r.requester_id);
    if (!ids || ids === prev) continue;          // 부서 관리자가 없는 쪽은 건너뛰고, 같은 관리자면 한 번
    prev = ids;
    dept.push({ role: 'DEPT_MANAGER', ccId: cc });
  }
  if (!dept.length) dept.push({ role: 'DEPT_MANAGER', ccId: responsibleCc(r) });   // 아무도 없으면 대리 승인
  return Number(r.approval_steps ?? 2) >= 2 ? [...dept, { role: 'ASSET_ACCOUNTANT', ccId: null }] : dept;
}

async function createSteps(c: PoolClient, p: Principal, r: Record<string, any>) {
  await c.query('DELETE FROM approval WHERE asset_request_id = $1', [r.id]);
  for (const [i, s] of (await planSteps(c, r)).entries()) {
    await c.query(`INSERT INTO approval (id, tenant_id, asset_request_id, step_no, approver_role, cost_center_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), p.tenantId, r.id, i + 1, s.role, s.ccId, p.userId]);
  }
}

// 볼 수 있는가: 범위 안, 요청자, 또는 어느 단계든 승인 자격(결정한 사람 포함)
async function visible(c: PoolClient, p: Principal, r: Record<string, any>): Promise<boolean> {
  if (r.requester_id === p.userId) return true;
  const ps = new Params([r.id]);
  const inScope = (await c.query(`SELECT 1 FROM asset_request r LEFT JOIN asset a ON a.id = r.asset_id WHERE r.id = $1 AND ${requestScope(p, ps)}`, ps.values)).rowCount;
  if (inScope) return true;
  return (await steps(c, r.id)).some((s) => s.approver_id === p.userId || eligible(p, s, r));
}

// ---------------- 목록 ----------------
export async function listRequests(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50) || 50));
  const types = (q.type ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const statuses = (q.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (types.some((t) => !(TYPES as readonly string[]).includes(t))) k.fail('type', TYPES.join(', '));
  if (statuses.some((t) => !(REQ_STATUSES as readonly string[]).includes(t))) k.fail('status', REQ_STATUSES.join(', '));
  const assetId = k.uuid(q, 'assetId');
  k.done();
  const ps = new Params();
  const where = [requestScope(p, ps)];
  if (types.length) where.push(`r.request_type::text = ANY(${ps.add(types)})`);
  if (statuses.length) where.push(`r.status::text = ANY(${ps.add(statuses)})`);
  if (q.mine === 'true') where.push(`r.requester_id = ${ps.add(p.userId)}`);
  if (assetId) where.push(`r.asset_id = ${ps.add(assetId)}`);
  if (q.q?.trim()) {
    const t = ps.add(`%${likeEsc(q.q.trim().slice(0, 50))}%`);
    where.push(`(r.request_no ILIKE ${t} OR a.asset_tag ILIKE ${t} OR a.sap_asset_no ILIKE ${t})`);
  }
  const from = `FROM asset_request r LEFT JOIN asset a ON a.id = r.asset_id JOIN app_user u ON u.id = r.requester_id
    LEFT JOIN approval ap ON ap.asset_request_id = r.id AND ap.step_no = r.current_step AND ap.decision = 'PENDING'
      AND r.status IN ('SUBMITTED', 'MGR_APPROVED')
    WHERE ${where.join(' AND ')}`;
  const total = (await c.query(`SELECT count(*)::int AS n ${from}`, ps.values)).rows[0].n as number;
  const off = ps.add((page - 1) * pageSize), lim = ps.add(pageSize);
  const rows = (await c.query(`SELECT r.id, r.request_no, r.request_type, r.status, r.source, a.asset_tag, u.display_name, r.current_step,
      ap.approver_role, r.submitted_at, r.created_at ${from} ORDER BY coalesce(r.submitted_at, r.created_at) DESC, r.request_no DESC OFFSET ${off} LIMIT ${lim}`,
  ps.values)).rows;
  return {
    items: rows.map((r) => clean({ id: r.id, requestNo: r.request_no, requestType: r.request_type, status: r.status, source: r.source,
      assetTag: r.asset_tag ?? undefined, requesterName: r.display_name, currentStep: r.current_step, awaitingRole: r.approver_role ?? undefined,
      submittedAt: iso(r.submitted_at), createdAt: iso(r.created_at) })),
    page, pageSize, total,
  };
}

// ---------------- 상세 ----------------
export async function getRequest(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id);
  if (!(await visible(c, p, r))) throw E.notFound('요청을 찾을 수 없습니다');
  return detail(c, p, r);
}

async function detail(c: PoolClient, p: Principal, r: Record<string, any>) {
  const st = await steps(c, r.id);
  const cur = st.find((s) => s.step_no === r.current_step && s.decision === 'PENDING' && ['SUBMITTED', 'MGR_APPROVED'].includes(r.status));
  const canDecide = !!cur && eligible(p, cur, r) && r.requester_id !== p.userId
    && !st.some((s) => s.step_no < cur.step_no && s.approver_id === p.userId);
  const amount = can(p, 'amount.read') || r.requester_id === p.userId || canDecide;
  const posting = (await c.query(`SELECT id, posting_id, posting_type, status, attempt_count, sap_document_no, sap_fiscal_year, sap_asset_no, result_at, messages
     FROM sap_posting WHERE asset_request_id = $1 ORDER BY created_at DESC LIMIT 1`, [r.id])).rows[0];
  const codes = (await c.query(`SELECT
      (SELECT class_code || ' · ' || name FROM asset_class WHERE id = $1) AS cls,
      (SELECT cost_center_code || ' · ' || name FROM cost_center WHERE id = $2) AS cc,
      (SELECT room_code || ' · ' || name FROM room WHERE id = $3) AS room,
      (SELECT cost_center_code || ' · ' || name FROM cost_center WHERE id = $4) AS from_cc,
      (SELECT po_no || '/' || item_no FROM po_item WHERE id = $5) AS po`,
  [r.asset_class_id, r.target_cost_center_id, r.target_room_id, r.asset_cost_center_id, r.po_item_id])).rows[0];
  const isOwnOrMgr = r.requester_id === p.userId || (await assetWritable(c, p, r.asset_id));
  return clean({
    id: r.id, version: r.version, requestNo: r.request_no, status: r.status, source: r.source, currentStep: r.current_step,
    requesterId: r.requester_id, requesterName: r.requester_name, submittedAt: iso(r.submitted_at), completedAt: iso(r.completed_at), createdAt: iso(r.created_at),
    request: clean({
      requestType: r.request_type, assetId: r.asset_id ?? undefined, reason: r.reason ?? undefined, assetClassId: r.asset_class_id ?? undefined,
      acquisitionValue: amount ? num(r.acquisition_value) : undefined, poItemId: r.po_item_id ?? undefined,
      targetCostCenterId: r.target_cost_center_id ?? undefined, targetRoomId: r.target_room_id ?? undefined, changes: r.changes ?? undefined,
      effectiveDate: day(r.effective_date), retireType: r.retire_type ?? undefined, saleAmount: amount ? num(r.sale_amount) : undefined,
      buyer: r.buyer ?? undefined,
    }),
    labels: clean({ assetClass: codes.cls ?? undefined, targetCostCenter: codes.cc ?? undefined, targetRoom: codes.room ?? undefined,
      currentCostCenter: codes.from_cc ?? undefined, poItem: codes.po ?? undefined }),
    amountMasked: !amount && (r.acquisition_value !== null || r.sale_amount !== null),
    isProfitCenterChange: r.is_profit_center_change,
    deptManagerMissing: Number(r.approval_steps ?? 2) > 0
      && (st.length ? st.some((s) => s.approver_role === 'DEPT_MANAGER' && !stepCc(s, r).exists) : !r.dept_exists),
    sapEnabled: !!r.sap_enabled, approvalSteps: Number(r.approval_steps ?? 2),
    asset: r.asset_id ? clean({ id: r.asset_id, assetTag: r.asset_tag, description: r.asset_description, status: r.asset_status,
      sapAssetNo: r.sap_asset_no ? `${r.sap_asset_no}-${r.sap_sub_no ?? '0000'}` : undefined, companyCode: r.company_code }) : undefined,
    approvals: st.map((s) => clean({ id: s.id, stepNo: s.step_no, approverRole: s.approver_role, approverName: s.approver_name ?? undefined,
      costCenter: s.step_cc_code ? `${s.step_cc_code} · ${s.step_cc_name}` : undefined,
      proxy: (s.approver_role === 'DEPT_MANAGER' && !stepCc(s, r).exists) || undefined,
      decision: s.decision, comment: s.comment ?? undefined, decidedAt: iso(s.decided_at) })),
    posting: posting ? clean({ id: posting.id, postingId: posting.posting_id, postingType: posting.posting_type, status: posting.status,
      attemptCount: posting.attempt_count, sapDocumentNo: posting.sap_document_no ?? undefined, sapFiscalYear: posting.sap_fiscal_year ?? undefined,
      sapAssetNo: posting.sap_asset_no ?? undefined, resultAt: iso(posting.result_at), messages: posting.messages ?? [] }) : undefined,
    attachments: [],
    actions: clean({
      approve: canDecide ? cur!.id : undefined,
      submit: r.status === 'DRAFT' && r.requester_id === p.userId ? true : undefined,
      edit: r.status === 'DRAFT' && r.requester_id === p.userId ? true : undefined,
      cancel: cancellable(r.status, posting) && isOwnOrMgr ? true : undefined,
      fix: r.status === 'POST_ERROR' && can(p, 'sap.finance') ? true : undefined,
    }),
  });
}

async function assetWritable(c: PoolClient, p: Principal, assetId: string | null): Promise<boolean> {
  if (!assetId || !can(p, 'asset.write')) return false;
  const ps = new Params([assetId]);
  return !!(await c.query(`SELECT 1 FROM asset a WHERE a.id = $1 AND ${assetScope(p, 'asset.write', ps)}`, ps.values)).rowCount;
}

const cancellable = (status: string, posting?: Record<string, any>) =>
  ['DRAFT', 'SUBMITTED', 'MGR_APPROVED', 'POST_ERROR'].includes(status)
  || (status === 'ACCT_APPROVED' && (!posting || ['READY', 'FAILED'].includes(posting.status)));

// ---------------- 작성·수정 ----------------
interface Input {
  requestType: ReqType; assetId?: string; reason: string; assetClassId?: string; acquisitionValue?: number; poItemId?: string;
  targetCostCenterId?: string; targetRoomId?: string; changes?: Record<string, string>; effectiveDate?: string;
  retireType?: 'SCRAP' | 'LOSS'; saleAmount?: number; buyer?: string; submit?: boolean;
}

function read(body: unknown): Input {
  const k = new Check(body);
  const b = k.obj();
  const v: Partial<Input> = {
    requestType: k.oneOf(b, 'requestType', TYPES), assetId: k.uuid(b, 'assetId'), reason: k.str(b, 'reason', { required: true, max: 200 }),
    assetClassId: k.uuid(b, 'assetClassId'), acquisitionValue: k.num(b, 'acquisitionValue', { min: 0, max: 1e12 }), poItemId: k.uuid(b, 'poItemId'),
    targetCostCenterId: k.uuid(b, 'targetCostCenterId'), targetRoomId: k.uuid(b, 'targetRoomId'), effectiveDate: k.date(b, 'effectiveDate'),
    retireType: k.oneOf(b, 'retireType', ['SCRAP', 'SALE', 'LOSS'] as const) as Input['retireType'], saleAmount: k.num(b, 'saleAmount', { min: 0, max: 1e12 }),
    buyer: k.str(b, 'buyer', { max: 80 }), submit: k.bool(b, 'submit'),
  };
  if (!v.requestType) { if (b.requestType === undefined) k.errors.push({ field: 'requestType', code: 'ALM-E101', message: '필수 값입니다' }); }
  const req = (f: keyof Input, ok: boolean) => { if (!ok) k.errors.push({ field: f, code: 'ALM-E101', message: `${v.requestType}이면 필수입니다` }); };
  // changes: 허용 필드만(자산명·시리얼). 룸·코스트센터는 targetRoomId·targetCostCenterId로
  if (b.changes !== undefined && b.changes !== null) {
    const ch = k.obj(b.changes, 'changes');
    const out = new Map<string, string>();
    for (const key of Object.keys(ch)) {
      if (!(CHANGE_FIELDS as readonly string[]).includes(key)) k.fail(`changes.${key}`, `바꿀 수 있는 필드: ${CHANGE_FIELDS.join(', ')}`);
    }
    const d = k.str(ch, 'description', { max: 50, field: 'changes.description' });
    const s = k.str(ch, 'serialNo', { max: 40, field: 'changes.serialNo' });
    if (Object.prototype.hasOwnProperty.call(ch, 'description')) { if (!d) k.errors.push({ field: 'changes.description', code: 'ALM-E101', message: '빈 값으로 바꿀 수 없습니다' }); else out.set('description', d); }
    if (Object.prototype.hasOwnProperty.call(ch, 'serialNo')) out.set('serialNo', s ?? '');
    if (out.size) v.changes = Object.fromEntries(out);
  }
  switch (v.requestType) {
    case 'NEW_ASSET':
      req('assetId', !!v.assetId); req('assetClassId', !!v.assetClassId); req('targetCostCenterId', !!v.targetCostCenterId);
      req('acquisitionValue', v.acquisitionValue !== undefined);
      if (v.acquisitionValue !== undefined && v.acquisitionValue <= 0) k.fail('acquisitionValue', '0보다 커야 합니다');
      break;
    case 'CHANGE':
      req('assetId', !!v.assetId);
      if (!v.changes && !v.targetRoomId) k.errors.push({ field: 'changes', code: 'ALM-E101', message: 'changes 또는 targetRoomId 중 하나는 필요합니다' });
      break;
    case 'TRANSFER':
      req('assetId', !!v.assetId); req('targetCostCenterId', !!v.targetCostCenterId); req('effectiveDate', !!v.effectiveDate);
      break;
    case 'RETIRE':
      req('assetId', !!v.assetId); req('retireType', !!v.retireType); req('effectiveDate', !!v.effectiveDate);
      if ((v.retireType as string) === 'SALE') k.fail('retireType', '매각은 요청 유형 SALE로');
      break;
    case 'SALE':
      req('assetId', !!v.assetId); req('saleAmount', v.saleAmount !== undefined); req('buyer', !!v.buyer);
      if (v.saleAmount !== undefined && v.saleAmount <= 0) k.fail('saleAmount', '0보다 커야 합니다');
      break;
  }
  k.done();
  return v as Input;
}

// 유형과 맞지 않는 값은 버린다(저장 값은 유형에 필요한 것만)
function normalize(v: Input): Input {
  const keep: Record<ReqType, (keyof Input)[]> = {
    NEW_ASSET: ['assetClassId', 'acquisitionValue', 'poItemId', 'targetCostCenterId', 'effectiveDate'],
    CHANGE: ['changes', 'targetRoomId'],
    TRANSFER: ['targetCostCenterId', 'targetRoomId', 'effectiveDate'],
    RETIRE: ['retireType', 'effectiveDate'],
    SALE: ['saleAmount', 'buyer', 'effectiveDate'],
  };
  const base: (keyof Input)[] = ['requestType', 'assetId', 'reason', 'submit'];
  const allowed = new Set<keyof Input>([...base, ...keep[v.requestType]]);
  return Object.fromEntries(Object.entries(v).filter(([key]) => allowed.has(key as keyof Input))) as unknown as Input;
}

// 대상 자산·참조 값 검사 → 저장할 값(손익센터 변경 여부 포함)
async function validate(c: PoolClient, p: Principal, v: Input, selfId?: string) {
  const ps = new Params([v.assetId]);
  const a = (await c.query(`SELECT a.*, co.company_code FROM asset a JOIN company co ON co.id = a.company_id
     WHERE a.id = $1 AND ${assetScope(p, 'asset.read', ps)}`, ps.values)).rows[0];
  if (!a) throw new AlmError(404, 'ALM-E404', '대상 자산을 찾을 수 없습니다');
  const bad = (field: string, message: string): never => { throw E.badRequest(`입력 값을 확인하세요: ${field} ${message}`, { errors: [{ field, code: 'ALM-E100', message }] }); };
  if (['RETIRED', 'DISPOSED'].includes(a.status)) throw new AlmError(409, 'ALM-E322', `이미 ${a.status === 'RETIRED' ? '폐기' : '처분'}된 자산입니다`);
  const open = (await c.query(`SELECT request_no FROM asset_request WHERE asset_id = $1 AND status::text = ANY($2) AND id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000') LIMIT 1`,
    [a.id, OPEN, selfId ?? null])).rows[0];
  if (open) throw new AlmError(409, 'ALM-E315', `이 자산에 진행 중인 요청(${open.request_no})이 있습니다`);

  let pcChange = false;
  if (v.requestType === 'NEW_ASSET') {
    const co = (await c.query('SELECT sap_enabled FROM company WHERE id = $1', [a.company_id])).rows[0];
    if (!co?.sap_enabled) throw new AlmError(422, 'ALM-E100', '이 회사는 SAP 연계를 쓰지 않습니다(SAP 신규 등록 불가)');
    if (a.sap_asset_no) throw new AlmError(409, 'ALM-E322', '이미 SAP 자산번호가 있는 자산입니다');
    // Bundle 구성품은 SAP에 보내지 않는다(Bundle을 등록)
    if (a.parent_asset_id) {
      const b = (await c.query('SELECT asset_tag FROM asset WHERE id = $1', [a.parent_asset_id])).rows[0];
      throw new AlmError(409, 'ALM-E322', `Bundle(${b?.asset_tag ?? ''}) 구성품은 SAP에 등록할 수 없습니다 — Bundle을 등록하세요`, { bundleAssetTag: b?.asset_tag });
    }
    const cls = (await c.query('SELECT is_capitalized, is_low_value, is_active, is_manual FROM asset_class WHERE id = $1', [v.assetClassId])).rows[0];
    if (!cls?.is_active) bad('assetClassId', '활성 자산클래스가 아닙니다');
    if (cls.is_manual) bad('assetClassId', 'ALM에서 직접 만든 클래스는 SAP에 등록할 수 없습니다(SAP 자산클래스를 고르세요)');
    if (cls.is_capitalized === false || cls.is_low_value) bad('assetClassId', '자본화 자산클래스만 SAP에 등록합니다');
  }
  if (v.targetCostCenterId) {
    const cc = (await c.query(`SELECT id, company_id, is_active FROM cost_center WHERE id = $1`, [v.targetCostCenterId])).rows[0];
    if (!cc?.is_active || cc.company_id !== a.company_id) bad('targetCostCenterId', '자산 회사코드의 활성 코스트센터가 아닙니다');
    if (v.requestType === 'TRANSFER') {
      if (v.targetCostCenterId === a.cost_center_id) bad('targetCostCenterId', '현재 코스트센터와 같습니다');
      const pcs = (await c.query(`SELECT cc.id, pc.profit_center_code, pc.segment FROM cost_center cc LEFT JOIN profit_center pc ON pc.id = cc.profit_center_id
         WHERE cc.id = ANY($1)`, [[a.cost_center_id, v.targetCostCenterId].filter(Boolean)])).rows;
      const from = pcs.find((x) => x.id === a.cost_center_id), to = pcs.find((x) => x.id === v.targetCostCenterId);
      pcChange = !from || !to || (from.profit_center_code ?? null) !== (to.profit_center_code ?? null) || (from.segment ?? null) !== (to.segment ?? null);
    }
  }
  if (v.targetRoomId) {
    const room = (await c.query('SELECT r.id FROM room r JOIN site s ON s.id = r.site_id WHERE r.id = $1 AND r.is_active AND s.is_active', [v.targetRoomId])).rows[0];
    if (!room) bad('targetRoomId', '활성 룸이 아닙니다');
    if (v.requestType === 'CHANGE' && v.targetRoomId === a.room_id && !v.changes) bad('targetRoomId', '현재 룸과 같습니다');
  }
  if (v.poItemId) {
    const po = (await c.query('SELECT company_id, is_deleted FROM po_item WHERE id = $1', [v.poItemId])).rows[0];
    if (!po || po.is_deleted || po.company_id !== a.company_id) bad('poItemId', '자산 회사코드의 PO 항목이 아닙니다');
  }
  if (v.requestType === 'CHANGE' && v.changes) {
    const same = Object.entries(v.changes).every(([f, x]) => (f === 'description' ? a.description : a.serial_no ?? '') === x);
    if (same && (!v.targetRoomId || v.targetRoomId === a.room_id)) bad('changes', '바뀐 값이 없습니다');
    if (v.changes.serialNo !== undefined && a.sap_asset_no && v.changes.serialNo.length > 18) bad('changes.serialNo', 'SAP 자산의 시리얼은 18자 이하(SERNR)');
  }
  return { asset: a, pcChange };
}

export async function createRequest(c: PoolClient, p: Principal, body: unknown, mails: MailRequest[]) {
  const v = normalize(read(body));
  const { asset, pcChange } = await validate(c, p, v);
  const id = randomUUID();
  const [no] = await nextNumbers(c, p.tenantId, 'asset_request');
  await c.query(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, asset_id, requester_id, reason, asset_class_id,
      acquisition_value, po_item_id, target_cost_center_id, target_room_id, is_profit_center_change, changes, effective_date, retire_type, sale_amount, buyer,
      created_by, updated_by)
    VALUES ($1, $2, $3, $4, 'DRAFT', 'USER', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $6, $6)`,
  [id, p.tenantId, no, v.requestType, asset.id, p.userId, v.reason, v.assetClassId ?? null, v.acquisitionValue ?? null, v.poItemId ?? null,
    v.targetCostCenterId ?? null, v.targetRoomId ?? null, pcChange, v.changes ? JSON.stringify(v.changes) : null, v.effectiveDate ?? null,
    v.requestType === 'SALE' ? 'SALE' : v.retireType ?? null, v.saleAmount ?? null, v.buyer ?? null]);
  if (v.submit) await doSubmit(c, p, await load(c, id, true), mails);
  return detail(c, p, await load(c, id));
}

export async function patchRequest(c: PoolClient, p: Principal, id: string, ifMatch: string | undefined, body: unknown) {
  const r = await load(c, id, true);
  if (!(await visible(c, p, r))) throw E.notFound('요청을 찾을 수 없습니다');
  if (r.requester_id !== p.userId) throw E.forbidden('요청자만 고칠 수 있습니다');
  if (r.status !== 'DRAFT') throw new AlmError(409, 'ALM-E322', '제출한 요청은 고칠 수 없습니다(취소 후 새로 작성)');
  checkVersion(r, ifMatch);
  const v = normalize(read({ ...(body as object), requestType: r.request_type, assetId: r.asset_id }));
  const { pcChange } = await validate(c, p, v, r.id);
  await c.query(`UPDATE asset_request SET reason = $2, asset_class_id = $3, acquisition_value = $4, po_item_id = $5, target_cost_center_id = $6,
      target_room_id = $7, is_profit_center_change = $8, changes = $9, effective_date = $10, retire_type = $11, sale_amount = $12, buyer = $13,
      updated_at = now(), updated_by = $14, version = version + 1 WHERE id = $1`,
  [id, v.reason, v.assetClassId ?? null, v.acquisitionValue ?? null, v.poItemId ?? null, v.targetCostCenterId ?? null, v.targetRoomId ?? null, pcChange,
    v.changes ? JSON.stringify(v.changes) : null, v.effectiveDate ?? null, r.request_type === 'SALE' ? 'SALE' : v.retireType ?? null,
    v.saleAmount ?? null, v.buyer ?? null, p.userId]);
  return detail(c, p, await load(c, id));
}

function checkVersion(r: Record<string, any>, ifMatch: string | undefined) {
  if (!ifMatch) throw new AlmError(428, 'ALM-E101', 'If-Match 헤더(version)가 필요합니다');
  if (String(r.version) !== ifMatch.replace(/^W\//, '').replace(/"/g, '')) {
    throw new AlmError(409, 'ALM-E310', '다른 사람이 먼저 바꿨습니다. 새로 고친 뒤 다시 시도하세요', { currentVersion: r.version });
  }
}

// ---------------- 제출·취소 ----------------
export async function submitRequest(c: PoolClient, p: Principal, id: string, mails: MailRequest[]) {
  const r = await load(c, id, true);
  if (!(await visible(c, p, r))) throw E.notFound('요청을 찾을 수 없습니다');
  if (r.requester_id !== p.userId) throw E.forbidden('요청자만 제출할 수 있습니다');
  if (r.status !== 'DRAFT') throw new AlmError(409, 'ALM-E322', `이미 ${r.status} 상태입니다`);
  await doSubmit(c, p, r, mails);
  return detail(c, p, await load(c, id));
}

async function doSubmit(c: PoolClient, p: Principal, r: Record<string, any>, mails: MailRequest[]) {
  if (!responsibleCc(r)) throw new AlmError(422, 'ALM-E100', '자산에 코스트센터가 없어 부서 승인자를 정할 수 없습니다(코스트센터를 먼저 지정)');
  // 제출 시점에 다시 검사(초안 저장 뒤 자산이 바뀌었을 수 있음)
  await validate(c, p, normalize({ requestType: r.request_type, assetId: r.asset_id, reason: r.reason, assetClassId: r.asset_class_id ?? undefined,
    acquisitionValue: num(r.acquisition_value), poItemId: r.po_item_id ?? undefined, targetCostCenterId: r.target_cost_center_id ?? undefined,
    targetRoomId: r.target_room_id ?? undefined, changes: r.changes ?? undefined, effectiveDate: day(r.effective_date),
    retireType: r.retire_type ?? undefined, saleAmount: num(r.sale_amount), buyer: r.buyer ?? undefined }), r.id);
  await c.query(`UPDATE asset_request SET status = 'SUBMITTED', submitted_at = now(), current_step = 1, updated_at = now(), updated_by = $2, version = version + 1
    WHERE id = $1`, [r.id, p.userId]);
  const n = Number(r.approval_steps ?? 2);
  if (n === 0) {
    await c.query('DELETE FROM approval WHERE asset_request_id = $1', [r.id]);
    // 승인 없음(SAP 연계를 끈 회사): 범위 안의 자산 관리자만 제출할 수 있고 바로 반영
    if (!(await assetWritable(c, p, r.asset_id))) throw E.forbidden('이 회사는 승인 단계가 없어 자산 관리자만 요청을 처리할 수 있습니다');
    await finalize(c, p, r);
    return;
  }
  await createSteps(c, p, r);
  mails.push(...await stepMails(c, r, 1));
}

export async function cancelRequest(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (!(await visible(c, p, r))) throw E.notFound('요청을 찾을 수 없습니다');
  const own = r.requester_id === p.userId && can(p, 'request.create');
  if (!own && !(await assetWritable(c, p, r.asset_id))) throw E.forbidden('요청자 또는 범위 안의 자산 관리자만 취소할 수 있습니다');
  const posting = (await c.query(`SELECT id, status, lease_until FROM sap_posting WHERE asset_request_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [id])).rows[0];
  if (!cancellable(r.status, posting)) {
    throw new AlmError(409, 'ALM-E322', r.status === 'ACCT_APPROVED' ? 'SAP이 전기 중입니다. 결과가 온 뒤에 처리하세요' : `${r.status} 상태의 요청은 취소할 수 없습니다`);
  }
  if (posting && ['READY', 'FAILED'].includes(posting.status)) {
    await c.query(`UPDATE sap_posting SET status = 'CANCELLED', lease_until = NULL, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [posting.id, p.userId]);
  }
  await c.query(`UPDATE approval SET decision = 'SKIPPED', updated_at = now(), updated_by = $2, version = version + 1 WHERE asset_request_id = $1 AND decision = 'PENDING'`, [id, p.userId]);
  await c.query(`UPDATE asset_request SET status = 'CANCELLED', completed_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return detail(c, p, await load(c, id));
}

// ---------------- 승인함 ----------------
// 내가 결정할 수 있는 지금 단계(앞 단계가 끝난 PENDING). 본인 요청·내가 앞 단계를 승인한 요청은 뺀다
async function inboxRows(c: PoolClient, p: Principal) {
  if (!can(p, 'approval.decide') && !p.effectiveRoles.includes('ASSET_MANAGER')) return [];
  // 자산회계는 부서 관리자가 없는 요청의 1단계도 본다(대리)
  // 자산회계·자산 관리자는 부서 관리자가 없는 요청의 1단계도 본다(대리)
  const roles = p.effectiveRoles.some((x) => x === 'ASSET_ACCOUNTANT' || x === 'ASSET_MANAGER') ? [...STEP_ROLES]
    : STEP_ROLES.filter((r) => p.effectiveRoles.includes(r));
  if (!roles.length) return [];
  const rows = (await c.query(`${BASE.replace('SELECT r.*', `SELECT r.*, ap.id AS approval_id, ap.step_no, ap.approver_role, ap.created_at AS step_created,
      ${STEP_COLS}, (SELECT max(decided_at) FROM approval x WHERE x.asset_request_id = r.id AND x.step_no < ap.step_no) AS prev_decided`)}
    JOIN approval ap ON ap.asset_request_id = r.id AND ap.step_no = r.current_step AND ap.decision = 'PENDING'
    LEFT JOIN cost_center scc ON scc.id = ap.cost_center_id
    WHERE r.status IN ('SUBMITTED', 'MGR_APPROVED') AND ap.approver_role::text = ANY($1) AND r.requester_id <> $2
      AND NOT EXISTS (SELECT 1 FROM approval x WHERE x.asset_request_id = r.id AND x.step_no < ap.step_no AND x.approver_id = $2)
    ORDER BY r.submitted_at, r.request_no`, [roles, p.userId])).rows;
  return rows.filter((r) => eligible(p, r, r));
}

export async function inboxCount(c: PoolClient, p: Principal): Promise<number> {
  return (await inboxRows(c, p)).length;
}

export async function inbox(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  if (q.kind && !['ASSET_REQUEST', 'PURCHASE_REQUEST'].includes(q.kind)) throw E.badRequest('입력 값을 확인하세요: kind ASSET_REQUEST, PURCHASE_REQUEST 중 하나');
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50) || 50));
  const all = q.kind === 'PURCHASE_REQUEST' ? [] : await inboxRows(c, p);
  const slice = all.slice((page - 1) * pageSize, page * pageSize);
  const ccNames = new Map((await c.query('SELECT id, cost_center_code FROM cost_center WHERE id = ANY($1)',
    [slice.map((r) => r.target_cost_center_id).filter(Boolean)])).rows.map((x) => [x.id as string, x.cost_center_code as string]));
  return {
    items: slice.map((r) => clean({
      approvalId: r.approval_id, kind: 'ASSET_REQUEST', targetId: r.id, targetNo: r.request_no, requestType: r.request_type,
      summary: summary(r, ccNames), assetTag: r.asset_tag ?? undefined, targetCostCenterCode: ccNames.get(r.target_cost_center_id),
      isProfitCenterChange: r.is_profit_center_change || undefined, retireType: r.retire_type ?? undefined, buyer: r.buyer ?? undefined,
      requesterName: r.requester_name, stepNo: r.step_no, approverRole: r.approver_role, proxy: (r.approver_role === 'DEPT_MANAGER' && !stepCc(r, r).exists) || undefined,
      stepCostCenterCode: r.step_cc_code ?? undefined,
      waitingSince: iso(r.prev_decided ?? r.submitted_at ?? r.step_created),
      amount: num(r.acquisition_value ?? r.sale_amount),
    })),
    page, pageSize, total: all.length,
  };
}

function summary(r: Record<string, any>, cc: Map<string, string>): string {
  const tag = r.asset_tag ?? '';
  switch (r.request_type as ReqType) {
    case 'NEW_ASSET': return `${tag} SAP 등록 → ${cc.get(r.target_cost_center_id) ?? ''}`;
    case 'TRANSFER': return `${tag} → ${cc.get(r.target_cost_center_id) ?? ''}${r.is_profit_center_change ? ' (손익센터 변경)' : ''}`;
    case 'CHANGE': return `${tag} 변경`;
    case 'RETIRE': return `${tag} 폐기(${r.retire_type ?? ''})`;
    case 'SALE': return `${tag} 매각${r.buyer ? ` · ${r.buyer}` : ''}`;
  }
}

// ---------------- 승인·반려 ----------------
async function decidable(c: PoolClient, p: Principal, approvalId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(approvalId)) throw E.notFound('승인 단계를 찾을 수 없습니다');
  const ap = (await c.query('SELECT * FROM approval WHERE id = $1', [approvalId])).rows[0];
  if (!ap?.asset_request_id) throw E.notFound('승인 단계를 찾을 수 없습니다');
  const r = await load(c, ap.asset_request_id, true);
  await c.query('SELECT 1 FROM approval WHERE id = $1 FOR UPDATE', [approvalId]);
  const step = (await steps(c, r.id)).find((s) => s.id === approvalId)!;
  if (!(await visible(c, p, r)) && !eligible(p, step, r)) throw E.notFound('승인 단계를 찾을 수 없습니다');
  if (step.decision !== 'PENDING' || !['SUBMITTED', 'MGR_APPROVED'].includes(r.status)) throw new AlmError(409, 'ALM-E322', '이미 결정된 단계입니다');
  if (step.step_no !== r.current_step) throw new AlmError(409, 'ALM-E322', '앞 단계 승인이 끝나지 않았습니다');
  if (r.requester_id === p.userId) throw E.sod('본인 요청은 승인·반려할 수 없습니다(직무 분리)');
  // 전기 오류 보정(:fix)으로 다시 만든 단계는 보정한 사람이 결정할 수 없다(H-08)
  if (step.created_by === p.userId) throw E.sod('이 요청을 보정한 사람은 다시 만든 승인 단계를 결정할 수 없습니다(직무 분리)');
  const prev = (await c.query('SELECT 1 FROM approval WHERE asset_request_id = $1 AND step_no < $2 AND approver_id = $3', [r.id, step.step_no, p.userId])).rowCount;
  if (prev) throw E.sod('앞 단계를 승인한 사람은 다음 단계를 결정할 수 없습니다(직무 분리)');
  if (!eligible(p, step, r)) throw E.forbidden(`이 단계(${step.approver_role})의 승인 권한이 없습니다`);
  return { r, step };
}

function decision(body: unknown, required: boolean): string | undefined {
  const k = new Check(body ?? {});
  const comment = k.str(k.obj(), 'comment', { required, max: 500 });
  k.done();
  return comment;
}

const PROXY: Record<string, string> = { ASSET_ACCOUNTANT: '[대리] 부서 관리자 없음 → 자산회계 결정', ASSET_MANAGER: '[대리] 부서 관리자 없음 → 자산 관리자 결정' };
const withProxy = (r: Record<string, any>, step: Record<string, any>, comment?: string) =>
  (step.approver_role === 'DEPT_MANAGER' && !stepCc(step, r).exists ? `${PROXY[proxyRole(r)]}${comment ? ` · ${comment}` : ''}`.slice(0, 500) : comment);

export async function approve(c: PoolClient, p: Principal, approvalId: string, body: unknown, mails: MailRequest[]) {
  const { r, step } = await decidable(c, p, approvalId);
  const comment = withProxy(r, step, decision(body, false));
  await c.query(`UPDATE approval SET decision = 'APPROVED', approver_id = $2, comment = $3, decided_at = now(), updated_at = now(), updated_by = $2,
      version = version + 1 WHERE id = $1`, [step.id, p.userId, comment ?? null]);
  // 다음 단계. 다음도 부서 관리자 단계이고 이 사람이 그 자격도 있으면(두 부서를 같은 사람이 관리) 함께 승인
  const all = await steps(c, r.id);
  let no = step.step_no as number;
  for (;;) {
    const next = all.find((s) => s.step_no === no + 1);
    if (!next) {
      await finalize(c, p, r);
      mails.push(decidedMail(r, p, 'APPROVED', comment));
      break;
    }
    if (next.approver_role === 'DEPT_MANAGER' && stepCc(next, r).exists && eligible(p, next, r)) {
      await c.query(`UPDATE approval SET decision = 'APPROVED', approver_id = $2, comment = $3, decided_at = now(), updated_at = now(), updated_by = $2,
          version = version + 1 WHERE id = $1`, [next.id, p.userId, `[동일 승인자] ${step.step_no}단계 승인으로 함께 승인`]);
      no = next.step_no;
      continue;
    }
    await c.query(`UPDATE asset_request SET status = $2, current_step = $3, updated_at = now(), updated_by = $4, version = version + 1 WHERE id = $1`,
      [r.id, next.approver_role === 'DEPT_MANAGER' ? 'SUBMITTED' : 'MGR_APPROVED', next.step_no, p.userId]);
    mails.push(...await stepMails(c, r, next.step_no));
    break;
  }
  return stepOut(c, step.id);
}

export async function reject(c: PoolClient, p: Principal, approvalId: string, body: unknown, mails: MailRequest[]) {
  const given = decision(body, true);
  const { r, step } = await decidable(c, p, approvalId);
  const comment = withProxy(r, step, given)!;
  await c.query(`UPDATE approval SET decision = 'REJECTED', approver_id = $2, comment = $3, decided_at = now(), updated_at = now(), updated_by = $2,
      version = version + 1 WHERE id = $1`, [step.id, p.userId, comment]);
  await c.query(`UPDATE approval SET decision = 'SKIPPED', updated_at = now(), version = version + 1 WHERE asset_request_id = $1 AND decision = 'PENDING'`, [r.id]);
  await c.query(`UPDATE asset_request SET status = 'REJECTED', completed_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`,
    [r.id, p.userId]);
  mails.push(decidedMail(r, p, 'REJECTED', comment));
  return stepOut(c, step.id);
}

async function stepOut(c: PoolClient, id: string) {
  const s = (await c.query(`SELECT ap.*, u.display_name FROM approval ap LEFT JOIN app_user u ON u.id = ap.approver_id WHERE ap.id = $1`, [id])).rows[0];
  const r = (await c.query('SELECT status FROM asset_request WHERE id = $1', [s.asset_request_id])).rows[0];
  return clean({ id: s.id, stepNo: s.step_no, approverRole: s.approver_role, approverName: s.display_name ?? undefined, decision: s.decision,
    comment: s.comment ?? undefined, decidedAt: iso(s.decided_at), requestId: s.asset_request_id, requestStatus: r.status });
}

// 최종 승인: SAP 대상이면 전기 건(READY), 아니면 ALM에 바로 반영
async function finalize(c: PoolClient, p: Principal, r: Record<string, any>) {
  const a = (await c.query(`SELECT a.*, r.room_code, st.site_code, cc.cost_center_code FROM asset a LEFT JOIN room r ON r.id = a.room_id LEFT JOIN site st ON st.id = r.site_id
     LEFT JOIN cost_center cc ON cc.id = a.cost_center_id WHERE a.id = $1 FOR UPDATE OF a`, [r.asset_id])).rows[0];
  if (!a) throw new AlmError(409, 'ALM-E322', '대상 자산이 없습니다');
  if (['RETIRED', 'DISPOSED'].includes(a.status)) throw new AlmError(409, 'ALM-E322', '대상 자산이 이미 폐기·처분되었습니다');
  const type = r.request_type as ReqType;
  // SAP 연계를 끈 회사이거나 SAP 자산번호가 없는 자산: SAP에 보낼 것이 없으므로 바로 반영
  if (!r.sap_enabled || (type !== 'NEW_ASSET' && !a.sap_asset_no)) {
    if (type === 'NEW_ASSET') throw new AlmError(409, 'ALM-E322', '이 회사는 SAP 연계를 쓰지 않아 SAP 신규 등록을 처리할 수 없습니다');
    await applyLocal(c, p, r, a);
    await c.query(`UPDATE asset_request SET status = 'POSTED', completed_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`,
      [r.id, p.userId]);
    return;
  }
  if (type === 'NEW_ASSET' && a.sap_asset_no) throw new AlmError(409, 'ALM-E322', '이미 SAP 자산번호가 있는 자산입니다');
  const { postingType, payload } = await buildPosting(c, r, a);
  await upsertPosting(c, p, r, a, postingType, payload);
  await c.query(`UPDATE asset_request SET status = 'ACCT_APPROVED', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [r.id, p.userId]);
}

// 전기 건: 요청번호 = postingId. 실패·취소된 같은 번호가 있으면(전기 오류 보정 뒤 재승인) 그 행을 다시 READY로
async function upsertPosting(c: PoolClient, p: Principal, r: Record<string, any>, a: Record<string, any>, postingType: string, payload: Record<string, unknown>) {
  const res = await c.query(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, company_id, asset_request_id, asset_id, posting_date, value_date, payload,
      approved_by, approved_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, current_date, $8, $9, $10, now(), $10)
    ON CONFLICT (tenant_id, posting_id) DO UPDATE SET posting_type = EXCLUDED.posting_type, status = 'READY', posting_date = EXCLUDED.posting_date,
      value_date = EXCLUDED.value_date, payload = EXCLUDED.payload, approved_by = EXCLUDED.approved_by, approved_at = now(), attempt_count = 0,
      claim_batch_id = NULL, claimed_at = NULL, lease_until = NULL, result_at = NULL, messages = NULL, updated_at = now(), updated_by = EXCLUDED.approved_by,
      version = sap_posting.version + 1
    WHERE sap_posting.status IN ('FAILED', 'CANCELLED') AND sap_posting.asset_request_id = EXCLUDED.asset_request_id`,
  [randomUUID(), p.tenantId, r.request_no, postingType, a.company_id, r.id, a.id, day(r.effective_date) ?? null, JSON.stringify(payload), p.userId]);
  if (!res.rowCount) throw new AlmError(409, 'ALM-E302', `전기 ${r.request_no}이(가) 이미 진행 중이거나 끝났습니다`);
}

// 재전기(ALM-310 :retry)·보정(:fix): 요청의 지금 값으로 payload를 다시 만든다. 요청이 없거나 SAP 대상이 아니면 undefined
export async function rebuildPosting(c: PoolClient, requestId: string): Promise<{ postingType: string; payload: Record<string, unknown> } | undefined> {
  const r = await load(c, requestId);
  const a = (await c.query(`SELECT a.*, r.room_code, st.site_code FROM asset a LEFT JOIN room r ON r.id = a.room_id LEFT JOIN site st ON st.id = r.site_id WHERE a.id = $1`, [r.asset_id])).rows[0];
  if (!a || !r.sap_enabled) return undefined;
  return buildPosting(c, r, a);
}

// ---------------- 전기 오류 보정(:fix, ALM-230·310, sap.finance) ----------------
//   POST_ERROR인 요청만. 기술 필드(effectiveDate, 자산명·시리얼, 룸, 매입처, 사유)만 바꾸면 전기를 다시 READY(시도 0)로.
//   회계 필드(취득가, 매각금액, 코스트센터, 자산클래스, 폐기 유형)가 바뀌면 SUBMITTED로 되돌리고 승인 단계를 새로 만든다(재승인).
//   보정한 사람은 다시 만든 단계를 결정할 수 없다(decidable). 보정 사유는 자산 이력에 남긴다
const FIX_TECH = ['effectiveDate', 'description', 'serialNo', 'targetRoomId', 'buyer', 'reason'] as const;
const FIX_ACCT = ['acquisitionValue', 'saleAmount', 'targetCostCenterId', 'assetClassId', 'retireType'] as const;

export async function fixRequest(c: PoolClient, p: Principal, id: string, ifMatch: string | undefined, body: unknown, mails: MailRequest[]) {
  const r = await load(c, id, true);
  if (!(await visible(c, p, r))) throw E.notFound('요청을 찾을 수 없습니다');
  if (r.status !== 'POST_ERROR') throw new AlmError(409, 'ALM-E322', '전기 오류(POST_ERROR)인 요청만 보정합니다');
  checkVersion(r, ifMatch);
  const k = new Check(body);
  const b = k.obj();
  const comment = k.str(b, 'comment', { required: true, max: 500 });
  const effectiveDate = k.date(b, 'effectiveDate');
  const ch = b.changes === undefined || b.changes === null ? {} : k.obj(b.changes, 'changes');
  const allowed = new Set<string>([...FIX_TECH, ...FIX_ACCT]);
  for (const key of Object.keys(ch)) if (!allowed.has(key)) k.fail(`changes.${key}`, `바꿀 수 있는 필드: ${[...allowed].join(', ')}`);
  const v = {
    description: k.str(ch, 'description', { max: 50, field: 'changes.description' }), serialNo: k.str(ch, 'serialNo', { max: 18, field: 'changes.serialNo' }),
    targetRoomId: k.uuid(ch, 'targetRoomId', { field: 'changes.targetRoomId' }), buyer: k.str(ch, 'buyer', { max: 80, field: 'changes.buyer' }),
    reason: k.str(ch, 'reason', { max: 200, field: 'changes.reason' }),
    acquisitionValue: k.num(ch, 'acquisitionValue', { min: 0.01, max: 1e12, field: 'changes.acquisitionValue' }),
    saleAmount: k.num(ch, 'saleAmount', { min: 0.01, max: 1e12, field: 'changes.saleAmount' }),
    targetCostCenterId: k.uuid(ch, 'targetCostCenterId', { field: 'changes.targetCostCenterId' }), assetClassId: k.uuid(ch, 'assetClassId', { field: 'changes.assetClassId' }),
    retireType: k.oneOf(ch, 'retireType', ['SCRAP', 'LOSS'] as const, 'changes.retireType'),
  };
  if (effectiveDate === undefined && !Object.keys(ch).length) k.errors.push({ field: 'changes', code: 'ALM-E101', message: '바꿀 값이 없습니다' });
  k.done();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(ch, f);
  const old = (f: string) => (f === 'effectiveDate' ? day(r.effective_date) : f === 'acquisitionValue' ? num(r.acquisition_value) : f === 'saleAmount' ? num(r.sale_amount)
    : f === 'targetCostCenterId' ? r.target_cost_center_id : f === 'assetClassId' ? r.asset_class_id : f === 'retireType' ? r.retire_type
      : f === 'targetRoomId' ? r.target_room_id : f === 'buyer' ? r.buyer : f === 'reason' ? r.reason : (r.changes ?? {})[f]);
  const valOf = new Map<string, unknown>(Object.entries(v));
  const accounting = FIX_ACCT.some((f) => has(f) && (valOf.get(f) ?? null) !== (old(f) ?? null));
  const changes = { ...(r.changes ?? {}), ...(has('description') ? { description: v.description } : {}), ...(has('serialNo') ? { serialNo: v.serialNo ?? '' } : {}) };
  await c.query(`UPDATE asset_request SET effective_date = coalesce($2::date, effective_date),
      changes = CASE WHEN $3 THEN $4::jsonb ELSE changes END, target_room_id = CASE WHEN $5 THEN $6::uuid ELSE target_room_id END,
      buyer = CASE WHEN $7 THEN $8 ELSE buyer END, reason = coalesce($9, reason),
      acquisition_value = CASE WHEN $10 THEN $11::numeric ELSE acquisition_value END, sale_amount = CASE WHEN $12 THEN $13::numeric ELSE sale_amount END,
      target_cost_center_id = CASE WHEN $14 THEN $15::uuid ELSE target_cost_center_id END, asset_class_id = CASE WHEN $16 THEN $17::uuid ELSE asset_class_id END,
      retire_type = CASE WHEN $18 THEN $19::retire_type ELSE retire_type END, updated_at = now(), updated_by = $20, version = version + 1 WHERE id = $1`,
  [id, effectiveDate ?? null, has('description') || has('serialNo'), JSON.stringify(changes), has('targetRoomId'), v.targetRoomId ?? null, has('buyer'), v.buyer ?? null,
    v.reason ?? null, has('acquisitionValue'), v.acquisitionValue ?? null, has('saleAmount'), v.saleAmount ?? null, has('targetCostCenterId'), v.targetCostCenterId ?? null,
    has('assetClassId'), v.assetClassId ?? null, has('retireType'), v.retireType ?? null, p.userId]);
  // 바뀐 값으로 다시 검사(코스트센터·클래스·룸 유효성)
  const nr = await load(c, id);
  await validate(c, p, normalize({ requestType: nr.request_type, assetId: nr.asset_id, reason: nr.reason, assetClassId: nr.asset_class_id ?? undefined,
    acquisitionValue: num(nr.acquisition_value), poItemId: nr.po_item_id ?? undefined, targetCostCenterId: nr.target_cost_center_id ?? undefined,
    targetRoomId: nr.target_room_id ?? undefined, changes: nr.changes ?? undefined, effectiveDate: day(nr.effective_date),
    retireType: nr.retire_type ?? undefined, saleAmount: num(nr.sale_amount), buyer: nr.buyer ?? undefined }), id);
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes, asset_request_id, reason)
    VALUES ($1, $2, $3, 'UPDATED', $4, 'UI', $5, $6, $7)`,
  [randomUUID(), p.tenantId, r.asset_id, p.userId, JSON.stringify({ requestNo: r.request_no, fix: { effectiveDate, ...ch }, reapproval: accounting }), id,
    `전기 오류 보정: ${comment}`.slice(0, 200)]);
  const posting = (await c.query(`SELECT id FROM sap_posting WHERE asset_request_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [id])).rows[0];
  if (accounting) {
    // 재승인: 전기는 취소해 두고 최종 승인 때 같은 번호로 다시 READY
    if (posting) await c.query(`UPDATE sap_posting SET status = 'CANCELLED', lease_until = NULL, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [posting.id, p.userId]);
    await c.query(`UPDATE asset_request SET status = 'SUBMITTED', current_step = 1, updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
    await createSteps(c, p, { ...nr, approval_steps: Math.max(1, Number(nr.approval_steps ?? 2)) });
    mails.push(...await stepMails(c, nr, 1));
  } else {
    const built = await rebuildPosting(c, id);
    if (!built || !posting) throw new AlmError(409, 'ALM-E322', 'SAP 전기 대상이 아닙니다');
    await c.query(`UPDATE sap_posting SET status = 'READY', payload = $2, value_date = coalesce($3::date, value_date), attempt_count = 0, messages = NULL,
        lease_until = NULL, claim_batch_id = NULL, result_at = NULL, updated_at = now(), updated_by = $4, version = version + 1 WHERE id = $1`,
    [posting.id, JSON.stringify(built.payload), effectiveDate ?? null, p.userId]);
    await c.query(`UPDATE asset_request SET status = 'ACCT_APPROVED', updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
  }
  return detail(c, p, await load(c, id));
}

// SAP 자산 설명 2행(GENERALDATA-DESCRIPT2, 50자): 위치(사이트)와 룸. SAP 위치 마스터(T499S)에 의존하지 않도록 설명에 넣는다
const desc2 = (siteCode?: string | null, roomCode?: string | null) =>
  siteCode || roomCode ? [siteCode ? `Location: ${siteCode}` : '', roomCode ? `Room: ${roomCode}` : ''].filter(Boolean).join(' | ').slice(0, 50) : undefined;

async function buildPosting(c: PoolClient, r: Record<string, any>, a: Record<string, any>): Promise<{ postingType: string; payload: Record<string, unknown> }> {
  const code = async (sql: string, id: string | null) => (id ? (await c.query(sql, [id])).rows[0] : undefined);
  const tcc = await code(`SELECT cc.cost_center_code, pc.profit_center_code FROM cost_center cc LEFT JOIN profit_center pc ON pc.id = cc.profit_center_id
     WHERE cc.id = $1`, r.target_cost_center_id);
  const room = await code('SELECT r.room_code, s.site_code FROM room r JOIN site s ON s.id = r.site_id WHERE r.id = $1', r.target_room_id);
  switch (r.request_type as ReqType) {
    case 'NEW_ASSET': {
      const cls = await code('SELECT class_code FROM asset_class WHERE id = $1', r.asset_class_id);
      const po = await code('SELECT po_no, item_no FROM po_item WHERE id = $1', r.po_item_id);
      return { postingType: 'ASSET_CREATE', payload: clean({
        assetClass: cls?.class_code, description: a.description, costCenter: tcc?.cost_center_code, capDate: day(r.effective_date),
        serialNo: a.serial_no ? String(a.serial_no).slice(0, 18) : undefined, inventoryNo: a.asset_tag,
        description2: desc2(a.site_code, a.room_code), poNo: po?.po_no, poItem: po?.item_no }) };
    }
    case 'CHANGE': {
      const ch = (r.changes ?? {}) as Record<string, string>;
      const fields = clean({ description: ch.description, serialNo: ch.serialNo, description2: desc2(room?.site_code, room?.room_code) });
      return { postingType: 'ASSET_CHANGE', payload: { fields } };
    }
    case 'TRANSFER':
      if (r.is_profit_center_change) {
        return { postingType: 'ASSET_TRANSFER', payload: { newCostCenter: tcc?.cost_center_code, newProfitCenter: tcc?.profit_center_code ?? '',
          percent: 100, createNewSubNo: false } };
      }
      return { postingType: 'ASSET_CHANGE', payload: clean({ fields: clean({ costCenter: tcc?.cost_center_code,
        description2: desc2(room?.site_code, room?.room_code) }), costCenterValidFrom: day(r.effective_date) }) };
    case 'RETIRE':
      return { postingType: 'ASSET_RETIRE', payload: { retireType: r.retire_type, isPartial: false, reason: String(r.reason ?? '').slice(0, 50) } };
    case 'SALE':
      return { postingType: 'ASSET_RETIRE', payload: { retireType: 'SALE', saleAmount: Number(r.sale_amount), isPartial: false,
        reason: String(r.reason ?? r.buyer ?? '').slice(0, 50) } };
  }
}

// ALM 전용 자산: 최종 승인 즉시 반영
async function applyLocal(c: PoolClient, p: Principal, r: Record<string, any>, a: Record<string, any>) {
  const changes = await applyRequest(c, r, a);
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes, asset_request_id, reason)
    VALUES ($1, $2, $3, $4, $5, 'UI', $6, $7, $8)`,
  [randomUUID(), p.tenantId, a.id, ['RETIRE', 'SALE'].includes(r.request_type) ? (r.request_type === 'SALE' ? 'DISPOSED' : 'RETIRED') : 'UPDATED', p.userId,
    JSON.stringify({ requestNo: r.request_no, ...changes }), r.id, String(r.reason ?? '').slice(0, 200)]);
}

// 요청 값을 자산에 반영(ALM 전용은 승인 시, SAP 자산은 전기 결과가 POSTED일 때 postings.applyPosted가 부른다). 바뀐 값 {열: {before, after}}
export async function applyRequest(c: PoolClient, r: Record<string, any>, a: Record<string, any>): Promise<Record<string, unknown>> {
  const out = new Map<string, unknown>();
  const set = async (col: 'description' | 'serial_no' | 'room_id' | 'site_id' | 'cost_center_id' | 'status' | 'asset_class_id' | 'is_capitalized', after: unknown) => {
    if ((a[col] ?? null) === (after ?? null)) return;
    out.set(col, { before: a[col] ?? null, after: after ?? null });
  };
  const ch = (r.changes ?? {}) as Record<string, string>;
  if (ch.description) await set('description', ch.description);
  if (ch.serialNo !== undefined) await set('serial_no', ch.serialNo || null);
  if (r.target_room_id) {
    const site = (await c.query('SELECT site_id FROM room WHERE id = $1', [r.target_room_id])).rows[0]?.site_id ?? null;
    await set('room_id', r.target_room_id);
    await set('site_id', site);
  }
  if (r.target_cost_center_id) await set('cost_center_id', r.target_cost_center_id);
  if (r.request_type === 'NEW_ASSET') {
    if (r.asset_class_id) await set('asset_class_id', r.asset_class_id);
    await set('is_capitalized', true);
  }
  if (r.request_type === 'RETIRE') await set('status', 'RETIRED');
  if (r.request_type === 'SALE') await set('status', 'DISPOSED');
  if (!out.size) return {};
  const val = (col: string) => (out.has(col) ? (out.get(col) as { after: unknown }).after : null);
  // 고정 SQL: 열마다 (바꿀지, 새 값)
  await c.query(`UPDATE asset SET
      description = CASE WHEN $2 THEN $3 ELSE description END, serial_no = CASE WHEN $4 THEN $5 ELSE serial_no END,
      room_id = CASE WHEN $6 THEN $7::uuid ELSE room_id END, site_id = CASE WHEN $8 THEN $9::uuid ELSE site_id END,
      cost_center_id = CASE WHEN $10 THEN $11::uuid ELSE cost_center_id END, status = CASE WHEN $12 THEN $13::asset_status ELSE status END,
      asset_class_id = CASE WHEN $14 THEN $15::uuid ELSE asset_class_id END, is_capitalized = CASE WHEN $16 THEN $17::boolean ELSE is_capitalized END,
      assigned_user_id = CASE WHEN $12 THEN NULL ELSE assigned_user_id END, assigned_at = CASE WHEN $12 THEN NULL ELSE assigned_at END,
      updated_at = now(), version = version + 1 WHERE id = $1`,
  [a.id, out.has('description'), val('description'), out.has('serial_no'), val('serial_no'), out.has('room_id'), val('room_id'),
    out.has('site_id'), val('site_id'), out.has('cost_center_id'), val('cost_center_id'), out.has('status'), val('status'),
    out.has('asset_class_id'), val('asset_class_id'), out.has('is_capitalized'), val('is_capitalized')]);
  if (out.has('status')) {
    await c.query(`UPDATE asset_assignment SET returned_at = now(), updated_at = now(), version = version + 1 WHERE asset_id = $1 AND returned_at IS NULL`, [a.id]);
  }
  // Bundle 폐기·처분: 구성품도 함께
  const st = val('status') as string | null;
  if (a.is_bundle && (st === 'RETIRED' || st === 'DISPOSED')) {
    const tags = await cascadeBundle(c, a, st, r.id ?? null, r.request_no);
    if (tags.length) out.set('components', { before: null, after: tags });
  }
  return Object.fromEntries(out);
}

// ---------------- 알림 ----------------
// 다른 화면(ALM-112 등록·ALM-111 할당)이 제출 상태로 만든 요청: 지금 단계 승인자에게 메일(제출 상태가 아니면 없음)
export async function submittedMails(c: PoolClient, id: string): Promise<MailRequest[]> {
  const r = await load(c, id);
  if (r.status !== 'SUBMITTED') return [];
  return stepMails(c, r, r.current_step ?? 1);
}

// 그 단계의 승인자(부서 관리자가 없으면 대리 역할)에게
async function stepMails(c: PoolClient, r: Record<string, any>, stepNo: number): Promise<MailRequest[]> {
  const s = (await steps(c, r.id)).find((x) => x.step_no === stepNo);
  if (!s) return [];
  const cc = stepCc(s, r);
  const role = s.approver_role === 'DEPT_MANAGER' && !cc.exists ? proxyRole(r) : s.approver_role;
  return approverMails(c, { ...r, responsible_cc_code: cc.code }, role, stepNo);
}

async function approverMails(c: PoolClient, r: Record<string, any>, role: string, stepNo: number): Promise<MailRequest[]> {
  const users = (await c.query(`SELECT DISTINCT u.id FROM user_role ur JOIN app_user u ON u.id = ur.user_id
      LEFT JOIN company co ON co.id = ur.company_id LEFT JOIN site s ON s.id = ur.site_id LEFT JOIN cost_center cc ON cc.id = ur.cost_center_id
     WHERE ur.role = $1 AND u.is_active AND u.id <> $2
       AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
       AND (CASE WHEN $1 = 'DEPT_MANAGER' THEN cc.cost_center_code = $3
            ELSE (ur.company_id IS NULL OR co.company_code = $4) AND (ur.site_id IS NULL OR s.site_code = $5) AND (ur.cost_center_id IS NULL OR cc.cost_center_code = $3) END)`,
  [role, r.requester_id, r.responsible_cc_code, r.company_code, r.site_code])).rows;
  return users.map((u) => ({ recipientId: u.id as string, template: 'APPROVAL_REQUESTED', subjectType: 'ASSET_REQUEST', subjectId: r.id,
    params: { requester: r.requester_name, requestType: r.request_type, requestNo: r.request_no, target: r.asset_tag ?? '', path: path(r.id) },
    dedupeKey: `APPROVAL_REQUESTED:${r.id}:${stepNo}:${u.id}`.slice(0, 120) }));
}

function decidedMail(r: Record<string, any>, p: Principal, decision: 'APPROVED' | 'REJECTED', comment?: string): MailRequest {
  return { recipientId: r.requester_id, template: 'APPROVAL_DECIDED', subjectType: 'ASSET_REQUEST', subjectId: r.id,
    params: { approver: p.displayName, requestNo: r.request_no, decision, comment, path: path(r.id) },
    dedupeKey: `APPROVAL_DECIDED:${r.id}:${decision}`.slice(0, 120) };
}
