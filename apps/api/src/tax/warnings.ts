// 재산세 계산 경고(ALM-260). 경고는 code + params로 저장하고, 화면은 사용자 언어(i18n tax.warn.<code>)로 문장을 만든다.
//   message는 영어 기본 문장 — 엑셀 신고 자료(영문)와, params가 없는 예전 신고의 대체 문장으로 쓴다
import type { PropertyType } from './reference';

export interface TaxWarning { code: string; message: string; count?: number; params?: Record<string, unknown> }

const TYPE_EN: Record<PropertyType, string> = { EQUIPMENT: 'Furniture, fixtures, machinery & equipment', LEASEHOLD: 'Leasehold improvements',
  VEHICLE: 'Vehicles', CIP: 'Construction in progress', LEASED_IN: 'Leased from others', REAL_PROPERTY: 'Real property', INTANGIBLE: 'Intangible', EXCLUDED: 'Excluded' };

type P = Record<string, unknown>;
const list = (xs: unknown, more?: unknown) => `${(xs as string[]).map((x) => x || '(no asset class)').join(', ')}${more ? ', …' : ''}`;
const n = (x: unknown) => Number(x).toLocaleString('en-US');

const EN: Record<string, (p: P) => string> = {
  OLD_FACTOR_TABLE: (p) => `No ${p.taxYear} factor table, so the ${p.tableYear} table was used`,
  UNVERIFIED_FACTORS: () => 'The factor table is an unverified reference. Compare it with the jurisdiction\'s official table',
  NO_FACTOR_TABLE: (p) => `No ${p.factorSet} factor table, so factor 1.0 (cost as is) was used. Load or enter the factor table`,
  GENERIC_FACTORS: () => 'Generic straight-line factors (20% floor). Enter the appraisal district\'s depreciation table for better accuracy',
  NO_JURISDICTION: (p) => `${n(p.count)} asset(s) with no site, or whose site is not linked to a jurisdiction, are in no filing (${list(p.tags, p.more)}). Set the asset's site or link the site to a jurisdiction`,
  EXCLUDED_TYPES: (p) => `Left out as not reportable: ${(p.types as { type: PropertyType; count: number }[]).map((x) => `${TYPE_EN[x.type]} ${x.count}`).join(', ')}. Whether vehicles, CIP and leasehold improvements are included is set on the jurisdiction`,
  LEASED_LISTED: (p) => `${n(p.count)} leased item(s) are left out of the tax and listed on the return's leased equipment schedule (Excel 'Leased equipment'). Fill in the owner (lessor) name and address`,
  PROPERTY_TYPE_GUESSED: (p) => `Asset classes with no property type (${list(p.classes, p.more)}) were classified by name. Check them on the Property types tab`,
  NO_FACTOR_CLASS: (p) => `Classes not in the factor table (${list(p.classes)}) used factor 1.0`,
  UNKNOWN_COST: (p) => `${n(p.count)} asset(s) with no cost are left out of the totals (report them in the return's 'cost unknown' section at estimated value)`,
  ACQUIRED_AFTER_LIEN: (p) => `${n(p.count)} asset(s) acquired after the lien date (${p.lienDate}) are not in this year's filing (they belong to next year). Acquisition date is the SAP capitalization date → purchase date → ALM registration date`,
  NO_ASSETS: () => 'This company has no assets at the sites linked to this jurisdiction. Check the site links on the Jurisdictions tab',
  ZERO_MILLAGE: () => 'Millage (tax rate) is 0, so the estimated tax is 0. Enter the county millage on the Jurisdictions tab',
  NOT_TAXABLE: (p) => `${p.state} does not tax business personal property (no filing required). The listing is for reference`,
  EXEMPT: (p) => `Exempt because total fair market value is $${n(p.amount)} or less (the return is still filed)`,
};

/** 경고 하나. count는 목록·배지용, params는 화면 번역용 */
export function warn(code: string, params: P = {}, count?: number): TaxWarning {
  const message = (EN[code] ?? (() => code))(params);
  return { code, message, ...(count !== undefined ? { count } : {}), ...(Object.keys(params).length ? { params } : {}) };
}

// ---- 예전 신고(2026-10-19 이전)의 한국어 경고 → code + params ----
//   그때는 문장만 저장했다. 다시 계산하지 않아도 화면이 사용자 언어로 보이도록 읽을 때 값을 되살린다(못 읽으면 그대로)
const LEGACY_TYPE: Record<string, PropertyType> = { '장비·가구·기계': 'EQUIPMENT', 임차개량: 'LEASEHOLD', 차량: 'VEHICLE', 건설중자산: 'CIP', '임차 자산': 'LEASED_IN',
  부동산: 'REAL_PROPERTY', 무형: 'INTANGIBLE', 제외: 'EXCLUDED' };
const names = (s: string) => s.split(', ').map((x) => (x === '(클래스 없음)' ? '' : x));
const LEGACY: Record<string, (m: string) => P | undefined> = {
  OLD_FACTOR_TABLE: (m) => { const x = /(\d{4})년 계수표가 없어 (\d{4})년/.exec(m); return x ? { taxYear: +x[1], tableYear: +x[2] } : undefined; },
  NO_FACTOR_TABLE: (m) => { const x = /^(\S+) 계수표가 없어/.exec(m); return x ? { factorSet: x[1] } : undefined; },
  NO_JURISDICTION: (m) => { const x = /자산 (\d+)건은 어느 신고에도 들어가지 않았습니다\((.*?)( 외)?\)\./.exec(m); return x ? { count: +x[1], tags: x[2].split(', '), more: !!x[3] } : undefined; },
  EXCLUDED_TYPES: (m) => {
    const x = /뺐습니다: (.*?)\. 차량/.exec(m);
    const types = x?.[1].split(', ').map((part) => { const y = /^(.*) (\d+)건$/.exec(part); return y && LEGACY_TYPE[y[1]] ? { type: LEGACY_TYPE[y[1]], count: +y[2] } : undefined; });
    return types && types.every(Boolean) ? { types } : undefined;
  },
  LEASED_LISTED: (m) => { const x = /임차 장비 (\d+)건/.exec(m); return x ? { count: +x[1] } : undefined; },
  PROPERTY_TYPE_GUESSED: (m) => { const x = /자산클래스\((.*)\)는 이름으로/.exec(m); return x ? { classes: names(x[1]), more: false } : undefined; },
  NO_FACTOR_CLASS: (m) => { const x = /구분\((.*)\)은 계수/.exec(m); return x ? { classes: x[1].split(', ') } : undefined; },
  UNKNOWN_COST: (m) => { const x = /자산 (\d+)건/.exec(m); return x ? { count: +x[1] } : undefined; },
  ACQUIRED_AFTER_LIEN: (m) => { const x = /기준일\((\d{4}-\d\d-\d\d)\) 뒤에 취득한 자산 (\d+)건/.exec(m); return x ? { count: +x[2], lienDate: x[1] } : undefined; },
  NOT_TAXABLE: (m) => { const x = /^([A-Z]{2})는/.exec(m); return x ? { state: x[1] } : undefined; },
  EXEMPT: (m) => { const x = /\$([\d,.]+) 이하/.exec(m); return x ? { amount: Number(x[1].replace(/,/g, '')) } : undefined; },
};
const NO_PARAMS = new Set(['UNVERIFIED_FACTORS', 'GENERIC_FACTORS', 'NO_ASSETS', 'ZERO_MILLAGE']);

/** 저장된 경고를 읽을 때: params가 없는 예전 경고는 문장에서 값을 되살려 새 형식(영어 message + params)으로 */
export function upgradeWarning(w: TaxWarning): TaxWarning {
  if (w.params || !/[가-힣]/.test(w.message ?? '')) return w;
  if (NO_PARAMS.has(w.code)) return warn(w.code, {}, w.count);
  const params = LEGACY[w.code]?.(w.message);
  return params ? warn(w.code, params, w.count) : w;
}
