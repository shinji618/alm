// PAS Portal 연동 API(계약 v1, 읽기 전용). 인증·사용자 확인은 가드의 PORTAL 채널이 한다(클라이언트 ID·범위·tenantId+userSub).
// 승인·반려는 여기서 하지 않는다 — Portal은 deepLink로 ALM 화면을 연다(07 §11).
import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { E } from '../common/errors';
import { Db } from '../db/pool';
import type { Config } from '../config';
import * as rq from '../requests/requests';
import { calendarFeed, parseRange } from '../portal/calendar';
import { buildManifest, MENU_KEY_REQUESTS, parseLimit, toPortalItem } from '../portal/feed';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { CONFIG, DB } from './tokens';

@Controller()
export class PortalController {
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config) {}

  @Get('portal/manifest')
  @Operation('portalGetManifest')
  manifest() { return buildManifest(this.cfg); }

  @Get('portal/inbox')
  @Operation('portalGetInbox')
  async inbox(@Ctx() ctx: AlmContext, @Query('limit') limit?: string) {
    const r = await this.db.withTx(txOf(ctx), (c) => rq.inbox(c, ctx.principal!, { pageSize: String(parseLimit(limit)) }));
    return { items: (r.items as unknown as Parameters<typeof toPortalItem>[0][]).map((x) => toPortalItem(x)), total: r.total, asOf: new Date().toISOString() };
  }

  @Get('portal/calendar-feed')
  @Operation('portalGetCalendarFeed')
  async calendar(@Ctx() ctx: AlmContext, @Query('from') from?: string, @Query('to') to?: string) {
    const range = parseRange(from, to);
    const r = await this.db.withTx(txOf(ctx), (c) => calendarFeed(c, ctx.principal!, range));
    return { ...r, asOf: new Date().toISOString() };
  }

  @Get('portal/badges')
  @Operation('portalGetBadges')
  async badges(@Ctx() ctx: AlmContext) {
    return { badges: { [MENU_KEY_REQUESTS]: await this.db.withTx(txOf(ctx), (c) => rq.inboxCount(c, ctx.principal!)) } };
  }

  // 수명주기 훅(09 §9): 매니페스트에 선언만 하고 R1은 501. Portal은 "미지원"으로 기록해 수동 작업 목록에 올린다
  @Post('portal/tenant-export') @HttpCode(501) @Operation('portalTenantExport')
  tenantExport(): never { throw E.notImplemented('테넌트 내보내기는 아직 지원하지 않습니다'); }

  @Post('portal/tenant-import') @HttpCode(501) @Operation('portalTenantImport')
  tenantImport(): never { throw E.notImplemented('테넌트 가져오기는 아직 지원하지 않습니다'); }

  @Post('portal/erase') @HttpCode(501) @Operation('portalErase')
  erase(): never { throw E.notImplemented('개인정보 익명화는 아직 지원하지 않습니다'); }

  @Get('portal/jobs/:id') @Operation('portalGetJob')
  job(): never { throw E.notImplemented('수명주기 작업은 아직 지원하지 않습니다'); }
}
