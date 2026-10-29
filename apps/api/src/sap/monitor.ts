// SAP 연계 화면(ALM-310, WBS 4.6): 연결·IF 상태, 실행 로그, 전기 큐(재전기·취소), 수동 실행 요청, 대사 차이 처리, 필드 매핑, 연결 목록
//   openapi getSapStatus·listSapRuns·listSapRunMessages·listPostings·getPosting·retryPosting·releasePosting·cancelPosting·createRunRequest
//           listReconRuns·listReconDiffs·resolveReconDiffs·listFieldMappings·patchFieldMapping·listSapConnections
//   SAP 연계를 끈 회사의 데이터도 그대로 조회한다(기록). 처리(재전기·대사 처리)는 SAP 연계 회사만
import { desc2 } from '../common/sap-text';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';
import type { Principal } from '../platform/identity/principal';
import { can } from '../auth/scope';
import { nextNumbers } from '../assets/tags';
import { rebuildPosting } from '../requests/requests';
import { cancelActiveFlow } from '../requests/approvalAdapter';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const uuidOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const paging = (q: Record<string, string | undefined>) => {
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 50) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

// ---------------- 상태 ----------------
// 08 3장 인터페이스 목록. everyMin = 예정 주기(분). 마지막 실행이 주기의 2배를 넘으면 isOverdue
export const IFS: { id: string; name: string; direction: 'SAP_TO_ALM' | 'ALM_TO_SAP'; everyMin: number; runnable?: boolean }[] = [
  { id: 'IF-MD-01', name: '조직·코드 마스터', direction: 'SAP_TO_ALM', everyMin: 1440, runnable: true },
  { id: 'IF-AA-01', name: '자산 마스터 델타', direction: 'SAP_TO_ALM', everyMin: 1440, runnable: true },
  { id: 'IF-AA-02', name: '자산 금액', direction: 'SAP_TO_ALM', everyMin: 1440, runnable: true },
  { id: 'IF-MM-01', name: '자산 구매오더', direction: 'SAP_TO_ALM', everyMin: 1440, runnable: true },
  { id: 'IF-MM-03', name: '입고', direction: 'SAP_TO_ALM', everyMin: 15 },
  { id: 'IF-AA-03', name: '자산 생성', direction: 'ALM_TO_SAP', everyMin: 15 },
  { id: 'IF-AA-04', name: '자산 마스터 변경', direction: 'ALM_TO_SAP', everyMin: 15 },
  { id: 'IF-AA-05', name: '자산 이관', direction: 'ALM_TO_SAP', everyMin: 15 },
  { id: 'IF-AA-06', name: '폐기·매각', direction: 'ALM_TO_SAP', everyMin: 15 },
  { id: 'IF-AA-07', name: '실사 결과', direction: 'ALM_TO_SAP', everyMin: 15 },
  { id: 'IF-MM-02', name: '구매오더 생성', direction: 'ALM_TO_SAP', everyMin: 15 },
  { id: 'IF-RC-01', name: '대사 추출', direction: 'SAP_TO_ALM', everyMin: 10080, runnable: true },
  { id: 'IF-OP-01', name: '수동 실행 요청', direction: 'ALM_TO_SAP', everyMin: 15 },
];
const RUNNABLE = IFS.filter((x) => x.runnable).map((x) => x.id);
const CLAIMED_BY_JOB = new Set(['IF-AA-03', 'IF-AA-04', 'IF-AA-05', 'IF-AA-06', 'IF-AA-07', 'IF-MM-02', 'IF-OP-01']);

export async function status(c: PoolClient) {
  const conns = (await c.query(`SELECT sc.system_id, sc.last_call_at, co.company_code FROM sap_connection sc JOIN company co ON co.id = sc.company_id
     WHERE sc.is_active AND co.sap_enabled ORDER BY sc.system_id, co.company_code`)).rows;
  const last = new Map((await c.query(`SELECT DISTINCT ON (interface_id) interface_id, started_at, status, record_count FROM sap_if_run
     ORDER BY interface_id, started_at DESC`)).rows.map((r) => [r.interface_id as string, r]));
  const lastCall = conns.reduce<Date | undefined>((m, r) => (r.last_call_at && (!m || r.last_call_at > m) ? r.last_call_at : m), undefined);
  const queue = Object.fromEntries((await c.query(`SELECT status::text AS s, count(*)::int AS n FROM sap_posting WHERE status IN ('READY', 'CLAIMED', 'FAILED') GROUP BY 1`))
    .rows.map((r) => [r.s, r.n]));
  const pending = new Set((await c.query(`SELECT DISTINCT interface_id FROM sap_run_request WHERE status = 'PENDING'`)).rows.map((r) => r.interface_id as string));
  const now = Date.now();
  return {
    systemId: [...new Set(conns.map((r) => r.system_id))].join(', '), companyCodes: [...new Set(conns.map((r) => r.company_code as string))],
    lastCallAt: iso(lastCall),
    interfaces: IFS.map((f) => {
      const r = last.get(f.id);
      // SAP 잡이 가져가는 IF(전기·실행 요청)는 실행 기록이 결과가 있을 때만 생기므로 마지막 호출(claim) 기준으로 본다
      const seen: Date | undefined = CLAIMED_BY_JOB.has(f.id) ? (lastCall ?? r?.started_at) : r?.started_at;
      return clean({ interfaceId: f.id, name: f.name, direction: f.direction, everyMinutes: f.everyMin, lastRunAt: iso(r?.started_at), lastStatus: r?.status,
        lastRecordCount: r?.record_count, isOverdue: conns.length > 0 && (!seen || now - new Date(seen).getTime() > f.everyMin * 2 * 60_000),
        runnable: f.runnable ? true : undefined, runPending: pending.has(f.id) || undefined });
    }),
    postingQueue: { READY: queue.READY ?? 0, CLAIMED: queue.CLAIMED ?? 0, FAILED: queue.FAILED ?? 0 },
  };
}

// ---------------- 실행 로그 ----------------
export async function listRuns(c: PoolClient, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const from = k.date(q, 'from'), to = k.date(q, 'to');
  const st = k.oneOf(q, 'status', ['SUCCESS', 'PARTIAL', 'FAILED'] as const);
  if (q.interfaceId && !IFS.some((f) => f.id === q.interfaceId)) k.fail('interfaceId', 'IF ID');
  k.done();
  const { page, pageSize, offset } = paging(q);
  const where = `WHERE started_at >= coalesce($1::date, current_date - 30) AND started_at < coalesce($2::date, current_date) + 1
    AND ($3::text IS NULL OR interface_id = $3) AND ($4::text IS NULL OR status::text = $4)`;
  const args = [from ?? null, to ?? null, q.interfaceId ?? null, st ?? null];
  const total = (await c.query(`SELECT count(*)::int AS n FROM sap_if_run ${where}`, args)).rows[0].n as number;
  const rows = (await c.query(`SELECT * FROM sap_if_run ${where} ORDER BY started_at DESC LIMIT $5 OFFSET $6`, [...args, pageSize, offset])).rows;
  return {
    items: rows.map((r) => clean({ id: r.id, interfaceId: r.interface_id, direction: r.direction, batchId: r.batch_id, status: r.status, recordCount: r.record_count,
      errorCount: r.error_count, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), correlationId: r.correlation_id ?? undefined,
      httpStatus: r.http_status ?? undefined, sapSystem: r.sap_system ?? undefined })),
    page, pageSize, total,
  };
}

export async function runMessages(c: PoolClient, id: string, q: Record<string, string | undefined>) {
  if (!uuidOk(id) || !(await c.query('SELECT 1 FROM sap_if_run WHERE id = $1', [id])).rowCount) throw E.notFound('실행 기록을 찾을 수 없습니다');
  const { page, pageSize, offset } = paging(q);
  const result = q.result && ['OK', 'ERROR', 'SKIPPED'].includes(q.result) ? q.result : null;
  const total = (await c.query(`SELECT count(*)::int AS n FROM sap_if_message WHERE run_id = $1 AND ($2::text IS NULL OR result = $2)`, [id, result])).rows[0].n as number;
  const rows = (await c.query(`SELECT * FROM sap_if_message WHERE run_id = $1 AND ($2::text IS NULL OR result = $2) ORDER BY created_at, record_key LIMIT $3 OFFSET $4`,
    [id, result, pageSize, offset])).rows;
  return {
    items: rows.map((r) => clean({ recordKey: r.record_key, result: r.result, errorCode: r.error_code ?? undefined, message: r.message ?? undefined,
      payload: r.result === 'ERROR' ? r.payload ?? undefined : undefined })),
    page, pageSize, total,
  };
}

// ---------------- 전기 큐 ----------------
const P_STATUSES = ['READY', 'CLAIMED', 'POSTED', 'FAILED', 'CANCELLED'] as const;
const P_TYPES = ['ASSET_CREATE', 'ASSET_CHANGE', 'ASSET_TRANSFER', 'ASSET_RETIRE', 'COUNT_RESULT', 'PO_CREATE'] as const;
const lastMsg = (m: unknown) => {
  const arr = Array.isArray(m) ? m as { type: string; id: string; number: string; text: string }[] : [];
  const x = arr.find((y) => y.type === 'E' || y.type === 'A') ?? arr[0];
  return x ? `${x.id} ${x.number}: ${x.text}`.trim() : undefined;
};
const exhausted = (m: unknown) => Array.isArray(m) && m.some((x: { id?: string; number?: string }) => x.id === 'ALM' && x.number === '306');

export async function listPostings(c: PoolClient, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const statuses = (q.status ?? 'FAILED,READY,CLAIMED').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.some((s) => !(P_STATUSES as readonly string[]).includes(s))) k.fail('status', P_STATUSES.join(', '));
  const type = k.oneOf(q, 'type', P_TYPES);
  k.done();
  const { page, pageSize, offset } = paging(q);
  const term = q.q?.trim() ? `%${likeEsc(q.q.trim().slice(0, 30))}%` : null;
  const where = `WHERE p.status::text = ANY($1) AND ($2::text IS NULL OR p.posting_type::text = $2)
    AND ($3::text IS NULL OR p.posting_id ILIKE $3 OR a.asset_tag ILIKE $3 OR a.sap_asset_no ILIKE $3)`;
  const from = `FROM sap_posting p LEFT JOIN asset a ON a.id = p.asset_id LEFT JOIN company co ON co.id = p.company_id`;
  const args = [statuses, type ?? null, term];
  const total = (await c.query(`SELECT count(*)::int AS n ${from} ${where}`, args)).rows[0].n as number;
  const rows = (await c.query(`SELECT p.*, a.asset_tag, co.company_code ${from} ${where}
     ORDER BY CASE p.status WHEN 'FAILED' THEN 0 WHEN 'CLAIMED' THEN 1 WHEN 'READY' THEN 2 ELSE 3 END, p.updated_at DESC LIMIT $4 OFFSET $5`, [...args, pageSize, offset])).rows;
  return { items: rows.map(postingRow), page, pageSize, total };
}

const postingRow = (r: Record<string, any>) => clean({
  id: r.id, postingId: r.posting_id, postingType: r.posting_type, status: r.status, companyCode: r.company_code, assetTag: r.asset_tag ?? undefined,
  attemptCount: r.attempt_count, approvedAt: iso(r.approved_at), leaseUntil: iso(r.lease_until), sapDocumentNo: r.sap_document_no ?? undefined,
  lastMessage: lastMsg(r.messages), exhausted: exhausted(r.messages) || undefined, updatedAt: iso(r.updated_at),
});

async function loadPosting(c: PoolClient, id: string, lock = false) {
  if (!uuidOk(id)) throw E.notFound('전기 건을 찾을 수 없습니다');
  const r = (await c.query(`SELECT p.*, a.asset_tag, a.id AS asset_ref, co.company_code, co.sap_enabled, ar.request_no, ar.status AS request_status
     FROM sap_posting p LEFT JOIN asset a ON a.id = p.asset_id LEFT JOIN company co ON co.id = p.company_id LEFT JOIN asset_request ar ON ar.id = p.asset_request_id
    WHERE p.id = $1 ${lock ? 'FOR UPDATE OF p' : ''}`, [id])).rows[0];
  if (!r) throw E.notFound('전기 건을 찾을 수 없습니다');
  return r;
}

export async function getPosting(c: PoolClient, id: string) {
  const r = await loadPosting(c, id);
  return clean({
    summary: clean({ ...postingRow(r), sapFiscalYear: r.sap_fiscal_year ?? undefined, sapAssetNo: r.sap_asset_no ?? undefined, sapPoNo: r.sap_po_no ?? undefined,
      resultAt: iso(r.result_at), claimBatchId: r.claim_batch_id ?? undefined, claimedAt: iso(r.claimed_at), messages: r.messages ?? [] }),
    payload: r.payload, postingDate: iso(r.posting_date)?.slice(0, 10), valueDate: iso(r.value_date)?.slice(0, 10),
    requestNo: r.request_no ?? undefined, requestId: r.asset_request_id ?? undefined, requestStatus: r.request_status ?? undefined, assetId: r.asset_ref ?? undefined,
  });
}

// 재전기: FAILED만. 요청의 지금 값으로 payload를 다시 만들고 READY·시도 0. 시도 초과(E306)는 SAP 확인 체크(confirmSapChecked)가 있어야
export async function retryPosting(c: PoolClient, p: Principal, id: string, body: unknown) {
  const r = await loadPosting(c, id, true);
  if (r.status !== 'FAILED') throw new AlmError(409, 'ALM-E322', `${r.status} 상태는 재전기할 수 없습니다(FAILED만)`);
  if (!r.sap_enabled) throw new AlmError(409, 'ALM-E322', '이 회사는 SAP 연계를 쓰지 않습니다');
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (exhausted(r.messages) && b.confirmSapChecked !== true) {
    throw new AlmError(409, 'ALM-E322', 'SAP 결과 회신 없이 시도가 초과된 건입니다. SAP에 이미 전기됐는지(전표·자산) 확인한 뒤 확인 체크와 함께 다시 요청하세요',
      { needsConfirm: true });
  }
  const built = r.asset_request_id ? await rebuildPosting(c, r.asset_request_id) : undefined;
  await c.query(`UPDATE sap_posting SET status = 'READY', payload = coalesce($2::jsonb, payload), attempt_count = 0, messages = NULL, lease_until = NULL,
      claim_batch_id = NULL, claimed_at = NULL, result_at = NULL, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`,
  [id, built ? JSON.stringify(built.payload) : null, p.userId]);
  if (r.asset_request_id) {
    await c.query(`UPDATE asset_request SET status = 'ACCT_APPROVED', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1 AND status = 'POST_ERROR'`,
      [r.asset_request_id, p.userId]);
  }
  return postingRow(await loadPosting(c, id));
}

// 선점 취소(잠금 해제): CLAIMED만. READY로 되돌려 SAP 잡이 바로 다시 가져가게 한다(시험 실행·중단된 잡 뒤처리).
// 잠금이 남아 있어도 풀 수 있으므로 confirmed=true(SAP 잡이 지금 처리 중이 아님을 확인)가 있어야 한다.
// 시도 횟수는 1 줄인다(가져갈 때 올라간 만큼). SAP에 이미 전기됐어도 다음 실행의 POSTED 로그·BKTXT 확인이 중복 전기를 막는다.
export async function releasePosting(c: PoolClient, p: Principal, id: string, body?: unknown) {
  const r = await loadPosting(c, id, true);
  if (r.status !== 'CLAIMED') throw new AlmError(409, 'ALM-E322', `${r.status} 상태는 선점을 취소할 수 없습니다(CLAIMED만)`);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.confirmed !== true) {
    throw new AlmError(409, 'ALM-E322', 'SAP 잡이 지금 이 건을 처리 중이 아닌지 확인한 뒤 확인(confirmed)과 함께 다시 요청하세요', { needsConfirm: true });
  }
  await c.query(`UPDATE sap_posting SET status = 'READY', lease_until = NULL, claim_batch_id = NULL, claimed_at = NULL,
      attempt_count = greatest(attempt_count - 1, 0), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return postingRow(await loadPosting(c, id));
}

// 전기 취소: READY·FAILED만. 연결 요청은 CANCELLED(대기 단계 SKIPPED)
// 전기 취소: READY·FAILED, 그리고 잠금이 끝난 CLAIMED(SAP 잡이 가져간 뒤 회신이 없음 — 사람이 SAP에 전기되지 않았음을 확인해야 함)
export async function cancelPosting(c: PoolClient, p: Principal, id: string, body?: unknown) {
  const r = await loadPosting(c, id, true);
  const stale = r.status === 'CLAIMED' && r.lease_until && new Date(r.lease_until).getTime() < Date.now();
  if (r.status === 'CLAIMED' && !stale) throw new AlmError(409, 'ALM-E322', 'SAP 잡이 처리 중입니다(잠금이 끝난 뒤 취소할 수 있습니다)');
  if (!stale && !['READY', 'FAILED'].includes(r.status)) throw new AlmError(409, 'ALM-E322', `${r.status} 상태는 취소할 수 없습니다(READY·FAILED만)`);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (stale && b.confirmSapChecked !== true) {
    throw new AlmError(409, 'ALM-E322', 'SAP 결과 회신이 없는 건입니다. SAP에 이미 전기됐는지(전표·자산) 확인한 뒤 확인 체크와 함께 다시 요청하세요', { needsConfirm: true });
  }
  await c.query(`UPDATE sap_posting SET status = 'CANCELLED', lease_until = NULL, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  if (r.asset_request_id) {
    await cancelActiveFlow(c, p.userId, r.asset_request_id);
    await c.query(`UPDATE asset_request SET status = 'CANCELLED', completed_at = now(), updated_at = now(), updated_by = $2, version = version + 1
      WHERE id = $1 AND status NOT IN ('POSTED', 'CANCELLED')`, [r.asset_request_id, p.userId]);
  }
  if (r.purchase_request_id) {
    await c.query(`UPDATE purchase_request SET status = 'CANCELLED', updated_at = now(), version = version + 1 WHERE id = $1 AND status <> 'CANCELLED'`, [r.purchase_request_id]);
  }
  return postingRow(await loadPosting(c, id));
}

// ---------------- 수동 실행 요청(IF-OP-01) ----------------
export async function createRunRequest(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const iface = k.oneOf(b, 'interfaceId', RUNNABLE as unknown as readonly string[]);
  if (b.interfaceId === undefined) k.errors.push({ field: 'interfaceId', code: 'ALM-E101', message: '필수 값입니다' });
  const runType = k.oneOf(b, 'runType', ['WEEKLY', 'CAMPAIGN'] as const);
  const campaignCode = k.str(b, 'campaignCode', { max: 6 });
  const isClosing = k.bool(b, 'isClosing');
  if (runType && iface !== 'IF-RC-01') k.fail('runType', 'IF-RC-01만');
  if (runType === 'CAMPAIGN' && !campaignCode) k.errors.push({ field: 'campaignCode', code: 'ALM-E101', message: 'CAMPAIGN이면 필수입니다' });
  if (isClosing && iface !== 'IF-AA-02') k.fail('isClosing', 'IF-AA-02만');
  k.done();
  if (isClosing && !can(p, 'sap.finance')) throw E.forbidden('마감 실행은 sap.finance 권한이 필요합니다');
  if (!(await c.query('SELECT 1 FROM sap_connection sc JOIN company co ON co.id = sc.company_id WHERE sc.is_active AND co.sap_enabled LIMIT 1')).rowCount) {
    throw new AlmError(409, 'ALM-E322', 'SAP 연계를 쓰는 회사의 연결이 없습니다');
  }
  if ((await c.query(`SELECT 1 FROM sap_run_request WHERE interface_id = $1 AND status = 'PENDING'`, [iface])).rowCount) {
    throw new AlmError(409, 'ALM-E322', `${iface}의 실행 요청이 이미 대기 중입니다(SAP 15분 잡이 가져갑니다)`);
  }
  const id = randomUUID();
  const params = clean({ runType: iface === 'IF-RC-01' ? runType ?? 'WEEKLY' : undefined, campaignCode, isClosing: isClosing || undefined });
  await c.query(`INSERT INTO sap_run_request (id, tenant_id, interface_id, params, requested_by, created_by) VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, p.tenantId, iface, Object.keys(params).length ? JSON.stringify(params) : null, p.userId]);
  const r = (await c.query('SELECT * FROM sap_run_request WHERE id = $1', [id])).rows[0];
  return clean({ id, interfaceId: iface, ...params, status: r.status, requestedAt: iso(r.requested_at) });
}

export async function listRunRequests(c: PoolClient) {
  const rows = (await c.query(`SELECT rr.*, u.display_name FROM sap_run_request rr LEFT JOIN app_user u ON u.id = rr.requested_by
     ORDER BY rr.requested_at DESC LIMIT 50`)).rows;
  return { items: rows.map((r) => clean({ id: r.id, interfaceId: r.interface_id, ...(r.params ?? {}), status: r.status, requestedAt: iso(r.requested_at),
    requestedBy: r.display_name ?? undefined, pickedAt: iso(r.picked_at), doneAt: iso(r.done_at) })) };
}

// ---------------- 대사 ----------------
export async function listReconRuns(c: PoolClient, q: Record<string, string | undefined>) {
  const { page, pageSize, offset } = paging(q);
  const total = (await c.query('SELECT count(*)::int AS n FROM recon_run')).rows[0].n as number;
  const rows = (await c.query(`SELECT r.*, (SELECT count(*)::int FROM recon_diff d WHERE d.run_id = r.id AND d.status = 'OPEN') AS open_diffs
     FROM recon_run r ORDER BY r.snapshot_at DESC LIMIT $1 OFFSET $2`, [pageSize, offset])).rows;
  return {
    items: rows.map((r) => ({ id: r.id, runType: r.run_type, batchId: r.batch_id, snapshotAt: iso(r.snapshot_at), status: r.status, sapCount: r.sap_count,
      almCount: r.alm_count, diffCount: r.diff_count, openDiffs: r.open_diffs })),
    page, pageSize, total,
  };
}

const DIFF_TYPES = ['SAP_ONLY', 'ALM_ONLY', 'COST_CENTER', 'LOCATION', 'SERIAL', 'TAG', 'RETIRED'] as const;
export async function listReconDiffs(c: PoolClient, runId: string, q: Record<string, string | undefined>) {
  if (!uuidOk(runId) || !(await c.query('SELECT 1 FROM recon_run WHERE id = $1', [runId])).rowCount) throw E.notFound('대사 실행을 찾을 수 없습니다');
  const k = new Check(q);
  const type = k.oneOf(q, 'diffType', DIFF_TYPES);
  const st = q.status === 'ALL' ? null : k.oneOf(q, 'status', ['OPEN', 'RESOLVED', 'IGNORED'] as const) ?? 'OPEN';
  k.done();
  const { page, pageSize, offset } = paging(q);
  const where = `WHERE d.run_id = $1 AND ($2::text IS NULL OR d.diff_type::text = $2) AND ($3::text IS NULL OR d.status::text = $3)`;
  const total = (await c.query(`SELECT count(*)::int AS n FROM recon_diff d ${where}`, [runId, type ?? null, st])).rows[0].n as number;
  const rows = (await c.query(`SELECT d.*, a.asset_tag, u.display_name FROM recon_diff d LEFT JOIN asset a ON a.id = d.asset_id LEFT JOIN app_user u ON u.id = d.resolved_by
     ${where} ORDER BY d.diff_type, d.sap_asset_no NULLS LAST, a.asset_tag LIMIT $4 OFFSET $5`, [runId, type ?? null, st, pageSize, offset])).rows;
  return {
    items: rows.map((r) => clean({ id: r.id, diffType: r.diff_type, assetId: r.asset_id ?? undefined, assetTag: r.asset_tag ?? undefined,
      sapAssetNo: r.sap_asset_no ? `${r.sap_asset_no}-${r.sap_sub_no ?? '0000'}` : undefined, almValue: r.alm_value ?? undefined, sapValue: r.sap_value ?? undefined,
      suggestedAction: r.action, status: r.status, allowedActions: ALLOWED[r.diff_type as DiffType], resolvedBy: r.display_name ?? undefined, resolvedAt: iso(r.resolved_at) })),
    page, pageSize, total,
  };
}

type DiffType = (typeof DIFF_TYPES)[number];
type Action = 'SAP_TO_ALM' | 'ALM_TO_SAP' | 'IGNORE';
// 유형별로 할 수 있는 처리(태그는 라벨이 붙어 있어 SAP 값으로 바꾸지 않는다)
const ALLOWED: Record<DiffType, Action[]> = {
  SAP_ONLY: ['SAP_TO_ALM', 'IGNORE'], ALM_ONLY: ['IGNORE'], COST_CENTER: ['SAP_TO_ALM', 'IGNORE'], LOCATION: ['ALM_TO_SAP', 'SAP_TO_ALM', 'IGNORE'],
  SERIAL: ['ALM_TO_SAP', 'SAP_TO_ALM', 'IGNORE'], TAG: ['ALM_TO_SAP', 'IGNORE'], RETIRED: ['SAP_TO_ALM', 'IGNORE'],
};

class ItemError extends Error { constructor(readonly code: string, message: string) { super(message); } }

// 대사 차이 처리(건별 SAVEPOINT, 오류가 있으면 207)
//   SAP_TO_ALM: COST_CENTER·LOCATION·SERIAL은 ALM 값을 SAP 값으로, RETIRED는 ALM RETIRED, SAP_ONLY는 IF-AA-01 수동 실행 요청(전체를 SAP에서 다시 받음)
//   ALM_TO_SAP: 변경 요청(출처 RECONCILIATION, 승인 생략) + ASSET_CHANGE 전기 건(IF-AA-04). 같은 자산에 진행 중인 요청이 있으면 그 건은 오류
//   IGNORE: 무시(메모)
export async function resolveDiffs(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const items = k.arr(b, 'items', { required: true, max: 500 }).map((x, i) => {
    const o = k.obj(x, `items[${i}]`);
    return { id: k.uuid(o, 'id', { required: true, field: `items[${i}].id` })!, action: k.oneOf(o, 'action', ['SAP_TO_ALM', 'ALM_TO_SAP', 'IGNORE'] as const, `items[${i}].action`)!,
      note: k.str(o, 'note', { max: 200, field: `items[${i}].note` }) };
  });
  k.done();
  const results: Record<string, unknown>[] = [];
  let aa01Requested = false;
  for (const it of items) {
    await c.query('SAVEPOINT rd');
    try {
      const d = (await c.query(`SELECT d.*, a.status AS asset_status, a.company_id, co.sap_enabled, rs.company_code
          FROM recon_diff d LEFT JOIN asset a ON a.id = d.asset_id LEFT JOIN company co ON co.id = a.company_id
          LEFT JOIN LATERAL (SELECT company_code FROM recon_snapshot s WHERE s.run_id = d.run_id AND s.sap_asset_no = d.sap_asset_no LIMIT 1) rs ON true
         WHERE d.id = $1 FOR UPDATE OF d`, [it.id])).rows[0];
      if (!d) throw new ItemError('ALM-E404', '차이를 찾을 수 없습니다');
      if (d.status !== 'OPEN') throw new ItemError('ALM-E322', `이미 ${d.status}입니다`);
      if (!ALLOWED[d.diff_type as DiffType].includes(it.action)) throw new ItemError('ALM-E100', `${d.diff_type}에는 ${ALLOWED[d.diff_type as DiffType].join('·')}만`);
      let createdId: string | undefined;
      if (it.action === 'SAP_TO_ALM') createdId = await sapToAlm(c, p, d, () => { const first = !aa01Requested; aa01Requested = true; return first; });
      if (it.action === 'ALM_TO_SAP') createdId = await almToSap(c, p, d);
      await c.query(`UPDATE recon_diff SET status = $2, action = $3, resolved_by = $4, resolved_at = now(), updated_at = now(), updated_by = $4, version = version + 1
        WHERE id = $1`, [it.id, it.action === 'IGNORE' ? 'IGNORED' : 'RESOLVED', it.action, p.userId]);
      await c.query('RELEASE SAVEPOINT rd');
      results.push(clean({ id: it.id, status: 'OK', createdId }));
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT rd');
      if (!(e instanceof ItemError) && !(e instanceof AlmError)) throw e;
      results.push({ id: it.id, status: 'ERROR', code: e instanceof ItemError ? e.code : (e as AlmError).code, message: e.message });
    }
  }
  return { status: results.some((r) => r.status === 'ERROR') ? 207 : 200, body: { results } };
}

async function event(c: PoolClient, p: Principal, assetId: string, type: string, changes: unknown, note?: string) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes, reason) VALUES ($1, $2, $3, $4, $5, 'UI', $6, $7)`,
    [randomUUID(), p.tenantId, assetId, type, p.userId, JSON.stringify(changes), note ?? 'IF-RC-01 대사 차이 처리']);
}

async function sapToAlm(c: PoolClient, p: Principal, d: Record<string, any>, firstAa01: () => boolean): Promise<string | undefined> {
  if (d.diff_type === 'SAP_ONLY') {
    // ALM에 없는 SAP 자산: SAP에서 전체 자산 마스터를 다시 받는다(IF-AA-01 수동 실행 요청, 한 번만)
    if (firstAa01() && !(await c.query(`SELECT 1 FROM sap_run_request WHERE interface_id = 'IF-AA-01' AND status = 'PENDING'`)).rowCount) {
      const id = randomUUID();
      await c.query(`INSERT INTO sap_run_request (id, tenant_id, interface_id, params, requested_by, created_by) VALUES ($1, $2, 'IF-AA-01', NULL, $3, $3)`,
        [id, p.tenantId, p.userId]);
      return id;
    }
    return undefined;
  }
  if (!d.asset_id) throw new ItemError('ALM-E404', 'ALM 자산이 없습니다');
  if (d.sap_enabled === false) throw new ItemError('ALM-E322', '이 회사는 SAP 연계를 쓰지 않습니다');
  switch (d.diff_type) {
    case 'COST_CENTER': {
      const cc = (await c.query('SELECT id FROM cost_center WHERE company_id = $1 AND cost_center_code = $2 AND is_active', [d.company_id, d.sap_value])).rows[0];
      if (!cc) throw new ItemError('ALM-E104', `코스트센터 ${d.sap_value}가 ALM에 없습니다(IF-MD-01 먼저)`);
      await c.query('UPDATE asset SET cost_center_id = $2, updated_at = now(), version = version + 1 WHERE id = $1', [d.asset_id, cc.id]);
      await event(c, p, d.asset_id, 'SAP_SYNCED', { cost_center: { before: d.alm_value, after: d.sap_value } });
      return undefined;
    }
    case 'LOCATION': {
      const room = (await c.query('SELECT r.id, r.site_id FROM room r WHERE r.room_code = $1 AND r.is_active', [d.sap_value])).rows[0];
      if (!room) throw new ItemError('ALM-E100', `룸 ${d.sap_value ?? '(빈 값)'}이(가) ALM에 없습니다`);
      await c.query('UPDATE asset SET room_id = $2, site_id = $3, updated_at = now(), version = version + 1 WHERE id = $1', [d.asset_id, room.id, room.site_id]);
      await event(c, p, d.asset_id, 'SAP_SYNCED', { room: { before: d.alm_value, after: d.sap_value } });
      return undefined;
    }
    case 'SERIAL':
      await c.query('UPDATE asset SET serial_no = $2, updated_at = now(), version = version + 1 WHERE id = $1', [d.asset_id, d.sap_value ?? null]);
      await event(c, p, d.asset_id, 'SAP_SYNCED', { serial_no: { before: d.alm_value, after: d.sap_value } });
      return undefined;
    case 'RETIRED':
      if (!['RETIRED', 'DISPOSED'].includes(d.asset_status)) {
        await c.query(`UPDATE asset SET status = 'RETIRED', assigned_user_id = NULL, assigned_at = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [d.asset_id]);
        await c.query('UPDATE asset_assignment SET returned_at = now(), updated_at = now(), version = version + 1 WHERE asset_id = $1 AND returned_at IS NULL', [d.asset_id]);
        await event(c, p, d.asset_id, 'RETIRED', { status: { before: d.asset_status, after: 'RETIRED' }, sapDeactDate: d.sap_value });
      }
      return undefined;
  }
  throw new ItemError('ALM-E100', `${d.diff_type}에는 SAP_TO_ALM을 쓸 수 없습니다`);
}

// ALM 값을 SAP으로: 변경 요청(대사 출처, 승인 생략) + ASSET_CHANGE 전기 건
async function almToSap(c: PoolClient, p: Principal, d: Record<string, any>): Promise<string> {
  if (!d.asset_id) throw new ItemError('ALM-E404', 'ALM 자산이 없습니다');
  if (d.sap_enabled === false) throw new ItemError('ALM-E322', '이 회사는 SAP 연계를 쓰지 않습니다');
  const open = (await c.query(`SELECT request_no FROM asset_request WHERE asset_id = $1 AND status NOT IN ('POSTED', 'REJECTED', 'CANCELLED') LIMIT 1`, [d.asset_id])).rows[0];
  if (open) throw new ItemError('ALM-E315', `이 자산에 진행 중인 요청(${open.request_no})이 있습니다`);
  const a = (await c.query('SELECT a.*, r.room_code, st.site_code FROM asset a LEFT JOIN room r ON r.id = a.room_id LEFT JOIN site st ON st.id = r.site_id WHERE a.id = $1', [d.asset_id])).rows[0];
  // 위치·룸은 설명 2행(D-09 변경)
  const fields = d.diff_type === 'LOCATION' ? { description2: desc2(a.site_code, a.room_code) ?? '' }
    : d.diff_type === 'SERIAL' ? { serialNo: String(a.serial_no ?? '').slice(0, 18) } : { inventoryNo: a.asset_tag };
  const id = randomUUID();
  const [no] = await nextNumbers(c, p.tenantId, 'asset_request');
  await c.query(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, asset_id, requester_id, submitted_at, reason, changes, recon_diff_id,
      created_by, updated_by) VALUES ($1, $2, $3, 'CHANGE', 'ACCT_APPROVED', 'RECONCILIATION', $4, $5, now(), $6, $7, $8, $5, $5)`,
  [id, p.tenantId, no, d.asset_id, p.userId, `IF-RC-01 대사 차이(${d.diff_type}) ALM 값 전송`, JSON.stringify(fields), d.id]);
  const pid = randomUUID();
  await c.query(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, company_id, asset_request_id, asset_id, posting_date, payload, approved_by, approved_at, created_by)
    VALUES ($1, $2, $3, 'ASSET_CHANGE', $4, $5, $6, current_date, $7, $8, now(), $8)`,
  [pid, p.tenantId, no, a.company_id, id, d.asset_id, JSON.stringify({ fields }), p.userId]);
  await c.query('UPDATE recon_diff SET sap_posting_id = $2 WHERE id = $1', [d.id, pid]);
  return id;
}

// ---------------- 필드 매핑·연결 ----------------
export async function listFieldMappings(c: PoolClient) {
  return { items: (await c.query('SELECT * FROM field_mapping ORDER BY master_system, alm_field')).rows.map((r) => clean({ id: r.id, almField: r.alm_field,
    sapTable: r.sap_table ?? undefined, sapField: r.sap_field ?? undefined, masterSystem: r.master_system, interfaceIds: r.interface_ids ?? undefined,
    description: r.description ?? undefined })) };
}

export async function patchFieldMapping(c: PoolClient, p: Principal, id: string, body: unknown) {
  if (!uuidOk(id)) throw E.notFound('필드 매핑을 찾을 수 없습니다');
  const k = new Check(body);
  const description = k.str(k.obj(), 'description', { max: 200 });
  k.done();
  const r = (await c.query(`UPDATE field_mapping SET description = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1 RETURNING *`,
    [id, description ?? null, p.userId])).rows[0];
  if (!r) throw E.notFound('필드 매핑을 찾을 수 없습니다');
  return clean({ id: r.id, almField: r.alm_field, sapTable: r.sap_table ?? undefined, sapField: r.sap_field ?? undefined, masterSystem: r.master_system,
    interfaceIds: r.interface_ids ?? undefined, description: r.description ?? undefined });
}

export async function listConnections(c: PoolClient) {
  return { items: (await c.query(`SELECT sc.*, co.company_code, co.sap_enabled FROM sap_connection sc JOIN company co ON co.id = sc.company_id ORDER BY sc.system_id, co.company_code`))
    .rows.map((r) => clean({ id: r.id, systemId: r.system_id, companyCode: r.company_code, oauthClientId: r.oauth_client_id, lastCallAt: iso(r.last_call_at),
      isActive: r.is_active, companySapEnabled: r.sap_enabled, allowedCidrs: Array.isArray(r.allowed_cidrs) ? r.allowed_cidrs : [] })) };
}
