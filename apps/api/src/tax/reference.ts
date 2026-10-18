// 재산세(사업용 동산, Business Personal Property) 참고값(2026-10-17 조사). 관리 화면에서 관할을 만들 때 기본값으로 채우고,
// 계수표는 '참고표 불러오기'로 테넌트 표(tax_factor)에 복사한다. 표·세율·면제는 해마다 바뀌므로 신고 전에 관할 공식 자료로 확인한다.
//   GA: PT-50P, 1/1 기준·4/1 기한, 공정가치 × 40%, 공정가치 합계 $20,000 이하 면제(HB 808, 2025~), DOR 복합 환산 계수(Group I~IV)
//   AL: ADV-40, 10/1 기준·12/31 기한, Class II 20%, ADOR 복합 계수(경제적 내용연수 3~25년). $100,000 면제는 주 세금만(카운티 선택)
//   TX: 50-144, 1/1 기준·4/15 기한(5/15 연장), 100%, 위치당 $125,000 면제(HB 9, 2026~). 감정 구역(CAD)마다 자체 감가표
//   CA: BOE-571-L, 1/1 기준·4/1 기한(5/7 뒤 10% 가산), 100%, 기본 1% + 지방 부채. AH 581 원가지수 × 잔존율
//   IL·NJ: 일반 사업용 동산은 과세하지 않음(IL은 소득세로 대체, NJ는 통신 등 일부만 PT-10)

export interface StatePreset {
  state: string; name: string; taxable: boolean; formCode?: string; lienMonth: number; lienDay: number; dueMonth?: number; dueDay?: number;
  assessmentRatio: number; exemptionMode: 'NONE' | 'THRESHOLD' | 'DEDUCT'; exemptionAmount: number; factorSet: FactorSet; typicalMillage?: number; note: string;
  includeVehicles: boolean; includeCip: boolean; includeLeasehold: boolean;
}

// 재산세 자산 구분. 신고에 들어가는지는 관할 설정(차량·건설중)과 함께 정한다
export const PROPERTY_TYPES = ['EQUIPMENT', 'LEASEHOLD', 'VEHICLE', 'CIP', 'LEASED_IN', 'REAL_PROPERTY', 'INTANGIBLE', 'EXCLUDED'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
/** 관할 설정과 무관하게 BPP 세액에 넣지 않는 구분: 부동산(부동산세), 무형, 제외.
 *  임차 자산(LEASED_IN)은 세액에서 빼지만 신고서의 임차 장비 목록(GA Sch.A §2, AL Part E, TX Sch.F, CA Part III)에 넣는다 */
export const NEVER_TAXED: PropertyType[] = ['REAL_PROPERTY', 'INTANGIBLE', 'EXCLUDED'];

/** 자산클래스 이름으로 구분 추정(설정이 없을 때). 모르면 장비(EQUIPMENT) */
export function suggestPropertyType(name: string | null | undefined): PropertyType | undefined {
  const n = (name ?? '').toLowerCase();
  if (!n) return undefined;
  if (/(real estate|land|building|grundst|gebäude)/.test(n)) return 'REAL_PROPERTY';
  if (/(vehicle|automobile|truck|fahrzeug|\bcar\b|fleet)/.test(n)) return 'VEHICLE';
  if (/(under construction|\bauc\b|construction in progress|\bcip\b|anlagen im bau|fiaa_auc)/.test(n)) return 'CIP';
  if (/(leasehold|tenant improvement)/.test(n)) return 'LEASEHOLD';
  if (/operating lease/.test(n)) return 'LEASED_IN';
  if (/(goodwill|software|licen[cs]e|intangible|formation expense|patent|trademark|right of use)/.test(n)) return 'INTANGIBLE';
  if (/(advance payment|down payment)/.test(n)) return 'EXCLUDED';
  if (/(machin|fixture|fitting|furniture|hardware|equipment|computer|\bdp\b|low-value|tool|objects of art|capital lease|finance lease)/.test(n)) return 'EQUIPMENT';
  return undefined;
}

export const FACTOR_SETS = ['GA_DOR', 'AL_ADOR', 'CA_BOE581', 'GENERIC_SL'] as const;
export type FactorSet = (typeof FACTOR_SETS)[number];

export const STATE_PRESETS: StatePreset[] = [
  { state: 'GA', includeVehicles: false, includeCip: true, includeLeasehold: false, name: 'Georgia', taxable: true, formCode: 'PT-50P', lienMonth: 1, lienDay: 1, dueMonth: 4, dueDay: 1, assessmentRatio: 0.4,
    exemptionMode: 'THRESHOLD', exemptionAmount: 20000, factorSet: 'GA_DOR', typicalMillage: 30,
    note: 'File with the county Board of Tax Assessors by April 1 (PT-50P, Schedule A by year acquired). Attach Form 4562. Exempt if total FMV per county is $20,000 or less (return still required).' },
  { state: 'AL', includeVehicles: false, includeCip: true, includeLeasehold: true, name: 'Alabama', taxable: true, formCode: 'ADV-40', lienMonth: 10, lienDay: 1, dueMonth: 12, dueDay: 31, assessmentRatio: 0.2,
    exemptionMode: 'NONE', exemptionAmount: 0, factorSet: 'AL_ADOR', typicalMillage: 40,
    note: 'File ADV-40 with the county assessing official between Oct 1 and Dec 31 (alproptax.com). $100,000 exemption applies to the state levy only unless the county adopted it. Late filing: 10% penalty.' },
  { state: 'TX', includeVehicles: true, includeCip: false, includeLeasehold: true, name: 'Texas', taxable: true, formCode: '50-144', lienMonth: 1, lienDay: 1, dueMonth: 4, dueDay: 15, assessmentRatio: 1,
    exemptionMode: 'DEDUCT', exemptionAmount: 125000, factorSet: 'GENERIC_SL', typicalMillage: 21,
    note: 'Render with the county appraisal district by April 15 (May 15 on written request). First $125,000 per location exempt from 2026. Appraisal districts use their own schedules: enter the district schedule as factors for an accurate estimate.' },
  { state: 'CA', includeVehicles: false, includeCip: true, includeLeasehold: true, name: 'California', taxable: true, formCode: 'BOE-571-L', lienMonth: 1, lienDay: 1, dueMonth: 4, dueDay: 1, assessmentRatio: 1,
    exemptionMode: 'NONE', exemptionAmount: 0, factorSet: 'CA_BOE581', typicalMillage: 11,
    note: 'File BOE-571-L with the county assessor by April 1 (10% penalty after May 7). Required when asked or when taxable personal property is $100,000 or more at cost. Value = cost × AH 581 index × percent good.' },
  { state: 'IL', includeVehicles: false, includeCip: false, includeLeasehold: false, name: 'Illinois', taxable: false, lienMonth: 1, lienDay: 1, assessmentRatio: 0, exemptionMode: 'NONE', exemptionAmount: 0, factorSet: 'GENERIC_SL',
    note: 'Business personal property is not taxed (replaced by the Personal Property Replacement Income Tax on the income tax return). No return is filed.' },
  { state: 'NJ', includeVehicles: false, includeCip: false, includeLeasehold: false, name: 'New Jersey', taxable: false, lienMonth: 1, lienDay: 1, assessmentRatio: 0, exemptionMode: 'NONE', exemptionAmount: 0, factorSet: 'GENERIC_SL',
    note: 'General business personal property is not taxed. Only certain telephone/telegraph companies file PT-10 by September 1.' },
];

export interface FactorTable { factorSet: FactorSet; tableYear: number; source: string; verified: boolean; rows: Record<string, number[]> }  // class → 경과연수 1,2,…(AL은 0부터)

/** 경과연수 = 기준일 연도 − 취득 연도. AL은 기준일(10/1) 연도에 취득한 자산이 0년 */
export const AGE_START: Record<FactorSet, number> = { GA_DOR: 1, AL_ADOR: 0, CA_BOE581: 1, GENERIC_SL: 0 };

export const REFERENCE_TABLES: FactorTable[] = [
  { factorSet: 'GA_DOR', tableYear: 2024, verified: true,
    source: 'GA DOR Appraisal Procedures Manual composite conversion factors (DOR Personal Property Hot Topics 2024)',
    rows: {
      I: [0.87, 0.74, 0.58, 0.43, 0.32, 0.26, 0.21],
      II: [0.92, 0.85, 0.78, 0.70, 0.63, 0.54, 0.44, 0.34, 0.28, 0.25],
      III: [0.95, 0.91, 0.87, 0.82, 0.79, 0.75, 0.70, 0.63, 0.57, 0.52, 0.47, 0.41, 0.35, 0.31, 0.29, 0.28],
      IV: [0.67, 0.54, 0.31, 0.10],
    } },
  { factorSet: 'AL_ADOR', tableYear: 2026, verified: false,
    source: 'ADOR composite factors effective Oct 1, 2026 (acquired 2017-2026; older years use the last value — verify)',
    rows: {
      3: [0.84, 0.67, 0.44, 0.30, 0.20, 0.18, 0.16, 0.14, 0.12, 0.10],
      5: [0.93, 0.88, 0.73, 0.57, 0.38, 0.28, 0.26, 0.23, 0.21, 0.16],
      8: [0.95, 0.93, 0.84, 0.73, 0.61, 0.52, 0.43, 0.34, 0.29, 0.23],
      10: [0.96, 0.94, 0.89, 0.83, 0.76, 0.71, 0.63, 0.51, 0.40, 0.33, 0.29, 0.24],
      12: [0.97, 0.96, 0.92, 0.87, 0.82, 0.81, 0.75, 0.65, 0.57, 0.49, 0.40, 0.34, 0.31, 0.25],
      15: [0.98, 0.96, 0.94, 0.91, 0.89, 0.88, 0.87, 0.81, 0.73, 0.67, 0.60, 0.52, 0.43, 0.37, 0.34, 0.28],
      20: [0.99, 0.98, 0.97, 0.95, 0.94, 0.92, 0.90, 0.86, 0.83, 0.81, 0.78],
      25: [0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.91, 0.89, 0.88],
    } },
  { factorSet: 'CA_BOE581', tableYear: 2026, verified: false,
    source: 'BOE AH 581 (Jan 2026) Table 7 non-production computers (age 1-8; verify). Other classes: enter index × percent good from AH 581',
    rows: { COMP: [0.78, 0.61, 0.46, 0.34, 0.25, 0.18, 0.12, 0.08] } },
];

/** 내용연수(년) → 계수표 구분 */
export function lifeClassOf(set: FactorSet, life: number | null | undefined): string {
  const y = life && life > 0 ? life : null;
  switch (set) {
    case 'GA_DOR':
      if (y === null) return 'II';
      return y <= 4 ? 'IV' : y <= 7 ? 'I' : y <= 12 ? 'II' : 'III';
    case 'AL_ADOR': {
      const opts = [3, 5, 8, 10, 12, 15, 20, 25];
      const v = y ?? 10;
      return String(opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)));
    }
    case 'CA_BOE581':
    case 'GENERIC_SL':
      return `L${y ?? 7}`;
  }
}

/** 표 없이 계산하는 계수(GENERIC_SL): 정액 잔존율, 하한 20%. 감정 구역 표를 넣기 전 추정용 */
export function genericFactor(lifeClass: string, age: number): number {
  const life = Number(lifeClass.replace(/^L/, '')) || 7;
  return Math.max(0.2, Math.round((1 - (age + 0.5) / life) * 10000) / 10000);
}
