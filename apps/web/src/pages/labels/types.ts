import type { Tone } from '@/lib/status';

export type Layout = 'QR_CODE128' | 'QR_ONLY' | 'CODE128_ONLY';
export type JobStatus = 'QUEUED' | 'RENDERED' | 'PRINTED' | 'FAILED' | 'CANCELLED';
export type JobSource = 'ASSET_DETAIL' | 'GOODS_RECEIPT' | 'PDA_REQUEST' | 'BULK';
export const LAYOUTS: Layout[] = ['QR_CODE128', 'QR_ONLY', 'CODE128_ONLY'];
export const JOB_STATUSES: JobStatus[] = ['QUEUED', 'RENDERED', 'PRINTED', 'FAILED', 'CANCELLED'];
export const JOB_SOURCES: JobSource[] = ['ASSET_DETAIL', 'GOODS_RECEIPT', 'PDA_REQUEST', 'BULK'];

export interface LabelTemplate {
  id: string; version?: number; templateCode: string; name: string; layout: Layout; widthIn: number; heightIn: number; dpi: number; zpl: string; isDefault: boolean; isActive?: boolean;
}
export interface Printer { id: string; version?: number; name: string; siteId?: string; siteCode?: string; deviceName?: string; connection: 'USB' | 'NETWORK'; host?: string; dpi: number; isActive: boolean }
export interface LabelJob {
  id: string; assetId: string; assetTag: string; description?: string; model?: string; sapAssetNo?: string; roomCode?: string; siteCode?: string; companyName?: string;
  templateId: string; templateName: string; layout: Layout; source: JobSource; status: JobStatus; copies: number; attemptCount: number;
  requestedByName?: string; requestedAt: string; renderedByName?: string; renderedAt?: string; printerName?: string; printedAt?: string; error?: string; needsCheck?: boolean;
}
export interface JobPage { items: LabelJob[]; page: number; pageSize: number; total: number; counts: Partial<Record<JobStatus, number>> }
export interface ZplBundle { renderId: string; deviceName?: string; printerName: string; items: { jobId: string; assetTag: string; zpl: string }[] }
export interface BulkResult { results: { id: string; status: 'OK' | 'ERROR'; code?: string; message?: string }[] }

export const jobTone: Record<JobStatus, Tone> = { QUEUED: 'info', RENDERED: 'accent', PRINTED: 'ok', FAILED: 'bad', CANCELLED: 'neutral' };
