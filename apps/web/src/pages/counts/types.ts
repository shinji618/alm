// 실사 API 응답 타입(openapi 실사 영역: CampaignSummary·CampaignDetail·CountItemRow·UnregisteredRow)
import type { Tone } from '@/lib/status';

export const CAMPAIGN_STATUSES = ['SCOPING', 'COUNTING', 'REVIEW', 'POSTING', 'CLOSED', 'CANCELLED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const FLOW: CampaignStatus[] = ['SCOPING', 'COUNTING', 'REVIEW', 'POSTING', 'CLOSED'];
export const campaignTone: Record<CampaignStatus, Tone> = { SCOPING: 'info', COUNTING: 'accent', REVIEW: 'warn', POSTING: 'info', CLOSED: 'ok', CANCELLED: 'neutral' };

export type CountResult = 'PENDING' | 'FOUND' | 'MISPLACED' | 'NOT_FOUND';
export const resultTone: Record<CountResult, Tone> = { PENDING: 'neutral', FOUND: 'ok', MISPLACED: 'warn', NOT_FOUND: 'bad' };
export const ACTIONS = ['MASTER_CHANGE', 'RECOUNT', 'RETIRE_REQUEST', 'MARK_MISSING', 'REPAIR', 'ACCEPT'] as const;
export type VarianceAction = (typeof ACTIONS)[number];

export interface CampaignSummary { id: string; campaignCode: string; name: string; status: CampaignStatus; companyCode: string; keyDate: string; dueDate: string;
  totalItems: number; countedItems: number; varianceItems: number }
export interface RoomProgress { taskId: string; roomCode: string; assigneeName?: string; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'; expected: number; found: number; pending: number }
export interface Progress { total: number; found: number; misplaced: number; pending: number; notFound: number; unregistered: number; rooms: RoomProgress[] }
export interface CampaignScope { siteIds: string[]; roomIds?: string[]; assetClassIds?: string[]; includeNonCapitalized?: boolean }
export interface CampaignDetail { id: string; version: number; status: CampaignStatus; companyCode: string; sapEnabled: boolean; scopeFrozenAt?: string; closedAt?: string;
  campaign: { campaignCode: string; name: string; companyId: string; keyDate: string; dueDate: string; scope: CampaignScope };
  progress: Progress; postings: Record<string, number> }
export interface CountItemRow { id: string; assetId: string; assetTag: string; description: string; assetStatus: string; expectedRoomCode: string; foundRoomCode?: string;
  result: CountResult; condition?: 'GOOD' | 'DAMAGED' | 'UNUSED'; note?: string; countedByName?: string; countedAt?: string; needsRelabel?: boolean;
  varianceAction?: VarianceAction; requestNo?: string; photoCount: number }
export interface UnregisteredRow { id: string; tempNo: string; roomId: string; roomCode: string; categoryId?: string; categoryName?: string; description: string;
  serialNo?: string; scannedBarcode?: string; reportedByName: string; reportedAt: string; photoCount: number; resolution?: string; createdAssetTag?: string }
export interface BulkResult { results: { id: string; status: 'OK' | 'ERROR'; code?: string; message?: string; createdId?: string }[] }

// 판정·상태별로 쓸 수 있는 차이 처리(서버 규칙과 같다)
export function allowedActions(x: Pick<CountItemRow, 'result' | 'condition'>): VarianceAction[] {
  const out = new Set<VarianceAction>(['ACCEPT']);
  if (x.result === 'MISPLACED') ['MASTER_CHANGE', 'RECOUNT'].forEach((a) => out.add(a as VarianceAction));
  if (x.result === 'NOT_FOUND') ['RECOUNT', 'RETIRE_REQUEST', 'MARK_MISSING'].forEach((a) => out.add(a as VarianceAction));
  if (x.condition === 'DAMAGED') ['REPAIR', 'RETIRE_REQUEST'].forEach((a) => out.add(a as VarianceAction));
  return ACTIONS.filter((a) => out.has(a));
}
