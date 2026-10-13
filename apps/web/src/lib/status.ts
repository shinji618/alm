/** 화면설계서 5.1 상태 → 배지 색 매핑 */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'neutral';

export type AssetStatus = 'In Use' | 'In Stock' | 'In Repair' | 'On Order' | 'Missing' | 'Retired' | 'Disposed';
export type Stage = 'Plan' | 'Procure' | 'Deploy' | 'Operate' | 'Maintain' | 'Retire';

export const STAGES: Stage[] = ['Plan', 'Procure', 'Deploy', 'Operate', 'Maintain', 'Retire'];

export const assetStatusTone: Record<AssetStatus, Tone> = {
  'In Use': 'ok',
  'In Stock': 'info',
  'In Repair': 'warn',
  'On Order': 'accent',
  Missing: 'bad',
  Retired: 'neutral',
  Disposed: 'neutral',
};

export const stageColorVar: Record<Stage, string> = {
  Plan: 'var(--stage-plan)',
  Procure: 'var(--stage-procure)',
  Deploy: 'var(--stage-deploy)',
  Operate: 'var(--stage-operate)',
  Maintain: 'var(--stage-maintain)',
  Retire: 'var(--stage-retire)',
};

export const discoveryTone = { New: 'info', Matched: 'ok', Conflict: 'warn', Unmanaged: 'bad' } as const satisfies Record<string, Tone>;
export const licenseTone = { Compliant: 'ok', 'Over-licensed': 'info', 'Under-licensed': 'bad' } as const satisfies Record<string, Tone>;
export const differenceTone = { 'Location mismatch': 'warn', Damaged: 'warn', 'Not found': 'bad', Unregistered: 'info' } as const satisfies Record<string, Tone>;
export const jobTone = { Success: 'ok', Completed: 'ok', Running: 'info', Error: 'bad', Failed: 'bad' } as const satisfies Record<string, Tone>;

/** 계약·보증 만료: 지남/≤30 bad, ≤90 warn, 그 외 ok */
export function expiryTone(daysLeft: number): Tone {
  if (daysLeft <= 30) return 'bad';
  if (daysLeft <= 90) return 'warn';
  return 'ok';
}

/** API 상태 코드(자산 상태·단계) — 화면 글자는 i18n asset.status.* / asset.stage.* */
export type AssetStatusCode = 'ON_ORDER' | 'IN_STOCK' | 'IN_USE' | 'IN_REPAIR' | 'MISSING' | 'RETIRED' | 'DISPOSED';
export type StageCode = 'PLAN' | 'PROCURE' | 'DEPLOY' | 'OPERATE' | 'MAINTAIN' | 'RETIRE';
export const STATUS_CODES: AssetStatusCode[] = ['ON_ORDER', 'IN_STOCK', 'IN_USE', 'IN_REPAIR', 'MISSING', 'RETIRED', 'DISPOSED'];
export const STAGE_CODES: StageCode[] = ['PLAN', 'PROCURE', 'DEPLOY', 'OPERATE', 'MAINTAIN', 'RETIRE'];
export const statusCodeTone: Record<AssetStatusCode, Tone> = {
  IN_USE: 'ok', IN_STOCK: 'info', IN_REPAIR: 'warn', ON_ORDER: 'accent', MISSING: 'bad', RETIRED: 'neutral', DISPOSED: 'neutral',
};
export const stageCodeColorVar: Record<StageCode, string> = {
  PLAN: 'var(--stage-plan)', PROCURE: 'var(--stage-procure)', DEPLOY: 'var(--stage-deploy)',
  OPERATE: 'var(--stage-operate)', MAINTAIN: 'var(--stage-maintain)', RETIRE: 'var(--stage-retire)',
};
