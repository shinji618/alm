// 권한 카탈로그(api/permissions.json, 09 정의서 4장). 역할 → 권한 키 → 범위(ALL·CC·OWN·TASK, '-'는 범위 없음)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Scope = 'ALL' | 'CC' | 'OWN' | 'TASK' | '-';
export interface Catalog {
  roles: { code: string; name: string; summary?: string; requiredScope?: string[]; requireValidUntil?: boolean; maxValidYears?: number }[];
  permissions: { key: string }[];
  grants: Record<string, Record<string, Scope>>;
  operations: Record<string, string | string[] | null>;   // 배열 = 그중 하나만 있으면 된다(예: 요청 취소 = 요청자 또는 자산 관리자)
  implicit: { role: string; excludedIf: string[] };
  exclusiveRoles: string[];
  adminRole: string;                                                   // 마지막 관리자 보호 대상 역할
  scopeDimensions: string[];                                           // 이 제품이 쓰는 범위 차원
  sodRules: { rule: string; roles: [string, string]; description: string; sameScope?: string; scopeLabel?: string }[];
}

let cached: Catalog | undefined;
// 제품이 부팅 때 다른 위치의 카탈로그를 쓰려면 먼저 부른다(없으면 첫 catalog() 호출 때 기본 위치)
export function catalog(path = join(__dirname, '..', '..', 'permissions.json')): Catalog {
  return (cached ??= JSON.parse(readFileSync(path, 'utf8')) as Catalog);
}

// 유효 역할: 감사인(배타 역할)이 있으면 감사인만, 아니면 부여 역할 + 암묵 EMPLOYEE
export function effectiveRoles(assigned: string[], c = catalog()): string[] {
  const set = new Set(assigned);
  const exclusive = c.exclusiveRoles.find((r) => set.has(r));
  if (exclusive) return [exclusive];
  if (!c.implicit.excludedIf.some((r) => set.has(r))) set.add(c.implicit.role);
  return [...set];
}

// 권한 키 → 범위 목록. 같은 키에 ALL이 있으면 ALL 하나로 줄인다
export function permissionsOf(roles: string[], c = catalog()): Map<string, Scope[]> {
  const m = new Map<string, Scope[]>([['auth', ['-']]]);
  for (const r of roles) for (const [k, s] of Object.entries(c.grants[r] ?? {})) {
    const cur = m.get(k) ?? [];
    if (!cur.includes(s)) cur.push(s);
    m.set(k, cur.includes('ALL') ? ['ALL'] : cur);
  }
  return m;
}

// operationId → 필요한 권한 키. null이면 인증 없이 호출(로그인 단계), undefined면 카탈로그에 없는 작업(배포 오류)
export function permissionFor(operationId: string, c = catalog()): string | string[] | null | undefined {
  return operationId in c.operations ? c.operations[operationId] : undefined;
}
