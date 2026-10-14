// 할당·반납·수리(ALM-111 F-111-04·05, openapi checkOutAsset·checkInAsset·moveRepair). 권한 asset.assign + 범위. WBS 4.2
//   할당  : IN_STOCK·IN_USE → IN_USE. 기존 할당은 닫고 새 할당 행. 위치(룸)는 범위 안이어야 한다.
//           코스트센터(비면 사용자 소속, 그것도 없으면 현재 값)가 바뀌면
//             - SAP 자산: 바로 바꾸지 않고 자산 요청을 만든다(손익센터·세그먼트가 같으면 CHANGE, 다르면 TRANSFER). 승인(부서 관리자 →
//               자산회계)·SAP 전기가 끝나면 코스트센터가 바뀐다. 같은 자산에 진행 중인 요청이 있으면 409 ALM-E315
//             - SAP 자산이 아니면 ALM 값만 바로 바꾼다
//   반납  : IN_USE → IN_STOCK, 할당 종료. 위치가 비면 그 사이트의 IT 창고 룸(is_storage).
//   수리  : IN(IN_STOCK·IN_USE → IN_REPAIR), OUT(수리 전 상태로).
//   지금 상태에서 할 수 없는 처리는 409 ALM-E322.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../auth/principal';
import { allowsPlace, assetScope, Params } from '../auth/scope';
import { detail } from './assets';
import { nextNumbers } from './tags';

const state = (m: string) => new AlmError(409, 'ALM-E322', m);

async function target(c: PoolClient, p: Principal, id: string) {
  if (!UUID.test(id)) throw E.notFound('자산을 찾을 수 없습니다');
  const ps = new Params([id]);
  const a = (await c.query(`SELECT a.*, co.company_code FROM asset a JOIN company co ON co.id = a.company_id
     WHERE a.id = $1 AND ${assetScope(p, 'asset.assign', ps)} FOR UPDATE OF a`, ps.values)).rows[0];
  if (!a) throw E.notFound('자산을 찾을 수 없습니다');
  return a;
}

async function room(c: PoolClient, p: Principal, a: Record<string, any>, roomId: string) {
  const r = (await c.query(`SELECT r.id, r.room_code, r.site_id, s.site_code FROM room r JOIN site s ON s.id = r.site_id
     WHERE r.id = $1 AND r.is_active AND s.is_active`, [roomId])).rows[0];
  if (!r) throw E.badRequest('입력 값을 확인하세요: roomId 활성 룸이 아닙니다', { errors: [{ field: 'roomId', code: 'ALM-E100', message: '없음' }] });
  if (!allowsPlace(p, 'asset.assign', a.company_code, r.site_code)) throw E.forbidden('범위 밖 사이트로 옮길 수 없습니다');
  return r;
}

async function event(c: PoolClient, p: Principal, assetId: string, type: string, changes: unknown, reason?: string, requestId?: string) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes, reason, asset_request_id)
    VALUES ($1, $2, $3, $4, $5, 'UI', $6, $7, $8)`, [randomUUID(), p.tenantId, assetId, type, p.userId, JSON.stringify(changes), reason ?? null, requestId ?? null]);
}

// ---------------- 할당 ----------------
export async function checkOut(c: PoolClient, p: Principal, id: string, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const v = { userId: k.uuid(b, 'userId', { required: true }), costCenterId: k.uuid(b, 'costCenterId'), roomId: k.uuid(b, 'roomId', { required: true }),
    dueBackDate: k.date(b, 'dueBackDate'), note: k.str(b, 'note', { max: 200 }) };
  k.done();
  const a = await target(c, p, id);
  if (!['IN_STOCK', 'IN_USE'].includes(a.status)) throw state(`${a.status} 상태의 자산은 할당할 수 없습니다(재고·사용 중만)`);
  const user = (await c.query('SELECT id, display_name, cost_center_id FROM app_user WHERE id = $1 AND is_active', [v.userId])).rows[0];
  if (!user) throw E.badRequest('입력 값을 확인하세요: userId 활성 사용자가 아닙니다', { errors: [{ field: 'userId', code: 'ALM-E100', message: '없음' }] });
  const r = await room(c, p, a, v.roomId!);
  const ccId: string | null = v.costCenterId ?? user.cost_center_id ?? a.cost_center_id ?? null;
  if (ccId && ccId !== a.cost_center_id) {
    const ok = (await c.query('SELECT 1 FROM cost_center WHERE id = $1 AND company_id = $2 AND is_active', [ccId, a.company_id])).rowCount;
    if (!ok) throw E.badRequest('입력 값을 확인하세요: costCenterId 자산 회사코드의 활성 코스트센터가 아닙니다', { errors: [{ field: 'costCenterId', code: 'ALM-E100', message: '회사코드 불일치' }] });
  }

  // 코스트센터 변경: SAP 자산이면 요청(승인·전기 뒤 반영), 아니면 바로
  const createdRequests: Record<string, string>[] = [];
  const ccChanged = !!ccId && ccId !== a.cost_center_id;
  let newCc = a.cost_center_id;
  const sapOn = !!a.sap_asset_no && !!(await c.query('SELECT sap_enabled FROM company WHERE id = $1', [a.company_id])).rows[0]?.sap_enabled;
  if (ccChanged && sapOn) {
    const open = (await c.query(`SELECT request_no FROM asset_request WHERE asset_id = $1 AND status NOT IN ('POSTED', 'REJECTED', 'CANCELLED') LIMIT 1`, [a.id])).rows[0];
    if (open) throw new AlmError(409, 'ALM-E315', `이 자산에 진행 중인 요청(${open.request_no})이 있어 코스트센터를 바꿀 수 없습니다`);
    createdRequests.push(await transferRequest(c, p, a, ccId!, r.id));
  } else if (ccChanged) newCc = ccId;

  await c.query(`UPDATE asset_assignment SET returned_at = now(), updated_at = now(), updated_by = $2, version = version + 1 WHERE asset_id = $1 AND returned_at IS NULL`,
    [a.id, p.userId]);
  await c.query(`INSERT INTO asset_assignment (id, tenant_id, asset_id, user_id, cost_center_id, room_id, checked_out_at, due_back_date, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9)`, [randomUUID(), p.tenantId, a.id, user.id, ccId, r.id, v.dueBackDate ?? null, v.note ?? null, p.userId]);
  await c.query(`UPDATE asset SET status = 'IN_USE', assigned_user_id = $2, assigned_at = now(), due_back_date = $3, room_id = $4, site_id = $5,
      cost_center_id = $6, updated_at = now(), updated_by = $7, version = version + 1 WHERE id = $1`,
  [a.id, user.id, v.dueBackDate ?? null, r.id, r.site_id, newCc, p.userId]);
  await event(c, p, a.id, 'ASSIGNED', {
    status: { before: a.status, after: 'IN_USE' }, assigned_user_id: { before: a.assigned_user_id, after: user.id },
    ...(a.room_id !== r.id ? { room_id: { before: a.room_id, after: r.id } } : {}),
    ...(newCc !== a.cost_center_id ? { cost_center_id: { before: a.cost_center_id, after: newCc } } : {}),
    ...(ccChanged && a.sap_asset_no ? { pendingCostCenter: ccId } : {}),
  }, v.note, createdRequests[0]?.id);
  return { asset: await detail(c, p, a.id), createdRequests };
}

// 코스트센터 변경 요청: 손익센터·세그먼트가 다르면 이관(TRANSFER), 같으면 변경(CHANGE). 2단계 승인 대기(09 2장 S-14)
async function transferRequest(c: PoolClient, p: Principal, a: Record<string, any>, ccId: string, roomId: string) {
  const pc = (await c.query(`SELECT cc.id, pc.profit_center_code, pc.segment FROM cost_center cc LEFT JOIN profit_center pc ON pc.id = cc.profit_center_id
     WHERE cc.id = ANY($1)`, [[a.cost_center_id, ccId].filter(Boolean)])).rows;
  const from = pc.find((x) => x.id === a.cost_center_id), to = pc.find((x) => x.id === ccId);
  const pcChange = !from || !to || (from.profit_center_code ?? null) !== (to.profit_center_code ?? null) || (from.segment ?? null) !== (to.segment ?? null);
  const type = pcChange ? 'TRANSFER' : 'CHANGE';
  const id = randomUUID();
  const [no] = await nextNumbers(c, p.tenantId, 'asset_request');
  await c.query(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, asset_id, requester_id, submitted_at, reason,
      target_cost_center_id, target_room_id, is_profit_center_change, created_by, updated_by)
    VALUES ($1, $2, $3, $4, 'SUBMITTED', 'ASSIGNMENT', $5, $6, now(), 'ALM-111 할당에 따른 코스트센터 변경', $7, $8, $9, $6, $6)`,
  [id, p.tenantId, no, type, a.id, p.userId, ccId, roomId, pcChange]);
  for (const [step, role] of [[1, 'DEPT_MANAGER'], [2, 'ASSET_ACCOUNTANT']] as const) {
    await c.query(`INSERT INTO approval (id, tenant_id, asset_request_id, step_no, approver_role, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), p.tenantId, id, step, role, p.userId]);
  }
  return { id, requestNo: no, requestType: type, status: 'SUBMITTED' };
}

// ---------------- 반납 ----------------
export async function checkIn(c: PoolClient, p: Principal, id: string, body: unknown) {
  const k = new Check(body ?? {});
  const b = k.obj();
  const v = { roomId: k.uuid(b, 'roomId'), condition: k.oneOf(b, 'condition', ['GOOD', 'DAMAGED', 'UNUSED'] as const), note: k.str(b, 'note', { max: 200 }) };
  k.done();
  const a = await target(c, p, id);
  if (a.status !== 'IN_USE') throw state(`${a.status} 상태의 자산은 반납할 수 없습니다(사용 중만)`);
  let roomId: string | null = v.roomId ?? null, siteId: string | null = a.site_id;
  if (roomId) { const r = await room(c, p, a, roomId); siteId = r.site_id; }
  else if (a.site_id) {
    // 사이트의 IT 창고 룸(없으면 현재 위치 유지)
    roomId = (await c.query(`SELECT id FROM room WHERE site_id = $1 AND is_storage AND is_active ORDER BY room_code LIMIT 1`, [a.site_id])).rows[0]?.id ?? a.room_id;
  } else roomId = a.room_id;

  await c.query(`UPDATE asset_assignment SET returned_at = now(), note = coalesce($3, note), updated_at = now(), updated_by = $2, version = version + 1
    WHERE asset_id = $1 AND returned_at IS NULL`, [a.id, p.userId, v.note ?? null]);
  await c.query(`UPDATE asset SET status = 'IN_STOCK', assigned_user_id = NULL, assigned_at = NULL, due_back_date = NULL, room_id = $2, site_id = $3,
      updated_at = now(), updated_by = $4, version = version + 1 WHERE id = $1`, [a.id, roomId, siteId, p.userId]);
  await event(c, p, a.id, 'RETURNED', {
    status: { before: 'IN_USE', after: 'IN_STOCK' }, assigned_user_id: { before: a.assigned_user_id, after: null },
    ...(roomId !== a.room_id ? { room_id: { before: a.room_id, after: roomId } } : {}), ...(v.condition ? { condition: v.condition } : {}),
  }, v.note);
  return { asset: await detail(c, p, a.id), createdRequests: [] };
}

// ---------------- 수리 ----------------
export async function repair(c: PoolClient, p: Principal, id: string, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const v = { direction: k.oneOf(b, 'direction', ['IN', 'OUT'] as const), vendorId: k.uuid(b, 'vendorId'), ticketNo: k.str(b, 'ticketNo', { max: 30 }),
    note: k.str(b, 'note', { max: 200 }) };
  if (!v.direction && !k.errors.length) k.errors.push({ field: 'direction', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  const a = await target(c, p, id);
  if (v.vendorId && !(await c.query('SELECT 1 FROM vendor WHERE id = $1', [v.vendorId])).rowCount) {
    throw E.badRequest('입력 값을 확인하세요: vendorId 공급사가 없습니다', { errors: [{ field: 'vendorId', code: 'ALM-E100', message: '없음' }] });
  }
  const info = { ...(v.vendorId ? { vendorId: v.vendorId } : {}), ...(v.ticketNo ? { ticketNo: v.ticketNo } : {}) };
  if (v.direction === 'IN') {
    if (!['IN_STOCK', 'IN_USE'].includes(a.status)) throw state(`${a.status} 상태의 자산은 수리 입고할 수 없습니다(재고·사용 중만)`);
    await c.query(`UPDATE asset SET status = 'IN_REPAIR', updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [a.id, p.userId]);
    await event(c, p, a.id, 'REPAIR_IN', { status: { before: a.status, after: 'IN_REPAIR' }, ...info }, v.note);
  } else {
    if (a.status !== 'IN_REPAIR') throw state(`${a.status} 상태의 자산은 수리 출고할 수 없습니다(수리 중만)`);
    // 수리 입고 직전 상태로. 그 사이 할당이 끝났으면 재고로
    const prev = (await c.query(`SELECT changes->'status'->>'before' AS s FROM asset_event WHERE asset_id = $1 AND event_type = 'REPAIR_IN'
      ORDER BY occurred_at DESC, created_at DESC LIMIT 1`, [a.id])).rows[0]?.s;
    const back = prev === 'IN_USE' && a.assigned_user_id ? 'IN_USE' : 'IN_STOCK';
    await c.query(`UPDATE asset SET status = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [a.id, back, p.userId]);
    await event(c, p, a.id, 'REPAIR_OUT', { status: { before: 'IN_REPAIR', after: back }, ...info }, v.note);
  }
  return { asset: await detail(c, p, a.id), createdRequests: [] };
}
