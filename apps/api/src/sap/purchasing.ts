// IF-MM-01 자산 PO 항목·IF-MM-03 입고 수신(08 5.4·5.5, openapi sapPostPurchaseOrders·sapPostGoodsReceipts). WBS 4.7
//
// IF-MM-01
//   (PO번호, 항목) 업서트. 공급사는 vendor(공급사 번호)로 업서트. 코스트센터는 연결 회사코드 안에서 찾고 없으면 비움.
//   assets[](EKKN 자산번호)는 po_item_asset으로 맞춘다(목록에 없는 행은 지움, ALM에 그 자산이 있으면 연결).
//   almRequestNo가 있으면 구매요청과 연결하고 PO 번호를 적는다(PO_REQUESTED·PO_ERROR → PO_CREATED).
//   deletionFlag=true면 is_deleted(입고 대기 취소). 바뀐 값이 없으면 SKIPPED.
//   처리 뒤, 그 PO 항목이 없어 실패했던(ALM-E202) 최근 3일 입고를 다시 처리한다.
// IF-MM-03
//   같은 문서 행(materialDoc, docYear, docItem)이 다시 오면 SKIPPED(겹침 송신 대비).
//   101: 수량만큼 자산을 IN_STOCK으로(출처 GOODS_RECEIPT, 태그 AT-nnnnnn 채번). PO가 지정한 SAP 자산번호가 있으면
//        그 번호를 순서대로 붙이고, 그 번호의 ALM 자산이 이미 있으면(IF-AA-01이 먼저 만든 경우) 새로 만들지 않고 연결한다.
//        기본 라벨 템플릿이 있으면 라벨 출력 대기열(GOODS_RECEIPT)에 넣는다.
//   102·122: 자산을 지우지 않고 그 PO 항목의 입고 자산 중 최근 것부터 수량만큼 is_gr_cancelled=true, 자산 관리자 메일.
//   PO 항목이 없으면 ERROR ALM-E202(다음 IF-MM-01 후 자동 재처리).
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SapConn } from '../auth/sap';
import { nextAssetTags } from '../assets/tags';
import { Batch, each, logRun, Rec, RecError } from './inbound';
import { categoryFor, RETRY_DAYS } from './assets';
import { usersWithRole } from './postings';
import { defaultTemplateId } from '../labels/labels';

export const MAX_GR_UNITS = 500;   // 입고 1행에서 만드는 자산 수 상한(수량 단위 오입력 방지)

// ---------------- IF-MM-01 ----------------
const poKey = (r: Record<string, unknown>) => `${r.poNo ?? '?'}/${r.item ?? '?'}`;

export async function upsertPurchaseOrders(c: PoolClient, conn: SapConn, records: Record<string, unknown>[], batch: Batch) {
  for (const r of records) await each(c, batch, poKey(r), r, () => upsertPoItem(c, conn, r));
}

async function upsertPoItem(c: PoolClient, conn: SapConn, r: Record<string, unknown>): Promise<'OK' | 'SKIPPED'> {
  const f = new Rec(r);
  const poNo = f.str('poNo', 10, true)!, item = f.str('item', 5, true)!, cc = f.str('companyCode', 4, true)!;
  const vendorNo = f.str('vendor', 10), vendorName = f.str('vendorName', 80), description = f.str('description', 40, true)!;
  const qty = f.qty('quantity', true)!, price = f.num('unitPrice') ?? null, costCenter = f.str('costCenter', 10);
  const deleted = f.bool('deletionFlag') ?? false, prNo = f.str('almRequestNo', 12);
  if (qty < 0) throw new RecError('ALM-E100', 'quantity는 0 이상');
  if (cc !== conn.companyCode) throw new RecError('ALM-E401', `연결(${conn.companyCode})에 허용되지 않은 회사코드 ${cc}`);
  const assets = readAssets(r.assets);

  let vendorId: string | null = null;
  if (vendorNo) {
    vendorId = (await c.query(`INSERT INTO vendor (id, tenant_id, vendor_no, name) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, vendor_no) DO UPDATE SET name = coalesce($5, vendor.name), updated_at = now(), version = vendor.version + 1
        WHERE $5::text IS NOT NULL AND vendor.name IS DISTINCT FROM $5
      RETURNING id`, [randomUUID(), conn.tenantId, vendorNo, vendorName ?? vendorNo, vendorName ?? null])).rows[0]?.id
      ?? (await c.query('SELECT id FROM vendor WHERE vendor_no = $1', [vendorNo])).rows[0].id;
  }
  const ccId = costCenter ? (await c.query('SELECT id FROM cost_center WHERE company_id = $1 AND cost_center_code = $2', [conn.companyId, costCenter])).rows[0]?.id ?? null : null;
  const pr = prNo ? (await c.query('SELECT id, status, sap_po_no FROM purchase_request WHERE pr_no = $1', [prNo])).rows[0] : undefined;

  const up = await c.query(
    `INSERT INTO po_item (id, tenant_id, po_no, item_no, company_id, vendor_id, vendor_name, description, quantity, unit_price, cost_center_id,
        purchase_request_id, is_deleted, sap_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (tenant_id, po_no, item_no) DO UPDATE SET company_id = EXCLUDED.company_id, vendor_id = EXCLUDED.vendor_id,
        vendor_name = EXCLUDED.vendor_name, description = EXCLUDED.description, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price,
        cost_center_id = EXCLUDED.cost_center_id, purchase_request_id = coalesce(EXCLUDED.purchase_request_id, po_item.purchase_request_id),
        is_deleted = EXCLUDED.is_deleted, sap_synced_at = now(), updated_at = now(), version = po_item.version + 1
      WHERE (po_item.company_id, po_item.vendor_id, po_item.vendor_name, po_item.description, po_item.quantity, po_item.unit_price,
             po_item.cost_center_id, po_item.purchase_request_id, po_item.is_deleted)
        IS DISTINCT FROM (EXCLUDED.company_id, EXCLUDED.vendor_id, EXCLUDED.vendor_name, EXCLUDED.description, EXCLUDED.quantity, EXCLUDED.unit_price,
             EXCLUDED.cost_center_id, coalesce(EXCLUDED.purchase_request_id, po_item.purchase_request_id), EXCLUDED.is_deleted)
     RETURNING id`,
    [randomUUID(), conn.tenantId, poNo, item, conn.companyId, vendorId, vendorName ?? null, description, qty, price, ccId, pr?.id ?? null, deleted]);
  let changed = !!up.rowCount;
  const poItemId: string = up.rows[0]?.id ?? (await c.query('SELECT id FROM po_item WHERE po_no = $1 AND item_no = $2', [poNo, item])).rows[0].id;

  // EKKN 자산번호 맞추기
  const cur = (await c.query('SELECT sap_asset_no, sap_sub_no FROM po_item_asset WHERE po_item_id = $1', [poItemId])).rows;
  const want = new Set(assets.map((a) => `${a.assetNo}/${a.subNo}`));
  const have = new Set(cur.map((a) => `${a.sap_asset_no}/${a.sap_sub_no}`));
  for (const a of assets) {
    if (have.has(`${a.assetNo}/${a.subNo}`)) continue;
    const assetId = (await c.query('SELECT id FROM asset WHERE company_id = $1 AND sap_asset_no = $2 AND sap_sub_no = $3', [conn.companyId, a.assetNo, a.subNo])).rows[0]?.id ?? null;
    await c.query(`INSERT INTO po_item_asset (id, tenant_id, po_item_id, sap_asset_no, sap_sub_no, asset_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), conn.tenantId, poItemId, a.assetNo, a.subNo, assetId]);
    changed = true;
  }
  const gone = cur.filter((a) => !want.has(`${a.sap_asset_no}/${a.sap_sub_no}`));
  for (const a of gone) {
    await c.query('DELETE FROM po_item_asset WHERE po_item_id = $1 AND sap_asset_no = $2 AND sap_sub_no = $3', [poItemId, a.sap_asset_no, a.sap_sub_no]);
    changed = true;
  }

  if (pr && (pr.sap_po_no !== poNo || ['PO_REQUESTED', 'PO_ERROR'].includes(pr.status))) {
    await c.query(`UPDATE purchase_request SET sap_po_no = $2, status = CASE WHEN status IN ('PO_REQUESTED', 'PO_ERROR') THEN 'PO_CREATED'::purchase_request_status ELSE status END,
      updated_at = now(), version = version + 1 WHERE id = $1`, [pr.id, poNo]);
    changed = true;
  }
  return changed ? 'OK' : 'SKIPPED';
}

function readAssets(v: unknown): { assetNo: string; subNo: string }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 999) throw new RecError('ALM-E100', 'assets는 999건 이하 배열');
  const out = new Map<string, { assetNo: string; subNo: string }>();
  for (const a of v) {
    const f = new Rec((a && typeof a === 'object' ? a : {}) as Record<string, unknown>);
    const assetNo = f.str('assetNo', 12, true)!, subNo = f.str('subNo', 4) ?? '0000';
    out.set(`${assetNo}/${subNo}`, { assetNo, subNo });
  }
  return [...out.values()];
}

// ---------------- IF-MM-03 ----------------
const grKey = (r: Record<string, unknown>) => `${r.materialDoc ?? '?'}/${r.docYear ?? '?'}/${r.docItem ?? '?'}`;

export async function postGoodsReceipts(c: PoolClient, conn: SapConn, records: Record<string, unknown>[], batch: Batch) {
  for (const r of records) await each(c, batch, grKey(r), r, () => receiveOne(c, conn, r, batch));
}

async function receiveOne(c: PoolClient, conn: SapConn, r: Record<string, unknown>, batch: Batch): Promise<'OK' | 'SKIPPED' | { skip: string }> {
  const f = new Rec(r);
  const doc = f.str('materialDoc', 10, true)!, yearS = f.str('docYear', 4, true)!, line = f.str('docItem', 4, true)!;
  const poNo = f.str('poNo', 10, true)!, poItem = f.str('poItem', 5, true)!, mt = f.str('movementType', 3, true)!;
  const qty = f.qty('quantity', true)!, date = f.date('postingDate');
  if (!date) throw new RecError('ALM-E101', 'postingDate 필수');
  if (!/^\d{4}$/.test(yearS)) throw new RecError('ALM-E100', 'docYear 형식(YYYY)');
  if (!['101', '102', '122'].includes(mt)) throw new RecError('ALM-E100', 'movementType은 101·102·122');
  if (qty <= 0) throw new RecError('ALM-E100', 'quantity는 0보다 커야 함');

  if ((await c.query('SELECT 1 FROM goods_receipt WHERE material_doc = $1 AND doc_year = $2 AND doc_item = $3', [doc, Number(yearS), line])).rowCount) {
    return { skip: '이미 받은 입고 행' };
  }
  const po = (await c.query(`SELECT id, company_id, description, unit_price::float8 AS unit_price, cost_center_id, is_deleted FROM po_item
     WHERE po_no = $1 AND item_no = $2`, [poNo, poItem])).rows[0];
  if (!po || po.company_id !== conn.companyId) throw new RecError('ALM-E202', `PO 항목 ${poNo}/${poItem}이(가) ALM에 없음(IF-MM-01 수신 후 자동 재처리)`);

  const grId = randomUUID();
  await c.query(`INSERT INTO goods_receipt (id, tenant_id, po_item_id, material_doc, doc_year, doc_item, movement_type, quantity, posting_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [grId, conn.tenantId, po.id, doc, Number(yearS), line, mt, qty, date]);

  if (mt === '101') {
    if (!Number.isInteger(qty)) throw new RecError('ALM-E100', '자산 입고 수량은 정수여야 함');
    if (qty > MAX_GR_UNITS) throw new RecError('ALM-E100', `입고 1행 최대 ${MAX_GR_UNITS}개`);
    await createReceivedAssets(c, conn, po, grId, qty, date, doc);
    await c.query(`UPDATE goods_receipt SET assets_created_at = now() WHERE id = $1`, [grId]);
    await c.query(`UPDATE po_item SET gr_quantity = gr_quantity + $2, updated_at = now(), version = version + 1 WHERE id = $1`, [po.id, qty]);
    return 'OK';
  }

  // 102 취소·122 반품: 최근 입고 자산부터 수량만큼 입고 취소 표시
  const n = Math.ceil(qty);
  const hit = (await c.query(`UPDATE asset SET is_gr_cancelled = true, updated_at = now(), version = version + 1
     WHERE id IN (SELECT id FROM asset WHERE po_item_id = $1 AND goods_receipt_id IS NOT NULL AND NOT is_gr_cancelled
                  ORDER BY created_at DESC, asset_tag DESC LIMIT $2)
     RETURNING id, asset_tag`, [po.id, n])).rows;
  for (const a of hit) {
    await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, changes, reason) VALUES ($1, $2, $3, 'UPDATED', 'SAP', $4, $5)`,
      [randomUUID(), conn.tenantId, a.id, JSON.stringify({ is_gr_cancelled: { before: false, after: true }, materialDoc: doc, movementType: mt }),
        `IF-MM-03 ${mt} ${doc}/${yearS}/${line}`]);
  }
  await c.query(`UPDATE po_item SET gr_quantity = greatest(gr_quantity - $2, 0), updated_at = now(), version = version + 1 WHERE id = $1`, [po.id, qty]);
  const tags = hit.map((a) => a.asset_tag).sort();
  for (const id of await usersWithRole(c, 'ASSET_MANAGER')) {
    batch.mails.push({ recipientId: id, template: 'GR_CANCELLED', params: { poNo: `${poNo}/${poItem}`, movementType: mt, quantity: qty,
      assets: tags.length ? tags.join(', ').slice(0, 300) : '(없음)', path: '/assets?grCancelled=true' },
    subjectType: 'GOODS_RECEIPT', subjectId: grId, dedupeKey: `GR_CANCELLED:${grId}:${id}` });
  }
  return hit.length < n ? { skip: `입고 취소 표시 ${hit.length}/${n}개(나머지는 대상 자산 없음)` } : 'OK';
}

async function createReceivedAssets(c: PoolClient, conn: SapConn, po: Record<string, any>, grId: string, qty: number, date: string, doc: string) {
  // PO가 지정한 SAP 자산번호(아직 입고 자산과 연결 안 된 것부터)
  const planned = (await c.query(`SELECT pia.id, pia.sap_asset_no, pia.sap_sub_no, a.id AS asset_id, a.goods_receipt_id
      FROM po_item_asset pia LEFT JOIN asset a ON a.company_id = $2 AND a.sap_asset_no = pia.sap_asset_no AND a.sap_sub_no = pia.sap_sub_no
     WHERE pia.po_item_id = $1 ORDER BY pia.sap_asset_no, pia.sap_sub_no`, [po.id, conn.companyId])).rows
    .filter((p) => !p.goods_receipt_id);
  const template = qty > 0 ? await defaultTemplateId(c, conn.tenantId) : undefined;   // 템플릿이 없으면 기본 템플릿을 만든다(4.5)
  const toCreate = qty - Math.min(qty, planned.filter((p) => p.asset_id).length);
  // 입고만으로는 자산클래스를 모른다 → 'SAP Unclassified'(자산 관리자가 고친다. IF-AA-01이 오면 클래스가 채워짐). 태그는 그 카테고리의 번호 범위에서
  const category = toCreate > 0 ? await categoryFor(c, conn.tenantId, null) : undefined;
  const tags = await nextAssetTags(c, conn.tenantId, toCreate, category);

  for (let i = 0; i < qty; i++) {
    const p = planned[i];
    let assetId: string;
    if (p?.asset_id) {
      // IF-AA-01이 먼저 만든 같은 SAP 자산: 입고 정보만 붙인다
      assetId = p.asset_id;
      await c.query(`UPDATE asset SET po_item_id = $2, goods_receipt_id = $3, purchase_date = coalesce(purchase_date, $4), purchase_cost = coalesce(purchase_cost, $5),
          status = CASE WHEN status = 'ON_ORDER' THEN 'IN_STOCK'::asset_status ELSE status END, updated_at = now(), version = version + 1 WHERE id = $1`,
        [assetId, po.id, grId, date, po.unit_price]);
      await event(c, conn, assetId, 'UPDATED', { goodsReceipt: doc, linked: true });
    } else {
      assetId = randomUUID();
      await c.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, status, source, company_id, cost_center_id,
          sap_asset_no, sap_sub_no, purchase_date, purchase_cost, po_item_id, goods_receipt_id)
        VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', 'GOODS_RECEIPT', $6, $7, $8, $9, $10, $11, $12, $13)`,
        [assetId, conn.tenantId, tags.shift(), po.description, category, conn.companyId, po.cost_center_id, p?.sap_asset_no ?? null, p?.sap_asset_no ? p.sap_sub_no : null,
          date, po.unit_price, po.id, grId]);
      await event(c, conn, assetId, 'CREATED', { source: 'GOODS_RECEIPT', goodsReceipt: doc, ...(p ? { sapAsset: `${conn.companyCode}/${p.sap_asset_no}/${p.sap_sub_no}` } : {}) });
    }
    if (p) await c.query('UPDATE po_item_asset SET asset_id = $2, updated_at = now(), version = version + 1 WHERE id = $1', [p.id, assetId]);
    if (template) {
      await c.query(`INSERT INTO label_print_job (id, tenant_id, asset_id, template_id, source) VALUES ($1, $2, $3, $4, 'GOODS_RECEIPT')`,
        [randomUUID(), conn.tenantId, assetId, template]);
    }
  }
}

async function event(c: PoolClient, conn: SapConn, assetId: string, type: string, changes: unknown) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, changes, reason) VALUES ($1, $2, $3, $4, 'SAP', $5, 'IF-MM-03')`,
    [randomUUID(), conn.tenantId, assetId, type, JSON.stringify(changes)]);
}

// IF-MM-01 뒤: 최근 3일 안에 PO 항목이 없어(E202) 실패한 입고를 다시 처리
export async function retryPendingReceipts(c: PoolClient, conn: SapConn, correlationId?: string): Promise<Batch | undefined> {
  const rows = (await c.query(
    `SELECT DISTINCT ON (m.record_key) m.record_key, m.payload, m.created_at
       FROM sap_if_message m JOIN sap_if_run r ON r.id = m.run_id
      WHERE r.interface_id = 'IF-MM-03' AND m.result = 'ERROR' AND m.error_code = 'ALM-E202'
        AND m.created_at > now() - make_interval(days => $1) AND m.payload IS NOT NULL
      ORDER BY m.record_key, m.created_at DESC`, [RETRY_DAYS])).rows;
  const todo: Record<string, unknown>[] = [];
  for (const m of rows) {
    const p = m.payload as Record<string, unknown>;
    const done = (await c.query('SELECT 1 FROM goods_receipt WHERE material_doc = $1 AND doc_year = $2 AND doc_item = $3',
      [p.materialDoc, Number(p.docYear), p.docItem])).rowCount;
    const po = (await c.query('SELECT 1 FROM po_item WHERE po_no = $1 AND item_no = $2 AND company_id = $3', [p.poNo, p.poItem, conn.companyId])).rowCount;
    if (!done && po) todo.push(p);
  }
  if (!todo.length) return undefined;
  const startedAt = new Date();
  const batch = new Batch(`RETRY-${startedAt.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, todo.length);
  await postGoodsReceipts(c, conn, todo, batch);
  await logRun(c, conn, { interfaceId: 'IF-MM-03', batchId: batch.batchId, correlationId, startedAt, batch });
  return batch;
}
