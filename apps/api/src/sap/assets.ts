// IF-AA-01 자산 마스터 델타·IF-AA-02 자산 금액 수신(08 5.2·5.3, openapi sapUpsertAssets·sapPostAssetValues). WBS 4.7
//
// IF-AA-01
//   매칭: ① 회사코드 + 자산번호 + 하위번호 ② inventoryNo(= ALM 자산태그, SAP 번호가 아직 없는 자산). 둘 다 없으면 새로 만든다
//         (출처 SAP, last_seen_at 비움 = 실사 필요).
//   SAP 기준 필드만 갱신: 자산클래스, 자산명, 취득일(→ 자본화), 비활성일(→ RETIRED), 코스트센터, 마지막 실사일·메모.
//   시리얼·룸·태그는 ALM 기준이라 덮지 않는다(새로 만들 때만 채운다).
//   코스트센터·자산클래스가 ALM에 없으면 ERROR ALM-E104/E105 → 원문을 sap_if_message에 남기고, 다음 IF-MD-01이
//   그 유형을 다 받으면 최근 3일 안의 이런 건을 다시 처리한다(retryPendingAssets).
//   바뀐 값은 asset_event(SAP_SYNCED)에 전후값, 같으면 SKIPPED.
// IF-AA-02
//   (자산, 회계연도, 기간, 상각영역) 업서트. 자산이 없으면 ERROR ALM-E201. isClosing이면 그 기간을 마감값으로 잠그고,
//   잠긴 기간에 isClosing 없이 오는 값은 SKIPPED(일일 실행이 마감값을 덮지 않게).
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SapConn } from '../auth/sap';
import { Batch, each, logRun, Rec, RecError } from './inbound';

export const RETRY_DAYS = 3;
const keyOf = (r: Record<string, unknown>) => `${r.companyCode ?? '?'}/${r.assetNo ?? '?'}/${r.subNo ?? '?'}`;

interface AssetIn {
  companyCode: string; assetNo: string; subNo: string; assetClass: string; description: string; serialNo?: string; inventoryNo?: string;
  capDate?: string; deactDate?: string; lastCountDate?: string; inventoryNote?: string; costCenter: string; location?: string; changedAt: string;
}

function readAsset(r: Record<string, unknown>): AssetIn {
  const f = new Rec(r);
  const a: AssetIn = {
    companyCode: f.str('companyCode', 4, true)!, assetNo: f.str('assetNo', 12, true)!, subNo: f.str('subNo', 4, true)!,
    assetClass: f.str('assetClass', 8, true)!, description: f.str('description', 50, true)!, serialNo: f.str('serialNo', 18),
    inventoryNo: f.str('inventoryNo', 25), capDate: f.date('capDate'), deactDate: f.date('deactDate'), lastCountDate: f.date('lastCountDate'),
    inventoryNote: f.str('inventoryNote', 15), costCenter: f.str('costCenter', 10, true)!, location: f.str('location', 10),
    changedAt: f.ts('changedAt', true)!,
  };
  f.str('profitCenter', 10); f.str('plant', 4); f.str('room', 8);
  return a;
}

export async function upsertAssets(c: PoolClient, conn: SapConn, records: Record<string, unknown>[], batch: Batch) {
  for (const r of records) await each(c, batch, keyOf(r), r, () => upsertOne(c, conn, readAsset(r)));
}

// 비교·갱신 대상(SAP 기준 필드). 키 = asset 컬럼
type Fields = { asset_class_id: string; description: string; sap_cap_date: string | null; sap_deact_date: string | null;
  cost_center_id: string; last_count_date: string | null; last_count_note: string | null; is_capitalized: boolean };

async function upsertOne(c: PoolClient, conn: SapConn, a: AssetIn): Promise<'OK' | 'SKIPPED'> {
  if (a.companyCode !== conn.companyCode) throw new RecError('ALM-E401', `연결(${conn.companyCode})에 허용되지 않은 회사코드 ${a.companyCode}`);
  const cls = (await c.query('SELECT id FROM asset_class WHERE class_code = $1 AND is_active', [a.assetClass])).rows[0]?.id as string | undefined;
  if (!cls) throw new RecError('ALM-E105', `자산클래스 ${a.assetClass}가 ALM에 없음(IF-MD-01 수신 후 자동 재처리)`);
  const cc = (await c.query('SELECT id FROM cost_center WHERE company_id = $1 AND cost_center_code = $2 AND is_active', [conn.companyId, a.costCenter])).rows[0]?.id as string | undefined;
  if (!cc) throw new RecError('ALM-E104', `코스트센터 ${a.costCenter}가 ALM에 없음(IF-MD-01 수신 후 자동 재처리)`);
  const want: Fields = { asset_class_id: cls, description: a.description, sap_cap_date: a.capDate ?? null, sap_deact_date: a.deactDate ?? null,
    cost_center_id: cc, last_count_date: a.lastCountDate ?? null, last_count_note: a.inventoryNote ?? null, is_capitalized: !!a.capDate };

  const cols = 'id, status, asset_class_id, description, sap_cap_date::text, sap_deact_date::text, cost_center_id, last_count_date::text, last_count_note, is_capitalized, sap_asset_no';
  let cur = (await c.query(`SELECT ${cols} FROM asset WHERE company_id = $1 AND sap_asset_no = $2 AND sap_sub_no = $3`, [conn.companyId, a.assetNo, a.subNo])).rows[0];
  let linked = false;
  if (!cur && a.inventoryNo) {
    cur = (await c.query(`SELECT ${cols} FROM asset WHERE asset_tag = $1`, [a.inventoryNo])).rows[0];
    if (cur?.sap_asset_no) throw new RecError('ALM-E100', `자산태그 ${a.inventoryNo}가 다른 SAP 자산(${cur.sap_asset_no})에 연결되어 있음`);
    linked = !!cur;
  }
  const retire = !!a.deactDate && cur && !['RETIRED', 'DISPOSED'].includes(cur.status);

  if (!cur) {
    const id = randomUUID();
    const category = await categoryFor(c, conn.tenantId, cls);
    const room = a.location ? (await c.query('SELECT id, site_id FROM room WHERE room_code = $1 AND is_active', [a.location])).rows[0] : undefined;
    const tag = a.inventoryNo ?? await freeTag(c, `S${a.assetNo.replace(/^0+/, '')}${a.subNo === '0000' ? '' : `-${a.subNo.replace(/^0+/, '')}`}`);
    await c.query(`INSERT INTO asset (id, tenant_id, asset_tag, description, category_id, serial_no, status, source, company_id, site_id, room_id, cost_center_id,
        asset_class_id, is_capitalized, sap_asset_no, sap_sub_no, sap_cap_date, sap_deact_date, last_count_date, last_count_note, sap_synced_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'SAP', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())`,
      [id, conn.tenantId, tag, a.description, category, a.serialNo ?? null, a.deactDate ? 'RETIRED' : 'IN_USE', conn.companyId, room?.site_id ?? null,
        room?.id ?? null, cc, cls, want.is_capitalized, a.assetNo, a.subNo, want.sap_cap_date, want.sap_deact_date, want.last_count_date, want.last_count_note]);
    await event(c, conn, id, 'CREATED', { source: 'SAP', sapAsset: `${a.companyCode}/${a.assetNo}/${a.subNo}`, assetTag: tag, needsCount: true }, a.changedAt);
    return 'OK';
  }

  // 비교 대상은 고정 목록(필드 이름을 입력에서 받지 않는다)
  const pairs: [string, unknown, unknown][] = [
    ['asset_class_id', cur.asset_class_id, want.asset_class_id], ['description', cur.description, want.description],
    ['sap_cap_date', cur.sap_cap_date, want.sap_cap_date], ['sap_deact_date', cur.sap_deact_date, want.sap_deact_date],
    ['cost_center_id', cur.cost_center_id, want.cost_center_id], ['last_count_date', cur.last_count_date, want.last_count_date],
    ['last_count_note', cur.last_count_note, want.last_count_note], ['is_capitalized', cur.is_capitalized, want.is_capitalized],
  ];
  const changes = new Map<string, { before: unknown; after: unknown }>();
  for (const [name, before, after] of pairs) if ((before ?? null) !== (after ?? null)) changes.set(name, { before: before ?? null, after });
  if (linked) changes.set('sap_asset_no', { before: null, after: `${a.assetNo}/${a.subNo}` });
  if (retire) changes.set('status', { before: cur.status, after: 'RETIRED' });
  if (!changes.size) return 'SKIPPED';
  await c.query(`UPDATE asset SET asset_class_id = $2, description = $3, sap_cap_date = $4, sap_deact_date = $5, cost_center_id = $6,
      last_count_date = $7, last_count_note = $8, is_capitalized = $9, sap_asset_no = $10, sap_sub_no = $11,
      status = CASE WHEN $12 THEN 'RETIRED'::asset_status ELSE status END, sap_synced_at = now(), updated_at = now(), version = version + 1
    WHERE id = $1`,
    [cur.id, cls, a.description, want.sap_cap_date, want.sap_deact_date, cc, want.last_count_date, want.last_count_note, want.is_capitalized,
      a.assetNo, a.subNo, !!retire]);
  await event(c, conn, cur.id, 'SAP_SYNCED', Object.fromEntries(changes), a.changedAt);
  if (retire) await event(c, conn, cur.id, 'RETIRED', { reason: 'SAP 비활성일(DEAKT)', deactDate: a.deactDate }, a.changedAt);
  return 'OK';
}

async function event(c: PoolClient, conn: SapConn, assetId: string, type: string, changes: unknown, changedAt: string) {
  await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, channel, changes, reason) VALUES ($1, $2, $3, $4, 'SAP', $5, $6)`,
    [randomUUID(), conn.tenantId, assetId, type, JSON.stringify(changes), `IF-AA-01 ${changedAt}`.slice(0, 200)]);
}

// 새 SAP 자산의 카테고리: 그 자산클래스를 기본으로 둔 카테고리, 없으면 'SAP 미분류'(자산 관리자가 나중에 고친다)
async function categoryFor(c: PoolClient, tenantId: string, classId: string): Promise<string> {
  const hit = (await c.query('SELECT id FROM category WHERE default_asset_class_id = $1 AND is_active ORDER BY category_code LIMIT 1', [classId])).rows[0]?.id;
  if (hit) return hit;
  return (await c.query(`INSERT INTO category (id, tenant_id, category_code, name) VALUES ($1, $2, 'SAP-UNCLASSIFIED', 'SAP 미분류')
    ON CONFLICT (tenant_id, category_code) DO UPDATE SET is_active = true RETURNING id`, [randomUUID(), tenantId])).rows[0].id;
}

async function freeTag(c: PoolClient, base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const t = (i ? `${base}-${i}` : base).slice(0, 25);
    if (!(await c.query('SELECT 1 FROM asset WHERE asset_tag = $1', [t])).rowCount) return t;
  }
  throw new RecError('ALM-E100', '자산태그를 만들 수 없음');
}

// IF-MD-01이 코스트센터·자산클래스를 다 받은 뒤: 최근 3일 안에 E104·E105로 실패한 IF-AA-01 건을 다시 처리한다.
// 그 뒤에 더 새로운 값이 이미 반영된 자산(sap_synced_at이 오류보다 늦음)은 건너뛴다
export async function retryPendingAssets(c: PoolClient, conn: SapConn, correlationId?: string): Promise<Batch | undefined> {
  const rows = (await c.query(
    `SELECT DISTINCT ON (m.record_key) m.record_key, m.payload, m.created_at
       FROM sap_if_message m JOIN sap_if_run r ON r.id = m.run_id
      WHERE r.interface_id = 'IF-AA-01' AND m.result = 'ERROR' AND m.error_code IN ('ALM-E104', 'ALM-E105')
        AND m.created_at > now() - make_interval(days => $1) AND m.payload IS NOT NULL
      ORDER BY m.record_key, m.created_at DESC`, [RETRY_DAYS])).rows;
  const todo: Record<string, unknown>[] = [];
  for (const m of rows) {
    const p = m.payload as Record<string, unknown>;
    if (p.companyCode !== conn.companyCode) continue;
    const newer = (await c.query(`SELECT 1 FROM asset WHERE company_id = $1 AND sap_asset_no = $2 AND sap_sub_no = $3 AND sap_synced_at > $4`,
      [conn.companyId, p.assetNo, p.subNo, m.created_at])).rowCount;
    const fixedLater = (await c.query(`SELECT 1 FROM sap_if_message m2 JOIN sap_if_run r2 ON r2.id = m2.run_id
      WHERE r2.interface_id = 'IF-AA-01' AND r2.batch_id LIKE 'RETRY-%' AND m2.record_key = $1 AND m2.result = 'RETRIED' AND m2.created_at > $2`,
      [m.record_key, m.created_at])).rowCount;
    if (!newer && !fixedLater) todo.push(p);
  }
  if (!todo.length) return undefined;
  const startedAt = new Date();
  const batch = new Batch(`RETRY-${startedAt.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, todo.length);
  await upsertAssets(c, conn, todo, batch);
  // 성공한 건은 '다시 처리됨'으로 남겨 다음 재처리 대상에서 빠지게 한다
  const failedKeys = new Set(batch.errors.map((e) => e.key));
  for (const p of todo) if (!failedKeys.has(keyOf(p))) batch.extra.push({ key: keyOf(p), result: 'RETRIED' });
  await logRun(c, conn, { interfaceId: 'IF-AA-01', batchId: batch.batchId, correlationId, startedAt, batch });
  return batch;
}

export async function postAssetValues(c: PoolClient, conn: SapConn, b: Record<string, unknown>, records: Record<string, unknown>[], batch: Batch) {
  const closing = b.isClosing === true;
  const assets = new Map<string, string | null>();
  for (const r of records) {
    const key = `${keyOf(r)}/${r.fiscalYear ?? '?'}/${r.period ?? '?'}`;
    await each(c, batch, key, r, async () => {
      const f = new Rec(r);
      const cc = f.str('companyCode', 4, true)!, no = f.str('assetNo', 12, true)!, sub = f.str('subNo', 4, true)!;
      const fy = f.int('fiscalYear', { min: 1990, max: 2100, required: true })!, per = f.int('period', { min: 1, max: 16, required: true })!;
      const area = f.str('depArea', 2, true)!;
      const acq = f.num('acquisitionValue', true)!, dep = f.num('accumDepreciation', true)!, nbv = f.num('netBookValue', true)!;
      const ly = f.int('usefulLifeYears', { min: 0, max: 200 }) ?? null, lp = f.int('usefulLifePeriods', { min: 0, max: 999 }) ?? null;
      const dk = f.str('depKey', 4) ?? null;
      if (cc !== conn.companyCode) throw new RecError('ALM-E401', `연결(${conn.companyCode})에 허용되지 않은 회사코드 ${cc}`);
      const ak = `${no}/${sub}`;
      if (!assets.has(ak)) assets.set(ak, (await c.query('SELECT id FROM asset WHERE company_id = $1 AND sap_asset_no = $2 AND sap_sub_no = $3',
        [conn.companyId, no, sub])).rows[0]?.id ?? null);
      const assetId = assets.get(ak);
      if (!assetId) throw new RecError('ALM-E201', `자산 ${cc}/${no}/${sub}이 ALM에 없음(IF-AA-01 먼저)`);
      const cur = (await c.query(`SELECT acquisition_value::float8 AS acq, accum_depreciation::float8 AS dep, net_book_value::float8 AS nbv,
          useful_life_years AS ly, useful_life_periods AS lp, dep_key AS dk, is_closed FROM asset_value
        WHERE asset_id = $1 AND fiscal_year = $2 AND period = $3 AND dep_area = $4`, [assetId, fy, per, area])).rows[0];
      if (cur?.is_closed && !closing) return { skip: '마감된 기간(마감 실행 값 유지)' };
      if (cur && cur.acq === acq && cur.dep === dep && cur.nbv === nbv && cur.ly === ly && cur.lp === lp && cur.dk === dk && cur.is_closed === closing) return 'SKIPPED';
      await c.query(`INSERT INTO asset_value (id, tenant_id, asset_id, fiscal_year, period, dep_area, acquisition_value, accum_depreciation, net_book_value,
          useful_life_years, useful_life_periods, dep_key, is_closed, received_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
        ON CONFLICT (asset_id, fiscal_year, period, dep_area) DO UPDATE SET acquisition_value = EXCLUDED.acquisition_value,
          accum_depreciation = EXCLUDED.accum_depreciation, net_book_value = EXCLUDED.net_book_value, useful_life_years = EXCLUDED.useful_life_years,
          useful_life_periods = EXCLUDED.useful_life_periods, dep_key = EXCLUDED.dep_key, is_closed = EXCLUDED.is_closed, received_at = now(),
          updated_at = now(), version = asset_value.version + 1`,
        [randomUUID(), conn.tenantId, assetId, fy, per, area, acq, dep, nbv, ly, lp, dk, closing]);
      return 'OK';
    });
  }
}
