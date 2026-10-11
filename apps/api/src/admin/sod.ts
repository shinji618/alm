// 직무 분리(09 설계서 5.2): 막지 않고 경고(X-SoD-Warning)하고 /admin/sod-conflicts로 분기 점검(결정 S-08)
export interface RoleRow { role: string; costCenterCode?: string | null }
export interface SodHit { rule: string; roles: string[]; description: string }

const PAIRS: [string, string, string, string][] = [
  ['SOD-01', 'ASSET_MANAGER', 'ASSET_ACCOUNTANT', '자산 등록·할당부터 최종 승인·SAP 전기까지 한 사람이 처리'],
  ['SOD-02', 'SYS_ADMIN', 'ASSET_ACCOUNTANT', '권한 부여와 전기를 한 사람이 처리'],
  ['SOD-03', 'SYS_ADMIN', 'ASSET_MANAGER', '사용자 권한 관리와 자산 변경을 한 사람이 처리'],
];

export function sodConflicts(roles: RoleRow[]): SodHit[] {
  const has = (r: string) => roles.some((x) => x.role === r);
  const hits: SodHit[] = PAIRS.filter(([, a, b]) => has(a) && has(b)).map(([rule, a, b, description]) => ({ rule, roles: [a, b], description }));
  // SOD-04: 부서 관리자 + 자산회계가 같은 코스트센터(자산회계 범위가 전체이거나 같은 코스트센터)
  const ccs = roles.filter((r) => r.role === 'DEPT_MANAGER' && r.costCenterCode).map((r) => r.costCenterCode!);
  const acct = roles.filter((r) => r.role === 'ASSET_ACCOUNTANT');
  const same = ccs.filter((cc) => acct.some((a) => !a.costCenterCode || a.costCenterCode === cc));
  if (same.length) hits.push({ rule: 'SOD-04', roles: ['DEPT_MANAGER', 'ASSET_ACCOUNTANT'],
    description: `부서 승인과 최종 승인을 한 사람이 처리(코스트센터 ${[...new Set(same)].join(', ')})` });
  return hits;
}
