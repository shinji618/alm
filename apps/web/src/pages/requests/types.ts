// 자산 요청·승인 API 응답 타입(openapi AssetRequestSummary·AssetRequestDetail·ApprovalInboxRow)
import type { Tone } from '@/lib/status';

export const REQUEST_TYPES = ['NEW_ASSET', 'CHANGE', 'TRANSFER', 'RETIRE', 'SALE'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'MGR_APPROVED', 'ACCT_APPROVED', 'POSTED', 'POST_ERROR', 'REJECTED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface RequestSummary {
  id: string; requestNo: string; requestType: RequestType; status: RequestStatus; source: string; assetTag?: string; requesterName: string;
  currentStep: number; awaitingRole?: string; submittedAt?: string; createdAt: string;
}
export interface RequestInput {
  requestType: RequestType; assetId?: string; reason: string; assetClassId?: string; acquisitionValue?: number; poItemId?: string;
  targetCostCenterId?: string; targetRoomId?: string; changes?: { description?: string; serialNo?: string }; effectiveDate?: string;
  retireType?: 'SCRAP' | 'SALE' | 'LOSS'; saleAmount?: number; buyer?: string; submit?: boolean;
}
export interface ApprovalStep {
  id: string; stepNo: number; approverRole: string; approverName?: string; costCenter?: string; proxy?: boolean; decision: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
  comment?: string; decidedAt?: string; requestStatus?: RequestStatus;
}
export interface BapiMessage { type: string; id: string; number: string; text: string }
export interface RequestDetail {
  id: string; version: number; requestNo: string; status: RequestStatus; source: string; currentStep: number; requesterId: string; requesterName: string;
  submittedAt?: string; completedAt?: string; createdAt: string; request: RequestInput;
  labels: { assetClass?: string; targetCostCenter?: string; currentCostCenter?: string; targetRoom?: string; poItem?: string };
  amountMasked: boolean; isProfitCenterChange: boolean; deptManagerMissing: boolean; sapEnabled?: boolean; approvalSteps?: number;
  asset?: { id: string; assetTag: string; description: string; status: string; sapAssetNo?: string; companyCode: string };
  approvals: ApprovalStep[];
  posting?: { id: string; postingId: string; postingType: string; status: string; attemptCount: number; sapDocumentNo?: string; sapFiscalYear?: number;
    sapAssetNo?: string; resultAt?: string; messages: BapiMessage[] };
  actions: { approve?: string; submit?: boolean; edit?: boolean; cancel?: boolean; fix?: boolean };
}
export interface InboxRow {
  approvalId: string; kind: 'ASSET_REQUEST' | 'PURCHASE_REQUEST'; targetId: string; targetNo: string; requestType: RequestType; summary: string;
  requesterName: string; stepNo: number; approverRole: string; waitingSince: string; amount?: number;
  assetTag?: string; targetCostCenterCode?: string; isProfitCenterChange?: boolean; retireType?: string; buyer?: string; proxy?: boolean;
  stepCostCenterCode?: string;
}

export const statusTone: Record<RequestStatus, Tone> = {
  DRAFT: 'neutral', SUBMITTED: 'info', MGR_APPROVED: 'info', ACCT_APPROVED: 'accent', POSTED: 'ok', POST_ERROR: 'bad', REJECTED: 'warn', CANCELLED: 'neutral',
};
