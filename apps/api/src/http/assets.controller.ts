// 자산(ALM-110~112) API. 권한 키는 가드가 operationId로, 데이터 범위는 assets/·auth/scope가 확인. WBS 4.2
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import * as assets from '../assets/assets';
import { lookups } from '../assets/lookups';
import { checkIn, checkOut, repair } from '../assets/assign';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

@Controller()
export class AssetsController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('lookups')
  @Operation('getLookups')
  lookups(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'private, max-age=300');
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
    return this.db.withTx(txOf(ctx), (c) => assets.createAsset(c, ctx.principal!, body));
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
    const r = await this.db.withTx(txOf(ctx), (c) => assets.patchAsset(c, ctx.principal!, id, ifMatch, body));
    res.setHeader('ETag', `"${r.asset.version}"`);
    return r;
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
    return this.db.withTx(txOf(ctx), (c) => checkOut(c, ctx.principal!, id, body));
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
