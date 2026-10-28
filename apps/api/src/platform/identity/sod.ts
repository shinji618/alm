// 직무 분리(09 설계서 5.2): 막지 않고 경고(X-SoD-Warning)하고 /admin/sod-conflicts로 분기 점검(결정 S-08)
// 규칙은 권한 카탈로그(permissions.json sodRules)가 정한다. sameScope가 있으면 그 차원이 같을 때만 충돌이다
import { catalog, Catalog } from './permissions';
import { ScopeMap } from './adapter';

export interface RoleRow { role: string; scope: ScopeMap }
export interface SodHit { rule: string; roles: string[]; description: string }

export function sodConflicts(roles: RoleRow[], c: Catalog = catalog()): SodHit[] {
  const hits: SodHit[] = [];
  for (const rule of c.sodRules ?? []) {
    const [a, b] = rule.roles;
    const as = roles.filter((r) => r.role === a), bs = roles.filter((r) => r.role === b);
    if (!as.length || !bs.length) continue;
    if (!rule.sameScope) { hits.push({ rule: rule.rule, roles: [a, b], description: rule.description }); continue; }
    // 같은 범위: A 쪽이 값을 가진 행 중, B 쪽에 그 차원이 비었거나(전체) 같은 값인 것
    const dim = rule.sameScope;
    const same = as.filter((x) => x.scope[dim]).map((x) => x.scope[dim])
      .filter((v) => bs.some((y) => !y.scope[dim] || y.scope[dim] === v));
    if (same.length) hits.push({ rule: rule.rule, roles: [a, b],
      description: rule.description.replace('{scope}', `${rule.scopeLabel ?? dim} ${[...new Set(same)].join(', ')}`) });
  }
  return hits;
}
