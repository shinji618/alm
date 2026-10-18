// 재산세(사업용 동산) 신고 자료·과거 기록(ALM-260). 권한 tax.read(조회)·tax.manage(관할·계수표·신고 처리)
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import * as tx from '../tax/tax';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

@Controller('tax')
export class TaxController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('reference')
  @Operation('getTaxReference')
  reference() { return tx.reference(); }

  @Get('jurisdictions')
  @Operation('listTaxJurisdictions')
  jurisdictions(@Ctx() ctx: AlmContext) { return this.db.withTx(txOf(ctx), (c) => tx.listJurisdictions(c)); }

  @Post('jurisdictions')
  @HttpCode(201)
  @Operation('createTaxJurisdiction')
  createJurisdiction(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.createJurisdiction(c, ctx.principal!, body)); }

  @Patch('jurisdictions/:id')
  @Operation('patchTaxJurisdiction')
  patchJurisdiction(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => tx.patchJurisdiction(c, ctx.principal!, id, body));
  }

  @Put('jurisdictions/:id/sites')
  @Operation('setTaxJurisdictionSites')
  setSites(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => tx.setJurisdictionSites(c, ctx.principal!, id, body));
  }

  @Get('factors')
  @Operation('listTaxFactors')
  factors(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => tx.listFactors(c, q)); }

  @Put('factors')
  @Operation('replaceTaxFactors')
  replaceFactors(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.replaceFactors(c, ctx.principal!, body)); }

  @Post('factors\\:load-reference')
  @HttpCode(200)
  @Operation('loadTaxReferenceFactors')
  loadReference(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.loadReference(c, ctx.principal!, body)); }

  @Get('class-map')
  @Operation('listTaxClassMap')
  classMap(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => tx.listClassMap(c, q)); }

  @Put('class-map')
  @Operation('replaceTaxClassMap')
  replaceClassMap(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.replaceClassMap(c, ctx.principal!, body)); }

  @Get('filings')
  @Operation('listTaxFilings')
  filings(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => tx.listFilings(c, q)); }

  @Post('filings')
  @HttpCode(201)
  @Operation('createTaxFiling')
  create(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.createFiling(c, ctx.principal!, body)); }

  @Get('filings/:id')
  @Operation('getTaxFiling')
  get(@Ctx() ctx: AlmContext, @Param('id') id: string) { return this.db.withTx(txOf(ctx), (c) => tx.getFiling(c, id)); }

  @Get('filings/:id/lines')
  @Operation('listTaxFilingLines')
  lines(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => tx.listFilingLines(c, id, q)); }

  @Patch('filings/:id')
  @Operation('patchTaxFiling')
  patch(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.patchFiling(c, ctx.principal!, id, body)); }

  @Delete('filings/:id')
  @HttpCode(204)
  @Operation('deleteTaxFiling')
  async remove(@Ctx() ctx: AlmContext, @Param('id') id: string) { await this.db.withTx(txOf(ctx), (c) => tx.deleteFiling(c, id)); }

  @Post('filings/:id\\:regenerate')
  @HttpCode(200)
  @Operation('regenerateTaxFiling')
  regenerate(@Ctx() ctx: AlmContext, @Param('id') id: string) { return this.db.withTx(txOf(ctx), (c) => tx.regenerateFiling(c, ctx.principal!, id)); }

  @Post('filings/:id\\:file')
  @HttpCode(200)
  @Operation('fileTaxFiling')
  file(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => tx.fileFiling(c, ctx.principal!, id, body)); }

  @Post('filings/:id\\:reopen')
  @HttpCode(200)
  @Operation('reopenTaxFiling')
  reopen(@Ctx() ctx: AlmContext, @Param('id') id: string) { return this.db.withTx(txOf(ctx), (c) => tx.reopenFiling(c, ctx.principal!, id)); }

  // 엑셀 신고 자료(요약·취득연도별·자산 목록·원가 모름·신규·처분)
  @Get('filings/:id/export')
  @Operation('exportTaxFiling')
  async export(@Ctx() ctx: AlmContext, @Param('id') id: string, @Res() res: Response) {
    const x = await this.db.withTx(txOf(ctx), (c) => tx.exportFiling(c, id));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${x.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(x.body);
  }
}
