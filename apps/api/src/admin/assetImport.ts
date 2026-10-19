// 자산 일괄 업로드(관리 > 자산 일괄 업로드, ADM-060, 2026-10-19 결정): 엑셀(xlsx)·CSV로 신규 등록과 기존 수정.
//   - 자산태그가 비었거나 ALM에 없는 태그 → 신규(ALM에만 등록, SAP 등록 요청 없음). 없는 태그를 적으면 그 태그로 만든다(기존 라벨 유지)
//   - ALM에 있는 태그 → 수정. 적힌 칸만 바꾼다(빈 칸은 그대로). 수정 가능: 자산명·모델·시리얼·룸·호스트명·IP·MAC·보증 만료·메모
//     회사·코스트센터·상태·사용자·구매가 등은 수정에서 무시(경고) — 이관·할당 요청과 SAP 기준 필드 규칙을 지킨다
//   - 미리보기(:preview)와 적용(:apply)은 같은 파일을 받는다. 행마다 SAVEPOINT에서 화면 등록·수정과 같은 함수(createAsset·patchAsset)를 돌린다:
//     오류 행은 그 행만 되돌린다. 미리보기는 끝에 전체를 되돌리고, 적용은 오류 없는 행만 남긴다(오류 행은 건너뜀)
//   - Bundle(2026-10-19): isBundle=Y 행은 Bundle로 신규 등록(모델 불필요). bundleTag = 넣을 Bundle 태그(ALM에 있거나 같은 파일의 Bundle 행).
//     Bundle 행을 먼저 처리한다. 미리보기도 적용과 같이 행을 반영해 보고(같은 파일 Bundle 참조 확인) 마지막에 전부 되돌린다
//   - 모델(2026-10-19): 선택. 모델 마스터(부품번호·'제조사 모델명')에 있으면 연결, 없으면 적은 글자 그대로(asset.model_text)
//   권한 asset.write(범위: 역할 행의 회사코드·사이트). 최대 2,000행, 파일 700KB
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';
import type { Principal } from '../auth/principal';
import { assetScope, Params } from '../auth/scope';
import { createAsset, patchAsset } from '../assets/assets';
import { attachComponents } from '../assets/bundles';
import { buildXlsx, type Cell } from '../common/xlsx';
import { excelDate, readCsv, readXlsx } from '../common/xlsxRead';

export const COLUMNS = ['assetTag', 'description', 'categoryCode', 'model', 'serialNo', 'companyCode', 'roomCode', 'costCenterCode', 'status',
  'assignedUserEmail', 'purchaseDate', 'purchaseCost', 'warrantyEndDate', 'hostname', 'ipAddress', 'macAddress', 'notes', 'printLabel', 'isBundle', 'bundleTag'] as const;
type Col = (typeof COLUMNS)[number];
const REQUIRED_NEW: Col[] = ['description', 'categoryCode', 'companyCode', 'roomCode', 'costCenterCode'];
const UPDATE_COLS: Col[] = ['description', 'model', 'serialNo', 'roomCode', 'hostname', 'ipAddress', 'macAddress', 'warrantyEndDate', 'notes', 'bundleTag'];
const DATE_COLS: Col[] = ['purchaseDate', 'warrantyEndDate'];
const MAX_ROWS = 2000;
const MAX_BYTES = 700 * 1024;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{1,29}$/;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const HEAD = new Map(COLUMNS.map((c) => [norm(c), c]));

export interface RowMessage { field?: Col; code: string; message: string }
export interface RowResult {
  rowNo: number; action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP'; status: 'OK' | 'WARN' | 'ERROR'; assetTag?: string; description?: string;
  changes?: string[]; errors: RowMessage[]; warnings: RowMessage[]; assetId?: string;
}

// ---------------- 파일 읽기 ----------------
function readFile(body: unknown) {
  const k = new Check(body), b = k.obj();
  const fileName = k.str(b, 'fileName', { required: true, max: 200 }) ?? '';
  const content = k.str(b, 'contentBase64', { required: true, max: Math.ceil(MAX_BYTES * 4 / 3) + 8 }) ?? '';
  k.done();
  const buf = Buffer.from(content, 'base64');
  if (!buf.length) throw E.badRequest('빈 파일입니다');
  if (buf.length > MAX_BYTES) throw new AlmError(413, 'ALM-E110', `파일이 너무 큽니다(최대 ${MAX_BYTES / 1024}KB)`);
  let sheet;
  try {
    sheet = /\.csv$/i.test(fileName) || buf.subarray(0, 2).toString() !== 'PK' ? readCsv(buf.toString('utf8')) : readXlsx(buf, 'Assets');
  } catch (e) {
    throw E.badRequest(`엑셀(xlsx)·CSV 파일을 읽을 수 없습니다: ${(e as Error).message}`);
  }
  // 머리글 행: 알려진 열 이름이 가장 많이 들어 있는 처음 5행 중 하나
  let headIdx = -1, best = 0;
  sheet.rows.slice(0, 5).forEach((r, i) => { const n = r.filter((x) => HEAD.has(norm(x ?? ''))).length; if (n > best) { best = n; headIdx = i; } });
  if (headIdx < 0 || best < 2) throw E.badRequest(`머리글을 찾을 수 없습니다. 템플릿의 열 이름(${COLUMNS.slice(0, 4).join(', ')} …)을 쓰세요`);
  const map = sheet.rows[headIdx].map((h) => HEAD.get(norm(h ?? '')));
  const unknown = sheet.rows[headIdx].filter((h, i) => h && !map[i]);
  const rows: { rowNo: number; v: Partial<Record<Col, string>> }[] = [];
  sheet.rows.slice(headIdx + 1).forEach((r, i) => {
    const v: Partial<Record<Col, string>> = {};
    r.forEach((x, ci) => { const c = map[ci]; const t = (x ?? '').trim(); if (c && t) v[c] = t; });
    if (Object.keys(v).length) rows.push({ rowNo: headIdx + 2 + i, v });
  });
  if (!rows.length) throw E.badRequest('데이터 행이 없습니다');
  if (rows.length > MAX_ROWS) throw E.badRequest(`한 번에 ${MAX_ROWS}행까지 올릴 수 있습니다(지금 ${rows.length}행)`);
  return { fileName, rows, unknownColumns: unknown };
}

// ---------------- 코드 → id ----------------
async function lookups(c: PoolClient) {
  const m = async (sql: string) => (await c.query(sql)).rows;
  const cats = new Map((await m(`SELECT id, upper(category_code) AS k FROM category WHERE is_active`)).map((r) => [r.k as string, r.id as string]));
  const models = await m(`SELECT id, category_id, upper(coalesce(part_no, '')) AS part, upper(manufacturer || ' ' || model_name) AS full_name, upper(model_name) AS name FROM model WHERE is_active`);
  const cos = new Map((await m(`SELECT id, upper(company_code) AS k FROM company WHERE is_active`)).map((r) => [r.k as string, r.id as string]));
  const rooms = new Map((await m(`SELECT r.id, upper(r.room_code) AS k FROM room r JOIN site s ON s.id = r.site_id WHERE r.is_active AND s.is_active`)).map((r) => [r.k as string, r.id as string]));
  const ccs = await m(`SELECT cc.id, upper(cc.cost_center_code) AS k, cc.company_id FROM cost_center cc WHERE cc.is_active`);
  const users = new Map((await m(`SELECT id, lower(email) AS k FROM app_user WHERE is_active`)).map((r) => [r.k as string, r.id as string]));
  return {
    cat: (s: string) => cats.get(s.toUpperCase()),
    model: (s: string, catId?: string) => {
      const u = s.toUpperCase(), inCat = models.filter((x) => !catId || x.category_id === catId);
      const hit = inCat.filter((x) => x.part === u || x.full_name === u);
      if (hit.length === 1) return hit[0].id as string;
      const byName = inCat.filter((x) => x.name === u);
      return byName.length === 1 ? byName[0].id as string : undefined;
    },
    co: (s: string) => cos.get(s.toUpperCase()),
    room: (s: string) => rooms.get(s.toUpperCase()),
    cc: (s: string, coId?: string) => { const h = ccs.filter((x) => x.k === s.toUpperCase() && (!coId || x.company_id === coId)); return h.length === 1 ? h[0].id as string : undefined; },
    user: (s: string) => users.get(s.toLowerCase()),
  };
}

function date(v: string | undefined): string | undefined | null {
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 20000 && Number(v) < 80000) return excelDate(Number(v));   // 엑셀 날짜 일련번호
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v) ?? null;
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);   // 미국식 MM/DD/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}
const yes = (v?: string) => !!v && /^(y|yes|true|1|o|예)$/i.test(v);

/** AlmError(필드 오류 포함) → 행 메시지. API 필드 이름을 업로드 열 이름으로 바꾼다 */
const FIELD_COL: Record<string, Col> = { categoryId: 'categoryCode', modelId: 'model', companyId: 'companyCode', roomId: 'roomCode', costCenterId: 'costCenterCode',
  assignedUserId: 'assignedUserEmail', description: 'description', serialNo: 'serialNo', status: 'status', purchaseDate: 'purchaseDate', purchaseCost: 'purchaseCost',
  warrantyEndDate: 'warrantyEndDate', hostname: 'hostname', ipAddress: 'ipAddress', macAddress: 'macAddress', notes: 'notes' };
function fromError(e: unknown): RowMessage[] {
  const rm = (e as { rowMsg?: RowMessage })?.rowMsg;
  if (rm) return [rm];
  // 같은 태그가 이미 있음(자동 채번과 적힌 태그가 겹침 등)
  if ((e as { code?: string })?.code === '23505') return [{ field: 'assetTag', code: 'DUPLICATE_TAG', message: '이미 있는 자산태그입니다' }];
  if (!(e instanceof AlmError)) throw e;
  const errs = (e.detail?.errors as { field: string; code: string; message: string }[] | undefined) ?? [];
  if (errs.length) return errs.map((x) => ({ field: FIELD_COL[x.field], code: x.code, message: x.message }));
  return [{ code: e.code, message: e.message }];
}

// ---------------- 미리보기·적용 ----------------
export async function previewImport(c: PoolClient, p: Principal, body: unknown) { return run(c, p, body, false); }
export async function applyImport(c: PoolClient, p: Principal, body: unknown) { return run(c, p, body, true); }

async function run(c: PoolClient, p: Principal, body: unknown, apply: boolean) {
  const f = readFile(body);
  const L = await lookups(c);
  const tags = f.rows.map((r) => r.v.assetTag?.toUpperCase()).filter((x): x is string => !!x);
  const existing = new Map((await c.query(`SELECT a.id, upper(a.asset_tag) AS k, a.asset_tag, a.version, a.category_id, a.description, a.serial_no, a.hostname,
      host(a.ip_address) AS ip, a.mac_address, a.notes, a.model_id, a.model_text, a.room_id, to_char(a.warranty_end_date, 'YYYY-MM-DD') AS warranty, a.is_bundle,
      (SELECT upper(b.asset_tag) FROM asset b WHERE b.id = a.parent_asset_id) AS bundle_tag FROM asset a WHERE upper(a.asset_tag) = ANY($1)`, [tags])).rows
    .map((r) => [r.k as string, r]));
  const ps = new Params([[...existing.values()].map((r) => r.id)]);
  const writable = new Set((await c.query(`SELECT a.id FROM asset a WHERE a.id = ANY($1::uuid[]) AND ${assetScope(p, 'asset.write', ps)}`, ps.values)).rows.map((r) => r.id as string));
  const seen = new Map<string, number>();
  const results: RowResult[] = [];
  // Bundle 행 먼저(구성품 행이 같은 파일의 Bundle을 참조할 수 있게). 미리보기는 전체를 마지막에 되돌린다
  const ordered = [...f.rows.filter((r) => yes(r.v.isBundle)), ...f.rows.filter((r) => !yes(r.v.isBundle))];
  if (!apply) await c.query('SAVEPOINT imp_preview');
  // bundleTag → Bundle(범위 안·활성). 이 실행에서 만든 Bundle도 찾는다
  const bundleOf = async (tag: string): Promise<{ row?: Record<string, any>; code?: string; message?: string }> => {
    const bp = new Params([tag.toUpperCase()]);
    const b = (await c.query(`SELECT a.id, a.asset_tag, a.company_id, a.is_bundle, a.status FROM asset a WHERE upper(a.asset_tag) = $1 AND ${assetScope(p, 'asset.write', bp)}`, bp.values)).rows[0];
    if (!b) return { code: 'UNKNOWN_BUNDLE', message: `Bundle을 찾을 수 없습니다(ALM 또는 이 파일의 isBundle 행): ${tag}` };
    if (!b.is_bundle) return { code: 'NOT_BUNDLE', message: `Bundle 자산이 아닙니다: ${tag}` };
    if (['RETIRED', 'DISPOSED'].includes(b.status)) return { code: 'NOT_BUNDLE', message: `폐기·처분된 Bundle입니다: ${tag}` };
    return { row: b };
  };
  // 구성품으로 넣기: 안 되면 행 오류(bundleTag 열)
  const attach = async (_res: RowResult, assetId: string, tag: string) => {
    const b = await bundleOf(tag);
    if (!b.row) throw Object.assign(new Error(b.message), { rowMsg: { field: 'bundleTag' as Col, code: b.code!, message: b.message! } });
    try { await attachComponents(c, p, b.row, { ids: [assetId], tags: [] }); } catch (e) {
      const m = e instanceof AlmError ? ((e.detail?.errors as { message: string }[] | undefined)?.[0]?.message ?? e.message) : undefined;
      if (m === undefined) throw e;
      throw Object.assign(new Error(m), { rowMsg: { field: 'bundleTag' as Col, code: 'BUNDLE_COMPONENT', message: m } });
    }
  };

  for (const { rowNo, v } of ordered) {
    const res: RowResult = { rowNo, action: 'SKIP', status: 'OK', assetTag: v.assetTag, description: v.description, errors: [], warnings: [] };
    results.push(res);
    const err = (field: Col | undefined, code: string, message: string) => res.errors.push({ field, code, message });
    const warn = (field: Col | undefined, code: string, message: string) => res.warnings.push({ field, code, message });
    const tagKey = v.assetTag?.toUpperCase();
    if (tagKey) {
      if (seen.has(tagKey)) err('assetTag', 'DUPLICATE_TAG', `같은 태그가 ${seen.get(tagKey)}행에도 있습니다`);
      seen.set(tagKey, rowNo);
    }
    const cur = tagKey ? existing.get(tagKey) : undefined;
    for (const dc of DATE_COLS) if (v[dc] && date(v[dc]) === null) err(dc, 'BAD_DATE', `날짜 형식이 아닙니다(YYYY-MM-DD): ${v[dc]}`);

    if (cur) {
      // ---- 수정 ----
      res.action = 'UPDATE';
      res.assetTag = cur.asset_tag;
      if (!writable.has(cur.id)) { err('assetTag', 'OUT_OF_SCOPE', '수정 권한 범위 밖 자산입니다'); }
      const ignored = COLUMNS.filter((x) => x !== 'assetTag' && v[x] && !UPDATE_COLS.includes(x));
      if (ignored.length) warn(undefined, 'IGNORED_ON_UPDATE', ignored.join(', '));   // 화면: 수정에서 무시한 열(이관·할당 요청 또는 SAP에서 관리)
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const put = (col: Col, key: string, val: unknown, before: unknown) => { if (val !== undefined && (before ?? null) !== val) { patch[key] = val; changes.push(col); } };
      put('description', 'description', v.description, cur.description);
      put('serialNo', 'serialNo', v.serialNo, cur.serial_no);
      put('hostname', 'hostname', v.hostname, cur.hostname);
      put('ipAddress', 'ipAddress', v.ipAddress, cur.ip);
      put('macAddress', 'macAddress', v.macAddress, cur.mac_address);
      put('notes', 'notes', v.notes, cur.notes);
      if (v.warrantyEndDate && date(v.warrantyEndDate)) put('warrantyEndDate', 'warrantyEndDate', date(v.warrantyEndDate), cur.warranty);
      // 모델: 마스터에 있으면 그 모델, 없으면 입력 글자 그대로(직접 입력)
      if (v.model) { const id = L.model(v.model, cur.category_id); if (id) put('model', 'modelId', id, cur.model_id); else if (cur.model_id || v.model !== cur.model_text) { patch.modelName = v.model; changes.push('model'); } }
      if (v.roomCode) { const id = L.room(v.roomCode); if (!id) err('roomCode', 'UNKNOWN_ROOM', `활성 룸이 아닙니다: ${v.roomCode}`); else put('roomCode', 'roomId', id, cur.room_id); }
      if (v.isBundle && yes(v.isBundle) !== !!cur.is_bundle) warn('isBundle', 'IGNORED_ON_UPDATE', 'isBundle');
      const toBundle = v.bundleTag && v.bundleTag.toUpperCase() !== cur.bundle_tag ? v.bundleTag : undefined;
      if (toBundle) changes.push('bundleTag');
      res.changes = changes;
      if (!res.errors.length && !changes.length) { res.action = 'UNCHANGED'; }
      if (!res.errors.length && changes.length) {
        await c.query('SAVEPOINT imp');
        try {
          const out = Object.keys(patch).length ? await patchAsset(c, p, cur.id, String(cur.version), patch) : { createdRequests: [] };
          if (toBundle) await attach(res, cur.id, toBundle);
          if (out.createdRequests?.length) warn(undefined, 'SAP_CHANGE_QUEUED', 'SAP 자산이라 변경(자산명·시리얼·룸)이 SAP 전기 대기열에 들어갑니다');
          res.assetId = cur.id;
          await c.query('RELEASE SAVEPOINT imp');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT imp');
          res.errors.push(...fromError(e));
        }
      }
    } else {
      // ---- 신규 ----
      res.action = 'CREATE';
      if (v.assetTag && !TAG.test(v.assetTag)) err('assetTag', 'BAD_TAG', '자산태그는 영문·숫자·- . _ 2~30자입니다');
      const isBundle = yes(v.isBundle);
      for (const col of REQUIRED_NEW) if (!v[col]) err(col, 'REQUIRED', '신규 등록에 필요합니다');
      if (isBundle && v.bundleTag) err('bundleTag', 'BUNDLE_COMPONENT', 'Bundle은 다른 Bundle에 넣을 수 없습니다');
      const catId = v.categoryCode ? L.cat(v.categoryCode) : undefined;
      if (v.categoryCode && !catId) err('categoryCode', 'UNKNOWN_CATEGORY', `활성 카테고리 코드가 아닙니다: ${v.categoryCode}`);
      const modelId = v.model ? L.model(v.model, catId) : undefined;   // 마스터에 없으면 modelName(직접 입력)으로
      const coId = v.companyCode ? L.co(v.companyCode) : undefined;
      if (v.companyCode && !coId) err('companyCode', 'UNKNOWN_COMPANY', `활성 회사코드가 아닙니다: ${v.companyCode}`);
      const roomId = v.roomCode ? L.room(v.roomCode) : undefined;
      if (v.roomCode && !roomId) err('roomCode', 'UNKNOWN_ROOM', `활성 룸이 아닙니다: ${v.roomCode}`);
      const ccId = v.costCenterCode ? L.cc(v.costCenterCode, coId) : undefined;
      if (v.costCenterCode && !ccId) err('costCenterCode', 'UNKNOWN_COST_CENTER', `이 회사코드의 활성 코스트센터가 아닙니다: ${v.costCenterCode}`);
      const userId = v.assignedUserEmail ? L.user(v.assignedUserEmail) : undefined;
      if (v.assignedUserEmail && !userId) err('assignedUserEmail', 'UNKNOWN_USER', `활성 사용자가 아닙니다: ${v.assignedUserEmail}`);
      const status = (v.status ?? (userId ? 'IN_USE' : 'IN_STOCK')).toUpperCase().replace(/[\s-]/g, '_');
      if (!['IN_STOCK', 'IN_USE', 'ON_ORDER'].includes(status)) err('status', 'BAD_STATUS', '신규 상태는 IN_STOCK·IN_USE·ON_ORDER 중 하나입니다');
      const cost = v.purchaseCost !== undefined ? Number(v.purchaseCost.replace(/[$,\s]/g, '')) : undefined;
      if (cost !== undefined && !(Number.isFinite(cost) && cost >= 0)) err('purchaseCost', 'BAD_NUMBER', `금액이 아닙니다: ${v.purchaseCost}`);
      if (!res.errors.length) {
        await c.query('SAVEPOINT imp');
        try {
          const out = await createAsset(c, p, { ...(isBundle ? { isBundle: true } : {}), categoryId: catId, modelId, modelName: modelId ? undefined : v.model, description: v.description, serialNo: v.serialNo, companyId: coId, roomId,
            costCenterId: ccId, status, assignedUserId: status === 'IN_USE' ? userId : undefined, purchaseDate: date(v.purchaseDate) ?? undefined,
            purchaseCost: cost, warrantyEndDate: date(v.warrantyEndDate) ?? undefined, hostname: v.hostname, notes: v.notes,
            printLabel: yes(v.printLabel), registerInSap: false }, v.assetTag ? { assetTag: v.assetTag.toUpperCase() } : {});
          const a = out.asset as { id: string; assetTag: string };
          res.assetId = a.id;
          res.assetTag = a.assetTag;
          if (v.bundleTag) await attach(res, a.id, v.bundleTag);
          if (v.status && userId && status !== 'IN_USE') warn('assignedUserEmail', 'USER_IGNORED', 'IN_USE가 아니면 사용자는 넣지 않습니다');
          await c.query('RELEASE SAVEPOINT imp');
          if (!apply) res.assetTag = v.assetTag?.toUpperCase();   // 미리보기: 자동 채번은 적용 때 정해진다
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT imp');
          res.errors.push(...fromError(e));
        }
      }
    }
    res.status = res.errors.length ? 'ERROR' : res.warnings.length ? 'WARN' : 'OK';
    if (res.errors.length && apply) res.assetId = undefined;
  }
  if (!apply) await c.query('ROLLBACK TO SAVEPOINT imp_preview');
  results.sort((a, b) => a.rowNo - b.rowNo);
  const count = (fn: (r: RowResult) => boolean) => results.filter(fn).length;
  return {
    fileName: f.fileName, applied: apply, unknownColumns: f.unknownColumns,
    summary: { rows: results.length, create: count((r) => r.action === 'CREATE' && r.status !== 'ERROR'), update: count((r) => r.action === 'UPDATE' && r.status !== 'ERROR'),
      unchanged: count((r) => r.action === 'UNCHANGED'), errors: count((r) => r.status === 'ERROR'), warnings: count((r) => r.status === 'WARN') },
    rows: results.map((r) => Object.fromEntries(Object.entries(r).filter(([, x]) => x !== undefined))),
  };
}

// ---------------- 템플릿 ----------------
const HELP: [Col, string, string][] = [
  ['assetTag', 'Asset tag. Empty = new asset with the next AT-number. A tag not in ALM = new asset that keeps that tag. A tag in ALM = update that asset.', '자산태그. 비우면 신규(자동 채번), ALM에 없는 태그면 그 태그로 신규, 있는 태그면 수정'],
  ['description', 'Asset name (max 50). Required for new.', '자산명(50자). 신규 필수'],
  ['categoryCode', 'Category code (Codes sheet). Required for new. Not changed on update.', '카테고리 코드. 신규 필수, 수정 안 됨'],
  ['model', "Optional. Model part number or 'Manufacturer Model name' from the Codes sheet links the model; any other text is kept as typed.", "선택. Codes 시트의 부품번호·'제조사 모델명'이면 모델에 연결, 아니면 적은 글자 그대로"],
  ['serialNo', 'Serial number (max 40; SAP assets max 18).', '시리얼(40자, SAP 자산 18자)'],
  ['companyCode', 'Company code. Required for new. Not changed on update.', '회사코드. 신규 필수, 수정 안 됨'],
  ['roomCode', 'Room code; the site comes from the room. Required for new.', '룸 코드(사이트는 룸에서). 신규 필수'],
  ['costCenterCode', 'Cost center of the company. Required for new. Not changed on update (use a transfer request).', '코스트센터. 신규 필수, 수정은 이관 요청으로'],
  ['status', 'New only: IN_STOCK (default), IN_USE (needs a user) or ON_ORDER.', '신규만: IN_STOCK(기본)·IN_USE(사용자 필요)·ON_ORDER'],
  ['assignedUserEmail', 'New only: user email when IN_USE.', '신규만: IN_USE일 때 사용자 이메일'],
  ['purchaseDate', 'New only: YYYY-MM-DD.', '신규만: 구매일'],
  ['purchaseCost', 'New only: purchase cost (USD).', '신규만: 구매가'],
  ['warrantyEndDate', 'Warranty end, YYYY-MM-DD.', '보증 만료일'],
  ['hostname', 'Hostname (max 63).', '호스트명'],
  ['ipAddress', 'IP address (update).', 'IP(수정)'],
  ['macAddress', 'MAC address AA:BB:CC:DD:EE:FF (update).', 'MAC(수정)'],
  ['notes', 'Notes.', '메모'],
  ['printLabel', 'New only: Y = add to the label print queue.', '신규만: Y면 라벨 출력 대기열에 추가'],
  ['isBundle', 'New only: Y = register a bundle asset (no model needed). Components are registered in SAP as this one asset.', '신규만: Y면 Bundle 자산으로 등록(모델 불필요). 구성품을 SAP에 이 자산 1건으로 등록'],
  ['bundleTag', 'Tag of the bundle this asset belongs to: a bundle in ALM or an isBundle row in this file (give that row a tag). Only assets not in SAP.', '넣을 Bundle 태그(ALM의 Bundle 또는 이 파일의 isBundle 행 — 그 행에 태그를 적으세요). SAP에 없는 자산만'],
];

export async function importTemplate(c: PoolClient, p: Principal, withAssets: boolean) {
  const sheets: { name: string; rows: Cell[][]; widths?: number[] }[] = [];
  const data: Cell[][] = [COLUMNS.slice()];
  if (withAssets) {
    const ps = new Params();
    for (const r of (await c.query(`SELECT a.asset_tag, a.description, cat.category_code, coalesce(m.part_no, m.manufacturer || ' ' || m.model_name, a.model_text) AS model, a.serial_no,
        co.company_code, rm.room_code, cc.cost_center_code, a.status, to_char(a.warranty_end_date, 'YYYY-MM-DD') AS warranty, a.hostname, host(a.ip_address) AS ip, a.mac_address, a.notes,
        a.is_bundle, (SELECT b.asset_tag FROM asset b WHERE b.id = a.parent_asset_id) AS bundle_tag
      FROM asset a JOIN category cat ON cat.id = a.category_id JOIN company co ON co.id = a.company_id LEFT JOIN model m ON m.id = a.model_id
      LEFT JOIN room rm ON rm.id = a.room_id LEFT JOIN cost_center cc ON cc.id = a.cost_center_id
     WHERE a.status NOT IN ('RETIRED', 'DISPOSED') AND ${assetScope(p, 'asset.write', ps)} ORDER BY a.asset_tag LIMIT ${MAX_ROWS}`, ps.values)).rows) {
      data.push([r.asset_tag, r.description, r.category_code, r.model, r.serial_no, r.company_code, r.room_code, r.cost_center_code, r.status, null, null, null,
        r.warranty, r.hostname, r.ip, r.mac_address, r.notes, null, r.is_bundle ? 'Y' : null, r.bundle_tag]);
    }
  }
  sheets.push({ name: 'Assets', rows: data, widths: [14, 32, 12, 26, 18, 10, 12, 12, 11, 26, 12, 12, 14, 16, 15, 18, 30, 9, 9, 14] });
  sheets.push({ name: 'Instructions', rows: [['Column', 'How to fill (English)', '작성 방법(한국어)'], ...HELP.map((h) => [h[0], h[1], h[2]] as Cell[]),
    [], ['Rules', 'Upload the Assets sheet (xlsx or CSV, up to 2,000 rows). Preview first; only rows without errors are applied. New assets are registered in ALM only (no SAP request).',
      'Assets 시트를 올립니다(xlsx·CSV, 최대 2,000행). 먼저 미리보기, 오류 없는 행만 적용. 신규는 ALM에만 등록(SAP 요청 없음)'],
    ['Example', 'AT-009001 | Latitude 7440 | NB | Dell Latitude 7440 | SN123 | 1000 | ATL-101 | CC100 | IN_STOCK', '예시']], widths: [18, 90, 60] });
  const q = async (sql: string) => (await c.query(sql)).rows;
  const codes: Cell[][] = [['Type', 'Code', 'Name', 'Belongs to']];
  for (const r of await q(`SELECT category_code, name FROM category WHERE is_active ORDER BY category_code`)) codes.push(['Category', r.category_code, r.name, null]);
  for (const r of await q(`SELECT m.part_no, m.manufacturer || ' ' || m.model_name AS full_name, cat.category_code FROM model m JOIN category cat ON cat.id = m.category_id WHERE m.is_active ORDER BY cat.category_code, full_name`)) codes.push(['Model', r.part_no ?? r.full_name, r.full_name, r.category_code]);
  for (const r of await q(`SELECT company_code, name FROM company WHERE is_active ORDER BY company_code`)) codes.push(['Company', r.company_code, r.name, null]);
  for (const r of await q(`SELECT r.room_code, r.name, s.site_code FROM room r JOIN site s ON s.id = r.site_id WHERE r.is_active AND s.is_active ORDER BY s.site_code, r.room_code`)) codes.push(['Room', r.room_code, r.name, r.site_code]);
  for (const r of await q(`SELECT cc.cost_center_code, cc.name, co.company_code FROM cost_center cc JOIN company co ON co.id = cc.company_id WHERE cc.is_active ORDER BY co.company_code, cc.cost_center_code`)) codes.push(['Cost center', r.cost_center_code, r.name, r.company_code]);
  sheets.push({ name: 'Codes', rows: codes, widths: [12, 26, 36, 12] });
  return { fileName: withAssets ? `ALM_assets_${new Date().toISOString().slice(0, 10)}.xlsx` : 'ALM_asset_import_template.xlsx', body: buildXlsx(sheets) };
}
