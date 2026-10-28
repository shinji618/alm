// Bundle 자산(2026-10-19 요청). WBS 4.2
//   ALM에서는 구성품을 각각 자산태그로 관리하고, SAP에는 Bundle 1건만 등록한다(NEW_ASSET은 Bundle에만).
//   구성품: SAP 자산번호가 없는 ALM 자산만. Bundle 안에 Bundle은 넣지 않는다. 같은 회사코드. 한 Bundle에만.
//   구성품은 SAP 신규 등록 요청을 받지 않는다(requests.validate). 다른 요청은 SAP 자산번호가 없으므로 ALM에만 반영된다.
//   연동: 폐기·처분 시 함께(cascadeBundle, requests.applyRequest가 부름) · 실사는 구성품별(Bundle은 대상 제외, SAP 실사일은 Bundle로)
//         · 재산세는 Bundle 기준(구성품 제외, Bundle 원가 = SAP 취득가 → 구매가 → 구성품 구매가 합)
//   위치·코스트센터는 구성품마다 따로 둔다(따라가지 않음).
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../platform/identity/principal';
import { assetScope, can, Params } from '../auth/scope';

export const MAX_COMPONENTS = 200;
const OPEN = ['DRAFT', 'SUBMITTED', 'MGR_APPROVED', 'ACCT_APPROVED', 'POST_ERROR'];
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type Problem = { field: string; code: string; message: string };

/** 본문 { assetIds?, assetTags? } → 중복 없는 id·태그 목록 */
export function parseComponentRefs(k: Check, b: Record<string, unknown>) {
  const ids = k.arr(b, 'assetIds', { max: MAX_COMPONENTS }).map((x, i) => { const s = typeof x === 'string' ? x : ''; if (!UUID.test(s)) k.fail(`assetIds[${i}]`, 'uuid'); return s; });
  const tags = k.arr(b, 'assetTags', { max: MAX_COMPONENTS }).map((x, i) => { const s = typeof x === 'string' ? x.trim().toUpperCase() : ''; if (!s || s.length > 25) k.fail(`assetTags[${i}]`, '자산태그'); return s; });
  return { ids: [...new Set(ids)], tags: [...new Set(tags)] };
}

/** 구성품을 Bundle에 넣는다. 하나라도 안 되면 아무것도 넣지 않고 409(detail.errors에 자산별 이유) */
export async function attachComponents(c: PoolClient, p: Principal, bundle: Record<string, any>, refs: { ids: string[]; tags: string[] }) {
  if (!refs.ids.length && !refs.tags.length) return [];
  const ps = new Params([refs.ids, refs.tags, OPEN]);
  const rows = (await c.query(`SELECT a.id, a.asset_tag, a.is_bundle, a.parent_asset_id, a.sap_asset_no, a.company_id, a.status, b.asset_tag AS bundle_tag,
        (SELECT r.request_no FROM asset_request r WHERE r.asset_id = a.id AND r.request_type = 'NEW_ASSET' AND r.status::text = ANY($3::text[]) LIMIT 1) AS open_new
       FROM asset a LEFT JOIN asset b ON b.id = a.parent_asset_id
      WHERE (a.id = ANY($1::uuid[]) OR upper(a.asset_tag) = ANY($2::text[])) AND ${assetScope(p, 'asset.write', ps)}
      ORDER BY a.asset_tag FOR UPDATE OF a`, ps.values)).rows;
  const errors: Problem[] = [];
  const found = new Set(rows.flatMap((r) => [r.id as string, String(r.asset_tag).toUpperCase()]));
  for (const x of [...refs.ids, ...refs.tags]) if (!found.has(x)) errors.push({ field: x, code: 'ALM-E404', message: '자산을 찾을 수 없거나 수정 권한이 없습니다' });
  const add: Record<string, any>[] = [];
  for (const r of rows) {
    const bad = (message: string) => errors.push({ field: r.asset_tag, code: 'ALM-E322', message });
    if (r.id === bundle.id) bad('Bundle 자신은 구성품이 될 수 없습니다');
    else if (r.is_bundle) bad('Bundle은 다른 Bundle에 넣을 수 없습니다');
    else if (r.parent_asset_id === bundle.id) continue;   // 이미 이 Bundle의 구성품
    else if (r.parent_asset_id) bad(`이미 다른 Bundle(${r.bundle_tag})의 구성품입니다`);
    else if (r.sap_asset_no) bad('SAP에 등록된 자산은 구성품이 될 수 없습니다');
    else if (r.company_id !== bundle.company_id) bad('Bundle과 회사코드가 다릅니다');
    else if (['RETIRED', 'DISPOSED'].includes(r.status)) bad('폐기·처분된 자산입니다');
    else if (r.open_new) bad(`진행 중인 SAP 신규 등록 요청(${r.open_new})이 있습니다`);
    else add.push(r);
  }
  if (errors.length) {
    throw new AlmError(409, 'ALM-E322', `구성품으로 넣을 수 없는 자산이 ${errors.length}건 있습니다: ${errors.slice(0, 3).map((e) => `${e.field} ${e.message}`).join('; ')}`, { errors });
  }
  if (!add.length) return [];
  await c.query(`UPDATE asset SET parent_asset_id = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = ANY($1::uuid[])`,
    [add.map((r) => r.id), bundle.id, p.userId]);
  for (const r of add) await event(c, p, r.id, { bundle: { before: null, after: bundle.asset_tag } });
  await event(c, p, bundle.id, { componentsAdded: add.map((r) => r.asset_tag) });
  return add.map((r) => r.asset_tag as string);
}

async function bundleFor(c: PoolClient, p: Principal, id: string) {
  if (!UUID.test(id)) throw E.notFound('자산을 찾을 수 없습니다');
  const ps = new Params([id]);
  const b = (await c.query(`SELECT a.* FROM asset a WHERE a.id = $1 AND ${assetScope(p, 'asset.write', ps)} FOR UPDATE`, ps.values)).rows[0];
  if (!b) throw E.notFound('자산을 찾을 수 없습니다');
  if (!b.is_bundle) throw new AlmError(409, 'ALM-E322', 'Bundle 자산이 아닙니다');
  if (['RETIRED', 'DISPOSED'].includes(b.status)) throw new AlmError(409, 'ALM-E322', '폐기·처분된 Bundle은 구성품을 바꿀 수 없습니다');
  return b;
}

// POST /assets/{id}/components
export async function addComponents(c: PoolClient, p: Principal, id: string, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const refs = parseComponentRefs(k, b);
  if (!refs.ids.length && !refs.tags.length) k.errors.push({ field: 'assetIds', code: 'ALM-E101', message: 'assetIds 또는 assetTags가 필요합니다' });
  k.done();
  const bundle = await bundleFor(c, p, id);
  const added = await attachComponents(c, p, bundle, refs);
  const n = (await c.query('SELECT count(*)::int AS n FROM asset WHERE parent_asset_id = $1', [id])).rows[0].n as number;
  if (n > MAX_COMPONENTS) throw E.badRequest(`입력 값을 확인하세요: assetIds 구성품은 ${MAX_COMPONENTS}개까지입니다`);
  return { added, ...(await bundleView(c, p, bundle)) };
}

// DELETE /assets/{id}/components/{componentId}
export async function removeComponent(c: PoolClient, p: Principal, id: string, componentId: string) {
  const bundle = await bundleFor(c, p, id);
  if (!UUID.test(componentId)) throw E.notFound('구성품을 찾을 수 없습니다');
  const r = (await c.query('SELECT id, asset_tag FROM asset WHERE id = $1 AND parent_asset_id = $2 FOR UPDATE', [componentId, id])).rows[0];
  if (!r) throw E.notFound('이 Bundle의 구성품이 아닙니다');
  await c.query('UPDATE asset SET parent_asset_id = NULL, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1', [componentId, p.userId]);
  await event(c, p, componentId, { bundle: { before: bundle.asset_tag, after: null } });
  await event(c, p, id, { componentsRemoved: [r.asset_tag] });
  return bundleView(c, p, bundle);
}

/** 상세 화면용: Bundle이면 구성품 목록·합계, 구성품이면 소속 Bundle */
export async function bundleView(c: PoolClient, p: Principal, a: Record<string, any>) {
  const amount = can(p, 'amount.read');
  if (a.is_bundle) {
    const rows = (await c.query(`SELECT a.id, a.asset_tag, a.description, a.status, a.serial_no, a.purchase_cost, cat.name AS category_name, r.room_code,
        u.display_name AS user_name FROM asset a JOIN category cat ON cat.id = a.category_id LEFT JOIN room r ON r.id = a.room_id
        LEFT JOIN app_user u ON u.id = a.assigned_user_id WHERE a.parent_asset_id = $1 ORDER BY a.asset_tag`, [a.id])).rows;
    const costs = rows.filter((x) => !['RETIRED', 'DISPOSED'].includes(x.status)).map((x) => numOrNull(x.purchase_cost));
    return {
      components: rows.map((x) => Object.fromEntries(Object.entries({ id: x.id, assetTag: x.asset_tag, description: x.description, status: x.status,
        categoryName: x.category_name, serialNo: x.serial_no ?? undefined, roomCode: x.room_code ?? undefined, assignedUserName: x.user_name ?? undefined,
        purchaseCost: amount ? numOrNull(x.purchase_cost) : null }).filter(([, v]) => v !== undefined))),
      componentCostTotal: amount ? Math.round(costs.reduce<number>((s, v) => s + (v ?? 0), 0) * 100) / 100 : null,
    };
  }
  if (a.parent_asset_id) {
    const b = (await c.query('SELECT id, asset_tag, description, sap_asset_no, sap_sub_no FROM asset WHERE id = $1', [a.parent_asset_id])).rows[0];
    if (b) return { bundle: Object.fromEntries(Object.entries({ id: b.id, assetTag: b.asset_tag, description: b.description,
      sapAssetNo: b.sap_asset_no ? `${b.sap_asset_no}-${b.sap_sub_no ?? '0000'}` : undefined }).filter(([, v]) => v !== undefined)) };
  }
  return {};
}

/** 구성품 구매가 합(Bundle SAP 등록 취득가 기본값) */
export async function componentCost(c: PoolClient, bundleId: string): Promise<number> {
  return Number((await c.query(`SELECT coalesce(sum(purchase_cost), 0) AS s FROM asset WHERE parent_asset_id = $1 AND status NOT IN ('RETIRED', 'DISPOSED')`, [bundleId])).rows[0].s);
}

/** Bundle이 폐기(RETIRED)·처분(DISPOSED)되면 아직 쓰는 구성품도 같은 상태로. 할당은 반납 처리. 이력은 구성품마다 */
export async function cascadeBundle(c: PoolClient, bundle: Record<string, any>, status: 'RETIRED' | 'DISPOSED', requestId: string | null, requestNo: string) {
  const rows = (await c.query(`UPDATE asset SET status = $2::asset_status, assigned_user_id = NULL, assigned_at = NULL, updated_at = now(), version = version + 1
     WHERE parent_asset_id = $1 AND status NOT IN ('RETIRED', 'DISPOSED') RETURNING id, asset_tag`, [bundle.id, status])).rows;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as string);
  await c.query(`UPDATE asset_assignment SET returned_at = now(), updated_at = now(), version = version + 1 WHERE asset_id = ANY($1::uuid[]) AND returned_at IS NULL`, [ids]);
  for (const r of rows) {
    await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, changes, asset_request_id, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), bundle.tenant_id, r.id, status, bundle.sap_asset_no ? 'SAP' : 'UI', JSON.stringify({ requestNo, bundle: bundle.asset_tag, status }), requestId,
      `Bundle ${bundle.asset_tag} ${status === 'RETIRED' ? '폐기' : '처분'}에 따라`.slice(0, 200)]);
  }
  return rows.map((r) => r.asset_tag as string).sort();
}

async function event(c: PoolClient, p: Principal, assetId: string, changes: unknown) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes) VALUES ($1, $2, $3, 'UPDATED', $4, 'UI', $5)`,
    [randomUUID(), p.tenantId, assetId, p.userId, JSON.stringify(changes)]);
}
