// 실물 실사 캠페인(ALM-240, WBS 4.4). 01 기능정의서 7.2 F-240-01~06, openapi 실사 영역
//   단계: SCOPING(범위·룸 담당 배정) → COUNTING(PDA 스캔) → REVIEW(차이 처리) → POSTING(SAP 실사일 전기) → CLOSED. 취소 CANCELLED
//   SCOPING에서 룸 작업(count_task)은 범위로 맞춰 둔다(배정용). 시작 때 담당 없는 룸이 있으면 422 ALM-E316,
//   범위 자산마다 count_item을 만든다(RETIRED·DISPOSED·룸 없는 자산 제외).
//   실사 종료: PENDING → NOT_FOUND. 차이(MISPLACED·NOT_FOUND·파손)는 모두 처리해야 결과 전기(409 ALM-E317).
//   결과 전기: 실사한(FOUND·MISPLACED) SAP 자산마다 COUNT_RESULT 전기 건(IVDAT=기준일, INVZU=코드-OK/MV). SAP 자산이 아니면 ALM에 바로 반영.
//   종료: 전기 건이 모두 POSTED면 CLOSED, SAP 회사면 대사(IF-RC-01 CAMPAIGN) 실행 요청
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../platform/identity/principal';
import type { MailRequest } from '../notify/mail';
import { createRequest } from '../requests/requests';
import { createAsset } from '../assets/assets';

export const CAMPAIGN_CODE = /^[A-Z0-9]{2,6}$/;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

interface Scope { siteIds: string[]; roomIds?: string[]; assetClassIds?: string[]; includeNonCapitalized?: boolean }

// 차이로 보는 행: 위치 불일치·미발견·파손
const VARIANCE = `(ci.result IN ('MISPLACED', 'NOT_FOUND') OR ci.condition = 'DAMAGED')`;

// ---------------- 읽기 ----------------
async function load(c: PoolClient, id: string, lock = false) {
  if (!isUuid(id)) throw E.notFound('캠페인을 찾을 수 없습니다');
  const r = (await c.query(`SELECT cc.*, co.company_code, co.sap_enabled FROM count_campaign cc JOIN company co ON co.id = cc.company_id WHERE cc.id = $1${lock ? ' FOR UPDATE OF cc' : ''}`, [id])).rows[0];
  if (!r) throw E.notFound('캠페인을 찾을 수 없습니다');
  return r;
}

async function progress(c: PoolClient, campaignId: string) {
  const n = (await c.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE result = 'FOUND')::int AS found, count(*) FILTER (WHERE result = 'MISPLACED')::int AS misplaced,
      count(*) FILTER (WHERE result = 'PENDING')::int AS pending, count(*) FILTER (WHERE result = 'NOT_FOUND')::int AS not_found
    FROM count_item WHERE campaign_id = $1`, [campaignId])).rows[0];
  const unreg = (await c.query('SELECT count(*)::int AS n FROM count_unregistered WHERE campaign_id = $1', [campaignId])).rows[0].n as number;
  return { total: n.total, found: n.found, misplaced: n.misplaced, pending: n.pending, notFound: n.not_found, unregistered: unreg, rooms: await rooms(c, campaignId) };
}

async function rooms(c: PoolClient, campaignId: string) {
  return (await c.query(`SELECT t.id, r.room_code, u.display_name, t.status, t.expected_count,
      (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id AND ci.result IN ('FOUND', 'MISPLACED'))::int AS found,
      (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id AND ci.result = 'PENDING')::int AS pending
    FROM count_task t JOIN room r ON r.id = t.room_id LEFT JOIN app_user u ON u.id = t.assignee_id
    WHERE t.campaign_id = $1 ORDER BY r.room_code`, [campaignId])).rows
    .map((x) => clean({ taskId: x.id, roomCode: x.room_code, assigneeName: x.display_name ?? undefined, status: x.status, expected: x.expected_count,
      found: x.found, pending: x.pending }));
}

function campaignOut(r: Record<string, any>) {
  return { campaignCode: r.campaign_code, name: r.name, companyId: r.company_id, keyDate: day(r.key_date), dueDate: day(r.due_date), scope: r.scope };
}

async function detail(c: PoolClient, id: string) {
  const r = await load(c, id);
  return { id: r.id, version: r.version, campaign: campaignOut(r), status: r.status, companyCode: r.company_code, sapEnabled: !!r.sap_enabled,
    scopeFrozenAt: iso(r.scope_frozen_at), closedAt: iso(r.closed_at), progress: await progress(c, id),
    postings: await postingCounts(c, id) };
}

async function postingCounts(c: PoolClient, campaignId: string) {
  const rows = (await c.query(`SELECT p.status, count(*)::int AS n FROM sap_posting p JOIN count_item ci ON ci.id = p.count_item_id
    WHERE ci.campaign_id = $1 GROUP BY p.status`, [campaignId])).rows;
  return Object.fromEntries(rows.map((x) => [x.status as string, x.n as number]));
}

export async function listCampaigns(c: PoolClient, q: Record<string, string | undefined>) {
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50) || 50));
  const statuses = (q.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const where = statuses.length ? 'WHERE cc.status::text = ANY($1)' : 'WHERE $1::text[] IS NULL';
  const args: unknown[] = [statuses.length ? statuses : null];
  const total = (await c.query(`SELECT count(*)::int AS n FROM count_campaign cc ${where}`, args)).rows[0].n as number;
  const rows = (await c.query(`SELECT cc.*, co.company_code,
      (SELECT count(*) FROM count_item ci WHERE ci.campaign_id = cc.id)::int AS total,
      (SELECT count(*) FROM count_item ci WHERE ci.campaign_id = cc.id AND ci.result <> 'PENDING')::int AS counted,
      (SELECT count(*) FROM count_item ci WHERE ci.campaign_id = cc.id AND ${VARIANCE})::int AS variance
    FROM count_campaign cc JOIN company co ON co.id = cc.company_id ${where}
    ORDER BY cc.key_date DESC, cc.campaign_code OFFSET $2 LIMIT $3`, [...args, (page - 1) * pageSize, pageSize])).rows;
  return {
    items: rows.map((r) => ({ id: r.id, campaignCode: r.campaign_code, name: r.name, status: r.status, companyCode: r.company_code,
      keyDate: day(r.key_date), dueDate: day(r.due_date), totalItems: r.total, countedItems: r.counted, varianceItems: r.variance })),
    page, pageSize, total,
  };
}

export async function getCampaign(c: PoolClient, id: string) {
  return detail(c, id);
}

// ---------------- 만들기·고치기 ----------------
function readScope(k: Check, v: unknown): Scope | undefined {
  if (v === undefined) return undefined;
  const o = k.obj(v, 'scope');
  const ids = (key: string, required = false) => {
    const a = o[key];
    if (a === undefined || a === null) { if (required) k.errors.push({ field: `scope.${key}`, code: 'ALM-E101', message: '필수 값입니다' }); return undefined; }
    if (!Array.isArray(a) || a.length > 500 || a.some((x) => !isUuid(x))) { k.fail(`scope.${key}`, 'uuid 배열(최대 500)'); return undefined; }
    return [...new Set(a as string[])];
  };
  const siteIds = ids('siteIds', true);
  if (siteIds && !siteIds.length) k.fail('scope.siteIds', '사이트를 하나 이상 고르세요');
  return clean({ siteIds: siteIds ?? [], roomIds: ids('roomIds'), assetClassIds: ids('assetClassIds'), includeNonCapitalized: k.bool(o, 'includeNonCapitalized', 'scope.includeNonCapitalized') }) as Scope;
}

function readCampaign(body: unknown, partial: boolean) {
  const k = new Check(body);
  const b = k.obj();
  const v = {
    campaignCode: k.str(b, 'campaignCode', { required: !partial, pattern: /^[A-Z0-9]{2,6}$/i })?.toUpperCase(),
    name: k.str(b, 'name', { required: !partial, max: 100 }),
    companyId: k.uuid(b, 'companyId', { required: !partial }),
    keyDate: k.date(b, 'keyDate'), dueDate: k.date(b, 'dueDate'),
    scope: readScope(k, b.scope),
  };
  if (!partial) {
    if (!v.keyDate) k.errors.push({ field: 'keyDate', code: 'ALM-E101', message: '필수 값입니다' });
    if (!v.dueDate) k.errors.push({ field: 'dueDate', code: 'ALM-E101', message: '필수 값입니다' });
    if (!v.scope) k.errors.push({ field: 'scope', code: 'ALM-E101', message: '필수 값입니다' });
  }
  if (v.keyDate && v.dueDate && v.dueDate < v.keyDate) k.fail('dueDate', '기준일 이후여야 합니다');
  k.done();
  return { ...v, has: (f: string) => Object.prototype.hasOwnProperty.call(b, f) };
}

// 범위의 사이트·룸·클래스가 같은 회사·테넌트에 있는지
async function checkScope(c: PoolClient, companyId: string, s: Scope) {
  const bad = (field: string, msg: string) => { throw E.badRequest(msg, { errors: [{ field, code: 'ALM-E100', message: msg }] }); };
  if (!(await c.query('SELECT 1 FROM company WHERE id = $1 AND is_active', [companyId])).rowCount) bad('companyId', '없는 회사코드입니다');
  if ((await c.query('SELECT count(*)::int AS n FROM site WHERE id = ANY($1)', [s.siteIds])).rows[0].n !== s.siteIds.length) bad('scope.siteIds', '없는 사이트가 있습니다');
  if (s.roomIds?.length && (await c.query('SELECT count(*)::int AS n FROM room WHERE id = ANY($1) AND site_id = ANY($2)', [s.roomIds, s.siteIds])).rows[0].n !== s.roomIds.length) {
    bad('scope.roomIds', '범위 사이트 밖의 룸이 있습니다');
  }
  if (s.assetClassIds?.length && (await c.query('SELECT count(*)::int AS n FROM asset_class WHERE id = ANY($1)', [s.assetClassIds])).rows[0].n !== s.assetClassIds.length) {
    bad('scope.assetClassIds', '없는 자산클래스가 있습니다');
  }
}

export async function createCampaign(c: PoolClient, p: Principal, body: unknown) {
  const v = readCampaign(body, false);
  await checkScope(c, v.companyId!, v.scope!);
  if ((await c.query('SELECT 1 FROM count_campaign WHERE campaign_code = $1', [v.campaignCode])).rowCount) throw E.duplicate(`캠페인 코드 ${v.campaignCode}가 이미 있습니다`);
  const id = randomUUID();
  await c.query(`INSERT INTO count_campaign (id, tenant_id, campaign_code, name, company_id, key_date, due_date, status, scope, owner_id, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'SCOPING', $8, $9, $9, $9)`,
  [id, p.tenantId, v.campaignCode, v.name, v.companyId, v.keyDate, v.dueDate, JSON.stringify(v.scope), p.userId]);
  return detail(c, id);
}

export async function patchCampaign(c: PoolClient, p: Principal, id: string, ifMatch: string | undefined, body: unknown) {
  const r = await load(c, id, true);
  const want = Number(String(ifMatch ?? '').replace(/^W\//, '').replace(/"/g, ''));
  if (!ifMatch || !Number.isFinite(want)) throw new AlmError(428, 'ALM-E310', 'If-Match(version)가 필요합니다');
  if (want !== r.version) throw new AlmError(409, 'ALM-E310', '다른 사람이 먼저 바꿨습니다. 다시 불러오세요', { currentVersion: r.version });
  const v = readCampaign(body, true);
  if (['CLOSED', 'CANCELLED'].includes(r.status)) throw new AlmError(409, 'ALM-E322', `${r.status} 캠페인은 바꿀 수 없습니다`);
  const scoping = r.status === 'SCOPING';
  if (!scoping && (v.has('scope') || v.has('companyId') || v.has('keyDate') || v.has('campaignCode'))) {
    throw new AlmError(409, 'ALM-E322', '실사를 시작한 뒤에는 이름·기한만 바꿀 수 있습니다');
  }
  if (v.campaignCode && v.campaignCode !== r.campaign_code
    && (await c.query('SELECT 1 FROM count_campaign WHERE campaign_code = $1 AND id <> $2', [v.campaignCode, id])).rowCount) {
    throw E.duplicate(`캠페인 코드 ${v.campaignCode}가 이미 있습니다`);
  }
  const companyId = v.companyId ?? r.company_id, scope = v.scope ?? r.scope;
  if (scoping && (v.scope || v.companyId)) await checkScope(c, companyId, scope);
  const keyDate = v.keyDate ?? day(r.key_date), dueDate = v.dueDate ?? day(r.due_date);
  if (dueDate! < keyDate!) throw E.badRequest('기한은 기준일 이후여야 합니다', { errors: [{ field: 'dueDate', code: 'ALM-E100', message: '기준일 이전' }] });
  await c.query(`UPDATE count_campaign SET campaign_code = $2, name = $3, company_id = $4, key_date = $5, due_date = $6, scope = $7,
      updated_at = now(), updated_by = $8, version = version + 1 WHERE id = $1`,
  [id, v.campaignCode ?? r.campaign_code, v.name ?? r.name, companyId, keyDate, dueDate, JSON.stringify(scope), p.userId]);
  return detail(c, id);
}

// ---------------- 범위 ----------------
function scopeWhere(s: Scope, companyId: string) {
  const args: unknown[] = [companyId, s.siteIds];
  // Bundle은 실물이 없으므로 대상에서 빼고 구성품을 하나씩 센다. 구성품의 클래스·자본화 여부는 Bundle 기준
  const w = [`a.company_id = $1`, `a.site_id = ANY($2)`, `a.status NOT IN ('RETIRED', 'DISPOSED')`, 'NOT a.is_bundle'];
  const viaBundle = (col: string) => `coalesce((SELECT pb.${col} FROM asset pb WHERE pb.id = a.parent_asset_id), a.${col})`;
  if (s.roomIds?.length) { args.push(s.roomIds); w.push(`a.room_id = ANY($${args.length})`); }
  if (s.assetClassIds?.length) { args.push(s.assetClassIds); w.push(`${viaBundle('asset_class_id')} = ANY($${args.length})`); }
  if (s.includeNonCapitalized === false) w.push(viaBundle('is_capitalized'));
  return { where: w.join(' AND '), args };
}

async function scopeRooms(c: PoolClient, r: Record<string, any>) {
  const { where, args } = scopeWhere(r.scope as Scope, r.company_id);
  const rows = (await c.query(`SELECT a.room_id, rm.room_code, count(*)::int AS n FROM asset a JOIN room rm ON rm.id = a.room_id
    WHERE ${where} GROUP BY a.room_id, rm.room_code ORDER BY rm.room_code`, args)).rows;
  const noRoom = (await c.query(`SELECT count(*)::int AS n FROM asset a WHERE ${where} AND a.room_id IS NULL`, args)).rows[0].n as number;
  return { rows: rows as { room_id: string; room_code: string; n: number }[], noRoom };
}

export async function previewScope(c: PoolClient, id: string) {
  const r = await load(c, id);
  if (r.status !== 'SCOPING') throw new AlmError(409, 'ALM-E322', '범위 미리보기는 SCOPING 단계에서만 합니다');
  const { rows, noRoom } = await scopeRooms(c, r);
  const tasks = new Map((await c.query('SELECT id, room_id FROM count_task WHERE campaign_id = $1', [id])).rows.map((t) => [t.room_id as string, t.id as string]));
  return {
    total: rows.reduce((s, x) => s + x.n, 0),
    rooms: rows.map((x) => ({ taskId: tasks.get(x.room_id) ?? '', roomCode: x.room_code, status: 'NOT_STARTED', expected: x.n, found: 0, pending: x.n })),
    warnings: noRoom ? [`룸이 없는 자산 ${noRoom}건은 대상에서 제외됩니다`] : [],
  };
}

// SCOPING: 룸 작업을 지금 범위에 맞춘다(새 룸 추가, 빠진 룸 삭제, 대상 수 갱신). 담당 배정은 남긴다
async function syncTasks(c: PoolClient, p: Principal, r: Record<string, any>) {
  const { rows } = await scopeRooms(c, r);
  await c.query(`DELETE FROM count_task t WHERE t.campaign_id = $1 AND NOT (t.room_id = ANY($2))
    AND NOT EXISTS (SELECT 1 FROM count_item ci WHERE ci.task_id = t.id)`, [r.id, rows.map((x) => x.room_id)]);
  for (const x of rows) {
    await c.query(`INSERT INTO count_task (id, tenant_id, campaign_id, room_id, expected_count, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)
      ON CONFLICT (campaign_id, room_id) DO UPDATE SET expected_count = EXCLUDED.expected_count, updated_at = now(), version = count_task.version + 1
      WHERE count_task.expected_count IS DISTINCT FROM EXCLUDED.expected_count`, [randomUUID(), p.tenantId, r.id, x.room_id, x.n, p.userId]);
  }
  return rows;
}

export async function listCampaignTasks(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (r.status === 'SCOPING') await syncTasks(c, p, r);
  return progress(c, id);
}

export async function assignCountTask(c: PoolClient, p: Principal, taskId: string, body: unknown) {
  if (!isUuid(taskId)) throw E.notFound('작업을 찾을 수 없습니다');
  const k = new Check(body);
  const assigneeId = k.uuid(k.obj(), 'assigneeId', { required: true });
  k.done();
  const t = (await c.query(`SELECT t.*, cc.status AS campaign_status FROM count_task t JOIN count_campaign cc ON cc.id = t.campaign_id WHERE t.id = $1 FOR UPDATE OF t`, [taskId])).rows[0];
  if (!t) throw E.notFound('작업을 찾을 수 없습니다');
  if (!['SCOPING', 'COUNTING', 'REVIEW'].includes(t.campaign_status)) throw new AlmError(409, 'ALM-E322', `${t.campaign_status} 캠페인은 배정을 바꿀 수 없습니다`);
  const counter = (await c.query(`SELECT 1 FROM user_role ur JOIN app_user u ON u.id = ur.user_id WHERE ur.user_id = $1 AND ur.role = 'COUNTER' AND u.is_active
      AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)`, [assigneeId])).rowCount;
  if (!counter) throw E.badRequest('실사 담당자(COUNTER) 역할이 있는 사용자만 배정할 수 있습니다', { errors: [{ field: 'assigneeId', code: 'ALM-E100', message: 'COUNTER 아님' }] });
  await c.query('UPDATE count_task SET assignee_id = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1', [taskId, assigneeId, p.userId]);
  return (await rooms(c, t.campaign_id)).find((x) => x.taskId === taskId);
}

export async function startCampaign(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (r.status !== 'SCOPING') throw new AlmError(409, 'ALM-E322', '이미 시작한 캠페인입니다');
  const rows = await syncTasks(c, p, r);
  if (!rows.length) throw new AlmError(422, 'ALM-E100', '범위에 실사할 자산이 없습니다');
  const unassigned = (await c.query(`SELECT r.room_code FROM count_task t JOIN room r ON r.id = t.room_id WHERE t.campaign_id = $1 AND t.assignee_id IS NULL ORDER BY 1`, [id])).rows;
  if (unassigned.length) {
    throw new AlmError(422, 'ALM-E316', `담당이 없는 룸이 ${unassigned.length}곳 있습니다(먼저 배정): ${unassigned.slice(0, 10).map((x) => x.room_code).join(', ')}`,
      { rooms: unassigned.map((x) => x.room_code) });
  }
  const { where, args } = scopeWhere(r.scope as Scope, r.company_id);
  args.push(p.tenantId, id, p.userId);
  const n = args.length;
  await c.query(`INSERT INTO count_item (id, tenant_id, campaign_id, asset_id, task_id, expected_room_id, created_by, updated_by)
    SELECT gen_random_uuid(), $${n - 2}, $${n - 1}, a.id, t.id, a.room_id, $${n}, $${n}
      FROM asset a JOIN count_task t ON t.campaign_id = $${n - 1} AND t.room_id = a.room_id
     WHERE ${where} AND a.room_id IS NOT NULL`, args);
  await c.query(`UPDATE count_task t SET expected_count = (SELECT count(*) FROM count_item ci WHERE ci.task_id = t.id), updated_at = now() WHERE t.campaign_id = $1`, [id]);
  await c.query(`UPDATE count_campaign SET status = 'COUNTING', scope_frozen_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return detail(c, id);
}

export async function cancelCampaign(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (!['SCOPING', 'COUNTING'].includes(r.status)) throw new AlmError(409, 'ALM-E322', '범위 확정·실사 중인 캠페인만 취소합니다');
  await c.query(`UPDATE count_campaign SET status = 'CANCELLED', closed_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return detail(c, id);
}

// ---------------- 실사 대상·차이 ----------------
export async function listCountItems(c: PoolClient, id: string, q: Record<string, string | undefined>) {
  await load(c, id);
  const k = new Check(q);
  const roomId = k.uuid(q, 'roomId');
  const results = (q.result ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (results.some((x) => !['PENDING', 'FOUND', 'MISPLACED', 'NOT_FOUND'].includes(x))) k.fail('result', 'PENDING, FOUND, MISPLACED, NOT_FOUND');
  k.done();
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 100) || 100));
  const args: unknown[] = [id];
  const w = ['ci.campaign_id = $1'];
  if (results.length) { args.push(results); w.push(`ci.result::text = ANY($${args.length})`); }
  if (roomId) { args.push(roomId); w.push(`(ci.expected_room_id = $${args.length} OR ci.found_room_id = $${args.length})`); }
  if (q.variance === 'true') w.push(VARIANCE);
  if (q.unresolved === 'true') w.push('ci.variance_action IS NULL');
  if (q.q?.trim()) { args.push(`%${likeEsc(q.q.trim().slice(0, 40))}%`); w.push(`(a.asset_tag ILIKE $${args.length} OR a.description ILIKE $${args.length})`); }
  const from = `FROM count_item ci JOIN asset a ON a.id = ci.asset_id JOIN room er ON er.id = ci.expected_room_id LEFT JOIN room fr ON fr.id = ci.found_room_id
    LEFT JOIN app_user u ON u.id = ci.counted_by WHERE ${w.join(' AND ')}`;
  const total = (await c.query(`SELECT count(*)::int AS n ${from}`, args)).rows[0].n as number;
  const rows = (await c.query(`SELECT ci.*, a.asset_tag, a.description, a.status AS asset_status, er.room_code AS expected_code, fr.room_code AS found_code, u.display_name,
      (SELECT ar.request_no FROM asset_request ar WHERE ar.asset_id = ci.asset_id AND ar.source = 'COUNT_VARIANCE' AND ar.created_at >= ci.created_at
        ORDER BY ar.created_at DESC LIMIT 1) AS request_no,
      (SELECT count(*) FROM attachment f WHERE f.owner_type = 'count_item' AND f.owner_id = ci.id AND f.linked_at IS NOT NULL)::int AS photos
    ${from} ORDER BY er.room_code, a.asset_tag OFFSET $${args.length + 1} LIMIT $${args.length + 2}`, [...args, (page - 1) * pageSize, pageSize])).rows;
  return {
    items: rows.map((x) => clean({ id: x.id, assetId: x.asset_id, assetTag: x.asset_tag, description: x.description, assetStatus: x.asset_status,
      expectedRoomCode: x.expected_code, foundRoomCode: x.found_code ?? undefined, result: x.result, condition: x.condition ?? undefined,
      note: x.note ?? undefined, countedByName: x.display_name ?? undefined, countedAt: iso(x.counted_at), needsRelabel: x.needs_relabel || undefined,
      varianceAction: x.variance_action ?? undefined, requestNo: x.request_no ?? undefined, photoCount: x.photos })),
    page, pageSize, total,
  };
}

export async function closeCounting(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (r.status !== 'COUNTING') throw new AlmError(409, 'ALM-E322', '실사 중(COUNTING)인 캠페인만 종료합니다');
  await c.query(`UPDATE count_item SET result = 'NOT_FOUND', updated_at = now(), updated_by = $2, version = version + 1 WHERE campaign_id = $1 AND result = 'PENDING'`, [id, p.userId]);
  await c.query(`UPDATE count_campaign SET status = 'REVIEW', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return detail(c, id);
}

const ACTIONS = ['MASTER_CHANGE', 'RECOUNT', 'RETIRE_REQUEST', 'MARK_MISSING', 'REPAIR', 'ACCEPT'] as const;
type Action = (typeof ACTIONS)[number];

// 동작별로 받을 수 있는 판정(파손은 condition)
function allowedFor(x: Record<string, any>): Action[] {
  const out = new Set<Action>(['ACCEPT']);
  if (x.result === 'MISPLACED') ['MASTER_CHANGE', 'RECOUNT'].forEach((a) => out.add(a as Action));
  if (x.result === 'NOT_FOUND') ['RECOUNT', 'RETIRE_REQUEST', 'MARK_MISSING'].forEach((a) => out.add(a as Action));
  if (x.condition === 'DAMAGED') ['REPAIR', 'RETIRE_REQUEST'].forEach((a) => out.add(a as Action));
  return [...out];
}

export async function resolveVariances(c: PoolClient, p: Principal, body: unknown, mails: MailRequest[]) {
  const k = new Check(body);
  const list = k.arr(k.obj(), 'items', { required: true, max: 500 });
  const items = list.map((x, i) => {
    const o = k.obj(x, `items[${i}]`);
    return { id: k.uuid(o, 'id', { required: true, field: `items[${i}].id` })!, action: k.oneOf(o, 'action', ACTIONS, `items[${i}].action`)!,
      retireType: k.oneOf(o, 'retireType', ['SCRAP', 'LOSS'] as const, `items[${i}].retireType`), note: k.str(o, 'note', { max: 200, field: `items[${i}].note` }) };
  });
  list.forEach((x, i) => { if ((x as Record<string, unknown>)?.action === undefined) k.errors.push({ field: `items[${i}].action`, code: 'ALM-E101', message: '필수 값입니다' }); });
  k.done();
  const results: { id: string; status: 'OK' | 'ERROR'; code?: string; message?: string; createdId?: string }[] = [];
  for (const it of items) {
    await c.query('SAVEPOINT v');
    try {
      const created = await resolveOne(c, p, it, mails);
      await c.query('RELEASE SAVEPOINT v');
      results.push(clean({ id: it.id, status: 'OK' as const, createdId: created }));
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT v');
      const err = e instanceof AlmError ? e : undefined;
      if (!err) throw e;
      results.push({ id: it.id, status: 'ERROR', code: err.code, message: err.message });
    }
  }
  return { results };
}

async function resolveOne(c: PoolClient, p: Principal, it: { id: string; action: Action; retireType?: 'SCRAP' | 'LOSS'; note?: string }, mails: MailRequest[]) {
  const x = (await c.query(`SELECT ci.*, cc.status AS campaign_status, cc.campaign_code, a.status AS asset_status FROM count_item ci
    JOIN count_campaign cc ON cc.id = ci.campaign_id JOIN asset a ON a.id = ci.asset_id WHERE ci.id = $1 FOR UPDATE OF ci`, [it.id])).rows[0];
  if (!x) throw E.notFound('실사 대상을 찾을 수 없습니다');
  if (x.campaign_status !== 'REVIEW') throw new AlmError(409, 'ALM-E322', '차이 검토(REVIEW) 단계에서만 처리합니다');
  if (!allowedFor(x).includes(it.action)) throw new AlmError(409, 'ALM-E322', `${x.result}${x.condition === 'DAMAGED' ? '·DAMAGED' : ''}에는 ${it.action}을(를) 쓸 수 없습니다`);
  const reason = `실사 ${x.campaign_code} ${it.note ? `· ${it.note}` : ''}`.trim().slice(0, 200);
  let created: string | undefined;
  const asRequest = async (b: Record<string, unknown>) => {
    const d = await createRequest(c, p, { assetId: x.asset_id, reason, submit: true, ...b }, mails);
    await c.query(`UPDATE asset_request SET source = 'COUNT_VARIANCE' WHERE id = $1`, [d.id]);
    return d.id as string;
  };
  const event = (type: string, changes: unknown) => c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes, count_campaign_id, reason)
    VALUES ($1, $2, $3, $4, $5, 'UI', $6, $7, $8)`, [randomUUID(), p.tenantId, x.asset_id, type, p.userId, JSON.stringify(changes), x.campaign_id, reason]);
  switch (it.action) {
    case 'MASTER_CHANGE':
      created = await asRequest({ requestType: 'CHANGE', targetRoomId: x.found_room_id });
      break;
    case 'RETIRE_REQUEST':
      created = await asRequest({ requestType: 'RETIRE', retireType: it.retireType ?? (x.result === 'NOT_FOUND' ? 'LOSS' : 'SCRAP'),
        effectiveDate: new Date().toISOString().slice(0, 10) });
      break;
    case 'RECOUNT':
      await c.query(`UPDATE count_item SET result = 'PENDING', found_room_id = NULL, counted_by = NULL, counted_at = NULL, variance_action = NULL,
          resolved_by = NULL, resolved_at = NULL, note = coalesce($2, note), updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [it.id, it.note ?? null, p.userId]);
      await c.query(`UPDATE count_task SET status = 'IN_PROGRESS', completed_at = NULL, updated_at = now() WHERE id = $1 AND status = 'COMPLETED'`, [x.task_id]);
      return undefined;
    case 'MARK_MISSING':
      if (x.asset_status !== 'MISSING') {
        await c.query(`UPDATE asset SET status_before_missing = status, status = 'MISSING', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [x.asset_id, p.userId]);
        await event('STATUS_CHANGED', { status: { before: x.asset_status, after: 'MISSING' } });
      }
      break;
    case 'REPAIR':
      if (!['IN_REPAIR', 'RETIRED', 'DISPOSED'].includes(x.asset_status)) {
        await c.query(`UPDATE asset SET status = 'IN_REPAIR', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [x.asset_id, p.userId]);
        await event('REPAIR_IN', { status: { before: x.asset_status, after: 'IN_REPAIR' } });
      }
      break;
    case 'ACCEPT':
      break;
  }
  await c.query(`UPDATE count_item SET variance_action = $2, note = coalesce($3, note), resolved_by = $4, resolved_at = now(), updated_at = now(), updated_by = $4,
      version = version + 1 WHERE id = $1`, [it.id, it.action, it.note ?? null, p.userId]);
  return created;
}

// ---------------- 미등록 ----------------
export async function listUnregistered(c: PoolClient, id: string, q: Record<string, string | undefined>) {
  await load(c, id);
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50) || 50));
  const total = (await c.query('SELECT count(*)::int AS n FROM count_unregistered WHERE campaign_id = $1', [id])).rows[0].n as number;
  const rows = (await c.query(`SELECT u.*, r.room_code, cat.name AS category_name, ru.display_name AS reporter, a.asset_tag,
      (SELECT count(*) FROM attachment f WHERE f.owner_type = 'count_unregistered' AND f.owner_id = u.id AND f.linked_at IS NOT NULL)::int AS photos
    FROM count_unregistered u JOIN room r ON r.id = u.room_id LEFT JOIN category cat ON cat.id = u.category_id
    JOIN app_user ru ON ru.id = u.reported_by LEFT JOIN asset a ON a.id = u.created_asset_id
    WHERE u.campaign_id = $1 ORDER BY u.temp_no OFFSET $2 LIMIT $3`, [id, (page - 1) * pageSize, pageSize])).rows;
  return {
    items: rows.map((x) => clean({ id: x.id, tempNo: x.temp_no, roomId: x.room_id, roomCode: x.room_code, categoryId: x.category_id ?? undefined,
      description: x.description, categoryName: x.category_name ?? undefined, serialNo: x.serial_no ?? undefined, scannedBarcode: x.scanned_barcode ?? undefined,
      reportedByName: x.reporter, reportedAt: iso(x.reported_at), photoCount: x.photos, resolution: x.resolution ?? undefined, createdAssetTag: x.asset_tag ?? undefined })),
    page, pageSize, total,
  };
}

export async function resolveUnregistered(c: PoolClient, p: Principal, id: string, body: unknown) {
  if (!isUuid(id)) throw E.notFound('미등록 자산을 찾을 수 없습니다');
  const k = new Check(body);
  const b = k.obj();
  const action = k.oneOf(b, 'action', ['REGISTER', 'NON_ASSET'] as const);
  if (b.action === undefined) k.errors.push({ field: 'action', code: 'ALM-E101', message: '필수 값입니다' });
  const note = k.str(b, 'note', { max: 200 });
  const asset = b.asset === undefined ? undefined : k.obj(b.asset, 'asset');
  k.done();
  const u = (await c.query(`SELECT u.*, cc.status AS campaign_status, cc.company_id, rm.site_id FROM count_unregistered u JOIN count_campaign cc ON cc.id = u.campaign_id
    JOIN room rm ON rm.id = u.room_id WHERE u.id = $1 FOR UPDATE OF u`, [id])).rows[0];
  if (!u) throw E.notFound('미등록 자산을 찾을 수 없습니다');
  if (u.resolution) throw new AlmError(409, 'ALM-E322', '이미 처리했습니다');
  if (!['COUNTING', 'REVIEW'].includes(u.campaign_status)) throw new AlmError(409, 'ALM-E322', '실사 중이거나 차이 검토 중인 캠페인에서만 처리합니다');
  let createdId: string | undefined;
  if (action === 'REGISTER') {
    // 보고값(설명·시리얼·카테고리·발견 룸·회사)을 기본으로, 화면에서 고친 값(모델·코스트센터 등)을 덮는다
    const d = await createAsset(c, p, { description: u.description.slice(0, 50), serialNo: u.serial_no ?? undefined, categoryId: u.category_id ?? undefined,
      roomId: u.room_id, companyId: u.company_id, notes: `실사 미등록 ${u.temp_no}${note ? ` · ${note}` : ''}`.slice(0, 500), ...(asset ?? {}) });
    createdId = d.asset.id as string;
    // 미등록 사진을 새 자산 첨부로도 보이게 복사 연결(원본은 실사 기록으로 남김)
    await c.query(`INSERT INTO attachment (id, tenant_id, owner_type, owner_id, kind, file_name, content_type, size_bytes, s3_key, sha256, linked_at, created_by)
      SELECT gen_random_uuid(), tenant_id, 'asset', $2, kind, file_name, content_type, size_bytes, s3_key, sha256, now(), $3 FROM attachment
       WHERE owner_type = 'count_unregistered' AND owner_id = $1 AND linked_at IS NOT NULL`, [id, createdId, p.userId]);
  }
  await c.query(`UPDATE count_unregistered SET resolution = $2, created_asset_id = $3, resolved_by = $4, resolved_at = now(), updated_at = now(), updated_by = $4,
      version = version + 1 WHERE id = $1`, [id, action, createdId ?? null, p.userId]);
  return clean({ id, status: 'OK', createdId });
}

// ---------------- 결과 전기·종료 ----------------
export async function postCountResults(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (r.status !== 'REVIEW') throw new AlmError(409, 'ALM-E322', '차이 검토(REVIEW) 단계에서만 전기합니다');
  const open = (await c.query(`SELECT count(*)::int AS n FROM count_item ci WHERE ci.campaign_id = $1 AND ${VARIANCE} AND ci.variance_action IS NULL`, [id])).rows[0].n as number;
  const unreg = (await c.query('SELECT count(*)::int AS n FROM count_unregistered WHERE campaign_id = $1 AND resolution IS NULL', [id])).rows[0].n as number;
  if (open || unreg) throw new AlmError(409, 'ALM-E317', `처리하지 않은 차이 ${open}건, 미등록 ${unreg}건이 남았습니다`, { variances: open, unregistered: unreg });
  const counted = (await c.query(`SELECT ci.id, ci.asset_id, ci.result, a.sap_asset_no, a.company_id, a.parent_asset_id, pb.sap_asset_no AS bundle_sap_no
     FROM count_item ci JOIN asset a ON a.id = ci.asset_id LEFT JOIN asset pb ON pb.id = a.parent_asset_id
    WHERE ci.campaign_id = $1 AND ci.result IN ('FOUND', 'MISPLACED') ORDER BY a.asset_tag`, [id])).rows;
  const note = (res: string) => `${r.campaign_code}-${res === 'FOUND' ? 'OK' : 'MV'}`.slice(0, 15);
  // Bundle 구성품: 구성품 실사일은 ALM에, SAP에는 Bundle 1건(구성품 중 하나라도 위치가 다르면 MV)
  const bundles = new Map<string, { itemId: string; companyId: string; result: string; sap: boolean }>();
  for (const x of counted) {
    if (!x.parent_asset_id) continue;
    const b = bundles.get(x.parent_asset_id);
    if (!b) bundles.set(x.parent_asset_id, { itemId: x.id, companyId: x.company_id, result: x.result, sap: !!x.bundle_sap_no });
    else if (x.result === 'MISPLACED') b.result = 'MISPLACED';
  }
  const items = [
    ...counted.map((x) => ({ ...x, sap_asset_no: x.parent_asset_id ? null : x.sap_asset_no })),
    ...[...bundles].map(([bid, b]) => ({ id: b.itemId, asset_id: bid, result: b.result, sap_asset_no: b.sap ? 'Y' : null, company_id: b.companyId })),
  ];
  let seq = 0;
  for (const x of items) {
    if (r.sap_enabled && x.sap_asset_no) {
      seq += 1;
      await c.query(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, company_id, asset_id, count_item_id, posting_date, payload, approved_by, approved_at, created_by)
        VALUES ($1, $2, $3, 'COUNT_RESULT', $4, $5, $6, current_date, $7, $8, now(), $8)
        ON CONFLICT (tenant_id, posting_id) DO NOTHING`,
      [randomUUID(), p.tenantId, `${r.campaign_code}-${String(seq).padStart(5, '0')}`.slice(0, 12), x.company_id, x.asset_id, x.id,
        JSON.stringify({ lastCountDate: day(r.key_date), inventoryNote: note(x.result) }), p.userId]);
    } else {
      // SAP에 보낼 것이 없는 자산: 실사일을 ALM에 바로
      await c.query(`UPDATE asset SET last_count_date = $2, last_count_note = $3, updated_at = now(), version = version + 1 WHERE id = $1`, [x.asset_id, day(r.key_date), note(x.result)]);
    }
  }
  await c.query(`UPDATE count_campaign SET status = 'POSTING', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return detail(c, id);
}

export async function closeCampaign(c: PoolClient, p: Principal, id: string) {
  const r = await load(c, id, true);
  if (r.status !== 'POSTING') throw new AlmError(409, 'ALM-E322', '결과 전기(POSTING) 단계에서만 종료합니다');
  const left = (await c.query(`SELECT count(*)::int AS n FROM sap_posting sp JOIN count_item ci ON ci.id = sp.count_item_id
    WHERE ci.campaign_id = $1 AND sp.status NOT IN ('POSTED', 'CANCELLED')`, [id])).rows[0].n as number;
  if (left) throw new AlmError(409, 'ALM-E322', `SAP 전기가 끝나지 않은 건이 ${left}건 있습니다(SAP 연계 화면에서 확인)`, { pending: left });
  await c.query(`UPDATE count_campaign SET status = 'CLOSED', closed_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  // 실사 종료 대사(IF-RC-01 CAMPAIGN): SAP 회사이고 연결이 있으면 실행 요청(이미 대기 중이면 건너뜀)
  if (r.sap_enabled && (await c.query('SELECT 1 FROM sap_connection WHERE company_id = $1 AND is_active', [r.company_id])).rowCount
    && !(await c.query(`SELECT 1 FROM sap_run_request WHERE interface_id = 'IF-RC-01' AND status = 'PENDING'`)).rowCount) {
    await c.query(`INSERT INTO sap_run_request (id, tenant_id, interface_id, params, requested_by, created_by) VALUES ($1, $2, 'IF-RC-01', $3, $4, $4)`,
      [randomUUID(), p.tenantId, JSON.stringify({ runType: 'CAMPAIGN', campaignCode: r.campaign_code }), p.userId]);
  }
  return detail(c, id);
}
