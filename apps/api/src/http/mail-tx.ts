// 업무 트랜잭션 + 메일: 메일은 같은 트랜잭션에서 notification 행으로 남기고(롤백되면 함께 사라짐), 커밋 뒤 작업 큐로 보낸다
import type { PoolClient } from 'pg';
import type { Db } from '../db/pool';
import type { Config } from '../config';
import { log } from '../common/log';
import { Mailer, MailRequest, queueEmail, SendEmailJob } from '../notify/mail';
import { toPortalJob } from '../notify/portal';
import type { Job } from '../worker/worker';
import { AlmContext, txOf } from './context';

export async function withMail<T>(db: Db, mailer: Mailer | null, cfg: Config, ctx: AlmContext,
  fn: (c: PoolClient, mails: MailRequest[]) => Promise<T>): Promise<T> {
  const jobs: Job[] = [];
  const out = await db.withTx(txOf(ctx), async (c) => {
    const mails: MailRequest[] = [];
    const r = await fn(c, mails);
    for (const m of mails) { const j = await queueEmail(c, ctx.principal!.tenantId, m, cfg.appOrigin); if (!j) continue; jobs.push(j); const pj = cfg.portalNotify ? toPortalJob(ctx.principal!.tenantId, m, (j as SendEmailJob).notificationId) : undefined; if (pj) jobs.push(pj); }
    return r;
  });
  for (const j of jobs) {
    await mailer?.enqueue(j).catch((e) => log.error('mail enqueue failed', { type: j.type, err: String(e) }));
  }
  return out;
}
