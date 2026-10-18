// SAP 연계 화면(ALM-310) API. 권한 키는 가드가 operationId로 확인(sap.status·sap.monitor·sap.operate·sap.finance·sap.config). WBS 4.6
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import * as m from '../sap/monitor';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

@Controller('integration/sap')
export class SapWebController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('status')
  @Operation('getSapStatus')
  status(@Ctx() ctx: AlmContext) { return this.db.withTx(txOf(ctx), (c) => m.status(c)); }

  @Get('runs')
  @Operation('listSapRuns')
  runs(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => m.listRuns(c, q)); }

  @Get('runs/:id/messages')
  @Operation('listSapRunMessages')
  messages(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => m.runMessages(c, id, q)); }

  @Get('postings')
  @Operation('listPostings')
  postings(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => m.listPostings(c, q)); }

  @Get('postings/:id')
  @Operation('getPosting')
  posting(@Ctx() ctx: AlmContext, @Param('id') id: string) { return this.db.withTx(txOf(ctx), (c) => m.getPosting(c, id)); }

  @Post('postings/:id\\:retry')
  @HttpCode(200)
  @Operation('retryPosting')
  retry(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => m.retryPosting(c, ctx.principal!, id, body)); }

  @Post('postings/:id\\:cancel')
  @HttpCode(200)
  @Operation('cancelPosting')
  cancel(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => m.cancelPosting(c, ctx.principal!, id, body)); }

  @Get('run-requests')
  @Operation('listRunRequests')
  runRequests(@Ctx() ctx: AlmContext) { return this.db.withTx(txOf(ctx), (c) => m.listRunRequests(c)); }

  @Post('run-requests')
  @HttpCode(201)
  @Operation('createRunRequest')
  runRequest(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => m.createRunRequest(c, ctx.principal!, body)); }

  @Get('reconciliation/runs')
  @Operation('listReconRuns')
  reconRuns(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => m.listReconRuns(c, q)); }

  @Get('reconciliation/runs/:id/diffs')
  @Operation('listReconDiffs')
  reconDiffs(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query() q: Record<string, string>) { return this.db.withTx(txOf(ctx), (c) => m.listReconDiffs(c, id, q)); }

  @Post('reconciliation/diffs\\:resolve')
  @Operation('resolveReconDiffs')
  async resolve(@Ctx() ctx: AlmContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.db.withTx(txOf(ctx), (c) => m.resolveDiffs(c, ctx.principal!, body));
    res.status(r.status);
    return r.body;
  }

  @Get('field-mappings')
  @Operation('listFieldMappings')
  mappings(@Ctx() ctx: AlmContext) { return this.db.withTx(txOf(ctx), (c) => m.listFieldMappings(c)); }

  @Patch('field-mappings/:id')
  @Operation('patchFieldMapping')
  patchMapping(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => m.patchFieldMapping(c, ctx.principal!, id, body)); }

  @Get('connections')
  @Operation('listSapConnections')
  connections(@Ctx() ctx: AlmContext) { return this.db.withTx(txOf(ctx), (c) => m.listConnections(c)); }
}
