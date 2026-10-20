// 관리(openapi 관리 영역): 사용자·역할·직무 충돌·공통 코드·설정·회사(SAP 연계·승인 단계). 권한은 가드가 operationId로 확인(admin.user·admin.config)
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import { PrincipalCache } from '../auth/principal';
import { log } from '../common/log';
import * as users from '../admin/users';
import * as cfg from '../admin/config';
import * as companies from '../admin/companies';
import * as fin from '../admin/finmasters';
import * as cats from '../admin/categories';
import * as ranges from '../admin/numberRanges';
import * as dm from '../admin/deptmanagers';
import * as imp from '../admin/assetImport';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB, PRINCIPALS } from './tokens';

@Controller('admin')
export class AdminController {
  constructor(@Inject(DB) private db: Db, @Inject(PRINCIPALS) private cache: PrincipalCache) {}

  @Get('users')
  @Operation('listUsers')
  listUsers(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => users.listUsers(c, q));
  }

  @Post('users')
  @HttpCode(201)
  @Operation('createUser')
  createUser(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => users.createUser(c, p.tenantId, p.userId, body));
  }

  @Patch('users/:id')
  @Operation('patchUser')
  async patchUser(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    const r = await this.db.withTx(txOf(ctx), (c) => users.patchUser(c, id, ctx.principal!.userId, body));
    this.cache.clearUser(id);
    if (r.rolesCleared) log.warn('user email changed, roles cleared (H-10)', { userId: id, by: ctx.principal!.userId, correlationId: ctx.correlationId });
    return r.user;
  }

  @Put('users/:id/roles')
  @Operation('putUserRoles')
  async putUserRoles(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const p = ctx.principal!;
    const r = await this.db.withTx(txOf(ctx), (c) => users.putUserRoles(c, p.tenantId, id, p.userId, body));
    this.cache.clearUser(id);
    if (r.sod.length) res.setHeader('X-SoD-Warning', r.sod.map((h) => h.rule).join(', '));   // 09 5.2: 막지 않고 알림
    return r.user;
  }

  @Get('sod-conflicts')
  @Operation('listSodConflicts')
  listSodConflicts(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => users.listSodConflicts(c));
  }

  @Get('codes')
  @Operation('listCodes')
  listCodes(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => cfg.listCodes(c));
  }

  @Put('codes/:group')
  @Operation('putCodeGroup')
  putCodeGroup(@Ctx() ctx: AlmContext, @Param('group') group: string, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => cfg.putCodeGroup(c, p.tenantId, group, p.userId, body));
  }

  @Get('settings')
  @Operation('listSettings')
  listSettings(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => cfg.listSettings(c));
  }

  @Put('settings/:key')
  @Operation('putSetting')
  putSetting(@Ctx() ctx: AlmContext, @Param('key') key: string, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => cfg.putSetting(c, p.tenantId, key, p.userId, body));
  }

  @Get('companies')
  @Operation('listCompanies')
  listCompanies(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => companies.listCompanies(c));
  }

  @Post('companies')
  @HttpCode(201)
  @Operation('createCompany')
  createCompany(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => companies.createCompany(c, p.tenantId, p.userId, body));
  }

  @Patch('companies/:id')
  @Operation('patchCompany')
  patchCompany(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => companies.patchCompany(c, id, ctx.principal!.userId, body));
  }

  @Get('cost-centers')
  @Operation('listCostCenters')
  listCostCenters(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => fin.listCostCenters(c, q));
  }

  @Post('cost-centers')
  @HttpCode(201)
  @Operation('createCostCenter')
  createCostCenter(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => fin.createCostCenter(c, p.tenantId, p.userId, body));
  }

  @Patch('cost-centers/:id')
  @Operation('patchCostCenter')
  patchCostCenter(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => fin.patchCostCenter(c, id, ctx.principal!.userId, body));
  }

  @Get('asset-classes')
  @Operation('listAssetClasses')
  listAssetClasses(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => fin.listAssetClasses(c));
  }

  // 자산 카테고리(ADM-050): ALM에서 정의
  @Get('categories')
  @Operation('listCategories')
  listCategories(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => cats.listCategories(c, q));
  }

  @Post('categories')
  @HttpCode(201)
  @Operation('createCategory')
  createCategory(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => cats.createCategory(c, p.tenantId, p.userId, body));
  }

  @Patch('categories/:id')
  @Operation('patchCategory')
  patchCategory(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => cats.patchCategory(c, id, ctx.principal!.userId, body));
  }

  // ---- 자산태그 번호 범위(ADM-055) ----
  @Get('number-ranges')
  @Operation('listNumberRanges')
  listNumberRanges(@Ctx() ctx: AlmContext) {
    return this.db.withTx(txOf(ctx), (c) => ranges.listNumberRanges(c, ctx.principal!.tenantId));
  }

  @Post('number-ranges')
  @HttpCode(201)
  @Operation('createNumberRange')
  createNumberRange(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    const p = ctx.principal!;
    return this.db.withTx(txOf(ctx), (c) => ranges.createNumberRange(c, p.tenantId, p.userId, body));
  }

  @Patch('number-ranges/:id')
  @Operation('patchNumberRange')
  patchNumberRange(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown) {
    return this.db.withTx(txOf(ctx), (c) => ranges.patchNumberRange(c, id, ctx.principal!.userId, body));
  }

  @Delete('number-ranges/:id')
  @HttpCode(204)
  @Operation('deleteNumberRange')
  async deleteNumberRange(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    await this.db.withTx(txOf(ctx), (c) => ranges.deleteNumberRange(c, id));
  }

  // ---- 자산 일괄 업로드(ADM-060) ----
  @Get('asset-import/template')
  @Operation('getAssetImportTemplate')
  async importTemplate(@Ctx() ctx: AlmContext, @Query('withAssets') withAssets: string | undefined, @Res() res: Response) {
    const x = await this.db.withTx(txOf(ctx), (c) => imp.importTemplate(c, ctx.principal!, withAssets === 'true'));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${x.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(x.body);
  }

  @Post('asset-import\\:preview')
  @HttpCode(200)
  @Operation('previewAssetImport')
  previewImport(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => imp.previewImport(c, ctx.principal!, body)); }

  @Post('asset-import\\:apply')
  @HttpCode(200)
  @Operation('applyAssetImport')
  applyImport(@Ctx() ctx: AlmContext, @Body() body: unknown) { return this.db.withTx(txOf(ctx), (c) => imp.applyImport(c, ctx.principal!, body)); }

  @Delete('categories/:id')
  @HttpCode(204)
  @Operation('deleteCategory')
  async deleteCategory(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    await this.db.withTx(txOf(ctx), (c) => cats.deleteCategory(c, id));
  }

  // 코스트센터별 부서 관리자(ADM-040)
  @Get('dept-managers')
  @Operation('listDeptManagers')
  listDeptManagers(@Ctx() ctx: AlmContext, @Query() q: Record<string, string>) {
    return this.db.withTx(txOf(ctx), (c) => dm.listDeptManagers(c, q));
  }

  @Post('dept-managers')
  @HttpCode(201)
  @Operation('addDeptManager')
  async addDeptManager(@Ctx() ctx: AlmContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const p = ctx.principal!;
    const r = await this.db.withTx(txOf(ctx), (c) => dm.addDeptManager(c, p.tenantId, p.userId, body));
    this.cache.clearUser(r.userId);
    if (r.sod.length) res.setHeader('X-SoD-Warning', r.sod.map((h) => h.rule).join(', '));
    return r.manager;
  }

  @Patch('dept-managers/:id')
  @Operation('patchDeptManager')
  async patchDeptManager(@Ctx() ctx: AlmContext, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.db.withTx(txOf(ctx), (c) => dm.patchDeptManager(c, id, ctx.principal!.userId, body));
    this.cache.clearUser(r.userId);
    if (r.sod.length) res.setHeader('X-SoD-Warning', r.sod.map((h) => h.rule).join(', '));
    return r.manager;
  }

  @Delete('dept-managers/:id')
  @HttpCode(204)
  @Operation('removeDeptManager')
  async removeDeptManager(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    const userId = await this.db.withTx(txOf(ctx), (c) => dm.removeDeptManager(c, id, ctx.principal!.userId));
    this.cache.clearUser(userId);
  }
}
