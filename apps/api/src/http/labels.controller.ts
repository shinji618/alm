// 라벨 출력(ALM-250, WBS 4.5). 서버는 프린터에 연결하지 않는다 — ZPL을 발급하고 브라우저(Zebra Browser Print)의 결과 회신을 받는다(결정 A-08)
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import * as lb from '../labels/labels';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

@Controller()
export class LabelsController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('label-templates')
  @Operation('listLabelTemplates')
  templates(@Ctx() ctx: AlmContext) { return this.db.withTx(txOf(ctx), (c) => lb.listTemplates(c, ctx.principal!)); }

  @Post('label-templates')
  @HttpCode(201)
  @Operation('createLabelTemplate')
  createTemplate(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => lb.createTemplate(c, ctx.principal!, body)); }

  @Patch('label-templates/:id')
  @Operation('patchLabelTemplate')
  patchTemplate(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => lb.patchTemplate(c, ctx.principal!, id, body));
  }

  @Get('printers')
  @Operation('listPrinters')
  printers(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => lb.listPrinters(c, q)); }

  @Post('printers')
  @HttpCode(201)
  @Operation('createPrinter')
  createPrinter(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => lb.createPrinter(c, ctx.principal!, body)); }

  @Patch('printers/:id')
  @Operation('patchPrinter')
  patchPrinter(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => lb.patchPrinter(c, ctx.principal!, id, body));
  }

  @Get('printers/:id/test-label')
  @Operation('getTestLabel')
  testLabel(@Ctx() ctx: AlmContext, @Param('id') id: string) { return this.db.withTx(txOf(ctx), (c) => lb.testLabel(c, ctx.principal!, id)); }

  @Get('label-jobs')
  @Operation('listLabelJobs')
  jobs(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => lb.listJobs(c, ctx.principal!, q)); }

  @Post('label-jobs')
  @HttpCode(201)
  @Operation('createLabelJobs')
  createJobs(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => lb.createJobs(c, ctx.principal!, body)); }

  @Post('label-jobs\\:render')
  @HttpCode(200)
  @Operation('renderLabelJobs')
  render(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => lb.renderJobs(c, ctx.principal!, body)); }

  @Post('label-jobs\\:report')
  @Operation('reportLabelJobs')
  async report(@Ctx() ctx: AlmContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.db.withTx(txOf(ctx), (c) => lb.reportJobs(c, ctx.principal!, body));
    res.status(r.results.some((x) => x.status === 'ERROR') ? 207 : 200);
    return r;
  }

  @Post('label-jobs\\:cancel')
  @HttpCode(200)
  @Operation('cancelLabelJobs')
  cancel(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => lb.cancelJobs(c, ctx.principal!, body)); }

  @Get('label-jobs/:id/zpl')
  @Operation('previewZpl')
  zpl(@Ctx() ctx: AlmContext, @Param('id') id: string) { return this.db.withTx(txOf(ctx), (c) => lb.previewZpl(c, ctx.principal!, id)); }
}
