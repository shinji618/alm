// 재산세(사업용 동산, Business Personal Property) 신고 자료·예상 세액·과거 기록(ALM-260, 2026-10-17 요청)
//   관할(주·카운티) = 기준일·기한·평가율·세율·면제·계수표. 사이트를 관할에 연결한다(site.tax_jurisdiction_id)
//   신고 1건 = 회사 × 관할 × 기준일 연도. 계산하면 그 시점 자산을 행(tax_filing_line)으로 복사해 둔다 → 신고(FILED) 뒤에는 고정(과거 기록)
//   대상: 그 관할 사이트에 있는 회사 자산 중 기준일에 보유한 것(취득일 ≤ 기준일, 기준일 전에 폐기·처분된 것 제외, 발주 중 제외)
//   원가: SAP 자산(회사가 SAP 사용·자산번호 있음)은 SAP 취득가(APC), 아니면 ALM 구매가. 둘 다 없으면 '원가 모름'으로 따로 표시
//   공정가치 = 원가 × 계수(계수표: 기준일 연도 × 내용연수 구분 × 경과연수). 평가액 = (공정가치 − 면제) × 평가율. 예상 세액 = 평가액 × 밀리지 ÷ 1,000
//   전년 신고와 비교: NEW(신규) · CARRIED(계속) · DISPOSED(전년에 있었고 올해 없음 — 처분 목록)
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../auth/principal';
import { buildXlsx, type Cell } from '../common/xlsx';
import { AGE_START, FACTOR_SETS, genericFactor, lifeClassOf, NEVER_TAXED, PROPERTY_TYPES, REFERENCE_TABLES, STATE_PRESETS, suggestPropertyType, type FactorSet,
  type PropertyType } from './reference';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const pad = (n: number) => String(n).padStart(2, '0');
const notFound = (m = '재산세 신고를 찾을 수 없습니다') => E.notFound(m);

// ---------------- 참고값 ----------------
export function reference() {
  return { presets: STATE_PRESETS, factorSets: FACTOR_SETS, propertyTypes: PROPERTY_TYPES,
    referenceTables: REFERENCE_TABLES.map((t) => ({ factorSet: t.factorSet, tableYear: t.tableYear, source: t.source, verified: t.verified, classes: Object.keys(t.rows) })) };
}

// ---------------- 관할 ----------------
function jurOut(r: Record<string, any>, sites: { id: string; site_code: string; name: string }[] = []) {
  return clean({ id: r.id, version: r.version, state: r.state, county: r.county, name: r.name, taxable: r.taxable, formCode: r.form_code ?? undefined,
    lienMonth: r.lien_month, lienDay: r.lien_day, dueMonth: r.due_month ?? undefined, dueDay: r.due_day ?? undefined,
    assessmentRatio: Number(r.assessment_ratio), millage: Number(r.millage), exemptionMode: r.exemption_mode, exemptionAmount: Number(r.exemption_amount),
    factorSet: r.factor_set, includeVehicles: r.include_vehicles, includeCip: r.include_cip, includeLeasehold: r.include_leasehold, notes: r.notes ?? undefined, isActive: r.is_active,
    sites: sites.map((s) => ({ id: s.id, siteCode: s.site_code, name: s.name })) });
}

export async function listJurisdictions(c: PoolClient) {
  const rows = (await c.query('SELECT * FROM tax_jurisdiction ORDER BY state, county')).rows;
  const sites = (await c.query('SELECT id, site_code, name, tax_jurisdiction_id FROM site WHERE tax_jurisdiction_id IS NOT NULL ORDER BY site_code')).rows;
  return { items: rows.map((r) => jurOut(r, sites.filter((s) => s.tax_jurisdiction_id === r.id))) };
}

function readJur(body: unknown, partial: boolean) {
  const k = new Check(body), b = k.obj();
  const intIn = (key: string, min: number, max: number, req = false) => {
    const v = k.int(b, key, { min, max });
    if (req && !partial && b[key] === undefined) k.errors.push({ field: key, code: 'ALM-E101', message: '필수 값입니다' });
    return v;
  };
  const v = {
    state: k.str(b, 'state', { required: !partial, pattern: /^[A-Za-z]{2}$/ })?.toUpperCase(),
    county: k.str(b, 'county', { required: !partial, max: 60 }),
    name: k.str(b, 'name', { required: !partial, max: 100 }),
    taxable: k.bool(b, 'taxable'),
    formCode: k.str(b, 'formCode', { max: 20 }),
    lienMonth: intIn('lienMonth', 1, 12, true), lienDay: intIn('lienDay', 1, 31, true),
    dueMonth: intIn('dueMonth', 1, 12), dueDay: intIn('dueDay', 1, 31),
    assessmentRatio: k.num(b, 'assessmentRatio', { min: 0, max: 1 }),
    millage: k.num(b, 'millage', { min: 0, max: 500 }),
    exemptionMode: k.oneOf(b, 'exemptionMode', ['NONE', 'THRESHOLD', 'DEDUCT'] as const),
    exemptionAmount: k.num(b, 'exemptionAmount', { min: 0, max: 1e10 }),
    factorSet: k.oneOf(b, 'factorSet', FACTOR_SETS),
    includeVehicles: k.bool(b, 'includeVehicles'),
    includeCip: k.bool(b, 'includeCip'),
    includeLeasehold: k.bool(b, 'includeLeasehold'),
    notes: k.str(b, 'notes', { max: 2000 }),
    isActive: k.bool(b, 'isActive'),
  };
  if (!partial && !v.factorSet && b.factorSet === undefined) k.errors.push({ field: 'factorSet', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  return { v, has: (f: string) => Object.prototype.hasOwnProperty.call(b, f) };
}

export async function createJurisdiction(c: PoolClient, p: Principal, body: unknown) {
  const { v } = readJur(body, false);
  if ((await c.query('SELECT 1 FROM tax_jurisdiction WHERE state = $1 AND lower(county) = lower($2)', [v.state, v.county])).rowCount) {
    throw E.duplicate(`${v.state} ${v.county} 관할이 이미 있습니다`);
  }
  const id = randomUUID();
  await c.query(`INSERT INTO tax_jurisdiction (id, tenant_id, state, county, name, taxable, form_code, lien_month, lien_day, due_month, due_day, assessment_ratio,
      millage, exemption_mode, exemption_amount, factor_set, notes, is_active, created_by, updated_by, include_vehicles, include_cip, include_leasehold)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $21, $22)`,
  [id, p.tenantId, v.state, v.county, v.name, v.taxable ?? true, v.formCode ?? null, v.lienMonth, v.lienDay, v.dueMonth ?? null, v.dueDay ?? null,
    v.assessmentRatio ?? 1, v.millage ?? 0, v.exemptionMode ?? 'NONE', v.exemptionAmount ?? 0, v.factorSet, v.notes ?? null, v.isActive ?? true, p.userId,
    v.includeVehicles ?? STATE_PRESETS.find((x) => x.state === v.state)?.includeVehicles ?? false,
    v.includeCip ?? STATE_PRESETS.find((x) => x.state === v.state)?.includeCip ?? true,
    v.includeLeasehold ?? STATE_PRESETS.find((x) => x.state === v.state)?.includeLeasehold ?? true]);
  return jurOut((await c.query('SELECT * FROM tax_jurisdiction WHERE id = $1', [id])).rows[0]);
}

const JUR_COLS: [string, string][] = [['state', 'state'], ['county', 'county'], ['name', 'name'], ['taxable', 'taxable'], ['formCode', 'form_code'],
  ['lienMonth', 'lien_month'], ['lienDay', 'lien_day'], ['dueMonth', 'due_month'], ['dueDay', 'due_day'], ['assessmentRatio', 'assessment_ratio'],
  ['millage', 'millage'], ['exemptionMode', 'exemption_mode'], ['exemptionAmount', 'exemption_amount'], ['factorSet', 'factor_set'], ['notes', 'notes'], ['isActive', 'is_active'],
  ['includeVehicles', 'include_vehicles'], ['includeCip', 'include_cip'], ['includeLeasehold', 'include_leasehold']];

export async function patchJurisdiction(c: PoolClient, p: Principal, id: string, body: unknown) {
  if (!isUuid(id)) throw E.notFound('관할을 찾을 수 없습니다');
  const { v, has } = readJur(body, true);
  const cur = (await c.query('SELECT * FROM tax_jurisdiction WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound('관할을 찾을 수 없습니다');
  const sets: string[] = [], args: unknown[] = [id];
  for (const [f, colName] of JUR_COLS) {
    if (!has(f)) continue;
    args.push((v as Record<string, unknown>)[f] ?? null);
    sets.push(`${colName} = $${args.length}`);
  }
  if (sets.length) {
    args.push(p.userId);
    await c.query(`UPDATE tax_jurisdiction SET ${sets.join(', ')}, updated_at = now(), updated_by = $${args.length}, version = version + 1 WHERE id = $1`, args);
  }
  const sites = (await c.query('SELECT id, site_code, name FROM site WHERE tax_jurisdiction_id = $1 ORDER BY site_code', [id])).rows;
  return jurOut((await c.query('SELECT * FROM tax_jurisdiction WHERE id = $1', [id])).rows[0], sites);
}

/** 관할에 속한 사이트를 정한다(목록 그대로). 다른 관할에 있던 사이트는 옮겨 온다 */
export async function setJurisdictionSites(c: PoolClient, p: Principal, id: string, body: unknown) {
  if (!isUuid(id)) throw E.notFound('관할을 찾을 수 없습니다');
  const k = new Check(body), b = k.obj();
  const ids = k.arr(b, 'siteIds', { required: true, max: 500 });
  if (ids.some((x) => !isUuid(x))) k.fail('siteIds', 'uuid 배열');
  k.done();
  if (!(await c.query('SELECT 1 FROM tax_jurisdiction WHERE id = $1', [id])).rowCount) throw E.notFound('관할을 찾을 수 없습니다');
  await c.query(`UPDATE site SET tax_jurisdiction_id = NULL, updated_at = now(), updated_by = $2, version = version + 1
    WHERE tax_jurisdiction_id = $1 AND NOT (id = ANY($3::uuid[]))`, [id, p.userId, ids]);
  await c.query(`UPDATE site SET tax_jurisdiction_id = $1, updated_at = now(), updated_by = $2, version = version + 1
    WHERE id = ANY($3::uuid[]) AND tax_jurisdiction_id IS DISTINCT FROM $1`, [id, p.userId, ids]);
  const sites = (await c.query('SELECT id, site_code, name FROM site WHERE tax_jurisdiction_id = $1 ORDER BY site_code', [id])).rows;
  return jurOut((await c.query('SELECT * FROM tax_jurisdiction WHERE id = $1', [id])).rows[0], sites);
}

// ---------------- 계수표 ----------------
export async function listFactors(c: PoolClient, q: Record<string, string | undefined>) {
  const set = q.factorSet as FactorSet;
  if (!FACTOR_SETS.includes(set)) throw E.badRequest('factorSet이 올바르지 않습니다');
  const years = (await c.query('SELECT DISTINCT table_year FROM tax_factor WHERE factor_set = $1 ORDER BY 1 DESC', [set])).rows.map((r) => r.table_year as number);
  const year = q.tableYear ? Number(q.tableYear) : years[0];
  const rows = year ? (await c.query('SELECT life_class, age, factor, source FROM tax_factor WHERE factor_set = $1 AND table_year = $2 ORDER BY life_class, age',
    [set, year])).rows : [];
  return clean({ factorSet: set, tableYears: years, tableYear: year, source: rows[0]?.source ?? undefined, ageStart: AGE_START[set],
    rows: rows.map((r) => ({ lifeClass: r.life_class, age: r.age, factor: Number(r.factor) })) });
}

export async function replaceFactors(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const set = k.oneOf(b, 'factorSet', FACTOR_SETS);
  const year = k.int(b, 'tableYear', { min: 2000, max: 2100 });
  const source = k.str(b, 'source', { max: 200 });
  const rows = k.arr(b, 'rows', { required: true, max: 2000 }).map((x, i) => {
    const o = k.obj(x, `rows[${i}]`);
    return { lifeClass: k.str(o, 'lifeClass', { required: true, max: 10, field: `rows[${i}].lifeClass` })!, age: k.int(o, 'age', { min: 0, max: 100, field: `rows[${i}].age` })!,
      factor: k.num(o, 'factor', { min: 0, max: 1.5, field: `rows[${i}].factor` })! };
  });
  if (!set) k.errors.push({ field: 'factorSet', code: 'ALM-E101', message: '필수 값입니다' });
  if (year === undefined) k.errors.push({ field: 'tableYear', code: 'ALM-E101', message: '필수 값입니다' });
  rows.forEach((r, i) => { if (r.age === undefined || r.factor === undefined) k.errors.push({ field: `rows[${i}]`, code: 'ALM-E101', message: 'age·factor 필수' }); });
  const keys = new Set(rows.map((r) => `${r.lifeClass}|${r.age}`));
  if (keys.size !== rows.length) k.fail('rows', '같은 구분·경과연수가 두 번 있습니다');
  k.done();
  await writeTable(c, p, set!, year!, source ?? null, rows);
  return listFactors(c, { factorSet: set, tableYear: String(year) });
}

async function writeTable(c: PoolClient, p: Principal, set: string, year: number, source: string | null, rows: { lifeClass: string; age: number; factor: number }[]) {
  await c.query('DELETE FROM tax_factor WHERE factor_set = $1 AND table_year = $2', [set, year]);
  for (const r of rows) {
    await c.query(`INSERT INTO tax_factor (id, tenant_id, factor_set, table_year, life_class, age, factor, source, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, [randomUUID(), p.tenantId, set, year, r.lifeClass, r.age, r.factor, source, p.userId]);
  }
}

/** 참고표(조사값)를 테넌트 표로 복사. 같은 연도 표는 바꾼다 */
export async function loadReference(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const set = k.oneOf(b, 'factorSet', FACTOR_SETS);
  if (!set) k.errors.push({ field: 'factorSet', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  const tables = REFERENCE_TABLES.filter((t) => t.factorSet === set);
  if (!tables.length) throw new AlmError(409, 'ALM-E322', `${set}은(는) 참고표가 없습니다(정액 추정을 쓰거나 표를 직접 입력하세요)`);
  for (const t of tables) {
    const start = AGE_START[t.factorSet];
    const rows = Object.entries(t.rows).flatMap(([cls, vals]) => vals.map((f, i) => ({ lifeClass: cls, age: start + i, factor: f })));
    await writeTable(c, p, t.factorSet, t.tableYear, `${t.verified ? '' : '[verify] '}${t.source}`.slice(0, 200), rows);
  }
  return listFactors(c, { factorSet: set });
}

// ---------------- 카테고리 → 내용연수 구분 ----------------
export async function listClassMap(c: PoolClient, q: Record<string, string | undefined>) {
  const set = q.factorSet as FactorSet;
  if (!FACTOR_SETS.includes(set)) throw E.badRequest('factorSet이 올바르지 않습니다');
  const rows = (await c.query(`SELECT cat.id, cat.category_code, cat.name, cat.useful_life_years, m.life_class
      FROM category cat LEFT JOIN tax_class_map m ON m.category_id = cat.id AND m.factor_set = $1
     WHERE cat.is_active ORDER BY cat.name`, [set])).rows;
  return { factorSet: set, items: rows.map((r) => clean({ categoryId: r.id, categoryCode: r.category_code, name: r.name, usefulLifeYears: r.useful_life_years ?? undefined,
    lifeClass: r.life_class ?? undefined, defaultClass: lifeClassOf(set, r.useful_life_years) })) };
}

export async function replaceClassMap(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const set = k.oneOf(b, 'factorSet', FACTOR_SETS);
  const items = k.arr(b, 'items', { required: true, max: 1000 }).map((x, i) => {
    const o = k.obj(x, `items[${i}]`);
    return { categoryId: k.uuid(o, 'categoryId', { required: true, field: `items[${i}].categoryId` })!, lifeClass: k.str(o, 'lifeClass', { max: 10, field: `items[${i}].lifeClass` }) };
  });
  if (!set) k.errors.push({ field: 'factorSet', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  for (const it of items) {
    if (it.lifeClass) {
      await c.query(`INSERT INTO tax_class_map (id, tenant_id, factor_set, category_id, life_class, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (factor_set, category_id) DO UPDATE SET life_class = EXCLUDED.life_class, updated_at = now(), updated_by = EXCLUDED.updated_by, version = tax_class_map.version + 1`,
      [randomUUID(), p.tenantId, set, it.categoryId, it.lifeClass, p.userId]);
    } else {
      await c.query('DELETE FROM tax_class_map WHERE factor_set = $1 AND category_id = $2', [set, it.categoryId]);
    }
  }
  return listClassMap(c, { factorSet: set });
}

// ---------------- 신고 계산 ----------------
interface Jur { id: string; state: string; county: string; name: string; taxable: boolean; form_code: string | null; lien_month: number; lien_day: number;
  due_month: number | null; due_day: number | null; assessment_ratio: string; millage: string; exemption_mode: 'NONE' | 'THRESHOLD' | 'DEDUCT';
  exemption_amount: string; factor_set: FactorSet; notes: string | null; include_vehicles: boolean; include_cip: boolean; include_leasehold: boolean }

interface Line { assetId: string | null; assetTag: string; description: string; categoryName: string | null; lifeClass: string | null; propertyType: PropertyType; acquisitionDate: string | null;
  acquisitionYear: number | null; originalCost: number | null; costSource: 'SAP' | 'ALM' | null; age: number | null; factor: number | null; marketValue: number | null;
  siteCode: string | null; roomCode: string | null; change: 'NEW' | 'CARRIED' | 'DISPOSED'; disposalDate: string | null }

async function compute(c: PoolClient, companyId: string, j: Jur, taxYear: number) {
  const lien = `${taxYear}-${pad(j.lien_month)}-${pad(j.lien_day)}`;
  const warnings: { code: string; message: string; count?: number }[] = [];
  // 계수표: 기준일 연도 이하 중 가장 최근
  const tableYear = (await c.query('SELECT max(table_year) AS y FROM tax_factor WHERE factor_set = $1 AND table_year <= $2', [j.factor_set, taxYear])).rows[0]?.y as number | null;
  const table = new Map<string, number[]>();
  let source: string | undefined;
  if (tableYear) {
    for (const r of (await c.query('SELECT life_class, age, factor, source FROM tax_factor WHERE factor_set = $1 AND table_year = $2 ORDER BY life_class, age',
      [j.factor_set, tableYear])).rows) {
      const arr = table.get(r.life_class) ?? [];
      arr[r.age - AGE_START[j.factor_set]] = Number(r.factor);
      table.set(r.life_class, arr);
      source = r.source ?? source;
    }
    if (tableYear < taxYear) warnings.push({ code: 'OLD_FACTOR_TABLE', message: `${taxYear}년 계수표가 없어 ${tableYear}년 표를 썼습니다` });
    if (source?.startsWith('[verify]')) warnings.push({ code: 'UNVERIFIED_FACTORS', message: '계수표가 확인되지 않은 참고값입니다. 관할 공식 표와 대조하세요' });
  } else if (j.factor_set !== 'GENERIC_SL') {
    warnings.push({ code: 'NO_FACTOR_TABLE', message: `${j.factor_set} 계수표가 없어 계수 1.0(원가 그대로)으로 계산했습니다. 계수표를 불러오거나 입력하세요` });
  }
  if (j.factor_set === 'GENERIC_SL') warnings.push({ code: 'GENERIC_FACTORS', message: '정액 추정 계수(하한 20%)입니다. 감정 구역의 감가표를 넣으면 더 정확합니다' });
  const classMap = new Map((await c.query('SELECT category_id, life_class FROM tax_class_map WHERE factor_set = $1', [j.factor_set])).rows
    .map((r) => [r.category_id as string, r.life_class as string]));

  const rows = (await c.query(`SELECT a.id, a.asset_tag, a.description, a.status, a.category_id, cat.name AS category_name,
        cat.tax_property_type AS cat_type, ac.tax_property_type AS cls_type, ac.class_code, ac.name AS class_name,
        coalesce(cat.useful_life_years, ac.default_useful_life_years) AS life,
        coalesce(a.sap_cap_date, a.purchase_date, a.created_at::date) AS acq_date,
        CASE WHEN co.sap_enabled AND a.sap_asset_no IS NOT NULL THEN vl.acquisition_value END AS sap_cost, a.purchase_cost,
        s.site_code, r.room_code,
        coalesce(a.sap_deact_date, (SELECT max(e.occurred_at)::date FROM asset_event e WHERE e.asset_id = a.id AND e.event_type IN ('RETIRED', 'DISPOSED'))) AS disposal_date
      FROM asset a JOIN company co ON co.id = a.company_id JOIN site s ON s.id = a.site_id
      LEFT JOIN room r ON r.id = a.room_id LEFT JOIN category cat ON cat.id = a.category_id LEFT JOIN asset_class ac ON ac.id = a.asset_class_id
      LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id
     WHERE a.company_id = $1 AND s.tax_jurisdiction_id = $2 AND a.status <> 'ON_ORDER'
     ORDER BY a.asset_tag`, [companyId, j.id])).rows;
  const noLoc = (await c.query(`SELECT a.asset_tag FROM asset a LEFT JOIN site s ON s.id = a.site_id
     WHERE a.company_id = $1 AND a.status NOT IN ('ON_ORDER', 'RETIRED', 'DISPOSED') AND (a.site_id IS NULL OR s.tax_jurisdiction_id IS NULL)
     ORDER BY a.asset_tag`, [companyId])).rows.map((r) => r.asset_tag as string);
  const noLocation = noLoc.length;
  if (noLocation) warnings.push({ code: 'NO_JURISDICTION', count: noLocation, message: `사이트가 없거나 관할이 연결되지 않은 자산 ${noLocation}건은 어느 신고에도 들어가지 않았습니다(${noLoc.slice(0, 10).join(', ')}${noLocation > 10 ? ' 외' : ''}). 자산의 사이트를 지정하거나 사이트를 관할에 연결하세요` });

  const lines: Line[] = [];
  const missingClass = new Set<string>();
  let afterLien = 0;
  const excluded = new Map<PropertyType, number>();
  const guessed = new Set<string>();
  for (const a of rows) {
    const acq = day(a.acq_date)!;
    if (acq > lien) { if (!['RETIRED', 'DISPOSED'].includes(a.status)) afterLien += 1; continue; }
    const disposal = day(a.disposal_date) ?? null;
    if (['RETIRED', 'DISPOSED'].includes(a.status) && (!disposal || disposal <= lien)) continue;
    // 재산세 구분: 카테고리 → 자산클래스 → 클래스 이름 추정 → 장비
    const ptype: PropertyType = a.cat_type ?? a.cls_type ?? suggestPropertyType(a.class_name) ?? 'EQUIPMENT';
    if (!a.cat_type && !a.cls_type) guessed.add(a.class_code ?? '(클래스 없음)');
    if (NEVER_TAXED.includes(ptype) || (ptype === 'VEHICLE' && !j.include_vehicles) || (ptype === 'CIP' && !j.include_cip)
      || (ptype === 'LEASEHOLD' && !j.include_leasehold)) {
      excluded.set(ptype, (excluded.get(ptype) ?? 0) + 1);
      continue;
    }
    const sapCost = num(a.sap_cost), almCost = num(a.purchase_cost);
    const cost = sapCost ?? almCost;
    const lifeClass = classMap.get(a.category_id) ?? lifeClassOf(j.factor_set, a.life);
    const acqYear = Number(acq.slice(0, 4));
    const age = Math.max(0, taxYear - acqYear);
    let factor: number | null;
    if (ptype === 'LEASED_IN') factor = null;   // 임차 장비: 세액 없이 목록만
    else if (ptype === 'CIP') factor = 1;   // 건설중자산은 원가 그대로
    else if (j.factor_set === 'GENERIC_SL' && !table.size) factor = genericFactor(lifeClass, age);
    else if (!table.size) factor = 1;
    else {
      const arr = table.get(lifeClass);
      if (!arr?.length) { missingClass.add(lifeClass); factor = 1; } else {
        const vals = arr.filter((x) => x !== undefined);
        const i = age - AGE_START[j.factor_set];
        factor = i < 0 ? vals[0] : i >= arr.length ? vals[vals.length - 1] : (arr[i] ?? vals[vals.length - 1]);
      }
    }
    lines.push({ assetId: a.id, assetTag: a.asset_tag, description: a.description, categoryName: a.category_name ?? null, lifeClass, propertyType: ptype, acquisitionDate: acq,
      acquisitionYear: acqYear, originalCost: cost, costSource: sapCost !== null ? 'SAP' : almCost !== null ? 'ALM' : null, age, factor,
      marketValue: cost === null || factor === null ? null : r2(cost * factor), siteCode: a.site_code ?? null, roomCode: a.room_code ?? null, change: 'NEW', disposalDate: null });
  }
  if (excluded.size) {
    const parts = [...excluded].map(([k, n]) => `${TYPE_LABEL[k]} ${n}건`).join(', ');
    warnings.push({ code: 'EXCLUDED_TYPES', count: [...excluded.values()].reduce((x, y) => x + y, 0),
      message: `신고 대상이 아닌 구분이라 뺐습니다: ${parts}. 차량·건설중자산·임차개량 포함 여부는 관할 설정에서 바꿉니다` });
  }
  const leased = lines.filter((l) => l.propertyType === 'LEASED_IN').length;
  if (leased) warnings.push({ code: 'LEASED_LISTED', count: leased,
    message: `임차 장비 ${leased}건은 세액에서 빼고 신고서의 임차 장비 목록(엑셀 'Leased equipment')에 넣었습니다. 소유자(리스사) 이름·주소를 적으세요` });
  if (guessed.size) warnings.push({ code: 'PROPERTY_TYPE_GUESSED', count: guessed.size,
    message: `재산세 구분이 지정되지 않은 자산클래스(${[...guessed].slice(0, 10).join(', ')})는 이름으로 추정했습니다. 계수표 탭의 재산세 구분에서 확인하세요` });
  if (missingClass.size) warnings.push({ code: 'NO_FACTOR_CLASS', message: `계수표에 없는 구분(${[...missingClass].join(', ')})은 계수 1.0으로 계산했습니다` });
  const unknownCost = lines.filter((l) => l.originalCost === null && l.propertyType !== 'LEASED_IN').length;
  if (unknownCost) warnings.push({ code: 'UNKNOWN_COST', count: unknownCost, message: `원가가 없는 자산 ${unknownCost}건은 합계에서 빠졌습니다(신고서의 '원가 모름' 칸에 추정 시가로 적습니다)` });

  // 전년 신고와 비교
  const prior = (await c.query(`SELECT id, tax_year FROM tax_filing WHERE company_id = $1 AND jurisdiction_id = $2 AND tax_year < $3 ORDER BY tax_year DESC LIMIT 1`,
    [companyId, j.id, taxYear])).rows[0];
  if (prior) {
    const prev = (await c.query(`SELECT l.asset_id, l.asset_tag, l.description, l.category_name, l.life_class, l.property_type, l.acquisition_date, l.acquisition_year, l.original_cost,
        l.cost_source, l.site_code, l.room_code, coalesce(a.sap_deact_date, (SELECT max(e.occurred_at)::date FROM asset_event e WHERE e.asset_id = l.asset_id
          AND e.event_type IN ('RETIRED', 'DISPOSED'))) AS disposal_date
      FROM tax_filing_line l LEFT JOIN asset a ON a.id = l.asset_id WHERE l.filing_id = $1 AND l.change <> 'DISPOSED' AND l.property_type <> 'LEASED_IN'`, [prior.id])).rows;
    const now = new Set(lines.filter((l) => l.propertyType !== 'LEASED_IN').map((l) => l.assetId));
    const before = new Set(prev.map((x) => x.asset_id as string));
    for (const l of lines) if (l.propertyType !== 'LEASED_IN' && before.has(l.assetId!)) l.change = 'CARRIED';
    for (const x of prev) {
      if (x.asset_id && now.has(x.asset_id)) continue;
      lines.push({ assetId: x.asset_id, assetTag: x.asset_tag, description: x.description, categoryName: x.category_name, lifeClass: x.life_class, propertyType: x.property_type,
        acquisitionDate: day(x.acquisition_date) ?? null, acquisitionYear: x.acquisition_year, originalCost: num(x.original_cost), costSource: x.cost_source,
        age: null, factor: null, marketValue: null, siteCode: x.site_code, roomCode: x.room_code, change: 'DISPOSED', disposalDate: day(x.disposal_date) ?? null });
    }
  }

  const active = lines.filter((l) => l.change !== 'DISPOSED' && l.propertyType !== 'LEASED_IN');
  const totalCost = r2(active.reduce((s, l) => s + (l.originalCost ?? 0), 0));
  const mv = r2(active.reduce((s, l) => s + (l.marketValue ?? 0), 0));
  const exAmt = Number(j.exemption_amount);
  const exemption = !j.taxable ? mv : j.exemption_mode === 'THRESHOLD' ? (mv <= exAmt ? mv : 0) : j.exemption_mode === 'DEDUCT' ? Math.min(mv, exAmt) : 0;
  const assessed = j.taxable ? r2((mv - exemption) * Number(j.assessment_ratio)) : 0;
  const tax = r2(assessed * Number(j.millage) / 1000);
  // 세액이 0인 이유를 화면에 바로 보이게
  if (afterLien) warnings.push({ code: 'ACQUIRED_AFTER_LIEN', count: afterLien,
    message: `기준일(${lien}) 뒤에 취득한 자산 ${afterLien}건은 이 연도 신고에 들어가지 않습니다(다음 연도 신고 대상). 취득일은 SAP 자본화일 → 구매일 → ALM 등록일 순으로 봅니다` });
  if (!rows.length) warnings.push({ code: 'NO_ASSETS', message: '이 관할에 연결된 사이트에 이 회사 자산이 없습니다. 관할 탭에서 사이트 연결을 확인하세요' });
  if (j.taxable && Number(j.millage) === 0) warnings.push({ code: 'ZERO_MILLAGE', message: '밀리지(세율)가 0이라 예상 세액이 0입니다. 관할 탭에서 카운티 밀리지를 입력하세요' });
  if (!j.taxable) warnings.push({ code: 'NOT_TAXABLE', message: `${j.state}는 사업용 동산을 과세하지 않습니다(신고 대상 아님). 목록은 참고용입니다` });
  else if (j.exemption_mode === 'THRESHOLD' && exemption > 0) warnings.push({ code: 'EXEMPT', message: `공정가치 합계가 $${exAmt.toLocaleString('en-US')} 이하라 면제됩니다(신고서는 제출)` });
  const due = j.due_month ? `${taxYear}-${pad(j.due_month)}-${pad(j.due_day ?? 1)}` : null;
  const params = { state: j.state, county: j.county, name: j.name, taxable: j.taxable, formCode: j.form_code, lienMonth: j.lien_month, lienDay: j.lien_day,
    assessmentRatio: Number(j.assessment_ratio), millage: Number(j.millage), exemptionMode: j.exemption_mode, exemptionAmount: exAmt,
    factorSet: j.factor_set, includeVehicles: j.include_vehicles, includeCip: j.include_cip, includeLeasehold: j.include_leasehold, factorTableYear: tableYear ?? null, factorSource: source ?? null, priorFilingYear: prior?.tax_year ?? null };
  return { lien, due, lines, totals: { assetCount: active.length, totalCost, mv, exemption: r2(exemption), assessed, tax }, warnings, params };
}

async function writeFiling(c: PoolClient, p: Principal, id: string, r: Awaited<ReturnType<typeof compute>>) {
  await c.query('DELETE FROM tax_filing_line WHERE filing_id = $1', [id]);
  // 행은 500건씩 묶어 넣는다
  for (let i = 0; i < r.lines.length; i += 500) {
    const chunk = r.lines.slice(i, i + 500);
    const vals: unknown[] = [];
    const ph = chunk.map((l, j) => {
      const b = j * 20;
      vals.push(randomUUID(), p.tenantId, id, l.assetId, l.assetTag, l.description.slice(0, 50), l.categoryName?.slice(0, 60) ?? null, l.lifeClass, l.acquisitionDate,
        l.acquisitionYear, l.originalCost, l.costSource, l.age, l.factor, l.marketValue, l.siteCode, l.roomCode, l.change, l.disposalDate, l.propertyType);
      return `(${Array.from({ length: 20 }, (_, k) => `$${b + k + 1}`).join(', ')})`;
    });
    await c.query(`INSERT INTO tax_filing_line (id, tenant_id, filing_id, asset_id, asset_tag, description, category_name, life_class, acquisition_date, acquisition_year,
        original_cost, cost_source, age, factor, market_value, site_code, room_code, change, disposal_date, property_type) VALUES ${ph.join(', ')}`, vals);
  }
  const t = r.totals;
  await c.query(`UPDATE tax_filing SET lien_date = $2, due_date = $3, asset_count = $4, total_cost = $5, total_market_value = $6, exemption = $7, assessed_value = $8,
      estimated_tax = $9, params = $10, warnings = $11, generated_at = now(), generated_by = $12, updated_at = now(), updated_by = $12, version = version + 1 WHERE id = $1`,
  [id, r.lien, r.due, t.assetCount, t.totalCost, t.mv, t.exemption, t.assessed, t.tax, JSON.stringify(r.params), JSON.stringify(r.warnings), p.userId]);
}

async function jurisdiction(c: PoolClient, id: string): Promise<Jur> {
  const j = (await c.query('SELECT * FROM tax_jurisdiction WHERE id = $1', [id])).rows[0];
  if (!j) throw E.notFound('관할을 찾을 수 없습니다');
  return j;
}

export async function createFiling(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const companyId = k.uuid(b, 'companyId', { required: true });
  const jurisdictionId = k.uuid(b, 'jurisdictionId', { required: true });
  const taxYear = k.int(b, 'taxYear', { min: 2000, max: 2100 });
  if (taxYear === undefined) k.errors.push({ field: 'taxYear', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  if (!(await c.query('SELECT 1 FROM company WHERE id = $1', [companyId])).rowCount) throw E.badRequest('없는 회사코드입니다');
  const j = await jurisdiction(c, jurisdictionId!);
  if ((await c.query('SELECT 1 FROM tax_filing WHERE company_id = $1 AND jurisdiction_id = $2 AND tax_year = $3', [companyId, jurisdictionId, taxYear])).rowCount) {
    throw E.duplicate(`${taxYear}년 ${j.state} ${j.county} 신고가 이미 있습니다(다시 계산은 그 신고에서)`);
  }
  const r = await compute(c, companyId!, j, taxYear!);
  const id = randomUUID();
  await c.query(`INSERT INTO tax_filing (id, tenant_id, company_id, jurisdiction_id, tax_year, lien_date, params, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $7)`, [id, p.tenantId, companyId, jurisdictionId, taxYear, r.lien, p.userId]);
  await writeFiling(c, p, id, r);
  return getFiling(c, id);
}

async function load(c: PoolClient, id: string, lock = false) {
  if (!isUuid(id)) throw notFound();
  const f = (await c.query(`SELECT f.*, co.company_code, j.state, j.county, j.name AS jurisdiction_name, j.form_code
      FROM tax_filing f JOIN company co ON co.id = f.company_id JOIN tax_jurisdiction j ON j.id = f.jurisdiction_id WHERE f.id = $1${lock ? ' FOR UPDATE OF f' : ''}`, [id])).rows[0];
  if (!f) throw notFound();
  return f;
}

function summaryOut(f: Record<string, any>) {
  return clean({ id: f.id, version: f.version, companyId: f.company_id, companyCode: f.company_code, jurisdictionId: f.jurisdiction_id, state: f.state, county: f.county,
    jurisdictionName: f.jurisdiction_name, formCode: f.form_code ?? undefined, taxYear: f.tax_year, lienDate: day(f.lien_date), dueDate: day(f.due_date), status: f.status,
    assetCount: f.asset_count, totalCost: Number(f.total_cost), totalMarketValue: Number(f.total_market_value), exemption: Number(f.exemption),
    assessedValue: Number(f.assessed_value), estimatedTax: Number(f.estimated_tax), actualAssessed: num(f.actual_assessed) ?? undefined, actualTax: num(f.actual_tax) ?? undefined,
    filedAt: day(f.filed_at), filingRef: f.filing_ref ?? undefined, generatedAt: iso(f.generated_at) });
}

/** 과거 기록(신고 목록). 연도·주·회사·상태로 거른다 */
export async function listFilings(c: PoolClient, q: Record<string, string | undefined>) {
  const args: unknown[] = [];
  const w: string[] = [];
  if (q.taxYear) { args.push(Number(q.taxYear)); w.push(`f.tax_year = $${args.length}`); }
  if (q.state) { args.push(q.state.toUpperCase()); w.push(`j.state = $${args.length}`); }
  if (q.companyId && isUuid(q.companyId)) { args.push(q.companyId); w.push(`f.company_id = $${args.length}`); }
  if (q.jurisdictionId && isUuid(q.jurisdictionId)) { args.push(q.jurisdictionId); w.push(`f.jurisdiction_id = $${args.length}`); }
  if (q.status) { args.push(q.status.split(',')); w.push(`f.status::text = ANY($${args.length})`); }
  const rows = (await c.query(`SELECT f.*, co.company_code, j.state, j.county, j.name AS jurisdiction_name, j.form_code
      FROM tax_filing f JOIN company co ON co.id = f.company_id JOIN tax_jurisdiction j ON j.id = f.jurisdiction_id
      ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY f.tax_year DESC, j.state, j.county, co.company_code LIMIT 500`, args)).rows;
  const years = (await c.query('SELECT DISTINCT tax_year FROM tax_filing ORDER BY 1 DESC')).rows.map((r) => r.tax_year as number);
  return { items: rows.map(summaryOut), years };
}

export async function getFiling(c: PoolClient, id: string) {
  const f = await load(c, id);
  const schedule = (await c.query(`SELECT property_type, acquisition_year, life_class, count(*)::int AS n, sum(original_cost) AS cost, sum(market_value) AS mv, min(factor) AS factor
      FROM tax_filing_line WHERE filing_id = $1 AND change <> 'DISPOSED' AND property_type <> 'LEASED_IN' GROUP BY property_type, acquisition_year, life_class
      ORDER BY property_type, acquisition_year DESC, life_class`, [id])).rows;
  const byType = (await c.query(`SELECT property_type, count(*)::int AS n, coalesce(sum(original_cost), 0) AS cost, coalesce(sum(market_value), 0) AS mv
      FROM tax_filing_line WHERE filing_id = $1 AND change <> 'DISPOSED' AND property_type <> 'LEASED_IN' GROUP BY property_type ORDER BY property_type`, [id])).rows;
  const changes = (await c.query(`SELECT change, count(*)::int AS n, coalesce(sum(original_cost), 0) AS cost FROM tax_filing_line WHERE filing_id = $1 AND property_type <> 'LEASED_IN' GROUP BY change`, [id])).rows;
  const prior = (await c.query(`SELECT id, tax_year, status, total_cost, total_market_value, assessed_value, estimated_tax, actual_tax FROM tax_filing
     WHERE company_id = $1 AND jurisdiction_id = $2 AND tax_year < $3 ORDER BY tax_year DESC LIMIT 1`, [f.company_id, f.jurisdiction_id, f.tax_year])).rows[0];
  return { ...summaryOut(f), params: f.params, warnings: f.warnings ?? [], notes: f.notes ?? undefined,
    byType: byType.map((t) => ({ propertyType: t.property_type, count: t.n, cost: Number(t.cost), marketValue: Number(t.mv) })),
    schedule: schedule.map((s) => ({ propertyType: s.property_type, acquisitionYear: s.acquisition_year, lifeClass: s.life_class, count: s.n, cost: num(s.cost) ?? 0, marketValue: num(s.mv) ?? 0, factor: num(s.factor) })),
    changes: Object.fromEntries(changes.map((x) => [x.change, { count: x.n, cost: Number(x.cost) }])),
    prior: prior ? clean({ id: prior.id, taxYear: prior.tax_year, status: prior.status, totalCost: Number(prior.total_cost), totalMarketValue: Number(prior.total_market_value),
      assessedValue: Number(prior.assessed_value), estimatedTax: Number(prior.estimated_tax), actualTax: num(prior.actual_tax) ?? undefined }) : undefined };
}

export async function listFilingLines(c: PoolClient, id: string, q: Record<string, string | undefined>) {
  await load(c, id);
  const args: unknown[] = [id];
  const w = ['filing_id = $1'];
  if (q.change) { args.push(q.change.split(',')); w.push(`change = ANY($${args.length})`); }
  if (q.q?.trim()) { args.push(`%${q.q.trim().slice(0, 40).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); w.push(`(asset_tag ILIKE $${args.length} OR description ILIKE $${args.length})`); }
  const page = Math.max(1, Number(q.page ?? 1) || 1), pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 100) || 100));
  const total = (await c.query(`SELECT count(*)::int AS n FROM tax_filing_line WHERE ${w.join(' AND ')}`, args)).rows[0].n as number;
  const rows = (await c.query(`SELECT * FROM tax_filing_line WHERE ${w.join(' AND ')} ORDER BY change = 'DISPOSED', acquisition_year DESC NULLS LAST, asset_tag
     OFFSET $${args.length + 1} LIMIT $${args.length + 2}`, [...args, (page - 1) * pageSize, pageSize])).rows;
  return { items: rows.map(lineOut), page, pageSize, total };
}

const lineOut = (l: Record<string, any>) => clean({ assetId: l.asset_id ?? undefined, assetTag: l.asset_tag, description: l.description, categoryName: l.category_name ?? undefined,
  lifeClass: l.life_class ?? undefined, propertyType: l.property_type, acquisitionDate: day(l.acquisition_date), acquisitionYear: l.acquisition_year ?? undefined, originalCost: num(l.original_cost) ?? undefined,
  costSource: l.cost_source ?? undefined, age: l.age ?? undefined, factor: num(l.factor) ?? undefined, marketValue: num(l.market_value) ?? undefined,
  siteCode: l.site_code ?? undefined, roomCode: l.room_code ?? undefined, change: l.change, disposalDate: day(l.disposal_date) });

export async function regenerateFiling(c: PoolClient, p: Principal, id: string) {
  const f = await load(c, id, true);
  if (f.status !== 'DRAFT') throw new AlmError(409, 'ALM-E322', '신고한 건은 다시 계산할 수 없습니다(먼저 신고 취소)');
  await writeFiling(c, p, id, await compute(c, f.company_id, await jurisdiction(c, f.jurisdiction_id), f.tax_year));
  return getFiling(c, id);
}

export async function fileFiling(c: PoolClient, p: Principal, id: string, body: unknown) {
  const k = new Check(body), b = k.obj();
  const filedAt = k.date(b, 'filedAt');
  const ref = k.str(b, 'filingRef', { max: 60 });
  const notes = k.str(b, 'notes', { max: 2000 });
  if (!filedAt) k.errors.push({ field: 'filedAt', code: 'ALM-E101', message: '필수 값입니다' });
  k.done();
  const f = await load(c, id, true);
  if (f.status !== 'DRAFT') throw new AlmError(409, 'ALM-E322', '이미 신고했습니다');
  await c.query(`UPDATE tax_filing SET status = 'FILED', filed_at = $2, filing_ref = $3, notes = coalesce($4, notes), filed_by = $5, updated_at = now(), updated_by = $5,
      version = version + 1 WHERE id = $1`, [id, filedAt, ref ?? null, notes ?? null, p.userId]);
  return getFiling(c, id);
}

/** 고지 결과(평가액·세액) 기록 → ASSESSED */
export async function patchFiling(c: PoolClient, p: Principal, id: string, body: unknown) {
  const k = new Check(body), b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const assessed = k.num(b, 'actualAssessed', { min: 0, max: 1e12 });
  const tax = k.num(b, 'actualTax', { min: 0, max: 1e12 });
  const notes = k.str(b, 'notes', { max: 2000 });
  const ref = k.str(b, 'filingRef', { max: 60 });
  k.done();
  const f = await load(c, id, true);
  if ((has('actualAssessed') || has('actualTax')) && f.status === 'DRAFT') throw new AlmError(409, 'ALM-E322', '고지 결과는 신고한 뒤에 기록합니다');
  const nextAssessed = has('actualAssessed') ? assessed ?? null : f.actual_assessed;
  const nextTax = has('actualTax') ? tax ?? null : f.actual_tax;
  const status = f.status === 'DRAFT' ? 'DRAFT' : nextAssessed !== null || nextTax !== null ? 'ASSESSED' : 'FILED';
  await c.query(`UPDATE tax_filing SET actual_assessed = $2, actual_tax = $3, notes = $4, filing_ref = $5, status = $6, updated_at = now(), updated_by = $7, version = version + 1
    WHERE id = $1`, [id, nextAssessed, nextTax, has('notes') ? notes ?? null : f.notes, has('filingRef') ? ref ?? null : f.filing_ref, status, p.userId]);
  return getFiling(c, id);
}

/** 신고 취소(정정): FILED → DRAFT. 고지 결과가 있으면 못 한다 */
export async function reopenFiling(c: PoolClient, p: Principal, id: string) {
  const f = await load(c, id, true);
  if (f.status !== 'FILED') throw new AlmError(409, 'ALM-E322', f.status === 'DRAFT' ? '아직 신고하지 않았습니다' : '고지 결과가 기록된 신고는 되돌릴 수 없습니다');
  await c.query(`UPDATE tax_filing SET status = 'DRAFT', filed_at = NULL, filed_by = NULL, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $1`, [id, p.userId]);
  return getFiling(c, id);
}

export async function deleteFiling(c: PoolClient, id: string) {
  const f = await load(c, id, true);
  if (f.status !== 'DRAFT') throw new AlmError(409, 'ALM-E322', '신고한 건은 지울 수 없습니다(과거 기록)');
  await c.query('DELETE FROM tax_filing_line WHERE filing_id = $1', [id]);
  await c.query('DELETE FROM tax_filing WHERE id = $1', [id]);
}

// ---------------- 엑셀(신고 첨부·검토용) ----------------
export async function exportFiling(c: PoolClient, id: string): Promise<{ fileName: string; body: Buffer }> {
  const f = await getFiling(c, id);
  const lines = (await c.query(`SELECT * FROM tax_filing_line WHERE filing_id = $1 ORDER BY change = 'DISPOSED', acquisition_year DESC NULLS LAST, asset_tag`, [id])).rows.map(lineOut);
  const pr = f.params as Record<string, any>;
  const owned = lines.filter((l) => l.change !== 'DISPOSED' && l.propertyType !== 'LEASED_IN');
  const active = owned.filter((l) => l.originalCost !== undefined);
  const unknown = owned.filter((l) => l.originalCost === undefined);
  const leasedIn = lines.filter((l) => l.propertyType === 'LEASED_IN');
  const summary: Cell[][] = [
    ['Business Personal Property — filing workpaper', ''],
    ['Company', f.companyCode], ['Jurisdiction', `${f.jurisdictionName} (${f.state} · ${f.county})`], ['Form', f.formCode ?? (pr.taxable ? '' : 'Not taxable')],
    ['Tax year', f.taxYear], ['Lien (assessment) date', f.lienDate], ['Due date', f.dueDate ?? ''], ['Status', f.status],
    ['Assets reported', f.assetCount], ['Total original cost', f.totalCost], ['Market value (cost × factor)', f.totalMarketValue],
    ['Exemption', f.exemption], ['Assessment ratio', pr.assessmentRatio], ['Assessed value', f.assessedValue],
    ['Millage (per $1,000 assessed)', pr.millage], ['Estimated tax', f.estimatedTax],
    ['Factor table', `${pr.factorSet}${pr.factorTableYear ? ` ${pr.factorTableYear}` : ''}`], ['Factor source', pr.factorSource ?? ''],
    ['Filed on', f.filedAt ?? ''], ['Filing reference', f.filingRef ?? ''], ['Actual assessed', f.actualAssessed ?? ''], ['Actual tax', f.actualTax ?? ''],
    ...f.byType.map((t): Cell[] => [`  ${TYPE_LABEL_EN[t.propertyType as PropertyType]} (${t.count})`, t.marketValue]),
    ['Leased equipment listed (not taxed to you)', leasedIn.length],
    ['', ''], ['Not in ALM — report separately', 'Inventory and supplies (GA Schedule B, AL supplies, TX Schedules B/C, CA line 1), boats and aircraft'],
    ['Estimate only — confirm values, factor tables and millage with the jurisdiction before filing.', ''],
    ...((f.warnings as { message: string }[]) ?? []).map((w): Cell[] => ['Note', w.message]),
  ];
  const money = 'money' as const, factor = 'factor' as const, int = 'int' as const;
  const sheets = [
    { name: 'Summary', rows: summary, header: 1, widths: [34, 70], formats: [undefined, money] },
    { name: 'By year acquired', header: 1, widths: [24, 14, 12, 10, 18, 10, 18], formats: [undefined, int, undefined, int, money, factor, money],
      rows: [['Property type', 'Year acquired', 'Class', 'Assets', 'Original cost', 'Factor', 'Market value'],
        ...f.schedule.map((s): Cell[] => [TYPE_LABEL_EN[s.propertyType as PropertyType], s.acquisitionYear, s.lifeClass, s.count, s.cost, s.factor, s.marketValue]),
        ['Total', '', '', f.assetCount, f.totalCost, null, f.totalMarketValue]] },
    { name: 'Asset listing', header: 1, widths: [14, 32, 18, 22, 8, 12, 10, 16, 8, 8, 10, 16, 10, 12, 10],
      formats: [undefined, undefined, undefined, undefined, undefined, undefined, int, money, undefined, int, factor, money],
      rows: [['Asset tag', 'Description', 'Category', 'Property type', 'Class', 'Acquired', 'Year', 'Original cost', 'Source', 'Age', 'Factor', 'Market value', 'Site', 'Room', 'Change'],
        ...active.map((l): Cell[] => [l.assetTag, l.description, l.categoryName, TYPE_LABEL_EN[l.propertyType as PropertyType], l.lifeClass, l.acquisitionDate, l.acquisitionYear,
          l.originalCost, l.costSource, l.age, l.factor, l.marketValue, l.siteCode, l.roomCode, l.change])] },
    { name: 'Unknown cost', header: 1, widths: [14, 32, 18, 12, 12, 22], formats: [],
      rows: [['Asset tag', 'Description', 'Category', 'Acquired', 'Site', 'Estimated current value'], ...unknown.map((l): Cell[] => [l.assetTag, l.description, l.categoryName, l.acquisitionDate, l.siteCode, ''])] },
    { name: 'Leased equipment', header: 1, widths: [14, 32, 18, 12, 12, 10, 12, 30, 40], formats: [],
      rows: [['Asset tag', 'Description', 'Category', 'Acquired', 'Original cost', 'Site', 'Room', 'Owner (lessor) name', 'Owner address'],
        ...leasedIn.map((l): Cell[] => [l.assetTag, l.description, l.categoryName, l.acquisitionDate, l.originalCost, l.siteCode, l.roomCode, '', ''])] },
    { name: 'Additions', header: 1, widths: [14, 32, 12, 16, 10], formats: [undefined, undefined, undefined, money],
      rows: [['Asset tag', 'Description', 'Acquired', 'Original cost', 'Site'], ...owned.filter((l) => l.change === 'NEW').map((l): Cell[] => [l.assetTag, l.description, l.acquisitionDate, l.originalCost, l.siteCode])] },
    { name: 'Disposals', header: 1, widths: [14, 32, 12, 16, 12, 10], formats: [undefined, undefined, undefined, money],
      rows: [['Asset tag', 'Description', 'Acquired', 'Original cost', 'Disposed', 'Site'],
        ...lines.filter((l) => l.change === 'DISPOSED').map((l): Cell[] => [l.assetTag, l.description, l.acquisitionDate, l.originalCost, l.disposalDate, l.siteCode])] },
  ];
  const fileName = `BPP_${f.taxYear}_${f.state}_${String(f.county).replace(/[^A-Za-z0-9]+/g, '-')}_${f.companyCode}.xlsx`;
  return { fileName, body: buildXlsx(sheets) };
}

// ---------------- 재산세 구분(자산클래스·카테고리) ----------------
const TYPE_LABEL: Record<PropertyType, string> = { EQUIPMENT: '장비·가구·기계', LEASEHOLD: '임차개량', VEHICLE: '차량', CIP: '건설중자산',
  LEASED_IN: '임차 자산', REAL_PROPERTY: '부동산', INTANGIBLE: '무형', EXCLUDED: '제외' };
const TYPE_LABEL_EN: Record<PropertyType, string> = { EQUIPMENT: 'Furniture, fixtures, machinery & equipment', LEASEHOLD: 'Leasehold improvements',
  VEHICLE: 'Vehicles', CIP: 'Construction in progress', LEASED_IN: 'Leased from others', REAL_PROPERTY: 'Real property', INTANGIBLE: 'Intangible', EXCLUDED: 'Excluded' };

export async function listPropertyTypes(c: PoolClient) {
  const classes = (await c.query(`SELECT id, class_code, name, tax_property_type FROM asset_class WHERE is_active ORDER BY class_code`)).rows;
  const cats = (await c.query(`SELECT cat.id, cat.category_code, cat.name, cat.tax_property_type, ac.class_code, ac.name AS class_name, ac.tax_property_type AS class_type
      FROM category cat LEFT JOIN asset_class ac ON ac.id = cat.default_asset_class_id WHERE cat.is_active ORDER BY cat.name`)).rows;
  return {
    assetClasses: classes.map((r) => clean({ id: r.id, classCode: r.class_code, name: r.name, propertyType: r.tax_property_type ?? undefined,
      suggested: suggestPropertyType(r.name) ?? 'EQUIPMENT' })),
    categories: cats.map((r) => clean({ id: r.id, categoryCode: r.category_code, name: r.name, propertyType: r.tax_property_type ?? undefined,
      classCode: r.class_code ?? undefined, inherited: r.class_type ?? (r.class_code ? suggestPropertyType(r.class_name) ?? 'EQUIPMENT' : undefined) })),
  };
}

/** 보낸 항목만 바꾼다. propertyType이 null이면 지정 해제(클래스 이름 추정·상속으로 돌아감) */
export async function replacePropertyTypes(c: PoolClient, p: Principal, body: unknown) {
  const k = new Check(body), b = k.obj();
  const read = (key: string) => k.arr(b, key, { max: 1000 }).map((x, i) => {
    const o = k.obj(x, `${key}[${i}]`);
    const id = k.uuid(o, 'id', { required: true, field: `${key}[${i}].id` });
    const t = o.propertyType;
    if (t !== null && t !== undefined && !PROPERTY_TYPES.includes(t as PropertyType)) k.fail(`${key}[${i}].propertyType`, PROPERTY_TYPES.join(', '));
    return { id: id!, type: (t ?? null) as PropertyType | null };
  });
  const classes = read('assetClasses'), cats = read('categories');
  k.done();
  for (const x of classes) await c.query(`UPDATE asset_class SET tax_property_type = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [x.id, x.type, p.userId]);
  for (const x of cats) await c.query(`UPDATE category SET tax_property_type = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1`, [x.id, x.type, p.userId]);
  return listPropertyTypes(c);
}
