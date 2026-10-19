// ALM-260 재산세(사업용 동산) 신고 자료 — API 응답 형식(api/openapi.yaml Tax*)
export type FactorSet = 'GA_DOR' | 'AL_ADOR' | 'CA_BOE581' | 'GENERIC_SL';
export type ExemptionMode = 'NONE' | 'THRESHOLD' | 'DEDUCT';
export type FilingStatus = 'DRAFT' | 'FILED' | 'ASSESSED';
export type LineChange = 'NEW' | 'CARRIED' | 'DISPOSED';

export type PropertyType = 'EQUIPMENT' | 'LEASEHOLD' | 'VEHICLE' | 'CIP' | 'LEASED_IN' | 'REAL_PROPERTY' | 'INTANGIBLE' | 'EXCLUDED';
export const PROPERTY_TYPES: PropertyType[] = ['EQUIPMENT', 'LEASEHOLD', 'VEHICLE', 'CIP', 'LEASED_IN', 'REAL_PROPERTY', 'INTANGIBLE', 'EXCLUDED'];
export interface PropertyTypes {
  assetClasses: { id: string; classCode: string; name: string; propertyType?: PropertyType; suggested: PropertyType }[];
  categories: { id: string; categoryCode: string; name: string; propertyType?: PropertyType; classCode?: string; inherited?: PropertyType }[];
}
export const FACTOR_SETS: FactorSet[] = ['GA_DOR', 'AL_ADOR', 'CA_BOE581', 'GENERIC_SL'];
export const FILING_STATUSES: FilingStatus[] = ['DRAFT', 'FILED', 'ASSESSED'];
export const filingTone = { DRAFT: 'neutral', FILED: 'accent', ASSESSED: 'ok' } as const;
export const changeTone = { NEW: 'info', CARRIED: 'neutral', DISPOSED: 'warn' } as const;

export interface StatePreset {
  state: string; name: string; taxable: boolean; formCode?: string; lienMonth: number; lienDay: number; dueMonth?: number; dueDay?: number;
  assessmentRatio: number; exemptionMode: ExemptionMode; exemptionAmount: number; factorSet: FactorSet; typicalMillage?: number; note: string; includeVehicles: boolean; includeCip: boolean; includeLeasehold: boolean;
}
export interface TaxReference {
  presets: StatePreset[]; factorSets: FactorSet[];
  referenceTables: { factorSet: FactorSet; tableYear: number; source: string; verified: boolean; classes: string[] }[];
}
export interface Jurisdiction {
  id: string; version: number; state: string; county: string; name: string; taxable: boolean; formCode?: string; lienMonth: number; lienDay: number;
  dueMonth?: number; dueDay?: number; assessmentRatio: number; millage: number; exemptionMode: ExemptionMode; exemptionAmount: number; factorSet: FactorSet;
  includeVehicles: boolean; includeCip: boolean; includeLeasehold: boolean; notes?: string; isActive: boolean; sites?: { id: string; siteCode: string; name: string }[];
}
export interface FactorTable { factorSet: FactorSet; tableYears: number[]; tableYear?: number; source?: string; ageStart: number; rows: { lifeClass: string; age: number; factor: number }[] }
export interface ClassMapItem { categoryId: string; categoryCode?: string; name: string; usefulLifeYears?: number; lifeClass?: string; defaultClass: string }
export interface FilingSummary {
  id: string; version: number; companyId: string; companyCode: string; jurisdictionId: string; state: string; county: string; jurisdictionName: string; formCode?: string;
  taxYear: number; lienDate: string; dueDate?: string; status: FilingStatus; assetCount: number; totalCost: number; totalMarketValue: number; exemption: number;
  assessedValue: number; estimatedTax: number; actualAssessed?: number; actualTax?: number; filedAt?: string; filingRef?: string; generatedAt?: string;
}
export interface TaxWarning { code: string; message: string; count?: number; params?: Record<string, unknown> }

type T = (key: string, opts?: Record<string, unknown>) => string;
/** 경고 문장: code + params를 사용자 언어로. params가 없는 예전 신고·모르는 code는 서버 문장 그대로 */
export function warningText(w: TaxWarning, t: T): string {
  if (!w.params && !NO_PARAMS.has(w.code)) return w.message;
  const p = w.params ?? {};
  const names = (xs: unknown) => ((xs as string[] | undefined) ?? []).map((x) => x || t('tax.warn.noClass')).join(', ') + (p.more ? ', …' : '');
  const types = ((p.types as { type: string; count: number }[] | undefined) ?? []).map((x) => t('tax.warn.typeCount', { type: t(`tax.ptype.${x.type}`), count: x.count })).join(', ');
  const key = `tax.warn.${w.code}`;
  const out = t(key, { ...p, tags: names(p.tags), classes: names(p.classes), types, amount: typeof p.amount === 'number' ? p.amount.toLocaleString('en-US') : p.amount });
  return out === key ? w.message : out;
}
const NO_PARAMS = new Set(['UNVERIFIED_FACTORS', 'GENERIC_FACTORS', 'NO_ASSETS', 'ZERO_MILLAGE']);
export interface FilingDetail extends FilingSummary {
  params: { includeVehicles?: boolean; includeCip?: boolean; assessmentRatio: number; millage: number; exemptionMode: ExemptionMode; exemptionAmount: number; factorSet: FactorSet; factorTableYear: number | null;
    factorSource: string | null; priorFilingYear: number | null; taxable: boolean };
  warnings: TaxWarning[]; notes?: string;
  byType: { propertyType: PropertyType; count: number; cost: number; marketValue: number }[];
  schedule: { propertyType: PropertyType; acquisitionYear: number; lifeClass: string; count: number; cost: number; marketValue: number; factor: number | null }[];
  changes: Partial<Record<LineChange, { count: number; cost: number }>>;
  prior?: { id: string; taxYear: number; status: FilingStatus; totalCost: number; totalMarketValue: number; assessedValue: number; estimatedTax: number; actualTax?: number };
}
export interface FilingLine {
  assetId?: string; assetTag: string; description: string; categoryName?: string; lifeClass?: string; propertyType: PropertyType; acquisitionDate?: string; acquisitionYear?: number;
  originalCost?: number; costSource?: 'SAP' | 'ALM'; age?: number; factor?: number; marketValue?: number; siteCode?: string; roomCode?: string; change: LineChange; disposalDate?: string;
}
