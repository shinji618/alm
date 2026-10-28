// 제품 카탈로그(6.2 제품 등록): 역할 목록과 규칙. 권한(무엇을 할 수 있나)은 제품이 갖고, 중앙은 역할 부여 검증에 필요한 것만 받는다
import { Check, ROLE_CODE } from './validate';

export interface RoleDef { code: string; name: string; requiredScope?: string[]; requireValidUntil?: boolean; maxValidYears?: number }
export interface ScopeDimension { dimension: string; label: string; max: number }
export interface SodRule { rule: string; roles: [string, string]; description: string; sameScope?: string; scopeLabel?: string }
export interface Catalog {
  roles: RoleDef[];
  adminRole: string;                                  // 마지막 관리자 보호(H-04) 대상
  exclusiveRoles: string[];                           // 다른 역할과 함께 줄 수 없음(H-05, 예: 감사인)
  implicit?: { role: string; excludedIf: string[] };  // 부여하지 않아도 가지는 역할(예: EMPLOYEE). 제품이 계산
  scopeDimensions: ScopeDimension[];
  sodRules: SodRule[];
}

const DIM = /^[a-z][A-Za-z0-9]{1,29}$/;
export function parseCatalog(v: unknown, k = new Check(v), field = 'catalog'): Catalog {
  const o = k.obj(v, field);
  const roles = k.arr(o, 'roles', { required: true, max: 50, field: `${field}.roles` }).map((x, i) => {
    const f = `${field}.roles[${i}]`, r = k.obj(x, f);
    const def: RoleDef = { code: k.str(r, 'code', { required: true, pattern: ROLE_CODE, field: `${f}.code` }) ?? '',
      name: k.str(r, 'name', { required: true, max: 50, field: `${f}.name` }) ?? '' };
    const rs = k.arr(r, 'requiredScope', { field: `${f}.requiredScope` });
    if (rs.length) def.requiredScope = rs.map(String);
    if (k.bool(r, 'requireValidUntil', `${f}.requireValidUntil`)) def.requireValidUntil = true;
    const y = k.int(r, 'maxValidYears', { min: 1, max: 10, field: `${f}.maxValidYears` });
    if (y) def.maxValidYears = y;
    return def;
  });
  const codes = roles.map((r) => r.code);
  if (new Set(codes).size !== codes.length) k.fail(`${field}.roles`, '역할 코드가 중복되었습니다');
  const known = (c: unknown, f: string) => { if (typeof c !== 'string' || !codes.includes(c)) k.fail(f, `카탈로그에 없는 역할: ${String(c)}`); return String(c); };
  const adminRole = known(o.adminRole, `${field}.adminRole`);
  const exclusiveRoles = k.arr(o, 'exclusiveRoles', { field: `${field}.exclusiveRoles` }).map((c, i) => known(c, `${field}.exclusiveRoles[${i}]`));
  let implicit: Catalog['implicit'];
  if (o.implicit !== undefined && o.implicit !== null) {
    const im = k.obj(o.implicit, `${field}.implicit`);
    implicit = { role: known(im.role, `${field}.implicit.role`),
      excludedIf: k.arr(im, 'excludedIf', { field: `${field}.implicit.excludedIf` }).map((c, i) => known(c, `${field}.implicit.excludedIf[${i}]`)) };
  }
  const scopeDimensions = k.arr(o, 'scopeDimensions', { max: 10, field: `${field}.scopeDimensions` }).map((x, i) => {
    const f = `${field}.scopeDimensions[${i}]`, d = k.obj(x, f);
    return { dimension: k.str(d, 'dimension', { required: true, pattern: DIM, field: `${f}.dimension` }) ?? '',
      label: k.str(d, 'label', { required: true, max: 30, field: `${f}.label` }) ?? '',
      max: k.int(d, 'max', { min: 1, max: 60, field: `${f}.max` }) ?? 60 };
  });
  const dims = scopeDimensions.map((d) => d.dimension);
  roles.forEach((r, i) => (r.requiredScope ?? []).forEach((d) => { if (!dims.includes(d)) k.fail(`${field}.roles[${i}].requiredScope`, `없는 범위 차원: ${d}`); }));
  const sodRules = k.arr(o, 'sodRules', { max: 50, field: `${field}.sodRules` }).map((x, i) => {
    const f = `${field}.sodRules[${i}]`, s = k.obj(x, f);
    const pair = k.arr(s, 'roles', { required: true, field: `${f}.roles` });
    if (pair.length !== 2) k.fail(`${f}.roles`, '역할 두 개');
    const rule: SodRule = { rule: k.str(s, 'rule', { required: true, max: 20, field: `${f}.rule` }) ?? '',
      roles: [known(pair[0], `${f}.roles[0]`), known(pair[1], `${f}.roles[1]`)],
      description: k.str(s, 'description', { required: true, max: 200, field: `${f}.description` }) ?? '' };
    const same = k.str(s, 'sameScope', { field: `${f}.sameScope` });
    if (same) { if (!dims.includes(same)) k.fail(`${f}.sameScope`, `없는 범위 차원: ${same}`); rule.sameScope = same; }
    const label = k.str(s, 'scopeLabel', { max: 30, field: `${f}.scopeLabel` });
    if (label) rule.scopeLabel = label;
    return rule;
  });
  return { roles, adminRole, exclusiveRoles, ...(implicit ? { implicit } : {}), scopeDimensions, sodRules };
}

// ---- 범위 ----
export type ScopeMap = Record<string, string>;
export const scopeKey = (s: ScopeMap): string =>
  Object.entries(s).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([d, v]) => `${d}=${v}`).join('|');

// ---- 직무 분리(경고, 막지 않음). ALM sod.ts와 같은 규칙 ----
export interface SodHit { rule: string; roles: string[]; description: string }
export function sodConflicts(roles: { role: string; scope: ScopeMap }[], c: Catalog): SodHit[] {
  const hits: SodHit[] = [];
  for (const rule of c.sodRules) {
    const [a, b] = rule.roles;
    const as = roles.filter((r) => r.role === a), bs = roles.filter((r) => r.role === b);
    if (!as.length || !bs.length) continue;
    if (!rule.sameScope) { hits.push({ rule: rule.rule, roles: [a, b], description: rule.description }); continue; }
    const dim = rule.sameScope;
    const same = as.filter((x) => x.scope[dim]).map((x) => x.scope[dim]).filter((v) => bs.some((y) => !y.scope[dim] || y.scope[dim] === v));
    if (same.length) hits.push({ rule: rule.rule, roles: [a, b],
      description: rule.description.replace('{scope}', `${rule.scopeLabel ?? dim} ${[...new Set(same)].join(', ')}`) });
  }
  return hits;
}
