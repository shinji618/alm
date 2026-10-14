// 앱 셸(openapi getMe). navCounts.requests = 내 승인함 건수(4.3). features.sap = SAP 연계를 쓰는 회사가 있음. counts·sap은 해당 화면(4.4·4.6)이 생기면 채운다
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
    const { requests, sap } = await this.db.withTx(txOf(ctx), async (c) => ({
      requests: await inboxCount(c, ctx.principal!),
      // SAP 연계를 쓰는 회사가 하나도 없으면 화면이 SAP 메뉴·필드를 숨긴다
      sap: !!(await c.query('SELECT 1 FROM company WHERE is_active AND sap_enabled LIMIT 1')).rowCount,
    }));
    return { ...toMe(ctx.principal!, { requests, counts: 0, sap: 0 }), features: { sap } };
  }
}
