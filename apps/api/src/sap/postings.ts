// ALM → SAP 전기(IF-AA-03~07, IF-MM-02)와 수동 실행 요청(IF-OP-01). 08 4.2·6장, openapi sapClaimPostings·sapPostResult·sapGetRunRequests. WBS 4.7
//
// claim  : READY 또는 잠금이 지난 CLAIMED 건을 postingId 순으로 잡아 CLAIMED·15분 잠금·attempt+1.
//          시도가 5회를 채운 건은 내주지 않고 FAILED(ALM-E306) + 자산회계 메일. 월말 마감 기간(sap.posting_blackout)이면 빈 목록.
// result : POSTED면 결과(자산번호·전표·PO번호)를 자산·요청에 반영하고 asset_event(SAP_POSTED).
//          FAILED면 요청을 POST_ERROR(구매요청은 PO_ERROR)로, BAPI 메시지를 저장하고 자산회계 메일.
//          이미 결과가 있으면 같은 결과는 200(최초 결과), 다른 결과는 409 ALM-E302. 단, E306으로 FAILED가 된 건의 POSTED는 받는다(SAP 기준).
//          잠금이 지난 뒤 온 결과도 받는다(SAP은 BKTXT·INVNR·IHREZ로 중복 전기를 막는다).
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError } from '../common/errors';
import type { SapConn } from '../auth/sap';
import type { MailRequest } from '../notify/mail';
import { Batch, logRun } from './inbound';

export const LEASE_SECONDS = 900;
export const MAX_ATTEMPTS = 5;
export const POSTING_TYPES = ['ASSET_CREATE', 'ASSET_CHANGE', 'ASSET_TRANSFER', 'ASSET_RETIRE', 'COUNT_RESULT', 'PO_CREATE'] as const;
export type PostingType = (typeof POSTING_TYPES)[number];
export const IF_OF: Record<PostingType, string> = {
  ASSET_CREATE: 'IF-AA-03', ASSET_CHANGE: 'IF-AA-04', ASSET_TRANSFER: 'IF-AA-05', ASSET_RETIRE: 'IF-AA-06', COUNT_RESULT: 'IF-AA-07', PO_CREATE: 'IF-MM-02',
};
const E306 = { type: 'E', id: 'ALM', number: '306', text: `SAP 전기 시도 ${MAX_ATTEMPTS}회 초과(결과 회신 없음)` };

// 커밋 뒤 보낼 메일(호출한 쪽이 Mailer로 큐에 넣는다)
export type Mail = MailRequest;

const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);

async function blackout(c: PoolClient): Promise<boolean> {
  const v = (await c.query(`SELECT value FROM setting WHERE key = 'sap.posting_blackout'`)).rows[0]?.value as { from?: string; to?: string } | undefined;
  if (!v?.from || !v.to) return false;
  const now = Date.now();
  return Date.parse(v.from) <= now && now < Date.parse(v.to);
}

// 지금 유효한 역할을 가진 활성 사용자(회사·사이트 범위 무시: 알림은 넓게)
export async function usersWithRole(c: PoolClient, role: string): Promise<string[]> {
  return (await c.query(`SELECT DISTINCT u.id FROM user_role r JOIN app_user u ON u.id = r.user_id
     WHERE r.role = $1 AND u.is_active AND (r.valid_from IS NULL OR r.valid_from <= current_date)
       AND (r.valid_until IS NULL OR r.valid_until >= current_date)`, [role])).rows.map((r) => r.id as string);
}

async function accountantMails(c: PoolClient, postingId: string, attempt: number, message: string): Promise<Mail[]> {
  const users = (await usersWithRole(c, 'ASSET_ACCOUNTANT')).map((id) => ({ id }));
  return users.map((u) => ({ recipientId: u.id as string, template: 'SAP_POSTING_FAILED', params: { reference: postingId, message: message.slice(0, 300),
    path: `/integration/sap/postings?postingId=${encodeURIComponent(postingId)}` }, subjectType: 'SAP_POSTING', dedupeKey: `SAP_POSTING_FAILED:${postingId}:${attempt}:${u.id}`.slice(0, 120) }));
}

// ---------------- claim ----------------
export async function claimPostings(c: PoolClient, conn: SapConn, body: unknown): Promise<{ status: number; body: unknown; mails: Mail[] }> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const batchId = typeof b.batchId === 'string' ? b.batchId.trim() : '';
  if (!batchId) throw new AlmError(400, 'ALM-E101', '입력 값을 확인하세요: batchId 필수');
  if (batchId.length > 40) throw new AlmError(400, 'ALM-E100', '입력 값을 확인하세요: batchId 최대 40자');
  const max = b.maxItems === undefined ? 50 : b.maxItems;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 200) throw new AlmError(400, 'ALM-E100', 'maxItems는 1~200');
  let types: string[] = [...POSTING_TYPES];
  if (b.types !== undefined) {
    if (!Array.isArray(b.types) || b.types.some((t) => !POSTING_TYPES.includes(t))) throw new AlmError(400, 'ALM-E100', `types는 ${POSTING_TYPES.join(', ')}`);
    if (b.types.length) types = b.types as string[];
  }
  const mails: Mail[] = [];
  const out = { batchId, leaseSeconds: LEASE_SECONDS, items: [] as unknown[] };

  // 연결 갱신(잡이 도는지 화면에서 보는 기준)
  await c.query('UPDATE sap_connection SET last_call_at = now() WHERE id = $1', [conn.connectionId]);
  if (await blackout(c)) return { status: 200, body: out, mails };

  // 시도 초과 → FAILED(ALM-E306). 다른 잡이 잡고 있는 행은 건너뛴다
  const exhausted = (await c.query(
    `UPDATE sap_posting p SET status = 'FAILED', result_at = now(), lease_until = NULL, messages = $3, updated_at = now(), version = p.version + 1
      WHERE p.id IN (SELECT id FROM sap_posting WHERE company_id = $1 AND attempt_count >= $2
                       AND (status = 'READY' OR (status = 'CLAIMED' AND lease_until < now())) FOR UPDATE SKIP LOCKED)
      RETURNING p.posting_id, p.posting_type, p.asset_request_id, p.purchase_request_id, p.attempt_count`,
    [conn.companyId, MAX_ATTEMPTS, JSON.stringify([E306])])).rows;
  for (const p of exhausted) {
    await requestFailed(c, p);
    mails.push(...await accountantMails(c, p.posting_id, p.attempt_count, E306.text));
  }

  const rows = (await c.query(
    `UPDATE sap_posting p SET status = 'CLAIMED', claim_batch_id = $4, claimed_at = now(), lease_until = now() + make_interval(secs => $5),
         attempt_count = p.attempt_count + 1, updated_at = now(), version = p.version + 1
      WHERE p.id IN (SELECT id FROM sap_posting WHERE company_id = $1 AND posting_type::text = ANY($2) AND attempt_count < $6
                       AND (status = 'READY' OR (status = 'CLAIMED' AND lease_until < now()))
                     ORDER BY posting_id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING p.id`,
    [conn.companyId, types, max, batchId, LEASE_SECONDS, MAX_ATTEMPTS])).rows;
  if (rows.length) {
    const env = (await c.query(
      `SELECT p.posting_id, p.posting_type, p.posting_date, p.value_date, p.payload, p.approved_at, p.attempt_count, p.lease_until,
              a.sap_asset_no, a.sap_sub_no, a.asset_tag, u.email AS approved_by
         FROM sap_posting p LEFT JOIN asset a ON a.id = p.asset_id LEFT JOIN app_user u ON u.id = p.approved_by
        WHERE p.id = ANY($1) ORDER BY p.posting_id`, [rows.map((r) => r.id)])).rows;
    out.items = env.map((p) => ({
      postingId: p.posting_id, type: p.posting_type, companyCode: conn.companyCode,
      postingDate: day(p.posting_date) ?? new Date().toISOString().slice(0, 10),
      ...(p.value_date ? { valueDate: day(p.value_date) } : {}),
      ...(p.posting_type !== 'PO_CREATE' && (p.asset_tag || p.sap_asset_no)
        ? { asset: { ...(p.sap_asset_no ? { assetNo: p.sap_asset_no, subNo: p.sap_sub_no } : {}), ...(p.asset_tag ? { inventoryNo: p.asset_tag } : {}) } } : {}),
      payload: p.payload, approvedBy: p.approved_by ?? '', approvedAt: p.approved_at ? new Date(p.approved_at).toISOString() : '',
      attempt: p.attempt_count, leaseUntil: new Date(p.lease_until).toISOString(),
    }));
  }
  return { status: 200, body: out, mails };
}

// 요청을 전기 오류로(자산 요청 POST_ERROR, 구매요청 PO_ERROR)
async function requestFailed(c: PoolClient, p: { asset_request_id?: string | null; purchase_request_id?: string | null }) {
  if (p.asset_request_id) await c.query(`UPDATE asset_request SET status = 'POST_ERROR', updated_at = now(), version = version + 1 WHERE id = $1 AND status <> 'CANCELLED'`, [p.asset_request_id]);
  if (p.purchase_request_id) await c.query(`UPDATE purchase_request SET status = 'PO_ERROR', updated_at = now(), version = version + 1 WHERE id = $1 AND status <> 'CANCELLED'`, [p.purchase_request_id]);
}

// ---------------- result ----------------
interface Msg { type: string; id: string; number: string; text: string }
interface ResultIn { status: 'POSTED' | 'FAILED'; belnr?: string; gjahr?: number; assetNo?: string; subNo?: string; poNo?: string; messages: Msg[] }

function readResult(postingId: string, body: unknown): ResultIn {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const bad = (m: string, code = 'ALM-E100'): never => { throw new AlmError(400, code, `입력 값을 확인하세요: ${m}`); };
  if (b.postingId !== postingId) bad('postingId가 경로와 다릅니다');
  if (b.status !== 'POSTED' && b.status !== 'FAILED') bad('status는 POSTED 또는 FAILED');
  const s = (o: unknown, k: string, max: number, re?: RegExp): string | undefined => {
    const v = (o as Record<string, unknown> | undefined)?.[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.trim().length > max || (re && !re.test(v.trim()))) bad(`${k} 형식`);
    return (v as string).trim() || undefined;
  };
  const r: ResultIn = { status: b.status as ResultIn['status'], messages: [] };
  if (b.sapDocument !== undefined) {
    r.belnr = s(b.sapDocument, 'belnr', 10);
    const g = s(b.sapDocument, 'gjahr', 4, /^\d{4}$/);
    if (!r.belnr || !g) bad('sapDocument는 belnr·gjahr 필수');
    r.gjahr = Number(g);
  }
  if (b.asset !== undefined) { r.assetNo = s(b.asset, 'assetNo', 12); r.subNo = s(b.asset, 'subNo', 4); }
  r.poNo = s(b, 'poNo', 10);
  if (b.messages !== undefined) {
    if (!Array.isArray(b.messages) || b.messages.length > 100) bad('messages는 100건 이하 배열');
    r.messages = (b.messages as unknown[]).map((m) => {
      const t = s(m, 'type', 1, /^[SIWEA]$/);
      if (!t) bad('messages[].type 필수(S·I·W·E·A)');
      return { type: t!, id: s(m, 'id', 20) ?? '', number: s(m, 'number', 3) ?? '', text: s(m, 'text', 220) ?? '' };
    });
  }
  if (r.status === 'FAILED' && !r.messages.some((m) => m.type === 'E' || m.type === 'A')) bad('FAILED면 E·A 메시지가 필요합니다', 'ALM-E101');
  return r;
}

const sameResult = (p: Record<string, unknown>, r: ResultIn) => p.status === r.status && (r.status === 'FAILED' ||
  ((p.sap_document_no ?? undefined) === r.belnr && (p.sap_fiscal_year ?? undefined) === r.gjahr && (p.sap_po_no ?? undefined) === r.poNo
    && (!r.assetNo || ((p.sap_asset_no ?? undefined) === r.assetNo && (p.sap_sub_no ?? undefined) === (r.subNo ?? '0000')))));

export async function postResult(c: PoolClient, conn: SapConn, postingId: string, body: unknown, correlationId?: string)
  : Promise<{ status: number; body: unknown; mails: Mail[] }> {
  if (!postingId || postingId.length > 12) throw new AlmError(400, 'ALM-E100', 'postingId는 12자 이하');
  const r = readResult(postingId, body);
  const startedAt = new Date();
  const p = (await c.query(`SELECT * FROM sap_posting WHERE posting_id = $1 FOR UPDATE`, [postingId])).rows[0];
  if (!p || p.company_id !== conn.companyId) throw new AlmError(404, 'ALM-E404', `전기 ${postingId}이(가) 없습니다`);
  const type = p.posting_type as PostingType;
  const ack = async (status: string) => ({ postingId, status, requestStatus: await requestStatus(c, p, status) });

  const exhausted = p.status === 'FAILED' && Array.isArray(p.messages) && p.messages.some((m: Msg) => m.id === 'ALM' && m.number === '306');
  if (p.status === 'POSTED' || (p.status === 'FAILED' && !(exhausted && r.status === 'POSTED'))) {
    if (sameResult(p, r)) return { status: 200, body: await ack(p.status), mails: [] };
    throw new AlmError(409, 'ALM-E302', `전기 ${postingId}에는 이미 다른 결과(${p.status})가 있습니다`);
  }
  if (p.status === 'CANCELLED') throw new AlmError(409, 'ALM-E302', `전기 ${postingId}은(는) ALM에서 취소되었습니다(SAP 쪽 확인 필요)`);

  // 유형별 필수 결과
  if (r.status === 'POSTED') {
    if (type === 'ASSET_CREATE' && !r.assetNo) throw new AlmError(400, 'ALM-E101', '입력 값을 확인하세요: ASSET_CREATE는 asset.assetNo 필수');
    if ((type === 'ASSET_RETIRE' || type === 'ASSET_TRANSFER') && !r.belnr) throw new AlmError(400, 'ALM-E101', `입력 값을 확인하세요: ${type}는 sapDocument 필수`);
    if (type === 'PO_CREATE' && !r.poNo) throw new AlmError(400, 'ALM-E101', '입력 값을 확인하세요: PO_CREATE는 poNo 필수');
  }
  const subNo = r.assetNo ? (r.subNo ?? '0000') : null;
  await c.query(`UPDATE sap_posting SET status = $2, result_at = now(), lease_until = NULL, sap_document_no = $3, sap_fiscal_year = $4,
      sap_asset_no = $5, sap_sub_no = $6, sap_po_no = $7, messages = $8, updated_at = now(), version = version + 1 WHERE id = $1`,
    [p.id, r.status, r.belnr ?? null, r.gjahr ?? null, r.assetNo ?? null, subNo, r.poNo ?? null, r.messages.length ? JSON.stringify(r.messages) : null]);

  const mails: Mail[] = [];
  const batch = new Batch(postingId, 1);
  if (r.status === 'POSTED') {
    await applyPosted(c, conn, p, r, subNo);
    batch.okay(postingId);
  } else {
    await requestFailed(c, p);
    const first = r.messages.find((m) => m.type === 'E' || m.type === 'A')!;
    const text = `${first.id} ${first.number}: ${first.text}`.trim();
    batch.fail(postingId, `SAP-${first.id}${first.number}`.slice(0, 12), text, { messages: r.messages });
    mails.push(...await accountantMails(c, postingId, p.attempt_count, text));
  }
  await logRun(c, conn, { interfaceId: IF_OF[type], batchId: postingId, correlationId, startedAt, batch, direction: 'ALM_TO_SAP', httpStatus: 200 });
  return { status: 200, body: await ack(r.status), mails };
}

async function applyPosted(c: PoolClient, conn: SapConn, p: Record<string, any>, r: ResultIn, subNo: string | null) {
  const type = p.posting_type as PostingType;
  if (p.asset_request_id) {
    await c.query(`UPDATE asset_request SET status = 'POSTED', completed_at = now(), updated_at = now(), version = version + 1
      WHERE id = $1 AND status <> 'CANCELLED'`, [p.asset_request_id]);
  }
  if (type === 'PO_CREATE') {
    if (p.purchase_request_id) {
      await c.query(`UPDATE purchase_request SET status = 'PO_CREATED', sap_po_no = $2, updated_at = now(), version = version + 1
        WHERE id = $1 AND status <> 'CANCELLED'`, [p.purchase_request_id, r.poNo]);
    }
    return;
  }
  if (!p.asset_id) return;
  const changes: Record<string, unknown> = { postingId: p.posting_id, type };
  if ((type === 'ASSET_CREATE' || type === 'ASSET_TRANSFER') && r.assetNo) {
    // 같은 회사코드·자산번호가 다른 ALM 자산에 이미 있으면(SAP 수신이 먼저 만든 경우 등) 409로 사람이 확인
    const dup = (await c.query('SELECT asset_tag FROM asset WHERE company_id = $1 AND sap_asset_no = $2 AND sap_sub_no = $3 AND id <> $4',
      [conn.companyId, r.assetNo, subNo, p.asset_id])).rows[0];
    if (dup) throw new AlmError(409, 'ALM-E302', `SAP 자산 ${r.assetNo}/${subNo}이(가) 이미 다른 ALM 자산(${dup.asset_tag})에 연결되어 있습니다`);
    await c.query(`UPDATE asset SET sap_asset_no = $2, sap_sub_no = $3, sap_synced_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`,
      [p.asset_id, r.assetNo, subNo]);
    changes.sapAsset = `${conn.companyCode}/${r.assetNo}/${subNo}`;
  }
  if (type === 'COUNT_RESULT') {
    const pl = (p.payload ?? {}) as Record<string, unknown>;
    const d = typeof pl.lastCountDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pl.lastCountDate) ? pl.lastCountDate : null;
    const note = typeof pl.inventoryNote === 'string' ? pl.inventoryNote.slice(0, 15) : null;
    await c.query(`UPDATE asset SET last_count_date = coalesce($2, last_count_date), last_count_note = coalesce($3, last_count_note),
      updated_at = now(), version = version + 1 WHERE id = $1`, [p.asset_id, d, note]);
    Object.assign(changes, { lastCountDate: d, inventoryNote: note });
  }
  const campaign = p.count_item_id ? (await c.query('SELECT campaign_id FROM count_item WHERE id = $1', [p.count_item_id])).rows[0]?.campaign_id ?? null : null;
  await event(c, conn, p.asset_id, 'SAP_POSTED', changes, p.asset_request_id, campaign, r);
  if (type === 'ASSET_RETIRE') {
    const cur = (await c.query('SELECT status FROM asset WHERE id = $1', [p.asset_id])).rows[0];
    if (cur && !['RETIRED', 'DISPOSED'].includes(cur.status)) {
      await c.query(`UPDATE asset SET status = 'RETIRED', updated_at = now(), version = version + 1 WHERE id = $1`, [p.asset_id]);
      await event(c, conn, p.asset_id, 'RETIRED', { postingId: p.posting_id, before: cur.status }, p.asset_request_id, null, r);
    }
  }
}

async function event(c: PoolClient, conn: SapConn, assetId: string, type: string, changes: unknown, requestId: string | null, campaignId: string | null, r: ResultIn) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, changes, asset_request_id, count_campaign_id, sap_document_no, sap_fiscal_year)
    VALUES ($1, $2, $3, $4, 'SAP', $5, $6, $7, $8, $9)`,
    [randomUUID(), conn.tenantId, assetId, type, JSON.stringify(changes), requestId, campaignId, r.belnr ?? null, r.gjahr ?? null]);
}

async function requestStatus(c: PoolClient, p: Record<string, any>, fallback: string): Promise<string> {
  if (p.asset_request_id) return (await c.query('SELECT status FROM asset_request WHERE id = $1', [p.asset_request_id])).rows[0]?.status ?? fallback;
  if (p.purchase_request_id) return (await c.query('SELECT status FROM purchase_request WHERE id = $1', [p.purchase_request_id])).rows[0]?.status ?? fallback;
  return fallback;
}

// ---------------- IF-OP-01 ----------------
export async function pickRunRequests(c: PoolClient, conn: SapConn) {
  const rows = (await c.query(
    `UPDATE sap_run_request r SET status = 'PICKED', picked_at = now(), updated_at = now(), version = r.version + 1
      WHERE r.id IN (SELECT id FROM sap_run_request WHERE status = 'PENDING'
                       AND (params->>'companyCode' IS NULL OR params->>'companyCode' = $1)
                     ORDER BY requested_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.interface_id, r.params, r.status, r.requested_at, r.picked_at`, [conn.companyCode])).rows;
  rows.sort((a, b) => +new Date(a.requested_at) - +new Date(b.requested_at));
  return { items: rows.map((r) => {
    const p = (r.params ?? {}) as Record<string, unknown>;
    return { id: r.id, interfaceId: r.interface_id, ...(p.runType ? { runType: p.runType } : {}), ...(p.campaignCode ? { campaignCode: p.campaignCode } : {}),
      ...(p.isClosing === true ? { isClosing: true } : {}), status: r.status, requestedAt: new Date(r.requested_at).toISOString(),
      pickedAt: new Date(r.picked_at).toISOString() };
  }) };
}
