// 제품 어댑터: 공통 사용자 관리 엔진(platform/identity)이 제품별로 아는 것은 이 인터페이스뿐이다(문서 17)
import { PoolClient } from 'pg';
import { Check } from '../../common/validate';

export type ScopeMap = Record<string, string>;                 // 범위 차원 → 값(코드). 예: { company: '1000', site: 'ATL' }
export interface RoleScope { role: string; scope: ScopeMap; validFrom?: string; validUntil?: string }
export interface ScopeField { dimension: string; field: string; max: number; label: string }   // API 필드(companyCode 등)와 차원의 대응

// 제품이 사용자에 덧붙이는 프로필(ALM: 부서·소속 코스트센터). 엔진은 내용을 모른다
export interface ProfileAdapter {
  joinSql: string;                                            // listUsers·getUser의 FROM에 붙는 JOIN(app_user는 u)
  selectSql: string;                                          // SELECT에 붙는 열(앞에 쉼표 없이)
  sorts: Record<string, string>;                              // 정렬 키 → SQL 식
  parse(k: Check, o: Record<string, unknown>): Record<string, unknown>;
  validate(c: PoolClient, v: Record<string, unknown>): Promise<void>;
  save(c: PoolClient, tenantId: string, userId: string, actorId: string, v: Record<string, unknown>): Promise<void>;
  toRow(u: Record<string, unknown>): Record<string, unknown>;
}

export interface IdentityAdapter {
  scopeFields: ScopeField[];
  checkScope(c: PoolClient, scope: ScopeMap, i: number): Promise<void>;   // 범위 값이 제품 마스터에 있는지(없으면 E.badRequest)
  profile?: ProfileAdapter;
}

export const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;

// 범위 정규화 키: 차원 이름순 `차원=값`을 '|'로 이음. 범위 없으면 ''
export const scopeKey = (s: ScopeMap): string =>
  Object.entries(s).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([d, v]) => `${d}=${v}`).join('|');

// 역할 행 → API 모양({ role, companyCode, siteCode, ... , validFrom, validUntil })
export function toApiRole(a: IdentityAdapter, r: RoleScope): Record<string, unknown> {
  const o: Record<string, unknown> = { role: r.role };
  for (const f of a.scopeFields) if (r.scope[f.dimension]) o[f.field] = r.scope[f.dimension];
  return strip({ ...o, validFrom: r.validFrom, validUntil: r.validUntil });
}
