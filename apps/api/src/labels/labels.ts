// 라벨 출력(ALM-250, WBS 4.5). 서버는 프린터에 연결하지 않는다(결정 A-08):
//   대기열(label_print_job) → :render로 ZPL 발급(RENDERED, render_id) → 브라우저가 PC의 Zebra Browser Print로 프린터에 전송 → :report로 결과 회신(PRINTED·FAILED)
//   템플릿 변수: {assetTag} {description} {model} {sapAssetNo} {roomCode} {siteCode} {companyName}. 매수는 ^PQ, 해상도가 다르면 ^MU로 변환
//   권한: label.read(조회)·label.print(대기열·출력)·label.config(템플릿·프린터). 작업은 자산 범위(label.* 범위) 안에서만
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../auth/principal';
import { assetScope, Params } from '../auth/scope';

export const LAYOUTS = ['QR_CODE128', 'QR_ONLY', 'CODE128_ONLY'] as const;
export type Layout = (typeof LAYOUTS)[number];
const SOURCES = ['ASSET_DETAIL', 'GOODS_RECEIPT', 'PDA_REQUEST', 'BULK'] as const;
const STATUSES = ['QUEUED', 'RENDERED', 'PRINTED', 'FAILED', 'CANCELLED'] as const;
const PRINTABLE = new Set(['QUEUED', 'FAILED', 'RENDERED']);
/** RENDERED로 이 시간이 지나도록 회신이 없으면 '확인 필요' */
const CHECK_AFTER_MIN = 30;

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const conflict = (m: string) => new AlmError(409, 'ALM-E320', m);
const idOk = (id: string, what: string) => { if (!UUID.test(id)) throw E.notFound(`${what}을(를) 찾을 수 없습니다`); };

// ---------------- 기본 템플릿(2" × 1", 203 dpi = 406 × 203 dots) ----------------
//   테넌트에 템플릿이 하나도 없으면 처음 쓸 때 세 가지를 만든다(QR+Code128을 기본). 화면에서 고쳐 쓸 수 있다
const HEAD = '^XA\n^CI28^PW406^LL203^LH0,0\n';
export const DEFAULT_TEMPLATES: { code: string; name: string; layout: Layout; zpl: string; isDefault: boolean }[] = [
  { code: 'STD', name: 'QR + Code 128', layout: 'QR_CODE128', isDefault: true, zpl: `${HEAD}`
    + '^FO10,10^BQN,2,3^FDMA,{assetTag}^FS\n'
    + '^FO104,12^A0N,16,16^FB292,1,0,L^FD{companyName}^FS\n'
    + '^FO104,32^A0N,30,26^FB292,1,0,L^FD{assetTag}^FS\n'
    + '^FO104,66^A0N,18,16^FB292,1,0,L^FD{model}^FS\n'
    + '^FO104,88^A0N,18,16^FB292,1,0,L^FD{sapAssetNo}  {roomCode}^FS\n'
    + '^FO16,120^BY2,3,60^BCN,60,N,N,N^FD{assetTag}^FS\n^XZ' },
  { code: 'QR', name: 'QR only', layout: 'QR_ONLY', isDefault: false, zpl: `${HEAD}`
    + '^FO12,14^BQN,2,5^FDMA,{assetTag}^FS\n'
    + '^FO150,20^A0N,16,16^FB246,1,0,L^FD{companyName}^FS\n'
    + '^FO150,44^A0N,34,30^FB246,1,0,L^FD{assetTag}^FS\n'
    + '^FO150,88^A0N,18,16^FB246,2,0,L^FD{model}^FS\n'
    + '^FO150,140^A0N,18,16^FB246,1,0,L^FD{sapAssetNo}  {roomCode}^FS\n^XZ' },
  { code: 'C128', name: 'Code 128 only', layout: 'CODE128_ONLY', isDefault: false, zpl: `${HEAD}`
    + '^FO16,12^A0N,16,16^FB374,1,0,L^FD{companyName}^FS\n'
    + '^FO16,34^BY2,3,80^BCN,80,N,N,N^FD{assetTag}^FS\n'
    + '^FO16,122^A0N,30,26^FB374,1,0,L^FD{assetTag}^FS\n'
    + '^FO16,158^A0N,18,16^FB374,1,0,L^FD{model}  {sapAssetNo}  {roomCode}^FS\n^XZ' },
];

/** 기본 템플릿 id. 템플릿이 하나도 없으면 기본 세 가지를 만든다(자산 등록·입고·PDA 재출력 요청도 이걸 쓴다) */
export async function defaultTemplateId(c: PoolClient, tenantId: string): Promise<string> {
  await ensureTemplates(c, tenantId);
  const r = (await c.query(`SELECT id FROM label_template WHERE is_active ORDER BY is_default DESC, template_code LIMIT 1`)).rows[0];
  return r.id as string;
}

async function ensureTemplates(c: PoolClient, tenantId: string) {
  if ((await c.query('SELECT 1 FROM label_template WHERE is_active LIMIT 1')).rowCount) return;
  for (const t of DEFAULT_TEMPLATES) {
    await c.query(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, zpl, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, template_code) DO UPDATE SET is_active = true, updated_at = now()`, [randomUUID(), tenantId, t.code, t.name, t.layout, t.zpl, t.isDefault]);
  }
}

// ---------------- ZPL 치환 ----------------
export interface LabelData { assetTag: string; description?: string; model?: string; sapAssetNo?: string; roomCode?: string; siteCode?: string; companyName?: string }

/** 값에서 ZPL 명령 문자(^ ~)를 빼고 한 줄로 */
const zplSafe = (v: string | undefined, max = 60) => (v ?? '').replace(/[\^~\r\n\t]/g, ' ').trim().slice(0, max);
/** ^MU 변환은 150·200·300 → 300·600(올리기만). 203은 200, 305는 300으로 본다 */
const muBase = (dpi: number) => (dpi < 250 ? 200 : dpi < 450 ? 300 : 600);

export function renderZpl(tpl: string, d: LabelData, opt: { copies?: number; templateDpi?: number; printerDpi?: number } = {}): string {
  let z = tpl.replace(/\{(assetTag|description|model|sapAssetNo|roomCode|siteCode|companyName)\}/g, (_, k: keyof LabelData) => zplSafe(d[k]));
  const from = muBase(opt.templateDpi ?? 203), to = muBase(opt.printerDpi ?? opt.templateDpi ?? 203);
  if (to > from) z = z.replace(/\^XA/, `^XA^MUd,${from},${to}`);
  const copies = Math.max(1, Math.min(opt.copies ?? 1, 99));
  const end = z.lastIndexOf('^XZ');
  if (end >= 0 && !/\^PQ\d/.test(z)) z = `${z.slice(0, end)}^PQ${copies}\n${z.slice(end)}`;
  return z;
}

/** SAP 자산번호 표시: 앞 0 빼고 하위번호(0 아니면) */
export function sapNo(no?: string | null, sub?: string | null): string | undefined {
  if (!no) return undefined;
  const main = no.replace(/^0+(?=\d)/, '');
  const s = sub ? sub.replace(/^0+(?=\d)/, '') : '0';
  return s === '0' ? main : `${main}-${s}`;
}

const dataOf = (r: Record<string, any>): LabelData => ({
  assetTag: r.asset_tag, description: r.description ?? undefined, model: r.model_name ? `${r.manufacturer ?? ''} ${r.model_name}`.trim() : undefined,
  sapAssetNo: sapNo(r.sap_asset_no, r.sap_sub_no), roomCode: r.room_code ?? undefined, siteCode: r.site_code ?? undefined, companyName: (r.company_name ?? '').toUpperCase() || undefined,
});

// ---------------- 템플릿 ----------------
const tplRow = (r: Record<string, any>) => ({ id: r.id, version: r.version, templateCode: r.template_code, name: r.name, layout: r.layout,
  widthIn: Number(r.width_in), heightIn: Number(r.height_in), dpi: r.dpi, zpl: r.zpl, isDefault: r.is_default, isActive: r.is_active });

export async function listTemplates(c: PoolClient, p: Principal) {
  await ensureTemplates(c, p.tenantId);
  return { items: (await c.query('SELECT * FROM label_template ORDER BY is_active DESC, is_default DESC, template_code')).rows.map(tplRow) };
}

function readTemplate(body: unknown, partial: boolean) {
  const k = new Check(body), b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const take = (f: string) => !partial || has(f);
  const v = {
    code: partial ? undefined : k.str(b, 'templateCode', { required: true, max: 20, pattern: /^[A-Za-z0-9_.-]+$/ })?.toUpperCase(),
    name: take('name') ? k.str(b, 'name', { required: true, max: 60 }) : undefined,
    layout: take('layout') ? k.oneOf(b, 'layout', LAYOUTS) : undefined,
    widthIn: has('widthIn') ? k.num(b, 'widthIn', { min: 0.5, max: 8 }) : undefined,
    heightIn: has('heightIn') ? k.num(b, 'heightIn', { min: 0.25, max: 8 }) : undefined,
    dpi: has('dpi') ? k.int(b, 'dpi', { min: 150, max: 600 }) : undefined,
    zpl: take('zpl') ? k.str(b, 'zpl', { required: true, max: 8000 }) : undefined,
    isDefault: has('isDefault') ? k.bool(b, 'isDefault') : undefined,
    isActive: partial && has('isActive') ? k.bool(b, 'isActive') : undefined,
  };
  if (!partial && v.layout === undefined && b.layout === undefined) k.errors.push({ field: 'layout', code: 'ALM-E101', message: '필수 값입니다' });
  if (v.zpl !== undefined && !/^\s*\^XA[\s\S]*\^XZ\s*$/.test(v.zpl)) k.fail('zpl', 'ZPL은 ^XA로 시작해 ^XZ로 끝나야 합니다');
  if (partial && has('templateCode')) k.fail('templateCode', '코드는 바꿀 수 없습니다');
  k.done();
  return v;
}

export async function createTemplate(c: PoolClient, p: Principal, body: unknown) {
  const v = readTemplate(body, false);
  if ((await c.query('SELECT 1 FROM label_template WHERE template_code = $1', [v.code])).rowCount) throw E.duplicate(`이미 있는 템플릿 코드입니다: ${v.code}`);
  const id = randomUUID();
  if (v.isDefault) await c.query('UPDATE label_template SET is_default = false, updated_at = now(), updated_by = $1 WHERE is_default', [p.userId]);
  await c.query(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, width_in, height_in, dpi, zpl, is_default, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
  [id, p.tenantId, v.code, v.name, v.layout, v.widthIn ?? 2, v.heightIn ?? 1, v.dpi ?? 203, v.zpl, v.isDefault ?? false, p.userId]);
  return tplRow((await c.query('SELECT * FROM label_template WHERE id = $1', [id])).rows[0]);
}

export async function patchTemplate(c: PoolClient, p: Principal, id: string, body: unknown) {
  idOk(id, '템플릿');
  const v = readTemplate(body, true);
  const cur = (await c.query('SELECT * FROM label_template WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound('템플릿을 찾을 수 없습니다');
  if (v.isActive === false && (v.isDefault ?? cur.is_default)) throw conflict('기본 템플릿은 사용 안 함으로 바꿀 수 없습니다. 다른 템플릿을 기본으로 정한 뒤 바꾸세요');
  if (v.isDefault === false && cur.is_default) throw conflict('기본 템플릿을 끄려면 다른 템플릿을 기본으로 정하세요');
  if (v.isDefault) await c.query('UPDATE label_template SET is_default = false, updated_at = now(), updated_by = $2 WHERE is_default AND id <> $1', [id, p.userId]);
  const sets: string[] = [];
  const args: unknown[] = [id];
  const set = (col: string, val: unknown) => { if (val !== undefined) { args.push(val); sets.push(`${col} = $${args.length}`); } };
  set('name', v.name); set('layout', v.layout); set('width_in', v.widthIn); set('height_in', v.heightIn); set('dpi', v.dpi); set('zpl', v.zpl);
  set('is_default', v.isDefault); set('is_active', v.isActive);
  args.push(p.userId);
  await c.query(`UPDATE label_template SET ${[...sets, `updated_at = now()`, `updated_by = $${args.length}`, 'version = version + 1'].join(', ')} WHERE id = $1`, args);
  return tplRow((await c.query('SELECT * FROM label_template WHERE id = $1', [id])).rows[0]);
}

// ---------------- 프린터 ----------------
const prnRow = (r: Record<string, any>) => clean({ id: r.id, version: r.version, name: r.name, siteId: r.site_id, siteCode: r.site_code, deviceName: r.device_name,
  connection: r.connection, host: r.host, dpi: r.dpi, isActive: r.is_active });
const PRN_SQL = 'SELECT pr.*, s.site_code FROM printer pr LEFT JOIN site s ON s.id = pr.site_id';

export async function listPrinters(c: PoolClient, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const siteId = k.uuid(q as Record<string, unknown>, 'siteId');
  k.done();
  const rows = (await c.query(`${PRN_SQL} WHERE ($1::uuid IS NULL OR pr.site_id = $1 OR pr.site_id IS NULL) ORDER BY pr.is_active DESC, pr.name`, [siteId ?? null])).rows;
  return { items: rows.map(prnRow) };
}

function readPrinter(body: unknown, partial: boolean) {
  const k = new Check(body), b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const v = {
    name: !partial || has('name') ? k.str(b, 'name', { required: true, max: 60 }) : undefined,
    siteId: has('siteId') ? (b.siteId === null ? null : k.uuid(b, 'siteId')) : undefined,
    deviceName: has('deviceName') ? (b.deviceName === null ? null : k.str(b, 'deviceName', { max: 100 })) : undefined,
    connection: has('connection') ? k.oneOf(b, 'connection', ['USB', 'NETWORK'] as const) : undefined,
    host: has('host') ? (b.host === null ? null : k.str(b, 'host', { max: 100 })) : undefined,
    dpi: has('dpi') ? k.int(b, 'dpi', { min: 150, max: 600 }) : undefined,
    isActive: partial && has('isActive') ? k.bool(b, 'isActive') : undefined,
  };
  k.done();
  return v;
}

export async function createPrinter(c: PoolClient, p: Principal, body: unknown) {
  const v = readPrinter(body, false);
  if ((await c.query('SELECT 1 FROM printer WHERE name = $1', [v.name])).rowCount) throw E.duplicate(`이미 있는 프린터 이름입니다: ${v.name}`);
  if (v.siteId && !(await c.query('SELECT 1 FROM site WHERE id = $1', [v.siteId])).rowCount) throw E.notFound('사이트를 찾을 수 없습니다');
  const id = randomUUID();
  await c.query(`INSERT INTO printer (id, tenant_id, name, site_id, device_name, connection, host, dpi, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [id, p.tenantId, v.name, v.siteId ?? null, v.deviceName ?? null, v.connection ?? 'USB', v.host ?? null, v.dpi ?? 203, p.userId]);
  return prnRow((await c.query(`${PRN_SQL} WHERE pr.id = $1`, [id])).rows[0]);
}

export async function patchPrinter(c: PoolClient, p: Principal, id: string, body: unknown) {
  idOk(id, '프린터');
  const v = readPrinter(body, true);
  if (!(await c.query('SELECT 1 FROM printer WHERE id = $1 FOR UPDATE', [id])).rowCount) throw E.notFound('프린터를 찾을 수 없습니다');
  if (v.name && (await c.query('SELECT 1 FROM printer WHERE name = $1 AND id <> $2', [v.name, id])).rowCount) throw E.duplicate(`이미 있는 프린터 이름입니다: ${v.name}`);
  const sets: string[] = [];
  const args: unknown[] = [id];
  const set = (col: string, val: unknown) => { if (val !== undefined) { args.push(val); sets.push(`${col} = $${args.length}`); } };
  set('name', v.name); set('site_id', v.siteId); set('device_name', v.deviceName); set('connection', v.connection); set('host', v.host); set('dpi', v.dpi);
  set('is_active', v.isActive);
  args.push(p.userId);
  await c.query(`UPDATE printer SET ${[...sets, 'updated_at = now()', `updated_by = $${args.length}`, 'version = version + 1'].join(', ')} WHERE id = $1`, args);
  return prnRow((await c.query(`${PRN_SQL} WHERE pr.id = $1`, [id])).rows[0]);
}

/** 시험 라벨: 기본 템플릿에 견본 값. 이력은 남기지 않는다 */
export async function testLabel(c: PoolClient, p: Principal, id: string) {
  idOk(id, '프린터');
  const prn = (await c.query('SELECT * FROM printer WHERE id = $1', [id])).rows[0];
  if (!prn) throw E.notFound('프린터를 찾을 수 없습니다');
  const tpl = (await c.query('SELECT * FROM label_template WHERE id = $1', [await defaultTemplateId(c, p.tenantId)])).rows[0];
  const co = (await c.query('SELECT name FROM company ORDER BY company_code LIMIT 1')).rows[0];
  return { zpl: renderZpl(tpl.zpl, { assetTag: 'AT-TEST01', description: 'Test label', model: 'Zebra ZD421 test', sapAssetNo: '1000000', roomCode: 'TEST',
    companyName: (co?.name ?? 'ALM').toUpperCase() }, { templateDpi: tpl.dpi, printerDpi: prn.dpi }) };
}

// ---------------- 대기열·이력 ----------------
const JOB_SQL = `SELECT j.*, t.name AS template_name, t.layout, pr.name AS printer_name, ru.display_name AS requested_by_name, rn.display_name AS rendered_by_name,
    a.asset_tag, a.description, a.sap_asset_no, a.sap_sub_no, m.manufacturer, m.model_name, r.room_code, s.site_code, co.name AS company_name
  FROM label_print_job j JOIN asset a ON a.id = j.asset_id JOIN company co ON co.id = a.company_id JOIN label_template t ON t.id = j.template_id
  LEFT JOIN printer pr ON pr.id = j.printer_id LEFT JOIN app_user ru ON ru.id = j.requested_by LEFT JOIN app_user rn ON rn.id = j.rendered_by
  LEFT JOIN model m ON m.id = a.model_id LEFT JOIN room r ON r.id = a.room_id LEFT JOIN site s ON s.id = a.site_id`;

const jobRow = (r: Record<string, any>) => {
  const d = dataOf(r);
  return clean({
    id: r.id, assetId: r.asset_id, assetTag: r.asset_tag, description: r.description, model: d.model, sapAssetNo: d.sapAssetNo, roomCode: d.roomCode, siteCode: d.siteCode,
    companyName: d.companyName, templateId: r.template_id, templateName: r.template_name, layout: r.layout, source: r.source, status: r.status, copies: r.copies,
    attemptCount: r.attempt_count, requestedByName: r.requested_by_name, requestedAt: iso(r.requested_at), renderedByName: r.rendered_by_name, renderedAt: iso(r.rendered_at),
    printerName: r.printer_name, printedAt: iso(r.printed_at), error: r.error_message,
    needsCheck: r.status === 'RENDERED' && r.rendered_at && Date.now() - new Date(r.rendered_at).getTime() > CHECK_AFTER_MIN * 60_000 ? true : undefined,
  });
};

function intParam(k: Check, q: Record<string, string | undefined>, f: string, def: number, min: number, max: number): number {
  const v = q[f];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) { k.fail(f, `${min}~${max} 정수`); return def; }
  return n;
}

export async function listJobs(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const page = intParam(k, q, 'page', 1, 1, 100000), pageSize = intParam(k, q, 'pageSize', 50, 1, 500);
  const statuses = (q.status ?? 'QUEUED,FAILED,RENDERED').split(',').map((x) => x.trim()).filter(Boolean);
  if (statuses.some((x) => x !== 'ALL' && !STATUSES.includes(x as never))) k.fail('status', STATUSES.join(', '));
  const sources = (q.source ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (sources.some((x) => !SOURCES.includes(x as never))) k.fail('source', SOURCES.join(', '));
  const siteId = k.uuid(q as Record<string, unknown>, 'siteId');
  k.done();
  const ps = new Params();
  const w = [assetScope(p, 'label.read', ps)];
  if (!statuses.includes('ALL')) w.push(`j.status::text = ANY(${ps.add(statuses)})`);
  if (sources.length) w.push(`j.source::text = ANY(${ps.add(sources)})`);
  if (siteId) w.push(`a.site_id = ${ps.add(siteId)}`);
  if (q.q?.trim()) w.push(`(a.asset_tag ILIKE ${ps.add(`%${q.q.trim().slice(0, 40).replace(/[\\%_]/g, (m) => `\\${m}`)}%`)} OR a.description ILIKE $${ps.values.length})`);
  const where = w.join(' AND ');
  const total = (await c.query(`SELECT count(*)::int AS n FROM label_print_job j JOIN asset a ON a.id = j.asset_id WHERE ${where}`, ps.values)).rows[0].n as number;
  const ps2 = new Params();
  const counts = Object.fromEntries((await c.query(`SELECT j.status, count(*)::int AS n FROM label_print_job j JOIN asset a ON a.id = j.asset_id
     WHERE ${assetScope(p, 'label.read', ps2)} GROUP BY j.status`, ps2.values)).rows.map((r) => [r.status, r.n]));
  const rows = (await c.query(`${JOB_SQL} WHERE ${where} ORDER BY coalesce(j.printed_at, j.rendered_at, j.requested_at) DESC, j.asset_id
     OFFSET ${ps.add((page - 1) * pageSize)} LIMIT ${ps.add(pageSize)}`, ps.values)).rows;
  return { items: rows.map(jobRow), page, pageSize, total, counts };
}

export async function createJobs(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const ids = k.arr(b, 'assetIds', { max: 500 }).map((x, i) => { const s = typeof x === 'string' ? x : ''; if (!/^[0-9a-f-]{36}$/i.test(s)) k.fail(`assetIds[${i}]`, 'uuid'); return s; });
  const tags = k.arr(b, 'assetTags', { max: 500 }).map((x, i) => { const s = typeof x === 'string' ? x.trim().toUpperCase() : ''; if (!s || s.length > 30) k.fail(`assetTags[${i}]`, '자산태그'); return s; });
  const templateId = k.uuid(b, 'templateId');
  const copies = k.int(b, 'copies', { min: 1, max: 20 }) ?? 1;
  if (!ids.length && !tags.length) k.errors.push({ field: 'assetIds', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  const ps = new Params([ids, tags]);
  const found = (await c.query(`SELECT a.id, a.asset_tag FROM asset a WHERE (a.id = ANY($1::uuid[]) OR upper(a.asset_tag) = ANY($2::text[]))
     AND a.status NOT IN ('RETIRED', 'DISPOSED') AND ${assetScope(p, 'label.print', ps)}`, ps.values)).rows;
  const missingTags = tags.filter((t) => !found.some((f) => f.asset_tag.toUpperCase() === t));
  const missingIds = ids.filter((id) => !found.some((f) => f.id === id));
  if (missingTags.length || missingIds.length) {
    throw new AlmError(400, 'ALM-E100', `라벨을 출력할 수 없는 자산입니다(없음·범위 밖·폐기): ${[...missingTags, ...missingIds].slice(0, 5).join(', ')}`,
      { errors: [...missingTags.map((t) => ({ field: 'assetTags', code: 'ALM-E404', message: t })), ...missingIds.map((t) => ({ field: 'assetIds', code: 'ALM-E404', message: t }))] });
  }
  let tpl = templateId;
  if (tpl) { if (!(await c.query('SELECT 1 FROM label_template WHERE id = $1 AND is_active', [tpl])).rowCount) throw E.notFound('템플릿을 찾을 수 없습니다'); } else tpl = await defaultTemplateId(c, p.tenantId);
  const source = found.length > 1 ? 'BULK' : 'ASSET_DETAIL';
  const created: string[] = [];
  for (const a of found) {
    // 같은 자산이 이미 대기 중이면 새로 만들지 않고 템플릿·매수만 맞춘다
    const q0 = (await c.query(`SELECT id FROM label_print_job WHERE asset_id = $1 AND status = 'QUEUED' LIMIT 1`, [a.id])).rows[0];
    if (q0) {
      await c.query('UPDATE label_print_job SET template_id = $2, copies = $3, requested_by = $4, requested_at = now() WHERE id = $1', [q0.id, tpl, copies, p.userId]);
      created.push(q0.id);
      continue;
    }
    const id = randomUUID();
    await c.query(`INSERT INTO label_print_job (id, tenant_id, asset_id, template_id, source, copies, requested_by, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, p.tenantId, a.id, tpl, source, copies, p.userId]);
    created.push(id);
  }
  const rows = (await c.query(`${JOB_SQL} WHERE j.id = ANY($1::uuid[]) ORDER BY a.asset_tag`, [created])).rows;
  return { items: rows.map(jobRow), page: 1, pageSize: rows.length, total: rows.length };
}

/** 범위 안 작업을 잠그고 읽는다. 없거나 범위 밖이면 404 */
async function lockJobs(c: PoolClient, p: Principal, ids: string[]) {
  const ps = new Params([ids]);
  const rows = (await c.query(`SELECT j.* FROM label_print_job j JOIN asset a ON a.id = j.asset_id WHERE j.id = ANY($1::uuid[]) AND ${assetScope(p, 'label.print', ps)}
    ORDER BY j.id FOR UPDATE OF j`, ps.values)).rows;
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw E.notFound(`출력 작업을 찾을 수 없습니다: ${missing.slice(0, 3).join(', ')}`);
  return rows;
}

function readIds(k: Check, b: Record<string, unknown>, max: number) {
  const ids = [...new Set(k.arr(b, 'jobIds', { required: true, max }).map((x, i) => { const s = typeof x === 'string' ? x : ''; if (!/^[0-9a-f-]{36}$/i.test(s)) k.fail(`jobIds[${i}]`, 'uuid'); return s; }))];
  return ids;
}

export async function renderJobs(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const ids = readIds(k, b, 200);
  const printerId = k.uuid(b, 'printerId', { required: true });
  k.done();
  const prn = (await c.query('SELECT * FROM printer WHERE id = $1 AND is_active', [printerId])).rows[0];
  if (!prn) throw E.notFound('프린터를 찾을 수 없습니다');
  const jobs = await lockJobs(c, p, ids);
  const bad = jobs.filter((j) => !PRINTABLE.has(j.status));
  if (bad.length) throw conflict(`대기·실패·발급 상태의 작업만 출력합니다(${bad.length}건은 ${[...new Set(bad.map((j) => j.status))].join(', ')})`);
  const renderId = randomUUID();
  await c.query(`UPDATE label_print_job SET status = 'RENDERED', render_id = $2, printer_id = $3, rendered_by = $4, rendered_at = now(), attempt_count = attempt_count + 1,
      error_message = NULL WHERE id = ANY($1::uuid[])`, [ids, renderId, prn.id, p.userId]);
  const rows = (await c.query(`${JOB_SQL.replace('SELECT j.*,', 'SELECT j.*, t.zpl, t.dpi AS tpl_dpi,')} WHERE j.id = ANY($1::uuid[]) ORDER BY a.asset_tag`, [ids])).rows;
  return { renderId, deviceName: prn.device_name ?? undefined, printerName: prn.name,
    items: rows.map((r) => ({ jobId: r.id, assetTag: r.asset_tag, zpl: renderZpl(r.zpl, dataOf(r), { copies: r.copies, templateDpi: r.tpl_dpi, printerDpi: prn.dpi }) })) };
}

export async function reportJobs(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const renderId = k.uuid(b, 'renderId', { required: true })!;
  const list = k.arr(b, 'results', { required: true, max: 200 }).map((x, i) => {
    const o = k.obj(x, `results[${i}]`);
    return { jobId: k.uuid(o, 'jobId', { required: true, field: `results[${i}].jobId` })!, status: k.oneOf(o, 'status', ['PRINTED', 'FAILED'] as const, `results[${i}].status`)!,
      error: k.str(o, 'error', { max: 500, field: `results[${i}].error` }) };
  });
  const clientInfo = k.str(b, 'clientInfo', { max: 200 });
  k.done();
  const results: { id: string; status: 'OK' | 'ERROR'; code?: string; message?: string }[] = [];
  for (const it of list) {
    const ps = new Params([it.jobId]);
    const j = (await c.query(`SELECT j.*, t.name AS template_name, pr.name AS printer_name FROM label_print_job j JOIN asset a ON a.id = j.asset_id
        JOIN label_template t ON t.id = j.template_id LEFT JOIN printer pr ON pr.id = j.printer_id
       WHERE j.id = $1 AND ${assetScope(p, 'label.print', ps)} FOR UPDATE OF j`, ps.values)).rows[0];
    if (!j) { results.push({ id: it.jobId, status: 'ERROR', code: 'ALM-E404', message: '출력 작업을 찾을 수 없습니다' }); continue; }
    if (j.status !== 'RENDERED' || j.render_id !== renderId) {
      results.push({ id: it.jobId, status: 'ERROR', code: 'ALM-E320', message: `이 발급(renderId)의 RENDERED 작업이 아닙니다(현재 ${j.status})` });
      continue;
    }
    if (it.status === 'PRINTED') {
      await c.query(`UPDATE label_print_job SET status = 'PRINTED', printed_at = now(), client_info = $2, error_message = NULL WHERE id = $1`, [j.id, clientInfo ?? null]);
      await c.query(`INSERT INTO asset_event (id, tenant_id, asset_id, event_type, actor_id, channel, changes) VALUES ($1, $2, $3, 'LABEL_PRINTED', $4, 'UI', $5)`,
        [randomUUID(), p.tenantId, j.asset_id, p.userId, JSON.stringify({ template: j.template_name, printer: j.printer_name ?? undefined, copies: j.copies, source: j.source })]);
    } else {
      await c.query(`UPDATE label_print_job SET status = 'FAILED', error_message = $2, client_info = $3 WHERE id = $1`, [j.id, it.error ?? 'Browser Print 전송 실패', clientInfo ?? null]);
    }
    results.push({ id: it.jobId, status: 'OK' });
  }
  return { results };
}

/** 대기열에서 뺀다(CANCELLED). 출력 완료·취소된 작업은 그대로 */
export async function cancelJobs(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const ids = readIds(k, b, 500);
  k.done();
  const jobs = await lockJobs(c, p, ids);
  const bad = jobs.filter((j) => !PRINTABLE.has(j.status));
  if (bad.length) throw conflict(`출력이 끝났거나 취소된 작업은 뺄 수 없습니다(${bad.length}건)`);
  await c.query(`UPDATE label_print_job SET status = 'CANCELLED', error_message = NULL WHERE id = ANY($1::uuid[])`, [ids]);
  return { results: ids.map((id) => ({ id, status: 'OK' as const })) };
}

export async function previewZpl(c: PoolClient, p: Principal, id: string) {
  idOk(id, '출력 작업');
  const ps = new Params([id]);
  const r = (await c.query(`${JOB_SQL.replace('SELECT j.*,', 'SELECT j.*, t.zpl, t.dpi AS tpl_dpi, pr.dpi AS prn_dpi,')} WHERE j.id = $1 AND ${assetScope(p, 'label.read', ps)}`, ps.values)).rows[0];
  if (!r) throw E.notFound('출력 작업을 찾을 수 없습니다');
  return { zpl: renderZpl(r.zpl, dataOf(r), { copies: r.copies, templateDpi: r.tpl_dpi, printerDpi: r.prn_dpi ?? r.tpl_dpi }) };
}
