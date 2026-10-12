// 메일 알림(10 정의서 8.2). 흐름:
//   업무 트랜잭션 안에서 queueEmail() → notification(EMAIL, QUEUED) 행 + 보낼 내용 → 커밋 뒤 Mailer.enqueue()로 SQS 작업
//   worker 'send-email' → SES 발송(구성 세트 alm-<env>, 태그 tenant·notification) → SENT / FAILED
//   SES 반송·수신 거부·거절 → SNS → SQS alm-<env>-ses-events → worker가 해당 알림을 FAILED로. 같은 주소로 다시 보내지 않는 것은
//   구성 세트의 억제 목록(반송·수신 거부)이 맡는다.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Db } from '../db/pool';
import { log } from '../common/log';
import { EMAIL } from '../common/validate';
import type { Job } from '../worker/worker';
import { Params, render } from './templates';

export interface MailRequest {
  recipientId?: string;          // app_user.id(이메일·언어를 여기서 찾는다) 또는
  email?: string; locale?: string;
  template: string; params: Params;
  subjectType?: string; subjectId?: string;
  dedupeKey?: string;            // 같은 키는 한 번만(예: CONTRACT_EXPIRY_90:<계약 id>)
}
export interface SendEmailJob extends Job { type: 'send-email'; tenantId: string; notificationId: string; to: string; subject: string; html: string; text: string }

const mask = (e: string) => e.replace(/^(.).*@/, '$1***@');

// 트랜잭션 안에서 호출(app.tenant_id 설정됨). 보낼 대상이 없거나 이미 보낸 키면 undefined
export async function queueEmail(c: PoolClient, tenantId: string, r: MailRequest, appOrigin: string): Promise<SendEmailJob | undefined> {
  let to = r.email, locale = r.locale;
  if (r.recipientId) {
    const u = (await c.query('SELECT email, locale, is_active FROM app_user WHERE id = $1', [r.recipientId])).rows[0];
    if (!u?.is_active) return undefined;
    to = u.email; locale ??= u.locale;
  }
  if (!to || !EMAIL.test(to)) return undefined;
  const m = render(r.template, locale ?? 'ko', r.params, appOrigin);
  const id = randomUUID();
  const ins = await c.query(
    `INSERT INTO notification (id, tenant_id, channel, recipient_id, recipient_email, template, subject_type, subject_id, title, status, dedupe_key)
     VALUES ($1, $2, 'EMAIL', $3, $4, $5, $6, $7, $8, 'QUEUED', $9)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
    [id, tenantId, r.recipientId ?? null, to, r.template, r.subjectType ?? null, r.subjectId ?? null, m.subject.slice(0, 200), r.dedupeKey ?? null]);
  if (!ins.rowCount) return undefined;
  return { type: 'send-email', tenantId, notificationId: id, to, ...m };
}

// api·worker 쪽: 커밋 뒤 작업 큐로 보낸다
export class Mailer {
  constructor(private sqs: Pick<SQSClient, 'send'>, private queueUrl: string) {}
  async enqueue(job: SendEmailJob | undefined) {
    if (!job) return;
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }));
  }
}

// 다시 보내도 결과가 같지 않은 오류(주소·도메인·계정 문제)는 재시도하지 않는다
const PERMANENT = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException',
  'BadRequestException', 'NotFoundException']);

export class MailSender {
  constructor(private ses: Pick<SESv2Client, 'send'>, private db: Db | undefined, private o: { from: string; configSet?: string; env: string; appOrigin: string }) {}

  handlers(): Record<string, (job: Job) => Promise<void>> {
    return {
      'send-email': (j) => this.send(j as SendEmailJob),
      // 운영 확인용(DB 없이 시험 메일). ops-check.sh mail-test가 큐에 넣는다. DEV·QA는 SES 샌드박스라 등록된 주소로만 간다
      'mail-test': async (j) => {
        const to = String(j.to ?? '');
        if (!EMAIL.test(to)) { log.warn('mail-test: bad address'); return; }
        const m = render('TEST', String(j.locale ?? 'ko'), { env: this.o.env }, this.o.appOrigin);
        const id = await this.deliver(to, m, [{ Name: 'kind', Value: 'test' }]);
        log.info('mail-test sent', { to: mask(to), messageId: id });
      },
    };
  }

  private async deliver(to: string, m: { subject: string; html: string; text: string }, tags: { Name: string; Value: string }[]) {
    const r = await this.ses.send(new SendEmailCommand({
      FromEmailAddress: this.o.from, Destination: { ToAddresses: [to] }, ConfigurationSetName: this.o.configSet,
      Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Html: { Data: m.html, Charset: 'UTF-8' }, Text: { Data: m.text, Charset: 'UTF-8' } } } },
      EmailTags: [{ Name: 'env', Value: this.o.env }, ...tags],
    }));
    return r.MessageId;
  }

  private async send(j: SendEmailJob) {
    if (!this.db) throw new Error('DB 없음');
    const ctx = { tenantId: j.tenantId, actorType: 'SYSTEM' as const };
    const st = await this.db.withTx(ctx, async (c) => (await c.query('SELECT status FROM notification WHERE id = $1', [j.notificationId])).rows[0]?.status);
    if (st !== 'QUEUED') { log.info('send-email skipped', { notificationId: j.notificationId, status: st ?? 'missing' }); return; }   // 재전달·중복 메시지
    try {
      const messageId = await this.deliver(j.to, j, [{ Name: 'tenant', Value: j.tenantId }, { Name: 'notification', Value: j.notificationId }]);
      await this.db.withTx(ctx, (c) => c.query(`UPDATE notification SET status = 'SENT', sent_at = now(), error_message = NULL, updated_at = now(),
        version = version + 1 WHERE id = $1 AND status = 'QUEUED'`, [j.notificationId]));
      log.info('mail sent', { notificationId: j.notificationId, to: mask(j.to), messageId });
    } catch (e) {
      const name = (e as Error).name;
      if (!PERMANENT.has(name)) throw e;                     // 제한·일시 오류 → 메시지를 남겨 재시도(5회 뒤 DLQ)
      await this.fail(j.tenantId, j.notificationId, `${name}: ${(e as Error).message}`);
      log.warn('mail rejected', { notificationId: j.notificationId, to: mask(j.to), err: name });
    }
  }

  private fail(tenantId: string, id: string, msg: string) {
    return this.db!.withTx({ tenantId, actorType: 'SYSTEM' }, (c) => c.query(
      `UPDATE notification SET status = 'FAILED', error_message = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [id, msg.slice(0, 500)]));
  }

  // SES 이벤트(SNS 원문 전달): { eventType: 'Bounce'|'Complaint'|'Reject', mail: { tags: { tenant: [..], notification: [..] } }, bounce: {...} }
  async onEvent(j: Job) {
    const e = j.event as { eventType?: string; mail?: { tags?: Record<string, string[]>; destination?: string[] };
      bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: { diagnosticCode?: string }[] }; complaint?: { complaintFeedbackType?: string }; reject?: { reason?: string } };
    const type = e?.eventType ?? 'Unknown';
    const tenant = e?.mail?.tags?.tenant?.[0], id = e?.mail?.tags?.notification?.[0];
    const why = type === 'Bounce' ? `${e.bounce?.bounceType}/${e.bounce?.bounceSubType} ${e.bounce?.bouncedRecipients?.[0]?.diagnosticCode ?? ''}`
      : type === 'Complaint' ? `complaint ${e.complaint?.complaintFeedbackType ?? ''}` : type === 'Reject' ? `reject ${e.reject?.reason ?? ''}` : type;
    log.warn('ses event', { type, notificationId: id, to: (e?.mail?.destination ?? []).map(mask), why: why.trim().slice(0, 200) });
    // 일시 반송(Transient)은 SES가 다시 시도하므로 상태를 바꾸지 않는다
    if (!tenant || !id || !this.db || (type === 'Bounce' && e.bounce?.bounceType === 'Transient')) return;
    if (!/^[0-9a-f-]{36}$/i.test(tenant) || !/^[0-9a-f-]{36}$/i.test(id)) return;
    await this.fail(tenant, id, `${type}: ${why}`.trim());
  }
}

// ses-events 큐의 메시지 본문은 SES 이벤트 JSON 그대로(rawMessageDelivery)
export function parseSesEvent(body: string | undefined): Job | undefined {
  try {
    const e = JSON.parse(body ?? '');
    return e && typeof e.eventType === 'string' ? { type: 'ses-event', event: e } : undefined;
  } catch { return undefined; }
}
