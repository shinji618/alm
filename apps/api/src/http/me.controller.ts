// 앱 셸(openapi getMe). navCounts.requests = 내 승인함 건수(4.3). counts·sap은 해당 화면(4.4·4.6)이 생기면 채운다
import { Controller, Get, Inject } from '@nestjs/common';
import { toMe } from '../auth/login';
import { Db } from '../db/pool';
import { inboxCount } from '../requests/requests';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

@Controller('me')
export class MeController {
  constructor(@Inject(DB) private db: Db) {}

  @Get()
  @Operation('getMe')
  async getMe(@Ctx() ctx: AlmContext) {
    const requests = await this.db.withTx(txOf(ctx), (c) => inboxCount(c, ctx.principal!));
    return toMe(ctx.principal!, { requests, counts: 0, sap: 0 });
  }
}
