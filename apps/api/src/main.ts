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

export async function createApi(deps: Parameters<typeof AppModule.create>[0]) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.create(deps), { logger: ['error', 'warn'], bodyParser: true });
  app.disable('x-powered-by');
  app.set('trust proxy', 2);           // CloudFront → ALB
  app.setGlobalPrefix('api/v1');
  app.use(contextMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();
  return app;
}

async function main(role: string) {
  const cfg = loadConfig(role);
  switch (role) {
    case 'api': {
      const db = new Db(createPool(cfg));
      const app = await createApi({ cfg, db, cognito: new Cognito(cfg) });
      await app.listen(cfg.port, '0.0.0.0');
      log.info('api listening', { port: cfg.port, env: cfg.env });
      return;
    }
    case 'worker': {
      if (!cfg.jobsQueueUrl) throw new Error('JOBS_QUEUE_URL이 없다');
      const w = new Worker(new SQSClient({ region: cfg.region }), cfg.jobsQueueUrl);
      for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => w.stop());
      await w.run();
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
    case 'audit-archive':
    case 'partman':
      // 월 파티션·10년 보관(WBS 2.8 설계)은 3.4 2차에서 구현. 예약 작업이 실패로 보이지 않게 정상 종료
      log.info('not implemented yet', { role });
      return;
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
