// 대시보드(ALM-010, WBS 4.1). 위젯 전체를 한 번에. 5분 캐시, refresh=true면 다시 계산
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Db } from '../db/pool';
import { getDashboard } from '../dashboard/dashboard';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

@Controller()
export class DashboardController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('dashboard')
  @Operation('getDashboard')
  dashboard(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => getDashboard(c, ctx.principal!, q)); }
}
