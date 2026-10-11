// 작업 큐 소비자(10 정의서 6.3). SQS 긴 폴링 → 유형별 처리기. 처리기가 없는 유형은 기록 후 지운다(큐가 쌓여 jobs-age 경보가 울리지 않게).
// 처리기 오류는 메시지를 지우지 않는다 → 가시성 시간 뒤 재시도, maxReceiveCount를 넘으면 DLQ
import { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand, Message } from '@aws-sdk/client-sqs';
import { log } from '../common/log';

export interface Job { type: string; source?: string; [k: string]: unknown }
export type Handler = (job: Job) => Promise<void>;

// 예약 작업(app-stack cronTz): 처리 로직은 각 업무 WBS에서 채운다
export const SCHEDULED_TYPES = ['expiry-alerts', 'sap-watch', 'idempotency-cleanup', 'discovery-cleanup', 'notification-cleanup'];

export function parseJob(body: string | undefined): Job | undefined {
  try {
    const j = JSON.parse(body ?? '');
    return j && typeof j.type === 'string' ? (j as Job) : undefined;
  } catch { return undefined; }
}

export class Worker {
  private stopping = false;
  constructor(private sqs: Pick<SQSClient, 'send'>, private queueUrl: string, private handlers: Record<string, Handler> = {}) {}

  stop() { this.stopping = true; }

  // 한 번 받아 처리. 처리한(지운) 메시지 수를 돌려준다
  async pollOnce(waitSeconds = 20): Promise<number> {
    const r = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
    const done: Message[] = [];
    for (const m of r.Messages ?? []) {
      const job = parseJob(m.Body);
      if (!job) { log.warn('job malformed, dropped', { messageId: m.MessageId }); done.push(m); continue; }
      const h = this.handlers[job.type];
      if (!h) {
        log.info('job has no handler yet, dropped', { type: job.type, source: job.source, messageId: m.MessageId, known: SCHEDULED_TYPES.includes(job.type) });
        done.push(m); continue;
      }
      const t0 = Date.now();
      try {
        await h(job);
        log.info('job done', { type: job.type, ms: Date.now() - t0, messageId: m.MessageId });
        done.push(m);
      } catch (e) {
        log.error('job failed', { type: job.type, messageId: m.MessageId, receiveCount: m.Attributes?.ApproximateReceiveCount, err: String(e) });
      }
    }
    if (done.length) {
      await this.sqs.send(new DeleteMessageBatchCommand({ QueueUrl: this.queueUrl,
        Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }));
    }
    return done.length;
  }

  async run(): Promise<void> {
    log.info('worker started', { queue: this.queueUrl.replace(/^.*\//, ''), handlers: Object.keys(this.handlers) });
    while (!this.stopping) {
      try { await this.pollOnce(); } catch (e) {
        log.error('poll failed', { err: String(e) });
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    log.info('worker stopped');
  }
}
