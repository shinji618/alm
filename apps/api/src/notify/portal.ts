// Portal 인앱 알림(09 §6): 승인 요청·결과 메일과 같은 사건을 Portal 알림 센터에도 보낸다. 앱 백엔드 머신 토큰(client_credentials)으로
// Portal POST /v1/notifications 를 부른다. 설정(cfg.portalNotify)이 없으면 아무것도 하지 않는다. 같은 작업 큐(send-email과 같은 큐)를 쓴다.
import type { Job } from '../worker/worker';
import type { MailRequest } from './mail';
import { log } from '../common/log';

export interface PortalNotifyConfig { url: string; tokenUrl: string; clientId: string; clientSecret: string; scope?: string }
export interface PortalNotifyJob extends Job {
  type: 'portal-notify'; tenantId: string; userSub: string; eventCode: string; titleKey: string;
  params: Record<string, string>; linkUrl?: string; dedupeKey: string;
}

// 매니페스트 notifications.events 와 같아야 한다(Portal이 선언되지 않은 사건을 거부한다)
export const PORTAL_EVENTS = ['approval.requested', 'approval.decided'] as const;
const MAP: Record<string, { eventCode: (typeof PORTAL_EVENTS)[number]; titleKey: string; params: string[] }> = {
  APPROVAL_REQUESTED: { eventCode: 'approval.requested', titleKey: 'alm.notify.approvalRequested', params: ['requestNo', 'requester'] },
  APPROVAL_DECIDED: { eventCode: 'approval.decided', titleKey: 'alm.notify.approvalDecided', params: ['requestNo', 'approver', 'decision'] },
};

/** 메일 요청 → Portal 알림 작업. 대상 사용자·번역 대상 사건이 아니면 undefined. dedupeKey는 메일 알림 id라서 큐 재전달에도 한 번만 만들어진다 */
export function toPortalJob(tenantId: string, r: MailRequest, notificationId: string): PortalNotifyJob | undefined {
  const m = MAP[r.template];
  if (!m || !r.recipientId) return undefined;
  const params: Record<string, string> = {};
  for (const k of m.params) if (r.params[k] !== undefined) params[k] = String(r.params[k]).slice(0, 200);
  return { type: 'portal-notify', tenantId, userSub: r.recipientId, eventCode: m.eventCode, titleKey: m.titleKey, params,
    ...(r.subjectType === 'ASSET_REQUEST' && r.subjectId ? { linkUrl: `/requests/${r.subjectId}` } : {}), dedupeKey: `alm:${notificationId}` };
}

export class PortalNotifier {
  private token?: { value: string; until: number };
  constructor(private cfg: PortalNotifyConfig, private http: typeof fetch = fetch) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const r = await this.http(this.cfg.tokenUrl, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials', ...(this.cfg.scope ? { scope: this.cfg.scope } : {}) }) });
    if (!r.ok) throw new Error(`Portal 토큰 발급 실패(${r.status})`);
    const t = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, until: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  handlers(): Record<string, (job: Job) => Promise<void>> { return { 'portal-notify': (j) => this.send(j as PortalNotifyJob) }; }

  async send(j: PortalNotifyJob): Promise<void> {
    const r = await this.http(`${this.cfg.url.replace(/\/$/, '')}/v1/notifications`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.accessToken()}` },
      body: JSON.stringify({ tenantId: j.tenantId, userSub: j.userSub, appCode: 'alm', eventCode: j.eventCode, titleKey: j.titleKey, params: j.params,
        ...(j.linkUrl ? { linkUrl: j.linkUrl } : {}), dedupeKey: j.dedupeKey }) });
    if (r.status === 401) this.token = undefined;                       // 토큰 만료·폐기 → 다음 시도에서 새로 받는다
    if (r.ok) return;
    // 다시 보내도 같은 결과인 거절(사건 미선언·앱 미사용·사용자 없음·형식 오류)은 버린다. 그 밖(401·429·5xx)은 던져서 재시도한다
    if ([400, 403, 404, 422].includes(r.status)) { log.warn('portal notify dropped', { status: r.status, eventCode: j.eventCode }); return; }
    throw new Error(`Portal 알림 전송 실패(${r.status})`);
  }
}
