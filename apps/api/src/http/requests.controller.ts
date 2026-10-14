// 자산 요청·승인(ALM-230) API. 권한 키는 가드가 operationId로, 범위·승인 자격·직무 분리는 requests/가 확인. WBS 4.3
//   메일(승인 요청·결정)은 업무 트랜잭션 안에서 notification 행으로 남기고, 커밋 뒤 작업 큐로 보낸다
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { Db } from '../db/pool';
import type { Config } from '../config';
import type { Mailer, MailRequest } from '../notify/mail';
import { withMail } from './mail-tx';
import * as rq from '../requests/requests';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { CONFIG, DB, MAILER } from './tokens';

@Controller()
export class RequestsController {
  constructor(@Inject(DB) private db: Db, @Inject(MAILER) private mailer: Mailer | null, @Inject(CONFIG) private cfg: Config) {}

  private withMail<T>(ctx: AlmContext, fn: (c: PoolClient, mails: MailRequest[]) => Promise<T>): Promise<T> {
    return withMail(this.db, this.mailer, this.cfg, ctx, fn);
  }

  @Get('asset-requests')
  @Operation('listAssetRequests')
  list(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => rq.listRequests(c, ctx.principal!, q));
  }

  @Post('asset-requests')
  @HttpCode(201)
  @Operation('createAssetRequest')
  create(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    return this.withMail(ctx, (c, mails) => rq.createRequest(c, ctx.principal!, body, mails));
  }

  @Get('asset-requests/:id')
  @Operation('getAssetRequest')
  async get(@Ctx() ctx: AlmContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.db.withTx(txOf(ctx), (c) => rq.getRequest(c, ctx.principal!, id));
    res.setHeader('ETag', `"${r.version}"`);
    return r;
  }

  @Patch('asset-requests/:id')
  @Operation('patchAssetRequest')
  async patch(@Ctx() ctx: AlmContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
              @Res({ passthrough: true }) res: Response) {
    const r = await this.db.withTx(txOf(ctx), (c) => rq.patchRequest(c, ctx.principal!, id, ifMatch, body));
    res.setHeader('ETag', `"${r.version}"`);
    return r;
  }

  @Post('asset-requests/:id\\:submit')
  @HttpCode(200)
  @Operation('submitAssetRequest')
  submit(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.withMail(ctx, (c, mails) => rq.submitRequest(c, ctx.principal!, id, mails));
  }

  @Post('asset-requests/:id\\:fix')
  @HttpCode(200)
  @Operation('fixAssetRequest')
  async fix(@Ctx() ctx: AlmContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
            @Res({ passthrough: true }) res: Response) {
    const r = await this.withMail(ctx, (c, mails) => rq.fixRequest(c, ctx.principal!, id, ifMatch, body, mails));
    res.setHeader('ETag', `"${r.version}"`);
    return r;
  }

  @Post('asset-requests/:id\\:cancel')
  @HttpCode(200)
  @Operation('cancelAssetRequest')
  cancel(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => rq.cancelRequest(c, ctx.principal!, id));
  }

  @Get('approvals/inbox')
  @Operation('listApprovalInbox')
  inbox(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => rq.inbox(c, ctx.principal!, q));
  }

  @Post('approvals/:id\\:approve')
  @HttpCode(200)
  @Operation('approve')
  approve(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.withMail(ctx, (c, mails) => rq.approve(c, ctx.principal!, id, body, mails));
  }

  @Post('approvals/:id\\:reject')
  @HttpCode(200)
  @Operation('reject')
  reject(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.withMail(ctx, (c, mails) => rq.reject(c, ctx.principal!, id, body, mails));
  }
}
