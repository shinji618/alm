// 실사 캠페인(ALM-240) 웹 API. 권한 키는 가드가 operationId로 확인(count.read·count.manage·count.post). WBS 4.4
//   차이 처리에서 만든 요청(CHANGE·RETIRE)의 승인 메일은 업무 트랜잭션 안에서 쌓고 커밋 뒤 보낸다
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import type { Config } from '../config';
import type { Mailer } from '../notify/mail';
import { withMail } from './mail-tx';
import * as cp from '../counts/campaigns';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { CONFIG, DB, MAILER } from './tokens';

const etag = <T extends { version?: unknown }>(res: Response, r: T) => { if (r.version !== undefined) res.setHeader('ETag', `"${r.version}"`); return r; };

@Controller()
export class CountsController {
  constructor(@Inject(DB) private db: Db, @Inject(MAILER) private mailer: Mailer | null, @Inject(CONFIG) private cfg: Config) {}

  @Get('count-campaigns')
  @Operation('listCampaigns')
  list(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => cp.listCampaigns(c, q));
  }

  @Post('count-campaigns')
  @HttpCode(201)
  @Operation('createCampaign')
  async create(@Ctx() ctx: AlmContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return etag(res, await this.db.withTx(txOf(ctx), (c) => cp.createCampaign(c, ctx.principal!, body)));
  }

  @Get('count-campaigns/:id')
  @Operation('getCampaign')
  async get(@Ctx() ctx: AlmContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return etag(res, await this.db.withTx(txOf(ctx), (c) => cp.getCampaign(c, id)));
  }

  @Patch('count-campaigns/:id')
  @Operation('patchCampaign')
  async patch(@Ctx() ctx: AlmContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
              @Res({ passthrough: true }) res: Response) {
    return etag(res, await this.db.withTx(txOf(ctx), (c) => cp.patchCampaign(c, ctx.principal!, id, ifMatch, body)));
  }

  @Post('count-campaigns/:id\\:preview-scope')
  @HttpCode(200)
  @Operation('previewScope')
  preview(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.previewScope(c, id));
  }

  @Post('count-campaigns/:id\\:start')
  @HttpCode(200)
  @Operation('startCampaign')
  start(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.startCampaign(c, ctx.principal!, id));
  }

  @Post('count-campaigns/:id\\:cancel')
  @HttpCode(200)
  @Operation('cancelCampaign')
  cancel(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.cancelCampaign(c, ctx.principal!, id));
  }

  @Get('count-campaigns/:id/tasks')
  @Operation('listCampaignTasks')
  tasks(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.listCampaignTasks(c, ctx.principal!, id));
  }

  @Patch('count-tasks/:id')
  @Operation('assignCountTask')
  assign(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => cp.assignCountTask(c, ctx.principal!, id, body));
  }

  @Get('count-campaigns/:id/items')
  @Operation('listCountItems')
  items(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => cp.listCountItems(c, id, q));
  }

  @Post('count-campaigns/:id\\:close-counting')
  @HttpCode(200)
  @Operation('closeCounting')
  closeCounting(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.closeCounting(c, ctx.principal!, id));
  }

  @Post('count-items\\:resolve')
  @Operation('resolveVariances')
  async resolve(@Ctx() ctx: AlmContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await withMail(this.db, this.mailer, this.cfg, ctx, (c, mails) => cp.resolveVariances(c, ctx.principal!, body, mails));
    res.status(r.results.some((x) => x.status === 'ERROR') ? 207 : 200);
    return r;
  }

  @Get('count-campaigns/:id/unregistered')
  @Operation('listUnregistered')
  unregistered(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => cp.listUnregistered(c, id, q));
  }

  @Get('count-unregistered/:id/attachments')
  @Operation('listUnregisteredAttachments')
  unregisteredAttachments(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.listUnregisteredAttachments(c, id));
  }

  @Post('count-unregistered/:id\\:resolve')
  @HttpCode(200)
  @Operation('resolveUnregistered')
  resolveUnregistered(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => cp.resolveUnregistered(c, ctx.principal!, id, body));
  }

  @Post('count-campaigns/:id\\:post-results')
  @HttpCode(202)
  @Operation('postCountResults')
  post(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.postCountResults(c, ctx.principal!, id));
  }

  @Post('count-campaigns/:id\\:close')
  @HttpCode(200)
  @Operation('closeCampaign')
  close(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => cp.closeCampaign(c, ctx.principal!, id));
  }
}
