// 자산 API 응답 타입(openapi AssetSummary·AssetDetail·Lookups 등)
import type { AssetStatusCode, StageCode } from '@/lib/status';

export interface AssetSummary {
  id: string; assetTag: string; description: string; categoryName: string; modelName?: string; serialNo?: string;
  status: AssetStatusCode; stage: StageCode; siteCode?: string; roomCode?: string; assignedUserName?: string; costCenterCode?: string;
  sapAssetNo?: string; warrantyEndDate?: string; nbv: number | null; updatedAt: string;
  isBundle?: boolean; componentCount?: number; bundleAssetTag?: string;
}
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface RequestRef { id: string; requestNo: string; requestType: string; status: string }
export interface AssetDetail {
  id: string; version: number; assetTag: string; description: string; categoryId: string; modelId?: string; serialNo?: string;
  status: AssetStatusCode; stage: StageCode; source: string; siteId?: string; roomId?: string; costCenterId?: string; assignedUserId?: string;
  assignedAt?: string; dueBackDate?: string; hostname?: string; ipAddress?: string; macAddress?: string; osName?: string; warrantyEndDate?: string;
  lastCountDate?: string; lastSeenAt?: string; notes?: string;
  financial: { isCapitalized: boolean; companyCode: string; sapEnabled?: boolean; sapAssetNo?: string; sapSubNo?: string; assetClass?: string; capDate?: string;
    acquisitionValue?: number | null; accumDepreciation?: number | null; netBookValue?: number | null; usefulLifeYears?: number; valueAsOf?: string;
    tcoEstimate?: number | null; sapSyncedAt?: string };
  purchase?: { poNo: string; poItem: string; vendorName?: string; description: string; quantity: number; grQuantity: number; unitPrice?: number | null;
    isDeleted?: boolean; isGrCancelled?: boolean;
    goodsReceipt?: { materialDoc: string; docYear: number; docItem: string; movementType: string; quantity: number; postingDate: string } };
  openRequests: RequestRef[]; editableFields: string[];
  isBundle?: boolean; components?: BundleComponent[]; componentCostTotal?: number | null; bundle?: BundleRef;
}
export interface BundleComponent {
  id: string; assetTag: string; description: string; status: AssetStatusCode; categoryName: string; serialNo?: string; roomCode?: string;
  assignedUserName?: string; purchaseCost: number | null;
}
export interface BundleRef { id: string; assetTag: string; description: string; sapAssetNo?: string }
export interface BundleComponents { added?: string[]; components: BundleComponent[]; componentCostTotal: number | null }
export interface ChangeResult { asset: AssetDetail; createdRequests: RequestRef[] }
export interface LookupItem { id: string; code: string; label: string; parentId?: string; extra?: Record<string, unknown> }
export type Lookups = Partial<Record<'companies' | 'sites' | 'rooms' | 'costCenters' | 'assetClasses' | 'categories' | 'models' | 'vendors' | 'users', LookupItem[]>>;
