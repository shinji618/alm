// PDA 실사 업무 API(openapi PDA-02~08, WBS 4.8). 권한 count.scan(COUNTER, 범위 TASK = 내게 배정된 룸 작업)
//   작업목록은 내 룸의 count_item만. since(syncToken)로 델타, 7일 넘은 토큰은 410 ALM-E309(전체 다시 받기)
//   스캔은 서버가 다시 판정한다(FOUND·MISPLACED·OUT_OF_SCOPE·UNREGISTERED·DUPLICATE·RETIRED_ASSET). 기기 판정은 참고값
//   clientScanId로 멱등(같은 값이 다시 오면 최초 결과를 DUPLICATE로 돌려준다). 건별 SAVEPOINT — 한 건 실패가 다른 건을 막지 않는다
//   REVIEW 단계라도 재실사(RECOUNT)로 PENDING이 된 대상은 스캔을 받는다
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../auth/principal';
import { defaultTemplateId } from '../labels/labels';
import { assetScope, can, Params } from '../auth/scope';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const TOKEN_DAYS = 7;
const SCAN_RESULTS = ['FOUND', 'MISPLACED', 'OUT_OF_SCOPE', 'UNREGISTERED', 'DUPLICATE', 'RETIRED_ASSET'] as const;
const CONDITIONS = ['GOOD', 'DAMAGED', 'UNUSED'] as const;
const scope = (m = '배정된 실사 작업이 아닙니다') => new AlmError(403, 'ALM-E203', m);
const notCounting = (m = '실사 중(COUNTING)인 캠페인이 아닙니다') => new AlmError(409, 'ALM-E204', m);

function dt(k: Check, o: Record<string, unknown>, key: string, field = key, required = true) {
  const v = k.str(o, key, { required, field, pattern: DATETIME });
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined;
}

// ---------------- 동기화 토큰·커서 ----------------
// syncToken = base64url({ c: 캠페인, k: 종류, t: 조회 시작 시각 }). 다음 호출의 since
function token(campaignId: string, kind: 'W' | 'T', at: Date) {
  return Buffer.from(JSON.stringify({ c: campaignId, k: kind, t: at.toISOString() })).toString('base64url');
}
function since(raw: string | undefined, campaignId: string, kind: 'W' | 'T', now: Date): Date | undefined {
  if (!raw) return undefined;
  let t: Date | undefined;
  try {
    const j = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (j?.c === campaignId && j?.k === kind && typeof j.t === 'string') t = new Date(j.t);
  } catch { /* 아래에서 400 */ }
  if (!t || Number.isNaN(t.getTime())) throw E.badRequest('since(syncToken)가 올바르지 않습니다');
  if (now.getTime() - t.getTime() > TOKEN_DAYS * 86400_000) throw new AlmError(410, 'ALM-E309', '동기화 토큰이 만료됐습니다. 전체를 다시 받으세요');
  return t;
}
const cursorOf = (v: string) => Buffer.from(v).toString('base64url');
const fromCursor = (raw?: string) => { if (!raw) return undefined; const v = Buffer.from(raw, 'base64url').toString('utf8'); return v || undefined; };
function limitOf(raw: string | undefined, def: number, max: number) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw E.badRequest(`limit는 1~${max}입니다`);
  return n;
}

async function myCampaign(c: PoolClient, p: Principal, campaignId: string) {
  if (!isUuid(campaignId)) throw E.notFound('캠페인을 찾을 수 없습니다');
  const r = (await c.query(`SELECT cc.id, cc.status, cc.company_id, cc.scope FROM count_campaign cc WHERE cc.id = $1`, [campaignId])).rows[0];
  if (!r) throw E.notFound('캠페인을 찾을 수 없습니다');
  // 배정된 룸이 있거나, 이 캠페인에서 스캔한 적이 있으면(룸 담당이 바뀌어 델타로 removed를 받아야 하는 기기)
  const mine = (await c.query(`SELECT 1 FROM count_task WHERE campaign_id = $1 AND assignee_id = $2
    UNION ALL SELECT 1 FROM count_scan WHERE campaign_id = $1 AND scanned_by = $2 LIMIT 1`, [campaignId, p.userId])).rowCount;
  if (!mine) throw scope('이 캠페인에 배정된 룸이 없습니다');
  return r as { id: string; status: string; company_id: string; scope: { siteIds?: string[] } };
}

// ---------------- 작업 ----------------
const TASK_SQL = `SELECT t.id, t.campaign_id, cc.campaign_code, cc.name AS campaign_name, cc.key_date, cc.due_date, cc.status AS campaign_status,
    t.room_id, r.room_code, r.name AS room_name, s.site_code, t.status, t.expected_count, t.updated_at,
    (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id AND ci.result = 'FOUND')::int AS found,
    (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id AND ci.result = 'PENDING')::int AS pending
  FROM count_task t JOIN count_campaign cc ON cc.id = t.campaign_id JOIN room r ON r.id = t.room_id JOIN site s ON s.id = r.site_id`;

function taskOut(x: Record<string, any>) {
  return { taskId: x.id, campaignId: x.campaign_id, campaignCode: x.campaign_code, campaignName: x.campaign_name, keyDate: day(x.key_date), dueDate: day(x.due_date),
    roomId: x.room_id, roomCode: x.room_code, roomName: x.room_name, siteCode: x.site_code, status: x.status, expectedCount: x.expected_count,
    foundCount: x.found, pendingCount: x.pending, updatedAt: iso(x.updated_at) };
}

// 실사 중인 캠페인의 내 작업 + 차이 검토 중 재실사(PENDING)가 남은 작업
export async function pdaListTasks(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  const st = q.status;
  if (st && !['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'].includes(st)) throw E.badRequest('status가 올바르지 않습니다');
  const rows = (await c.query(`${TASK_SQL} WHERE t.assignee_id = $1 AND ($2::text IS NULL OR t.status::text = $2)
      AND (cc.status = 'COUNTING' OR (cc.status = 'REVIEW' AND EXISTS (SELECT 1 FROM count_item ci WHERE ci.task_id = t.id AND ci.result = 'PENDING')))
    ORDER BY cc.due_date, r.room_code`, [p.userId, st ?? null])).rows;
  return { items: rows.map(taskOut) };
}

export async function pdaUpdateTask(c: PoolClient, p: Principal, taskId: string, body: unknown) {
  const k = new Check(body), o = k.obj();
  const action = k.oneOf(o, 'action', ['START', 'COMPLETE'] as const);
  if (o.action === undefined) k.errors.push({ field: 'action', code: 'ALM-E101', message: '필수 값입니다' });
  const at = dt(k, o, 'at');
  const force = k.bool(o, 'force') ?? false;
  k.done();
  if (!isUuid(taskId)) throw E.notFound('작업을 찾을 수 없습니다');
  const t = (await c.query(`SELECT t.*, cc.status AS campaign_status FROM count_task t JOIN count_campaign cc ON cc.id = t.campaign_id WHERE t.id = $1 FOR UPDATE OF t`, [taskId])).rows[0];
  if (!t) throw E.notFound('작업을 찾을 수 없습니다');
  if (t.assignee_id !== p.userId) throw scope();
  if (t.campaign_status !== 'COUNTING' && t.campaign_status !== 'REVIEW') throw notCounting();
  if (action === 'START') {
    if (t.status !== 'IN_PROGRESS') await c.query(`UPDATE count_task SET status = 'IN_PROGRESS', started_at = coalesce(started_at, $2), completed_at = NULL,
        updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [taskId, at, p.userId]);
  } else {
    const pending = (await c.query(`SELECT count(*)::int AS n FROM count_item WHERE task_id = $1 AND result = 'PENDING'`, [taskId])).rows[0].n as number;
    if (pending > 0 && !force) throw new AlmError(409, 'ALM-E305', `미확인 자산 ${pending}건이 남았습니다`, { pendingCount: pending });
    await c.query(`UPDATE count_task SET status = 'COMPLETED', started_at = coalesce(started_at, $2), completed_at = $2,
        updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [taskId, at, p.userId]);
  }
  return taskOut((await c.query(`${TASK_SQL} WHERE t.id = $1`, [taskId])).rows[0]);
}

// ---------------- 작업목록·색인·룸·코드 ----------------
export async function pdaGetWorklist(c: PoolClient, p: Principal, campaignId: string, q: Record<string, string | undefined>, now = new Date()) {
  await myCampaign(c, p, campaignId);
  const from = since(q.since, campaignId, 'W', now);
  const limit = limitOf(q.limit, 2000, 5000);
  const after = fromCursor(q.cursor);
  if (after !== undefined && !isUuid(after)) throw E.badRequest('cursor가 올바르지 않습니다');
  const rows = (await c.query(`SELECT ci.id, ci.asset_id, a.asset_tag, a.description, cat.name AS category_name,
        CASE WHEN m.id IS NULL THEN NULL ELSE m.manufacturer || ' ' || m.model_name END AS model, a.serial_no, a.status AS asset_status,
        ci.expected_room_id, er.room_code AS expected_room_code, u.display_name AS user_name, ci.result, ci.counted_at,
        greatest(ci.updated_at, a.updated_at, t.updated_at) AS updated_at
      FROM count_item ci JOIN count_task t ON t.id = ci.task_id JOIN asset a ON a.id = ci.asset_id JOIN category cat ON cat.id = a.category_id
      LEFT JOIN model m ON m.id = a.model_id JOIN room er ON er.id = ci.expected_room_id LEFT JOIN app_user u ON u.id = a.assigned_user_id
     WHERE ci.campaign_id = $1 AND t.assignee_id = $2 AND ($3::uuid IS NULL OR ci.id > $3)
       AND ($4::timestamptz IS NULL OR ci.updated_at > $4 OR a.updated_at > $4 OR t.updated_at > $4)
     ORDER BY ci.id LIMIT $5`, [campaignId, p.userId, after ?? null, from ?? null, limit + 1])).rows;
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  // 델타: 내 룸에서 빠진 대상(룸 담당이 바뀐 경우). 첫 페이지에서만. 그 사이 바뀐 남의 룸 대상도 섞일 수 있다(기기는 모르는 id를 무시)
  const removed = from && !after ? (await c.query(`SELECT ci.id FROM count_item ci JOIN count_task t ON t.id = ci.task_id
      WHERE ci.campaign_id = $1 AND t.updated_at > $2 AND t.assignee_id IS DISTINCT FROM $3 ORDER BY ci.id`, [campaignId, from, p.userId])).rows.map((x) => x.id as string) : [];
  return clean({ campaignId, items: page.map((x) => clean({ countItemId: x.id, assetId: x.asset_id, assetTag: x.asset_tag, description: x.description,
      categoryName: x.category_name, model: x.model ?? undefined, serialNo: x.serial_no ?? undefined, assetStatus: x.asset_status, expectedRoomId: x.expected_room_id,
      expectedRoomCode: x.expected_room_code, assignedUserName: x.user_name ?? undefined, result: x.result, countedAt: iso(x.counted_at), updatedAt: iso(x.updated_at) })),
    removed, nextCursor: more ? cursorOf(page[page.length - 1].id) : undefined, syncToken: token(campaignId, 'W', now) });
}

// 범위 밖 태그: 같은 회사의 다른 자산(이 캠페인 대상이 아닌 것). 오프라인에서 OUT_OF_SCOPE·RETIRED_ASSET 판정용
export async function pdaGetTagIndex(c: PoolClient, p: Principal, campaignId: string, q: Record<string, string | undefined>, now = new Date()) {
  const cp = await myCampaign(c, p, campaignId);
  const from = since(q.since, campaignId, 'T', now);
  const limit = 5000;
  const after = fromCursor(q.cursor);
  const rows = (await c.query(`SELECT a.asset_tag, a.status, s.site_code FROM asset a LEFT JOIN site s ON s.id = a.site_id
     WHERE a.company_id = $1 AND NOT EXISTS (SELECT 1 FROM count_item ci WHERE ci.campaign_id = $2 AND ci.asset_id = a.id)
       AND ($3::text IS NULL OR a.asset_tag > $3) AND ($4::timestamptz IS NULL OR a.updated_at > $4)
     ORDER BY a.asset_tag LIMIT $5`, [cp.company_id, campaignId, after ?? null, from ?? null, limit + 1])).rows;
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return clean({ items: page.map((x) => clean({ assetTag: x.asset_tag, assetStatus: x.status, siteCode: x.site_code ?? undefined })),
    nextCursor: more ? cursorOf(page[page.length - 1].asset_tag) : undefined, syncToken: token(campaignId, 'T', now) });
}

export async function pdaListRooms(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  if (!q.campaignId) throw E.required('campaignId');
  const cp = await myCampaign(c, p, q.campaignId);
  const sites = Array.isArray(cp.scope?.siteIds) ? cp.scope.siteIds.filter(isUuid) : [];
  const rows = (await c.query(`SELECT r.id, r.room_code, r.name, r.floor, s.site_code, r.barcode FROM room r JOIN site s ON s.id = r.site_id
     WHERE r.is_active AND r.site_id = ANY($1::uuid[]) ORDER BY s.site_code, r.room_code`, [sites])).rows;
  return { items: rows.map((x) => clean({ roomId: x.id, roomCode: x.room_code, name: x.name, floor: x.floor ?? undefined, siteCode: x.site_code, barcode: x.barcode })) };
}

const CONDITION_LABEL: Record<string, Record<(typeof CONDITIONS)[number], string>> = {
  ko: { GOOD: '정상', DAMAGED: '파손', UNUSED: '미사용' },
  en: { GOOD: 'Good', DAMAGED: 'Damaged', UNUSED: 'Unused' },
};
export async function pdaGetCodes(c: PoolClient, p: Principal) {
  const rows = (await c.query('SELECT id, name FROM category WHERE is_active ORDER BY name')).rows;
  const lab = CONDITION_LABEL[(p.locale ?? 'en').slice(0, 2)] ?? CONDITION_LABEL.en;
  return { categories: rows.map((x) => ({ id: x.id, label: x.name })), conditions: CONDITIONS.map((id) => ({ id, label: lab[id] })) };
}

// ---------------- 스캔 ----------------
interface ScanIn { clientScanId: string; campaignId: string; taskId: string; roomId: string; barcode: string; inputMethod: string;
  condition?: (typeof CONDITIONS)[number]; isUserConfirmed?: boolean; needsRelabel?: boolean; note?: string; attachmentIds: string[]; scannedAt: Date }
type Outcome = { clientScanId: string; status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED'; serverResult?: string; countItemId?: string; assetId?: string; code?: string; message?: string };

export async function pdaPostScans(c: PoolClient, p: Principal, deviceId: string | undefined, body: unknown) {
  const k = new Check(body), o = k.obj();
  const bodyDevice = k.uuid(o, 'deviceId', { required: true });
  const list = k.arr(o, 'scans', { required: true, max: 200 });
  const scans: ScanIn[] = list.map((x, i) => {
    const f = (n: string) => `scans[${i}].${n}`;
    const s = k.obj(x, `scans[${i}]`);
    const ids = Array.isArray(s.attachmentIds) ? s.attachmentIds : s.attachmentIds === undefined ? [] : (k.fail(f('attachmentIds'), '배열이어야 합니다'), []);
    if (ids.length > 5 || ids.some((v) => !isUuid(v))) k.fail(f('attachmentIds'), '사진 id(uuid) 최대 5개');
    k.oneOf(s, 'deviceResult', SCAN_RESULTS, f('deviceResult'));
    return { clientScanId: k.uuid(s, 'clientScanId', { required: true, field: f('clientScanId') })!, campaignId: k.uuid(s, 'campaignId', { required: true, field: f('campaignId') })!,
      taskId: k.uuid(s, 'taskId', { required: true, field: f('taskId') })!, roomId: k.uuid(s, 'roomId', { required: true, field: f('roomId') })!,
      barcode: k.str(s, 'barcode', { required: true, max: 40, field: f('barcode') })!,
      inputMethod: k.oneOf(s, 'inputMethod', ['TRIGGER', 'CAMERA', 'MANUAL'] as const, f('inputMethod'))
        ?? (s.inputMethod === undefined ? (k.errors.push({ field: f('inputMethod'), code: 'ALM-E101', message: '필수 값입니다' }), '') : ''),
      condition: k.oneOf(s, 'condition', CONDITIONS, f('condition')), isUserConfirmed: k.bool(s, 'isUserConfirmed', f('isUserConfirmed')),
      needsRelabel: k.bool(s, 'needsRelabel', f('needsRelabel')), note: k.str(s, 'note', { max: 200, field: f('note') }),
      attachmentIds: ids as string[], scannedAt: dt(k, s, 'scannedAt', f('scannedAt'))! };
  });
  k.done();
  const device = deviceId ?? bodyDevice;
  const results: Outcome[] = [];
  const touched = new Set<string>();
  // scannedAt 순으로 처리(같은 자산은 가장 늦은 스캔이 남게). 결과는 요청 순서로 돌려준다
  const order = scans.map((s, i) => ({ s, i })).sort((a, b) => a.s.scannedAt.getTime() - b.s.scannedAt.getTime());
  const byIndex = new Map<number, Outcome>();
  for (const { s, i } of order) {
    await c.query('SAVEPOINT s');
    try {
      const r = await scanOne(c, p, device, s, touched);
      await c.query('RELEASE SAVEPOINT s');
      byIndex.set(i, r);
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      if (!(e instanceof AlmError)) throw e;
      byIndex.set(i, { clientScanId: s.clientScanId, status: 'REJECTED', code: e.code, message: e.message });
    }
  }
  scans.forEach((_, i) => results.push(clean(byIndex.get(i)!)));
  const tasks = touched.size ? (await c.query(`SELECT t.id, (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id AND ci.result IN ('FOUND', 'MISPLACED'))::int AS found,
      (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id AND ci.result = 'PENDING')::int AS pending FROM count_task t WHERE t.id = ANY($1::uuid[]) ORDER BY t.id`,
    [[...touched]])).rows.map((x) => ({ taskId: x.id, foundCount: x.found, pendingCount: x.pending })) : [];
  return { results, tasks };
}

async function scanOne(c: PoolClient, p: Principal, deviceId: string | undefined, s: ScanIn, touched: Set<string>): Promise<Outcome> {
  const prev = (await c.query('SELECT result, count_item_id, asset_id FROM count_scan WHERE client_scan_id = $1', [s.clientScanId])).rows[0];
  if (prev) return clean({ clientScanId: s.clientScanId, status: 'DUPLICATE' as const, serverResult: prev.result, countItemId: prev.count_item_id ?? undefined, assetId: prev.asset_id ?? undefined });
  const t = (await c.query(`SELECT t.id, t.status, t.assignee_id, cc.status AS campaign_status FROM count_task t JOIN count_campaign cc ON cc.id = t.campaign_id
     WHERE t.id = $1 AND t.campaign_id = $2 FOR UPDATE OF t`, [s.taskId, s.campaignId])).rows[0];
  if (!t || t.assignee_id !== p.userId) throw scope();
  if (t.campaign_status !== 'COUNTING' && t.campaign_status !== 'REVIEW') throw notCounting();
  if (!(await c.query('SELECT 1 FROM room WHERE id = $1 AND is_active', [s.roomId])).rowCount) throw E.badRequest('룸을 찾을 수 없습니다');

  // 바코드 값 = 자산태그(대소문자 구분 없이)
  const a = (await c.query(`SELECT id, status, status_before_missing FROM asset WHERE asset_tag IN ($1::text, upper($1::text)) ORDER BY asset_tag = $1::text DESC LIMIT 1`, [s.barcode])).rows[0];
  const item = a ? (await c.query('SELECT * FROM count_item WHERE campaign_id = $1 AND asset_id = $2 FOR UPDATE', [s.campaignId, a.id])).rows[0] : undefined;
  // REVIEW 단계는 재실사(PENDING) 대상만 받는다
  if (t.campaign_status === 'REVIEW' && item?.result !== 'PENDING') throw notCounting('차이 검토 중인 캠페인은 재실사 대상만 스캔합니다');

  let result: (typeof SCAN_RESULTS)[number];
  if (!a) result = 'UNREGISTERED';
  else if (['RETIRED', 'DISPOSED'].includes(a.status)) result = 'RETIRED_ASSET';
  else if (!item) result = 'OUT_OF_SCOPE';
  else if (item.result !== 'PENDING' && item.found_room_id === s.roomId) result = 'DUPLICATE';
  else result = item.expected_room_id === s.roomId ? 'FOUND' : 'MISPLACED';

  if (item) {
    touched.add(item.task_id);
    // 더 늦은 스캔만 대상에 반영(같은 자산을 여러 번 스캔)
    const later = !item.counted_at || s.scannedAt >= item.counted_at;
    if (later) {
      const r = result === 'DUPLICATE' ? item.result : result;
      await c.query(`UPDATE count_item SET result = $2, found_room_id = $3, condition = coalesce($4, condition), is_user_confirmed = is_user_confirmed OR $5,
          note = coalesce($6, note), counted_by = $7, counted_at = $8, needs_relabel = needs_relabel OR $9, updated_at = now(), updated_by = $7, version = version + 1
        WHERE id = $1`, [item.id, r, s.roomId, s.condition ?? null, !!s.isUserConfirmed, s.note ?? null, p.userId, s.scannedAt, !!s.needsRelabel]);
    }
    // 스캔이 들어온 룸 작업은 진행 중으로(완료한 룸에 스캔이 더 오면 되돌림)
    await c.query(`UPDATE count_task SET status = 'IN_PROGRESS', started_at = coalesce(started_at, $2), completed_at = NULL, updated_at = now()
      WHERE id = $1 AND status <> 'IN_PROGRESS'`, [item.task_id, s.scannedAt]);
  }
  if (a && result !== 'RETIRED_ASSET' && result !== 'UNREGISTERED') {
    await c.query('UPDATE asset SET last_seen_at = greatest(coalesce(last_seen_at, $2), $2) WHERE id = $1', [a.id, s.scannedAt]);
    // 분실(MISSING) 자산을 찾으면 이전 상태로 복원
    if (a.status === 'MISSING') {
      const back = a.status_before_missing ?? 'IN_STOCK';
      await c.query(`UPDATE asset SET status = $2, status_before_missing = NULL, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [a.id, back, p.userId]);
      await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes, count_campaign_id, reason)
        VALUES ($1, $2, $3, 'STATUS_CHANGED', $4, 'PDA', $5, $6, '실사 스캔으로 발견')`,
        [randomUUID(), p.tenantId, a.id, p.userId, JSON.stringify({ status: { before: 'MISSING', after: back } }), s.campaignId]);
    }
    if (s.needsRelabel && !(await c.query(`SELECT 1 FROM label_print_job WHERE asset_id = $1 AND status = 'QUEUED'`, [a.id])).rowCount) {
      const tpl = await defaultTemplateId(c, p.tenantId);
      await c.query(`INSERT INTO label_print_job (id, tenant_id, asset_id, template_id, source, requested_by, created_by, client_info)
        VALUES ($1, $2, $3, $4, 'PDA_REQUEST', $5, $5, $6)`, [randomUUID(), p.tenantId, a.id, tpl, p.userId, deviceId ? `PDA ${deviceId}` : 'PDA']);
    }
  }
  // 사진: 미리 올린 첨부(내가 올린, 아직 연결 안 된 count_item 사진)를 실사 대상에 연결
  if (item && s.attachmentIds.length) {
    await c.query(`UPDATE attachment SET owner_id = $2, linked_at = now() WHERE id = ANY($1::uuid[]) AND owner_type = 'count_item' AND owner_id IS NULL
      AND created_by = $3`, [s.attachmentIds, item.id, p.userId]);
  }
  await c.query(`INSERT INTO count_scan (id, tenant_id, campaign_id, task_id, room_id, client_scan_id, device_id, scanned_by, barcode, input_method, result,
      asset_id, count_item_id, condition, note, scanned_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [randomUUID(), p.tenantId, s.campaignId, s.taskId, s.roomId, s.clientScanId, deviceId && isUuid(deviceId) ? deviceId : null, p.userId, s.barcode, s.inputMethod,
      result, a?.id ?? null, item?.id ?? null, s.condition ?? null, s.note ?? null, s.scannedAt]);
  return clean({ clientScanId: s.clientScanId, status: 'ACCEPTED' as const, serverResult: result, countItemId: item?.id, assetId: a?.id });
}

// ---------------- 미등록 자산 ----------------
export async function pdaPostUnregistered(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), o = k.obj();
  k.uuid(o, 'deviceId', { required: true });
  const list = k.arr(o, 'items', { required: true, max: 50 });
  const items = list.map((x, i) => {
    const f = (n: string) => `items[${i}].${n}`;
    const s = k.obj(x, `items[${i}]`);
    const ids = Array.isArray(s.attachmentIds) ? s.attachmentIds : [];
    if (s.attachmentIds !== undefined && !Array.isArray(s.attachmentIds)) k.fail(f('attachmentIds'), '배열이어야 합니다');
    if (ids.length > 5 || ids.some((v) => !isUuid(v))) k.fail(f('attachmentIds'), '사진 id(uuid) 최대 5개');
    k.str(s, 'provisionalNo', { required: true, max: 20, field: f('provisionalNo') });
    return { clientScanId: k.uuid(s, 'clientScanId', { required: true, field: f('clientScanId') })!, campaignId: k.uuid(s, 'campaignId', { required: true, field: f('campaignId') })!,
      roomId: k.uuid(s, 'roomId', { required: true, field: f('roomId') })!, categoryId: k.uuid(s, 'categoryId', { field: f('categoryId') }),
      description: k.str(s, 'description', { required: true, max: 100, field: f('description') })!, serialNo: k.str(s, 'serialNo', { max: 40, field: f('serialNo') }),
      scannedBarcode: k.str(s, 'scannedBarcode', { max: 40, field: f('scannedBarcode') }), attachmentIds: ids as string[], reportedAt: dt(k, s, 'reportedAt', f('reportedAt'))! };
  });
  k.done();
  const results: Record<string, unknown>[] = [];
  for (const it of items) {
    await c.query('SAVEPOINT u');
    try {
      const prev = (await c.query('SELECT temp_no FROM count_unregistered WHERE client_scan_id = $1', [it.clientScanId])).rows[0];
      if (prev) { await c.query('RELEASE SAVEPOINT u'); results.push({ clientScanId: it.clientScanId, status: 'DUPLICATE', tempNo: prev.temp_no }); continue; }
      if (!it.attachmentIds.length) throw new AlmError(400, 'ALM-E110', '미등록 자산은 사진이 1장 이상 필요합니다');
      // 캠페인 행을 잠가 UNREG 번호를 줄 세운다
      const cp = (await c.query('SELECT status FROM count_campaign WHERE id = $1 FOR UPDATE', [it.campaignId])).rows[0];
      if (!cp) throw E.notFound('캠페인을 찾을 수 없습니다');
      if (!(await c.query('SELECT 1 FROM count_task WHERE campaign_id = $1 AND assignee_id = $2 LIMIT 1', [it.campaignId, p.userId])).rowCount) throw scope();
      if (cp.status !== 'COUNTING') throw notCounting();
      if (!(await c.query('SELECT 1 FROM room WHERE id = $1 AND is_active', [it.roomId])).rowCount) throw E.badRequest('룸을 찾을 수 없습니다');
      if (it.categoryId && !(await c.query('SELECT 1 FROM category WHERE id = $1', [it.categoryId])).rowCount) throw E.badRequest('카테고리를 찾을 수 없습니다');
      const photos = (await c.query(`SELECT id FROM attachment WHERE id = ANY($1::uuid[]) AND owner_type = 'count_unregistered' AND owner_id IS NULL AND created_by = $2`,
        [it.attachmentIds, p.userId])).rows;
      if (!photos.length) throw new AlmError(400, 'ALM-E110', '업로드한 사진을 찾을 수 없습니다(먼저 /pda/attachments:presign로 올리세요)');
      const n = Number((await c.query(`SELECT coalesce(max(substring(temp_no FROM 7)::int), 0) AS n FROM count_unregistered WHERE campaign_id = $1 AND temp_no ~ '^UNREG-[0-9]+$'`,
        [it.campaignId])).rows[0].n) + 1;
      const tempNo = `UNREG-${String(n).padStart(4, '0')}`;
      const id = randomUUID();
      await c.query(`INSERT INTO count_unregistered (id, tenant_id, campaign_id, temp_no, room_id, category_id, description, serial_no, scanned_barcode, client_scan_id,
          reported_by, reported_at, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $11)`,
        [id, p.tenantId, it.campaignId, tempNo, it.roomId, it.categoryId ?? null, it.description, it.serialNo ?? null, it.scannedBarcode ?? null, it.clientScanId, p.userId, it.reportedAt]);
      await c.query('UPDATE attachment SET owner_id = $2, linked_at = now() WHERE id = ANY($1::uuid[])', [photos.map((x) => x.id), id]);
      await c.query('RELEASE SAVEPOINT u');
      results.push({ clientScanId: it.clientScanId, status: 'ACCEPTED', tempNo });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT u');
      if (!(e instanceof AlmError)) throw e;
      results.push({ clientScanId: it.clientScanId, status: 'REJECTED', code: e.code, message: e.message });
    }
  }
  return { results };
}

// ---------------- PDA-09 자산 조회(바코드 → 상세, 2026-10-19) ----------------
//   어느 화면에서든 자산태그를 찍으면 상세를 본다. 보이는 범위:
//     전체 — 사용자의 asset.read 범위 안 자산, 또는 내게 배정된 실사(COUNTING·REVIEW) 캠페인의 대상 자산
//     제한 — 그 밖의 자산은 태그·상태·사이트만(범위 밖 태그 색인과 같은 수준, limited=true)
//   금액(취득가·장부가액)은 amount.read가 있을 때만. 없는 태그는 404 ALM-E404
const sapNo = (no?: string | null, sub?: string | null) => {
  if (!no) return undefined;
  const s = (sub ?? '0').replace(/^0+(?=\d)/, '');
  return `${no.replace(/^0+(?=\d)/, '')}${s === '0' ? '' : `-${s}`}`;
};

export async function pdaGetAsset(c: PoolClient, p: Principal, tag: string) {
  const t = (tag ?? '').trim();
  if (!t || t.length > 30) throw E.notFound('ALM 자산태그가 아닙니다');
  const a = (await c.query(`SELECT a.*, cat.name AS category_name, m.manufacturer, m.model_name, co.company_code, s.site_code, s.name AS site_name,
        r.room_code, r.name AS room_name, cc.cost_center_code, cc.name AS cost_center_name, u.display_name AS user_name, st.stage,
        vl.acquisition_value, vl.net_book_value
      FROM asset a JOIN category cat ON cat.id = a.category_id JOIN company co ON co.id = a.company_id LEFT JOIN model m ON m.id = a.model_id
      LEFT JOIN site s ON s.id = a.site_id LEFT JOIN room r ON r.id = a.room_id LEFT JOIN cost_center cc ON cc.id = a.cost_center_id
      LEFT JOIN app_user u ON u.id = a.assigned_user_id LEFT JOIN v_asset_stage st ON st.asset_id = a.id LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id
     WHERE upper(a.asset_tag) = upper($1)`, [t])).rows[0];
  if (!a) throw E.notFound('ALM에 없는 자산태그입니다');
  const ps = new Params([a.id]);
  const inScope = (await c.query(`SELECT 1 FROM asset a WHERE a.id = $1 AND ${assetScope(p, 'asset.read', ps)}`, ps.values)).rowCount;
  const mine = (await c.query(`SELECT cc.campaign_code, er.room_code AS expected_room, ci.result, ci.counted_at FROM count_item ci
      JOIN count_campaign cc ON cc.id = ci.campaign_id AND cc.status IN ('COUNTING', 'REVIEW') JOIN room er ON er.id = ci.expected_room_id
     WHERE ci.asset_id = $1 AND EXISTS (SELECT 1 FROM count_task t WHERE t.campaign_id = ci.campaign_id AND t.assignee_id = $2)
     ORDER BY cc.key_date DESC LIMIT 1`, [a.id, p.userId])).rows[0];
  // Bundle은 실사 대상이 아니다: 구성품이 내 실사 대상이면 Bundle도 상세로
  const bundleMine = !inScope && !mine && a.is_bundle && !!(await c.query(`SELECT 1 FROM count_item ci JOIN asset x ON x.id = ci.asset_id AND x.parent_asset_id = $1
      JOIN count_campaign cc ON cc.id = ci.campaign_id AND cc.status IN ('COUNTING', 'REVIEW')
     WHERE EXISTS (SELECT 1 FROM count_task t WHERE t.campaign_id = ci.campaign_id AND t.assignee_id = $2) LIMIT 1`, [a.id, p.userId])).rowCount;
  if (!inScope && !mine && !bundleMine) {
    return { assetTag: a.asset_tag, status: a.status, siteCode: a.site_code ?? undefined, limited: true };
  }
  const last = (await c.query(`SELECT ci.counted_at, cc.campaign_code, fr.room_code FROM count_item ci JOIN count_campaign cc ON cc.id = ci.campaign_id
      LEFT JOIN room fr ON fr.id = coalesce(ci.found_room_id, ci.expected_room_id) WHERE ci.asset_id = $1 AND ci.counted_at IS NOT NULL
     ORDER BY ci.counted_at DESC LIMIT 1`, [a.id])).rows[0];
  const events = (await c.query(`SELECT e.event_type, e.occurred_at, e.channel, u.display_name FROM asset_event e LEFT JOIN app_user u ON u.id = e.actor_id
     WHERE e.asset_id = $1 ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 5`, [a.id])).rows;
  const amount = can(p, 'amount.read');
  // Bundle: 구성품이면 소속 Bundle, Bundle이면 구성품(SAP에는 Bundle 1건)
  const bundle = a.parent_asset_id ? (await c.query('SELECT asset_tag, description, sap_asset_no, sap_sub_no FROM asset WHERE id = $1', [a.parent_asset_id])).rows[0] : undefined;
  const comps = a.is_bundle ? (await c.query(`SELECT x.asset_tag, x.description, x.status, r.room_code, count(*) OVER () AS n FROM asset x LEFT JOIN room r ON r.id = x.room_id
     WHERE x.parent_asset_id = $1 ORDER BY x.asset_tag LIMIT 50`, [a.id])).rows : [];
  return clean({
    isBundle: a.is_bundle || undefined, componentCount: a.is_bundle ? Number(comps[0]?.n ?? 0) : undefined,
    bundle: bundle ? clean({ assetTag: bundle.asset_tag, description: bundle.description, sapAssetNo: sapNo(bundle.sap_asset_no, bundle.sap_sub_no) }) : undefined,
    components: a.is_bundle ? comps.map((x) => clean({ assetTag: x.asset_tag, description: x.description, status: x.status, roomCode: x.room_code ?? undefined })) : undefined,
    assetTag: a.asset_tag, status: a.status, stage: a.stage ?? undefined, limited: false, description: a.description, categoryName: a.category_name,
    model: a.model_name ? `${a.manufacturer ?? ''} ${a.model_name}`.trim() : undefined, serialNo: a.serial_no, hostname: a.hostname,
    companyCode: a.company_code, siteCode: a.site_code, siteName: a.site_name, roomCode: a.room_code, roomName: a.room_name,
    costCenterCode: a.cost_center_code, costCenterName: a.cost_center_name, assignedUserName: a.user_name,
    sapAssetNo: sapNo(a.sap_asset_no, a.sap_sub_no), capitalizedOn: day(a.sap_cap_date), purchaseDate: day(a.purchase_date), warrantyEndDate: day(a.warranty_end_date),
    acquisitionValue: amount && a.acquisition_value !== null ? Number(a.acquisition_value) : undefined,
    netBookValue: amount && a.net_book_value !== null ? Number(a.net_book_value) : undefined,
    lastCountedAt: iso(last?.counted_at), lastCountedRoomCode: last?.room_code, lastCountCampaign: last?.campaign_code,
    count: mine ? clean({ campaignCode: mine.campaign_code, expectedRoomCode: mine.expected_room, result: mine.result, countedAt: iso(mine.counted_at) }) : undefined,
    events: events.map((e) => clean({ eventType: e.event_type, occurredAt: iso(e.occurred_at), channel: e.channel, actorName: e.display_name })),
  });
}
