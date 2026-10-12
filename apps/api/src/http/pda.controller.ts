// PDA 공통(openapi PDA-01 pdaGetMe·pdaRegisterDevice, 09 6.5). 업무 API(실사)는 5.x에서 추가
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Db } from '../db/pool';
import { securityEvent } from '../auth/login';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { DB } from './tokens';

const meta = (ctx: AlmContext) => ({ clientId: ctx.claims?.client_id, ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId });

@Controller('pda')
export class PdaController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('me')
  @Operation('pdaGetMe')
  async me(@Ctx() ctx: AlmContext) {
    const p = ctx.principal!;
    const settings = await this.db.withTx(txOf(ctx), async (c) => {
      // 앱 시작(로그인) 기록: 09 7장 LOGIN은 PDA /pda/me 호출 때
      if (!ctx.loginRecorded) {
        await c.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [p.userId]);
        await securityEvent(c, { tenantId: p.tenantId, type: 'LOGIN', actorId: p.userId, actorType: 'PDA', channel: 'PDA',
          meta: meta(ctx), target: ctx.device?.serial });
      }
      const rows = (await c.query(`SELECT key, value FROM setting WHERE key IN ('pda.min_app_version', 'pda.offline_hours')`)).rows;
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    });
    return {
      userId: p.userId, displayName: p.displayName, email: p.email, locale: p.locale, roles: p.effectiveRoles, tenantCode: p.tenantCode,
      serverTime: new Date().toISOString(),
      minAppVersion: typeof settings['pda.min_app_version'] === 'string' ? settings['pda.min_app_version'] : '1.0.0',
      offlineHours: typeof settings['pda.offline_hours'] === 'number' ? settings['pda.offline_hours'] : 24,
    };
  }

  // 같은 시리얼이면 갱신(멱등). 처음 보는 기기는 설정 pda.device_approval이 true면 비활성으로 등록하고 403 ALM-E406(결정 S-15)
  @Put('devices/:deviceSerial')
  @Operation('pdaRegisterDevice')
  async register(@Ctx() ctx: AlmContext, @Param('deviceSerial') serial: string, @Body() body: unknown) {
    const k = new Check(body), o = k.obj();
    const bodySerial = k.str(o, 'deviceSerial', { required: true, max: 40 });
    const model = k.str(o, 'model', { max: 40 });
    const appVersion = k.str(o, 'appVersion', { required: true, max: 20 });
    if (bodySerial && (bodySerial !== serial || serial !== ctx.device?.serial)) k.fail('deviceSerial', '경로·본문·X-Device-Id의 시리얼이 같아야 합니다');
    k.done();
    const p = ctx.principal!;
    const r = await this.db.withTx(txOf(ctx), async (c) => {
      const cur = (await c.query('SELECT id FROM pda_device WHERE device_serial = $1 FOR UPDATE', [serial])).rows[0];
      if (cur) {
        const u = (await c.query(
          `UPDATE pda_device SET model = coalesce($2, model), app_version = $3, last_user_id = $4, last_sync_at = now(),
                  updated_at = now(), updated_by = $4, version = version + 1 WHERE id = $1 RETURNING id, last_sync_at, is_active`,
          [cur.id, model ?? null, appVersion, p.userId])).rows[0];
        return { ...u, created: false };
      }
      const approval = (await c.query(`SELECT value FROM setting WHERE key = 'pda.device_approval'`)).rows[0]?.value === true;
      const n = (await c.query(
        `INSERT INTO pda_device (id, tenant_id, device_serial, model, app_version, last_user_id, last_sync_at, is_active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $6, $6) RETURNING id, last_sync_at, is_active`,
        [randomUUID(), p.tenantId, serial, model ?? null, appVersion, p.userId, !approval])).rows[0];
      if (!n.is_active) await securityEvent(c, { tenantId: p.tenantId, type: 'DEVICE_BLOCKED', actorId: p.userId, actorType: 'PDA', channel: 'PDA',
        meta: meta(ctx), target: serial, detail: { reason: 'APPROVAL_PENDING' } });
      return { ...n, created: true };
    });
    // 승인 대기로 등록됐으면 등록은 남기고 403(트랜잭션은 이미 커밋)
    if (!r.is_active) throw new AlmError(403, 'ALM-E406', '관리자 승인을 기다리는 기기입니다');
    if (!r.id) throw E.notFound();
    return { deviceId: r.id, lastSyncAt: (r.last_sync_at as Date).toISOString() };
  }
}
