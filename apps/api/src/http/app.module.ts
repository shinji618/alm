import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Config } from '../config';
import { Db } from '../db/pool';
import { Cognito } from '../auth/cognito';
import { PrincipalCache } from '../auth/principal';
import { AuthGuard } from './auth.guard';
import { ProblemFilter } from './problem.filter';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { HealthController } from './health.controller';
import { AdminController } from './admin.controller';
import { PdaController } from './pda.controller';
import { SapController } from './sap.controller';
import { TtlCache } from '../common/cache';
import { CONFIG, COGNITO, DB, FILES, LIMITER, MAILER, PRINCIPALS, SAP_CONNS } from './tokens';
import type { Mailer } from '../notify/mail';
import { MemoryCounterStore, SharedLimiter } from '../common/shared';
import { FilesController } from './files.controller';
import { AssetsController } from './assets.controller';
import { RequestsController } from './requests.controller';
import { SapWebController } from './sap-web.controller';
import { CountsController } from './counts.controller';
import type { FileStore } from '../files/files';

@Module({})
export class AppModule {
  static create(deps: { cfg: Config; db: Db; cognito: Cognito; principals?: PrincipalCache; limiter?: SharedLimiter; files?: FileStore; mailer?: Mailer }): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MeController, AdminController, PdaController, SapController, FilesController, AssetsController, RequestsController, SapWebController, CountsController],
      providers: [
        { provide: CONFIG, useValue: deps.cfg },
        { provide: DB, useValue: deps.db },
        { provide: COGNITO, useValue: deps.cognito },
        { provide: PRINCIPALS, useValue: deps.principals ?? new PrincipalCache() },
        { provide: SAP_CONNS, useValue: new TtlCache() },
        { provide: LIMITER, useValue: deps.limiter ?? new SharedLimiter(new MemoryCounterStore()) },
        { provide: FILES, useValue: deps.files ?? null },
        { provide: MAILER, useValue: deps.mailer ?? null },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
