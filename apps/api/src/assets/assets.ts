// 자산 목록·상세·등록·수정(ALM-110~112, openapi listAssets·getAsset·createAsset·patchAsset 외). WBS 4.2
//   범위: asset.read·asset.write의 역할 행 범위(09 4.1, auth/scope). 범위 밖 단건은 404.
//   금액: amount.read가 없으면 null(09 4.2).
//   등록: 태그 AT-nnnnnn, IN_USE면 할당 행, 라벨 대기열. SAP 등록(registerInSap)은 등록자가 판단해 체크한다(자동 판단 없음):
//         체크하면 자산클래스·구매가 필수 → 신규 자산 요청(NEW_ASSET, 부서 관리자 → 자산회계 승인 대기) → 최종 승인 뒤 IF-AA-03.
//   수정: If-Match(version) 필수 → 다르면 409 ALM-E310. SAP 기준 필드(자산클래스·취득가·코스트센터·회사코드)는 422 ALM-E211.
//         SAP 자산번호가 있는 자산의 자산명·시리얼·룸 변경은 ALM에 바로 반영하고 변경 요청(CHANGE) + SAP 전기 건(ASSET_CHANGE)을 만든다.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../auth/principal';
import { allowsPlace, assetScope, can, Params } from '../auth/scope';
import { nextAssetTags, nextNumbers } from './tags';
import { defaultTemplateId } from '../labels/labels';
import { attachComponents, bundleView, componentCost } from './bundles';

export const STATUSES = ['ON_ORDER', 'IN_STOCK', 'IN_USE', 'IN_REPAIR', 'MISSING', 'RETIRED', 'DISPOSED'] as const;
export const STAGES = ['PLAN', 'PROCURE', 'DEPLOY', 'OPERATE', 'MAINTAIN', 'RETIRE'] as const;
const QUICK = ['WARRANTY_90', 'PAST_USEFUL_LIFE', 'NON_SAP', 'UNCOUNTED_1Y'] as const;
// SAP 기준 필드: ALM 수정 API로 못 바꾼다
const SAP_FIELDS = ['assetClassId', 'purchaseCost', 'acquisitionValue', 'costCenterId', 'companyId'];
const PATCHABLE = ['description', 'modelId', 'serialNo', 'roomId', 'hostname', 'ipAddress', 'macAddress', 'warrantyEndDate', 'dueBackDate', 'notes'] as const;
// 이력의 금액 필드(amount.read 없으면 값 숨김)
const AMOUNT_KEYS = new Set(['purchase_cost', 'purchaseCost', 'acquisition_value', 'acquisitionValue', 'net_book_value', 'sale_amount', 'unit_price']);
const UPDATABLE = ['description', 'serial_no', 'hostname', 'ip_address', 'mac_address', 'warranty_end_date', 'due_back_date', 'notes',
  'model_id', 'room_id', 'site_id'];
const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// ---------------- 목록 ----------------
const SORT: Record<string, string> = {
  updatedAt: 'a.updated_at', assetTag: 'a.asset_tag', description: 'a.description', status: 'a.status', serialNo: 'a.serial_no',
  categoryName: 'c.name', siteCode: 's.site_code', roomCode: 'r.room_code', assignedUserName: 'u.display_name',
  costCenterCode: 'cc.cost_center_code', warrantyEndDate: 'a.warranty_end_date', sapAssetNo: 'a.sap_asset_no', nbv: 'vl.net_book_value',
};

export async function listAssets(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const page = intParam(k, q, 'page', 1, 1, 100000), pageSize = intParam(k, q, 'pageSize', 50, 1, 500);
  const ids: Record<string, string | undefined> = {};
  for (const f of ['categoryId', 'siteId', 'roomId', 'costCenterId', 'assignedUserId']) ids[f] = k.uuid(q, f);
  const status = csv(k, q, 'status', STATUSES), stage = csv(k, q, 'stage', STAGES);
  const quick = k.oneOf(q, 'quick', QUICK);
  const sorts = (q.sort ?? '-updatedAt').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3).map((s) => {
    const desc = s.startsWith('-'), f = desc ? s.slice(1) : s;
    if (!(f in SORT) || (f === 'nbv' && !can(p, 'amount.read'))) { k.fail('sort', `정렬 필드: ${Object.keys(SORT).join(', ')}`); return ''; }
    return `${SORT[f]} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
  });
  k.done();

  const ps = new Params();
  const where = [assetScope(p, 'asset.read', ps)];
  if (q.q?.trim()) {
    const t = ps.add(`%${likeEsc(q.q.trim().slice(0, 100))}%`);
    where.push(`(a.asset_tag ILIKE ${t} OR a.serial_no ILIKE ${t} OR a.hostname ILIKE ${t} OR host(a.ip_address) ILIKE ${t}
      OR a.description ILIKE ${t} OR u.display_name ILIKE ${t} OR u.email ILIKE ${t} OR a.sap_asset_no ILIKE ${t})`);
  }
  if (ids.categoryId) {
    where.push(`a.category_id IN (WITH RECURSIVE t AS (SELECT id FROM category WHERE id = ${ps.add(ids.categoryId)}
      UNION ALL SELECT x.id FROM category x JOIN t ON x.parent_id = t.id) SELECT id FROM t)`);
  }
  if (ids.siteId) where.push(`a.site_id = ${ps.add(ids.siteId)}`);
  if (ids.roomId) where.push(`a.room_id = ${ps.add(ids.roomId)}`);
  if (ids.costCenterId) where.push(`a.cost_center_id = ${ps.add(ids.costCenterId)}`);
  if (ids.assignedUserId) where.push(`a.assigned_user_id = ${ps.add(ids.assignedUserId)}`);
  if (status.length) where.push(`a.status::text = ANY(${ps.add(status)})`);
  if (stage.length) where.push(`st.stage = ANY(${ps.add(stage)})`);
  switch (quick) {
    case 'WARRANTY_90': where.push(`a.warranty_end_date BETWEEN current_date AND current_date + 90`); break;
    case 'PAST_USEFUL_LIFE': where.push(`st.useful_life_end < current_date AND a.status NOT IN ('RETIRED', 'DISPOSED')`); break;
    case 'NON_SAP': where.push(`a.sap_asset_no IS NULL AND a.status NOT IN ('RETIRED', 'DISPOSED')`); break;
    case 'UNCOUNTED_1Y': where.push(`(a.last_count_date IS NULL OR a.last_count_date < current_date - 365) AND a.status NOT IN ('RETIRED', 'DISPOSED')`); break;
  }
  const from = `FROM asset a
    JOIN category c ON c.id = a.category_id
    LEFT JOIN model m ON m.id = a.model_id
    LEFT JOIN site s ON s.id = a.site_id
    LEFT JOIN room r ON r.id = a.room_id
    LEFT JOIN app_user u ON u.id = a.assigned_user_id
    LEFT JOIN cost_center cc ON cc.id = a.cost_center_id
    LEFT JOIN v_asset_stage st ON st.asset_id = a.id
    LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id
    LEFT JOIN asset pb ON pb.id = a.parent_asset_id
    WHERE ${where.join(' AND ')}`;
  const total = (await c.query(`SELECT count(*)::int AS n ${from}`, ps.values)).rows[0].n as number;
  const off = ps.add((page - 1) * pageSize), lim = ps.add(pageSize);
  const rows = (await c.query(
    `SELECT a.id, a.asset_tag, a.description, c.name AS category_name, m.manufacturer, m.model_name, a.serial_no, a.status, st.stage,
            s.site_code, r.room_code, u.display_name AS user_name, cc.cost_center_code, a.sap_asset_no, a.sap_sub_no, a.warranty_end_date,
            vl.net_book_value, a.updated_at, a.is_bundle, pb.asset_tag AS bundle_tag,
            (SELECT count(*)::int FROM asset x WHERE x.parent_asset_id = a.id) AS component_count
       ${from} ORDER BY ${[...sorts, 'a.id'].join(', ')} OFFSET ${off} LIMIT ${lim}`, ps.values)).rows;
  const amount = can(p, 'amount.read');
  return {
    items: rows.map((r) => clean({
      id: r.id, assetTag: r.asset_tag, description: r.description, categoryName: r.category_name,
      modelName: r.model_name ? `${r.manufacturer} ${r.model_name}` : undefined, serialNo: r.serial_no ?? undefined, status: r.status,
      stage: r.stage ?? 'OPERATE', siteCode: r.site_code ?? undefined, roomCode: r.room_code ?? undefined, assignedUserName: r.user_name ?? undefined,
      costCenterCode: r.cost_center_code ?? undefined, sapAssetNo: r.sap_asset_no ? `${r.sap_asset_no}-${r.sap_sub_no ?? '0000'}` : undefined,
      warrantyEndDate: day(r.warranty_end_date), nbv: amount ? numOrNull(r.net_book_value) : null, updatedAt: iso(r.updated_at),
      isBundle: r.is_bundle || undefined, componentCount: r.is_bundle ? r.component_count : undefined, bundleAssetTag: r.bundle_tag ?? undefined,
    })),
    page, pageSize, total,
  };
}

function intParam(k: Check, q: Record<string, string | undefined>, f: string, def: number, min: number, max: number): number {
  const v = q[f];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) { k.fail(f, `${min}~${max} 정수`); return def; }
  return n;
}
function csv<T extends string>(k: Check, q: Record<string, string | undefined>, f: string, allowed: readonly T[]): T[] {
  const v = q[f];
  if (!v) return [];
  const xs = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = xs.filter((x) => !allowed.includes(x as T));
  if (bad.length) k.fail(f, `${allowed.join(', ')} 중에서`);
  return xs.filter((x) => allowed.includes(x as T)) as T[];
}

// ---------------- 상세 ----------------
// 범위 안 자산 한 건(없거나 범위 밖이면 404)
async function scoped(c: PoolClient, p: Principal, perm: string, id: string, lock = false) {
  if (!UUID.test(id)) throw E.notFound('자산을 찾을 수 없습니다');
  const ps = new Params([id]);
  const r = (await c.query(`SELECT a.* FROM asset a WHERE a.id = $1 AND ${assetScope(p, perm, ps)}${lock ? ' FOR UPDATE' : ''}`, ps.values)).rows[0];
  if (!r) throw E.notFound('자산을 찾을 수 없습니다');
  return r;
}

export async function getAsset(c: PoolClient, p: Principal, id: string) {
  await scoped(c, p, 'asset.read', id);
  return detail(c, p, id);
}

export async function detail(c: PoolClient, p: Principal, id: string) {
  const r = (await c.query(
    `SELECT a.*, host(a.ip_address) AS ip, st.stage, co.company_code, co.sap_enabled, ac.class_code, ac.default_useful_life_years,
            vl.fiscal_year, vl.period, vl.acquisition_value, vl.accum_depreciation, vl.net_book_value, vl.useful_life_years AS vl_life
       FROM asset a JOIN company co ON co.id = a.company_id
       LEFT JOIN asset_class ac ON ac.id = a.asset_class_id
       LEFT JOIN v_asset_stage st ON st.asset_id = a.id
       LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id
      WHERE a.id = $1`, [id])).rows[0];
  if (!r) throw E.notFound('자산을 찾을 수 없습니다');
  const reqs = (await c.query(`SELECT id, request_no, request_type, status FROM asset_request
     WHERE asset_id = $1 AND status NOT IN ('POSTED', 'REJECTED', 'CANCELLED') ORDER BY created_at DESC`, [id])).rows;
  const amount = can(p, 'amount.read');
  // 구매·입고(IF-MM-01·03): 입고로 연결된 PO 항목, 없으면 PO가 이 자산을 지정한 항목
  const po = (await c.query(`SELECT pi.po_no, pi.item_no, pi.vendor_name, pi.description, pi.quantity::float8 AS quantity, pi.gr_quantity::float8 AS gr_quantity,
      pi.unit_price, pi.is_deleted, gr.material_doc, gr.doc_year, gr.doc_item, gr.movement_type, gr.quantity::float8 AS gr_qty, gr.posting_date
     FROM po_item pi LEFT JOIN goods_receipt gr ON gr.id = $2
    WHERE pi.id = coalesce($1, (SELECT po_item_id FROM po_item_asset WHERE asset_id = $3 ORDER BY created_at DESC LIMIT 1))`,
  [r.po_item_id, r.goods_receipt_id, id])).rows[0];
  const ps = new Params([id]);
  const writable = can(p, 'asset.write') && !!(await c.query(`SELECT 1 FROM asset a WHERE a.id = $1 AND ${assetScope(p, 'asset.write', ps)}`, ps.values)).rowCount
    && !['DISPOSED'].includes(r.status);
  return clean({
    id: r.id, version: r.version, assetTag: r.asset_tag, description: r.description, categoryId: r.category_id, modelId: r.model_id ?? undefined,
    serialNo: r.serial_no ?? undefined, status: r.status, stage: r.stage ?? 'OPERATE', source: r.source, siteId: r.site_id ?? undefined,
    roomId: r.room_id ?? undefined, costCenterId: r.cost_center_id ?? undefined, assignedUserId: r.assigned_user_id ?? undefined,
    assignedAt: iso(r.assigned_at), dueBackDate: day(r.due_back_date), hostname: r.hostname ?? undefined, ipAddress: r.ip ?? undefined,
    macAddress: r.mac_address ?? undefined, osName: r.os_name ?? undefined, warrantyEndDate: day(r.warranty_end_date),
    lastCountDate: day(r.last_count_date), lastSeenAt: iso(r.last_seen_at), notes: r.notes ?? undefined,
    financial: clean({
      isCapitalized: r.is_capitalized, companyCode: r.company_code, sapEnabled: r.sap_enabled, sapAssetNo: r.sap_asset_no ?? undefined, sapSubNo: r.sap_sub_no ?? undefined,
      assetClass: r.class_code ?? undefined, capDate: day(r.sap_cap_date),
      acquisitionValue: amount ? numOrNull(r.acquisition_value) : null, accumDepreciation: amount ? numOrNull(r.accum_depreciation) : null,
      netBookValue: amount ? numOrNull(r.net_book_value) : null, usefulLifeYears: r.vl_life ?? r.default_useful_life_years ?? undefined,
      valueAsOf: r.fiscal_year ? `${r.fiscal_year}/${String(r.period).padStart(3, '0')}` : undefined,
      tcoEstimate: amount ? numOrNull(r.purchase_cost) : null, sapSyncedAt: iso(r.sap_synced_at),
    }),
    purchase: po ? clean({
      poNo: po.po_no, poItem: po.item_no, vendorName: po.vendor_name ?? undefined, description: po.description, quantity: po.quantity,
      grQuantity: po.gr_quantity, unitPrice: amount ? numOrNull(po.unit_price) : null, isDeleted: po.is_deleted || undefined,
      goodsReceipt: po.material_doc ? { materialDoc: po.material_doc, docYear: po.doc_year, docItem: po.doc_item, movementType: po.movement_type,
        quantity: po.gr_qty, postingDate: day(po.posting_date) } : undefined,
      isGrCancelled: r.is_gr_cancelled || undefined,
    }) : undefined,
    openRequests: reqs.map((x) => ({ id: x.id, requestNo: x.request_no, requestType: x.request_type, status: x.status })),
    isBundle: r.is_bundle || undefined, ...(await bundleView(c, p, r)),
    editableFields: writable ? PATCHABLE.filter((f) => f !== 'dueBackDate' || r.status === 'IN_USE') : [],
  });
}

// ---------------- 등록 ----------------
/** opts.assetTag: 일괄 업로드에서 기존 라벨 태그를 그대로 쓸 때(자동 채번 대신, 본문으로는 받지 않음) */
export async function createAsset(c: PoolClient, p: Principal, body: unknown, opts: { assetTag?: string } = {}) {
  const k = new Check(body);
  const b = k.obj();
  const v = {
    isBundle: k.bool(b, 'isBundle') ?? false,
    categoryId: k.uuid(b, 'categoryId', { required: true }), modelId: k.uuid(b, 'modelId', { required: b.isBundle !== true }),
    description: k.str(b, 'description', { required: true, max: 50 }), serialNo: k.str(b, 'serialNo', { max: 40 }),
    companyId: k.uuid(b, 'companyId', { required: true }), roomId: k.uuid(b, 'roomId', { required: true }),
    costCenterId: k.uuid(b, 'costCenterId', { required: true }), assetClassId: k.uuid(b, 'assetClassId'),
    status: k.oneOf(b, 'status', ['ON_ORDER', 'IN_STOCK', 'IN_USE'] as const) ?? 'IN_STOCK', assignedUserId: k.uuid(b, 'assignedUserId'),
    purchaseDate: k.date(b, 'purchaseDate'), purchaseCost: k.num(b, 'purchaseCost', { min: 0, max: 1e12 }),
    warrantyEndDate: k.date(b, 'warrantyEndDate'), hostname: k.str(b, 'hostname', { max: 63 }), notes: k.str(b, 'notes', { max: 4000 }),
    printLabel: k.bool(b, 'printLabel') ?? true, registerInSap: k.bool(b, 'registerInSap') ?? false,
  };
  // Bundle: 구성품(SAP에 없는 ALM 자산)을 함께 넣을 수 있다. SAP 등록 취득가가 없으면 구성품 구매가 합
  const componentIds = [...new Set(k.arr(b, 'componentIds', { max: 200 }).map((x, i) => { const s = typeof x === 'string' ? x : ''; if (!UUID.test(s)) k.fail(`componentIds[${i}]`, 'uuid'); return s; }))];
  if (componentIds.length && !v.isBundle) k.fail('componentIds', 'Bundle(isBundle)일 때만 지정합니다');
  const costFromComponents = v.isBundle && v.registerInSap && v.purchaseCost === undefined && componentIds.length > 0;
  if (v.registerInSap && v.purchaseCost === undefined && !costFromComponents) k.errors.push({ field: 'purchaseCost', code: 'ALM-E101', message: 'SAP 등록이면 필수입니다' });
  else if (v.registerInSap && v.purchaseCost !== undefined && v.purchaseCost <= 0) k.fail('purchaseCost', 'SAP 등록이면 0보다 커야 합니다');
  if (v.status === 'IN_USE' && !v.assignedUserId) k.errors.push({ field: 'assignedUserId', code: 'ALM-E101', message: 'IN_USE면 필수입니다' });
  if (v.status !== 'IN_USE' && v.assignedUserId) k.fail('assignedUserId', 'IN_USE일 때만 지정합니다');
  k.done();

  const ref = await refs(c, { ...v });
  if (v.registerInSap && !(await c.query('SELECT sap_enabled FROM company WHERE id = $1', [v.companyId])).rows[0]?.sap_enabled) {
    throw E.badRequest('입력 값을 확인하세요: registerInSap 이 회사는 SAP 연계를 쓰지 않습니다', { errors: [{ field: 'registerInSap', code: 'ALM-E100', message: 'SAP 연계를 쓰지 않는 회사' }] });
  }
  if (!allowsPlace(p, 'asset.write', ref.companyCode, ref.siteCode)) throw E.forbidden('범위 밖 회사코드·사이트에는 등록할 수 없습니다');
  const classId = v.assetClassId ?? ref.defaultClassId ?? null;
  const cls = classId ? (await c.query('SELECT id, class_code, is_capitalized, is_low_value, is_active, is_manual FROM asset_class WHERE id = $1', [classId])).rows[0] : undefined;
  if (classId && !cls?.is_active) throw E.badRequest('입력 값을 확인하세요: assetClassId 활성 자산클래스가 아닙니다', { errors: [{ field: 'assetClassId', code: 'ALM-E100', message: '없음' }] });
  // 자산클래스는 SAP에서 받은 것만(2026-10-18). 예전에 ALM에서 만든 클래스는 고를 수 없다
  if (cls?.is_manual) {
    throw E.badRequest('입력 값을 확인하세요: assetClassId SAP에서 받은 자산클래스만 쓸 수 있습니다', { errors: [{ field: 'assetClassId', code: 'ALM-E100', message: 'SAP 자산클래스가 아님' }] });
  }
  if (v.registerInSap && !cls) {
    throw new AlmError(400, 'ALM-E101', '입력 값을 확인하세요: assetClassId SAP 등록이면 자산클래스가 필요합니다(카테고리 기본값 없음)',
      { errors: [{ field: 'assetClassId', code: 'ALM-E101', message: 'SAP 등록이면 필수입니다' }] });
  }

  const id = randomUUID();
  const tag = opts.assetTag ?? (await nextAssetTags(c, p.tenantId, 1))[0];
  await c.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, model_id, serial_no, status, source, company_id, site_id, room_id,
      cost_center_id, asset_class_id, assigned_user_id, assigned_at, purchase_date, purchase_cost, warranty_end_date, hostname, notes, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MANUAL', $9, $10, $11, $12, $13, $14, CASE WHEN $14::uuid IS NULL THEN NULL ELSE now() END, $15, $16, $17, $18, $19, $20, $20)`,
  [id, p.tenantId, tag, v.description, v.categoryId, v.modelId, v.serialNo ?? null, v.status, v.companyId, ref.siteId, v.roomId, v.costCenterId,
    classId, v.assignedUserId ?? null, v.purchaseDate ?? null, v.purchaseCost ?? null, v.warrantyEndDate ?? null, v.hostname ?? null, v.notes ?? null, p.userId]);
  if (v.status === 'IN_USE') {
    await c.query(`INSERT INTO asset_assignment (id, tenant_id, asset_id, user_id, cost_center_id, room_id, checked_out_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`, [randomUUID(), p.tenantId, id, v.assignedUserId, v.costCenterId, v.roomId, p.userId]);
  }
  await event(c, p, id, 'CREATED', clean({ source: 'MANUAL', assetTag: tag, status: v.status, isBundle: v.isBundle || undefined }));

  // SAP 등록 체크: 신규 자산 요청(승인 후 IF-AA-03). 체크하지 않으면 ALM에만 둔다
  if (v.isBundle) {
    await c.query('UPDATE asset SET is_bundle = true WHERE id = $1', [id]);
    if (componentIds.length) await attachComponents(c, p, { id, asset_tag: tag, company_id: v.companyId }, { ids: componentIds, tags: [] });
  }
  let value = v.purchaseCost;
  if (costFromComponents) {
    value = await componentCost(c, id);
    if (!(value > 0)) {
      throw new AlmError(400, 'ALM-E101', '입력 값을 확인하세요: purchaseCost 구성품 구매가 합이 0입니다(SAP 등록 취득가를 입력하세요)',
        { errors: [{ field: 'purchaseCost', code: 'ALM-E101', message: 'SAP 등록이면 필수입니다' }] });
    }
  }
  const createdRequest = v.registerInSap && cls
    ? await newAssetRequest(c, p, { assetId: id, classId: cls.id, value: value!, costCenterId: v.costCenterId!, roomId: v.roomId! })
    : undefined;
  let labelJobId: string | undefined;
  if (v.printLabel) {
    const t = await defaultTemplateId(c, p.tenantId);   // 템플릿이 없으면 기본 템플릿을 만든다(4.5)
    {
      labelJobId = randomUUID();
      await c.query(`INSERT INTO label_print_job (id, tenant_id, asset_id, template_id, source, requested_by, created_by) VALUES ($1, $2, $3, $4, 'ASSET_DETAIL', $5, $5)`,
        [labelJobId, p.tenantId, id, t, p.userId]);
    }
  }
  return clean({ asset: await detail(c, p, id), createdRequest, labelJobId });
}

// 참조 확인(활성·같은 회사코드·모델은 카테고리 소속)
async function refs(c: PoolClient, v: { categoryId?: string; modelId?: string; companyId?: string; roomId?: string; costCenterId?: string; assignedUserId?: string }) {
  const errs: { field: string; code: string; message: string }[] = [];
  const one = async (sql: string, id: string | undefined, field: string, msg: string) => {
    if (!id) return undefined;
    const r = (await c.query(sql, [id])).rows[0];
    if (!r) errs.push({ field, code: 'ALM-E100', message: msg });
    return r;
  };
  const cat = await one('SELECT id, default_asset_class_id FROM category WHERE id = $1 AND is_active', v.categoryId, 'categoryId', '활성 카테고리가 아닙니다');
  const model = await one('SELECT id, category_id FROM model WHERE id = $1 AND is_active', v.modelId, 'modelId', '활성 모델이 아닙니다');
  if (model && cat && model.category_id !== cat.id) errs.push({ field: 'modelId', code: 'ALM-E100', message: '카테고리에 속한 모델이 아닙니다' });
  const co = await one('SELECT id, company_code FROM company WHERE id = $1 AND is_active', v.companyId, 'companyId', '활성 회사코드가 아닙니다');
  const room = await one(`SELECT r.id, r.site_id, s.site_code, p.company_id AS plant_company FROM room r JOIN site s ON s.id = r.site_id
     LEFT JOIN plant p ON p.id = s.plant_id WHERE r.id = $1 AND r.is_active AND s.is_active`, v.roomId, 'roomId', '활성 룸이 아닙니다');
  const cc = await one('SELECT id, company_id FROM cost_center WHERE id = $1 AND is_active', v.costCenterId, 'costCenterId', '활성 코스트센터가 아닙니다');
  if (cc && co && cc.company_id !== co.id) errs.push({ field: 'costCenterId', code: 'ALM-E100', message: '회사코드의 코스트센터가 아닙니다' });
  await one('SELECT id FROM app_user WHERE id = $1 AND is_active', v.assignedUserId, 'assignedUserId', '활성 사용자가 아닙니다');
  if (errs.length) throw new AlmError(400, 'ALM-E100', `입력 값을 확인하세요: ${errs[0].field} ${errs[0].message}`, { errors: errs });
  return { companyCode: co?.company_code as string, siteId: room?.site_id as string | null, siteCode: room?.site_code as string | null,
    defaultClassId: cat?.default_asset_class_id as string | null };
}

// 신규 자산 요청(NEW_ASSET): 제출 상태 + 승인 2단계(부서 관리자 → 자산회계, 09 2장 S-14). 승인 처리는 4.3
async function newAssetRequest(c: PoolClient, p: Principal, o: { assetId: string; classId: string; value: number; costCenterId: string; roomId: string }) {
  const id = randomUUID();
  const [no] = await nextNumbers(c, p.tenantId, 'asset_request');
  await c.query(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, asset_id, requester_id, submitted_at, reason,
      asset_class_id, acquisition_value, target_cost_center_id, target_room_id, created_by, updated_by)
    VALUES ($1, $2, $3, 'NEW_ASSET', 'SUBMITTED', 'USER', $4, $5, now(), 'ALM-112 자산 등록(SAP 등록 체크)', $6, $7, $8, $9, $5, $5)`,
  [id, p.tenantId, no, o.assetId, p.userId, o.classId, o.value, o.costCenterId, o.roomId]);
  for (const [step, role] of [[1, 'DEPT_MANAGER'], [2, 'ASSET_ACCOUNTANT']] as const) {
    await c.query(`INSERT INTO approval (id, tenant_id, asset_request_id, step_no, approver_role, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), p.tenantId, id, step, role, p.userId]);
  }
  return { id, requestNo: no, requestType: 'NEW_ASSET', status: 'SUBMITTED' };
}

// ---------------- 수정 ----------------
export async function patchAsset(c: PoolClient, p: Principal, id: string, ifMatch: string | undefined, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const sapKeys = Object.keys(b).filter((x) => SAP_FIELDS.includes(x));
  if (sapKeys.length) throw new AlmError(422, 'ALM-E211', `SAP 기준 필드는 여기서 바꿀 수 없습니다: ${sapKeys.join(', ')} (코스트센터는 할당 또는 이관 요청으로)`);
  const unknown = Object.keys(b).filter((x) => !(PATCHABLE as readonly string[]).includes(x));
  if (unknown.length) k.fail(unknown[0], '바꿀 수 없는 필드입니다(상태는 할당·반납·수리 API로)');
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const v = {
    description: has('description') ? k.str(b, 'description', { required: true, max: 50 }) : undefined,
    modelId: has('modelId') ? k.uuid(b, 'modelId', { required: true }) : undefined,
    serialNo: k.str(b, 'serialNo', { max: 40 }), roomId: has('roomId') ? k.uuid(b, 'roomId', { required: true }) : undefined,
    hostname: k.str(b, 'hostname', { max: 63 }), ipAddress: k.str(b, 'ipAddress', { max: 39 }), macAddress: k.str(b, 'macAddress', { max: 17, pattern: MAC }),
    warrantyEndDate: k.date(b, 'warrantyEndDate'), dueBackDate: k.date(b, 'dueBackDate'), notes: k.str(b, 'notes', { max: 4000 }),
  };
  if (v.ipAddress && !IPV4.test(v.ipAddress) && !IPV6.test(v.ipAddress)) k.fail('ipAddress', 'IP 형식이 아닙니다');
  k.done();
  if (!ifMatch) throw new AlmError(428, 'ALM-E101', 'If-Match 헤더(version)가 필요합니다');

  const cur = await scoped(c, p, 'asset.write', id, true);
  if (String(cur.version) !== ifMatch.replace(/^W\//, '').replace(/"/g, '')) {
    throw new AlmError(409, 'ALM-E310', '다른 사람이 먼저 수정했습니다. 새로 고친 뒤 다시 시도하세요', { currentVersion: cur.version });
  }
  if (cur.status === 'DISPOSED') throw new AlmError(409, 'ALM-E310', '처분된 자산은 수정할 수 없습니다');
  if (has('dueBackDate') && cur.status !== 'IN_USE') throw E.badRequest('입력 값을 확인하세요: dueBackDate 할당 중인 자산만', { errors: [{ field: 'dueBackDate', code: 'ALM-E100', message: 'IN_USE만' }] });

  // 바뀐 값만 모은다(열 이름 → 새 값). 열 이름은 아래 고정 목록에서만 온다
  const set: [string, unknown, unknown][] = [];
  const cmp = (col: string, before: unknown, after: unknown) => { if ((before ?? null) !== (after ?? null)) set.push([col, before ?? null, after ?? null]); };
  if (has('description')) cmp('description', cur.description, v.description);
  if (has('serialNo')) cmp('serial_no', cur.serial_no, v.serialNo ?? null);
  if (has('hostname')) cmp('hostname', cur.hostname, v.hostname ?? null);
  if (has('ipAddress')) cmp('ip_address', (await c.query('SELECT host($1::inet) AS h', [cur.ip_address])).rows[0]?.h ?? null, v.ipAddress ?? null);
  if (has('macAddress')) cmp('mac_address', cur.mac_address, v.macAddress?.toUpperCase().replace(/-/g, ':') ?? null);
  if (has('warrantyEndDate')) cmp('warranty_end_date', day(cur.warranty_end_date) ?? null, v.warrantyEndDate ?? null);
  if (has('dueBackDate')) cmp('due_back_date', day(cur.due_back_date) ?? null, v.dueBackDate ?? null);
  if (has('notes')) cmp('notes', cur.notes, v.notes ?? null);
  let roomCode: string | undefined;
  if (has('modelId') && v.modelId !== cur.model_id) {
    const m = (await c.query('SELECT category_id FROM model WHERE id = $1 AND is_active', [v.modelId])).rows[0];
    if (!m || m.category_id !== cur.category_id) throw E.badRequest('입력 값을 확인하세요: modelId 자산 카테고리의 활성 모델이 아닙니다', { errors: [{ field: 'modelId', code: 'ALM-E100', message: '카테고리 불일치' }] });
    cmp('model_id', cur.model_id, v.modelId);
  }
  if (has('roomId') && v.roomId !== cur.room_id) {
    const r = (await c.query(`SELECT r.id, r.room_code, r.site_id, s.site_code FROM room r JOIN site s ON s.id = r.site_id WHERE r.id = $1 AND r.is_active AND s.is_active`, [v.roomId])).rows[0];
    if (!r) throw E.badRequest('입력 값을 확인하세요: roomId 활성 룸이 아닙니다', { errors: [{ field: 'roomId', code: 'ALM-E100', message: '없음' }] });
    const co = (await c.query('SELECT company_code FROM company WHERE id = $1', [cur.company_id])).rows[0].company_code;
    if (!allowsPlace(p, 'asset.write', co, r.site_code)) throw E.forbidden('범위 밖 사이트로 옮길 수 없습니다');
    cmp('room_id', cur.room_id, r.id);
    cmp('site_id', cur.site_id, r.site_id);
    roomCode = r.room_code;
  }
  if (!set.length) return { asset: await detail(c, p, id), createdRequests: [] };

  // SAP 연계를 끈 회사는 SAP에 보내지 않는다
  const sapAsset = !!cur.sap_asset_no && !!(await c.query('SELECT sap_enabled FROM company WHERE id = $1', [cur.company_id])).rows[0]?.sap_enabled;
  const serialChanged = set.some(([col]) => col === 'serial_no');
  if (sapAsset && serialChanged && (v.serialNo ?? '').length > 18) {
    throw E.badRequest('입력 값을 확인하세요: serialNo SAP 자산의 시리얼은 18자 이하(SERNR)', { errors: [{ field: 'serialNo', code: 'ALM-E100', message: '18자 이하' }] });
  }
  // 고정 SQL: 열마다 (바꿀지, 새 값) 두 파라미터
  const val = new Map(set.map(([col, , after]) => [col, after]));
  const args = UPDATABLE.flatMap((col) => [val.has(col), val.get(col) ?? null]);
  await c.query(`UPDATE asset SET
      description = CASE WHEN $3 THEN $4 ELSE description END, serial_no = CASE WHEN $5 THEN $6 ELSE serial_no END,
      hostname = CASE WHEN $7 THEN $8 ELSE hostname END, ip_address = CASE WHEN $9 THEN $10::inet ELSE ip_address END,
      mac_address = CASE WHEN $11 THEN $12 ELSE mac_address END, warranty_end_date = CASE WHEN $13 THEN $14::date ELSE warranty_end_date END,
      due_back_date = CASE WHEN $15 THEN $16::date ELSE due_back_date END, notes = CASE WHEN $17 THEN $18 ELSE notes END,
      model_id = CASE WHEN $19 THEN $20::uuid ELSE model_id END, room_id = CASE WHEN $21 THEN $22::uuid ELSE room_id END,
      site_id = CASE WHEN $23 THEN $24::uuid ELSE site_id END,
      updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId, ...args]);
  await event(c, p, id, 'UPDATED', Object.fromEntries(set.map(([col, before, after]) => [col, { before, after }])));

  // SAP 자산: 자산명·시리얼·룸(STORT) 변경을 SAP에 보낸다(IF-AA-04). 회계 값이 아니므로 승인 없이 전기 대기
  const createdRequests: Record<string, string>[] = [];
  const fields: Record<string, string | null> = {};
  for (const [col, , after] of set) {
    if (col === 'description') fields.description = after as string;
    if (col === 'serial_no') fields.serialNo = (after as string | null) ?? '';
    if (col === 'room_id') fields.location = roomCode ?? '';
  }
  if (sapAsset && Object.keys(fields).length) createdRequests.push(await changeRequest(c, p, cur, fields));
  return { asset: await detail(c, p, id), createdRequests };
}

async function changeRequest(c: PoolClient, p: Principal, cur: Record<string, any>, fields: Record<string, string | null>) {
  const id = randomUUID();
  const [no] = await nextNumbers(c, p.tenantId, 'asset_request');
  await c.query(`INSERT INTO asset_request (id, tenant_id, request_no, request_type, status, source, asset_id, requester_id, submitted_at, reason, changes,
      created_by, updated_by) VALUES ($1, $2, $3, 'CHANGE', 'ACCT_APPROVED', 'USER', $4, $5, now(), 'ALM-111 자산 정보 변경(SAP 마스터 반영)', $6, $5, $5)`,
  [id, p.tenantId, no, cur.id, p.userId, JSON.stringify(fields)]);
  await c.query(`INSERT INTO sap_posting (id, tenant_id, posting_id, posting_type, company_id, asset_request_id, asset_id, posting_date, payload,
      approved_by, approved_at, created_by) VALUES ($1, $2, $3, 'ASSET_CHANGE', $4, $5, $6, current_date, $7, $8, now(), $8)`,
  [randomUUID(), p.tenantId, no, cur.company_id, id, cur.id, JSON.stringify({ fields }), p.userId]);
  return { id, requestNo: no, requestType: 'CHANGE', status: 'ACCT_APPROVED' };
}

async function event(c: PoolClient, p: Principal, assetId: string, type: string, changes: unknown) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes) VALUES ($1, $2, $3, $4, $5, 'UI', $6)`,
    [randomUUID(), p.tenantId, assetId, type, p.userId, JSON.stringify(changes)]);
}

// ---------------- 상세 탭 ----------------
export async function history(c: PoolClient, p: Principal, id: string, q: Record<string, string | undefined>) {
  await scoped(c, p, 'asset.read', id);
  const k = new Check(q);
  const page = intParam(k, q, 'page', 1, 1, 100000), pageSize = intParam(k, q, 'pageSize', 50, 1, 500);
  k.done();
  const total = (await c.query('SELECT count(*)::int AS n FROM asset_event WHERE asset_id = $1', [id])).rows[0].n as number;
  const rows = (await c.query(`SELECT e.id, e.event_type, e.occurred_at, u.display_name, e.channel, e.changes, e.reason, r.request_no, e.sap_document_no
      FROM asset_event e LEFT JOIN app_user u ON u.id = e.actor_id LEFT JOIN asset_request r ON r.id = e.asset_request_id
     WHERE e.asset_id = $1 ORDER BY e.occurred_at DESC, e.created_at DESC, e.id OFFSET $2 LIMIT $3`, [id, (page - 1) * pageSize, pageSize])).rows;
  const amount = can(p, 'amount.read');
  return {
    items: rows.map((r) => clean({ id: r.id, eventType: r.event_type, occurredAt: iso(r.occurred_at), actorName: r.display_name ?? undefined,
      channel: r.channel, changes: r.changes && !amount ? mask(r.changes) : r.changes ?? undefined, reason: r.reason ?? undefined,
      requestNo: r.request_no ?? undefined, sapDocumentNo: r.sap_document_no ?? undefined })),
    page, pageSize, total,
  };
}

function mask(ch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ch).map(([key, val]) => [key, AMOUNT_KEYS.has(key)
    ? (val && typeof val === 'object' ? { before: null, after: null } : null) : val]));
}

export async function values(c: PoolClient, p: Principal, id: string) {
  await scoped(c, p, 'asset.read', id);
  const rows = (await c.query(`SELECT fiscal_year, period, acquisition_value, accum_depreciation, net_book_value FROM asset_value
     WHERE asset_id = $1 AND dep_area = '01' ORDER BY fiscal_year DESC, period DESC LIMIT 24`, [id])).rows;
  return { items: rows.map((r) => ({ fiscalYear: r.fiscal_year, period: r.period, acquisitionValue: Number(r.acquisition_value),
    accumDepreciation: Number(r.accum_depreciation), netBookValue: Number(r.net_book_value) })) };
}

export async function assignments(c: PoolClient, p: Principal, id: string) {
  await scoped(c, p, 'asset.read', id);
  const rows = (await c.query(`SELECT u.display_name, cc.cost_center_code, r.room_code, x.checked_out_at, x.due_back_date, x.returned_at
      FROM asset_assignment x LEFT JOIN app_user u ON u.id = x.user_id LEFT JOIN cost_center cc ON cc.id = x.cost_center_id
      LEFT JOIN room r ON r.id = x.room_id WHERE x.asset_id = $1 ORDER BY x.checked_out_at DESC LIMIT 200`, [id])).rows;
  return { items: rows.map((r) => clean({ userName: r.display_name ?? undefined, costCenterCode: r.cost_center_code ?? undefined,
    roomCode: r.room_code ?? undefined, checkedOutAt: iso(r.checked_out_at), dueBackDate: day(r.due_back_date), returnedAt: iso(r.returned_at) })) };
}

export async function attachments(c: PoolClient, p: Principal, id: string) {
  await scoped(c, p, 'asset.read', id);
  const rows = (await c.query(`SELECT f.id, f.file_name, f.content_type, f.size_bytes, f.kind, f.owner_type, u.display_name, f.created_at
      FROM attachment f LEFT JOIN app_user u ON u.id = f.created_by
     WHERE f.linked_at IS NOT NULL AND ((f.owner_type = 'asset' AND f.owner_id = $1)
        OR (f.owner_type = 'count_item' AND f.owner_id IN (SELECT id FROM count_item WHERE asset_id = $1)))
     ORDER BY f.created_at DESC LIMIT 200`, [id])).rows;
  return { items: rows.map((r) => ({ id: r.id, fileName: r.file_name, contentType: r.content_type, sizeBytes: Number(r.size_bytes),
    kind: r.kind === 'PHOTO' ? 'PHOTO' : 'DOCUMENT', source: r.owner_type === 'asset' ? 'ASSET' : 'COUNT', uploadedBy: r.display_name ?? '', createdAt: iso(r.created_at) })) };
}
