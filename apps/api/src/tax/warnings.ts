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
