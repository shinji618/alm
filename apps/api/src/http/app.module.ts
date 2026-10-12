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
import { CONFIG, COGNITO, DB, PRINCIPALS, SAP_CONNS } from './tokens';

@Module({})
export class AppModule {
  static create(deps: { cfg: Config; db: Db; cognito: Cognito; principals?: PrincipalCache }): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MeController, AdminController, PdaController, SapController],
      providers: [
        { provide: CONFIG, useValue: deps.cfg },
        { provide: DB, useValue: deps.db },
        { provide: COGNITO, useValue: deps.cognito },
        { provide: PRINCIPALS, useValue: deps.principals ?? new PrincipalCache() },
        { provide: SAP_CONNS, useValue: new TtlCache() },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
