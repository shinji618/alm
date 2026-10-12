// 데이터 범위(09 4.1). RLS는 테넌트만 막고, 역할 행의 범위(회사코드·사이트·코스트센터·본인)는 여기서 SQL 조건으로 만든다.
//   ● (ALL·'-') : 역할 행에 회사코드·사이트가 있으면 그 범위, 없으면 테넌트 전체
//   CC          : 역할 행의 코스트센터(없으면 아무것도 못 봄 — 부서 관리자는 코스트센터 필수)
//   OWN         : 나에게 할당된 자산
//   TASK        : 실사 배정(자산 목록에는 해당 없음)
// 여러 역할 행은 OR. 범위 밖 단건은 404(존재를 알리지 않음).
import type { Principal } from './principal';
import { catalog, Scope } from './permissions';

export interface ScopeRow { scope: Scope; companyCode?: string; siteCode?: string; costCenterCode?: string }

// 이 권한을 주는 역할 행들. 암묵 EMPLOYEE(user_role에 없음)는 범위 없는 행 하나
export function scopeRows(p: Principal, perm: string): ScopeRow[] {
  const g = catalog().grants;
  const rows: ScopeRow[] = [];
  const stored = new Set(p.roles.map((r) => r.role));
  for (const r of p.roles) {
    if (!p.effectiveRoles.includes(r.role)) continue;
    const s = g[r.role]?.[perm];
    if (s) rows.push({ scope: s, companyCode: r.companyCode, siteCode: r.siteCode, costCenterCode: r.costCenterCode });
  }
  for (const role of p.effectiveRoles) {
    if (stored.has(role)) continue;
    const s = g[role]?.[perm];
    if (s) rows.push({ scope: s });
  }
  return rows;
}

// 파라미터를 모으며 SQL 조각을 만든다($n 번호를 이어서)
export class Params {
  readonly values: unknown[] = [];
  constructor(start: unknown[] = []) { this.values.push(...start); }
  add(v: unknown) { this.values.push(v); return `$${this.values.length}`; }
}

// 자산 범위 조건. alias는 asset 테이블 별칭(코드 상수만 넘긴다)
export function assetScope(p: Principal, perm: string, ps: Params, alias: 'a' = 'a'): string {
  const parts: string[] = [];
  for (const r of scopeRows(p, perm)) {
    if (r.scope === 'ALL' || r.scope === '-') {
      const c: string[] = [];
      if (r.companyCode) c.push(`${alias}.company_id IN (SELECT id FROM company WHERE company_code = ${ps.add(r.companyCode)})`);
      if (r.siteCode) c.push(`${alias}.site_id IN (SELECT id FROM site WHERE site_code = ${ps.add(r.siteCode)})`);
      if (!c.length) return 'true';
      parts.push(`(${c.join(' AND ')})`);
    } else if (r.scope === 'CC') {
      if (r.costCenterCode) parts.push(`${alias}.cost_center_id IN (SELECT id FROM cost_center WHERE cost_center_code = ${ps.add(r.costCenterCode)})`);
    } else if (r.scope === 'OWN') {
      parts.push(`${alias}.assigned_user_id = ${ps.add(p.userId)}`);
    }
  }
  return parts.length ? `(${parts.join(' OR ')})` : 'false';
}

// 범위가 회사코드·사이트로만 정해지는 쓰기 권한(asset.write 등): 바꿀 값(회사·사이트)도 범위 안인지
export function allowsPlace(p: Principal, perm: string, companyCode: string, siteCode: string | null): boolean {
  return scopeRows(p, perm).some((r) => (r.scope === 'ALL' || r.scope === '-')
    && (!r.companyCode || r.companyCode === companyCode) && (!r.siteCode || r.siteCode === siteCode));
}

export const can = (p: Principal, perm: string) => p.permissions.has(perm);
