// 자산(ALM-110~112) API. 권한 키는 가드가 operationId로, 데이터 범위는 assets/·auth/scope가 확인. WBS 4.2
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { Db } from '../db/pool';
import * as assets from '../assets/assets';
import { lookups } from '../assets/lookups';
import { addComponents, removeComponent } from '../assets/bundles';
import { checkIn, checkOut, repair } from '../assets/assign';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { CONFIG, DB, MAILER } from './tokens';
import type { Config } from '../config';
import type { Mailer } from '../notify/mail';
import { submittedMails } from '../requests/requests';
import { withMail } from './mail-tx';

@Controller()
export class AssetsController {
  constructor(@Inject(DB) private db: Db, @Inject(MAILER) private mailer: Mailer | null, @Inject(CONFIG) private cfg: Config) {}

  // 등록(SAP 등록 체크)·할당(코스트센터 변경)·수정이 만든 제출 상태 요청은 1단계 승인자에게 메일
  private withRequestMails<T extends { createdRequest?: Record<string, string>; createdRequests?: Record<string, string>[] }>(ctx: AlmContext, fn: (c: PoolClient) => Promise<T>) {
    return withMail(this.db, this.mailer, this.cfg, ctx, async (c, mails) => {
      const r = await fn(c);
      for (const q of [...(r.createdRequest ? [r.createdRequest] : []), ...(r.createdRequests ?? [])]) if (q.id) mails.push(...await submittedMails(c, q.id));
      return r;
    });
  }

  @Get('lookups')
  @Operation('getLookups')
  lookups(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    // 카테고리는 관리 화면에서 바로 바뀌고(추가·사용 안 함·삭제) 메뉴의 자산 수도 함께 오므로 캐시하지 않는다
    res.setHeader('Cache-Control', (q.types ?? '').split(',').includes('categories') ? 'no-store' : 'private, max-age=300');
    return this.db.withTx(txOf(ctx), (c) => lookups(c, ctx.principal!, q));
  }

  @Get('assets')
  @Operation('listAssets')
  list(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => assets.listAssets(c, ctx.principal!, q));
  }

  @Post('assets')
  @HttpCode(201)
  @Operation('createAsset')
  create(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    return this.withRequestMails(ctx, (c) => assets.createAsset(c, ctx.principal!, body));
  }

  @Get('assets/:id')
  @Operation('getAsset')
  async get(@Ctx() ctx: AlmContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const a = await this.db.withTx(txOf(ctx), (c) => assets.getAsset(c, ctx.principal!, id));
    res.setHeader('ETag', `"${a.version}"`);
    return a;
  }

  @Patch('assets/:id')
  @Operation('patchAsset')
  async patch(@Ctx() ctx: AlmContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
              @Res({ passthrough: true }) res: Response) {
    const r = await this.withRequestMails(ctx, (c) => assets.patchAsset(c, ctx.principal!, id, ifMatch, body));
    res.setHeader('ETag', `"${r.asset.version}"`);
    return r;
  }

  // Bundle 구성품(SAP에 없는 ALM 자산을 묶어 SAP에는 Bundle 1건)
  @Post('assets/:id/components')
  @HttpCode(200)
  @Operation('addBundleComponents')
  addComponents(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => addComponents(c, ctx.principal!, id, body));
  }

  @Delete('assets/:id/components/:componentId')
  @Operation('removeBundleComponent')
  removeComponent(@Ctx() ctx: AlmContext, @Param('id') id: string, @Param('componentId') componentId: string) {
    return this.db.withTx(txOf(ctx), (c) => removeComponent(c, ctx.principal!, id, componentId));
  }

  @Get('assets/:id/history')
  @Operation('listAssetHistory')
  history(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => assets.history(c, ctx.principal!, id, q));
  }

  @Get('assets/:id/values')
  @Operation('listAssetValues')
  values(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => assets.values(c, ctx.principal!, id));
  }

  @Get('assets/:id/assignments')
  @Operation('listAssetAssignments')
  assignments(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => assets.assignments(c, ctx.principal!, id));
  }

  @Get('assets/:id/attachments')
  @Operation('listAssetAttachments')
  attachments(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    return this.db.withTx(txOf(ctx), (c) => assets.attachments(c, ctx.principal!, id));
  }

  @Post('assets/:id\\:check-out')
  @HttpCode(200)
  @Operation('checkOutAsset')
  checkOut(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.withRequestMails(ctx, (c) => checkOut(c, ctx.principal!, id, body));
  }

  @Post('assets/:id\\:check-in')
  @HttpCode(200)
  @Operation('checkInAsset')
  checkIn(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => checkIn(c, ctx.principal!, id, body));
  }

  @Post('assets/:id\\:repair')
  @HttpCode(200)
  @Operation('moveRepair')
  repair(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => repair(c, ctx.principal!, id, body));
  }
}
