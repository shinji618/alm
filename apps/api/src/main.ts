// 이미지 1개, 역할별 진입점(10 정의서 6장): node dist/main <api|worker|migrate|seed|audit-archive|partman>
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from './config';
import { log } from './common/log';
import { createPool, Db } from './db/pool';
import { Cognito } from './auth/cognito';
import { AppModule } from './http/app.module';
import { contextMiddleware } from './http/context';
import { runMigrate, ownerClient } from './ops/migrate';
import { parseSeed, seed } from './ops/seed';
import { Worker } from './worker/worker';
import { maintainPartitions, archiveAll, s3Store } from './ops/archive';
import { connectCounterStore, MemoryCounterStore, SharedLimiter } from './common/shared';
import { s3FileStore } from './files/files';
import { MailSender, parseSesEvent } from './notify/mail';

export async function createApi(deps: Parameters<typeof AppModule.create>[0]) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.create(deps), { logger: ['error', 'warn'], bodyParser: true });
  app.disable('x-powered-by');
  app.set('trust proxy', 2);           // CloudFront → ALB
  app.setGlobalPrefix('api/v1');
  app.use(contextMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '10kb' });   // /oauth/token(SAP, x-www-form-urlencoded)
  app.enableShutdownHooks();
  return app;
}

async function main(role: string) {
  const cfg = loadConfig(role);
  switch (role) {
    case 'api': {
      const db = new Db(createPool(cfg));
      const limiter = new SharedLimiter(cfg.cache ? await connectCounterStore(cfg.cache, cfg.region) : new MemoryCounterStore());
      const files = cfg.filesBucket ? await s3FileStore(cfg.filesBucket, cfg.region) : undefined;
      const app = await createApi({ cfg, db, cognito: new Cognito(cfg), limiter, files });
      await app.listen(cfg.port, '0.0.0.0');
      log.info('api listening', { port: cfg.port, env: cfg.env });
      return;
    }
    case 'worker': {
      if (!cfg.jobsQueueUrl) throw new Error('JOBS_QUEUE_URL이 없다');
      const sqs = new SQSClient({ region: cfg.region });
      const db = new Db(createPool(cfg, { max: 5 }));
      const { SESv2Client } = await import('@aws-sdk/client-sesv2');
      const mail = cfg.mail ? new MailSender(new SESv2Client({ region: cfg.region }), db, { ...cfg.mail, env: cfg.env, appOrigin: cfg.appOrigin }) : undefined;
      const workers = [new Worker(sqs, cfg.jobsQueueUrl, { ...mail?.handlers() })];
      // SES 반송·수신 거부 이벤트 큐(같은 작업이 함께 읽는다)
      if (mail && cfg.mail?.eventsQueueUrl) workers.push(new Worker(sqs, cfg.mail.eventsQueueUrl, { 'ses-event': (j) => mail.onEvent(j) }, parseSesEvent));
      for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => workers.forEach((w) => w.stop()));
      await Promise.all(workers.map((w) => w.run()));
      await db.close();
      return;
    }
    case 'migrate':
      await runMigrate(cfg);
      return;
    case 'seed': {
      const input = parseSeed(process.argv[3] ?? process.env.SEED_JSON);
      const c = await ownerClient(cfg);
      try { await seed(c, input); } finally { await c.end(); }
      return;
    }
    case 'partman':
    case 'audit-archive': {
      // 보관 계정(alm_archive_login, IAM 토큰)으로 접속. 감사 기록 파티션만 다룬다(09 8.3)
      const pool = createPool(cfg, { max: 1 });
      const c = await pool.connect();
      try {
        if (role === 'partman') await maintainPartitions(c);
        else {
          if (!cfg.auditBucket) throw new Error('AUDIT_BUCKET이 없다');
          await maintainPartitions(c);     // 보관 전에 이번 달 이후 파티션도 확인
          await archiveAll(c, await s3Store(cfg.auditBucket, cfg.region), cfg.env, { dryRun: process.argv[3] === '--dry-run' });
        }
      } finally { c.release(); await pool.end(); }
      return;
    }
    default:
      throw new Error(`알 수 없는 역할: ${role}`);
  }
}

if (require.main === module) {
  const role = process.argv[2] || process.env.APP_ROLE || 'api';
  main(role).then(
    () => { if (role !== 'api') process.exit(0); },
    (e) => { log.error('fatal', { role, err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); process.exit(1); },
  );
}
