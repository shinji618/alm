// Portal 연동(PAS Portal 앱 연동 계약 v1): 매니페스트와 피드 모양 만들기. 업무 판단(누가 무엇을 결정할 수 있나)은 requests.inbox가 한다.
import type { Config } from '../config';

export const CONTRACT_VERSION = 1;
export const MENU_KEY_REQUESTS = 'requests';

export interface PortalManifest {
  contractVersion: number; appId: string; nameKey: string; icon: string; moduleCode: string; centralProductCode: string;
  launchUrl: string; apiBase: string; menu: { key: string; labelKey: string; path: string }[]; feeds: { approvalInbox: string; calendar: string; badges: string };
  notifications: { sends: boolean; events: string[] }; lifecycle: { tenantExport: string; tenantImport: string; erasureHook: string }; header: { component: boolean };
}

import { PORTAL_EVENTS } from '../notify/portal';

/** 주소는 설정의 APP_ORIGIN에서 만든다(환경별 alm-dev·qa·운영). 이 API는 /api/v1/portal 아래에 있다. */
export function buildManifest(cfg: Pick<Config, 'appOrigin'> & Partial<Pick<Config, 'portalNotify'>>): PortalManifest {
  const origin = cfg.appOrigin.replace(/\/$/, '');
  return {
    contractVersion: CONTRACT_VERSION, appId: 'alm', nameKey: 'app.alm.name', icon: 'box', moduleCode: 'ALM', centralProductCode: 'alm',
    launchUrl: `${origin}/`, apiBase: `${origin}/api/v1/portal`,
    menu: [{ key: MENU_KEY_REQUESTS, labelKey: 'app.alm.menu.requests', path: '/requests' }],
    // 일정·할 일 피드와 수명주기 훅은 아직 제공하지 않아 선언하지 않는다(Portal은 없는 피드를 건너뛴다)
    feeds: { approvalInbox: '/inbox', calendar: '/calendar-feed', badges: '/badges' },
    lifecycle: { tenantExport: '/tenant-export', tenantImport: '/tenant-import', erasureHook: '/erase' },
    notifications: cfg.portalNotify ? { sends: true, events: [...PORTAL_EVENTS] } : { sends: false, events: [] }, header: { component: false },
  };
}

const STEP_LABEL: Record<string, string> = { DEPT_MANAGER: '부서 관리자', ASSET_MANAGER: '자산 관리자', ASSET_ACCOUNTANT: '자산회계' };

export interface AlmInboxItem { approvalId: string; targetId: string; targetNo?: string; summary?: string; requesterName?: string; approverRole?: string; waitingSince?: string }
export interface PortalInboxItem { id: string; title: string; kind: string; requesterName?: string; stepLabel?: string; arrivedAt: string; deepLink: string }

/** 웹 승인함 한 건 → Portal 결재 대기 건. 금액은 통화를 알 수 없어(요청에 통화 열이 없다) 보내지 않는다. */
export function toPortalItem(r: AlmInboxItem, now = new Date()): PortalInboxItem {
  const no = r.targetNo ? `[${r.targetNo}] ` : '';
  return {
    id: String(r.approvalId), title: `${no}${r.summary ?? ''}`.trim().slice(0, 200) || String(r.targetNo ?? r.targetId), kind: 'ASSET_REQUEST',
    ...(r.requesterName ? { requesterName: r.requesterName } : {}),
    ...(r.approverRole ? { stepLabel: STEP_LABEL[r.approverRole] ?? r.approverRole } : {}),
    arrivedAt: r.waitingSince ?? now.toISOString(), deepLink: `/requests/${r.targetId}`,
  };
}

export const parseLimit = (v: unknown): number => { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 50; };
