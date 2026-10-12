// SAP 연계 인증(openapi sapToken·sapPing, 09 6.6, 08 4.4). 업무 API(IF-xx)는 7.x에서 추가
import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Db } from '../db/pool';
import { Cognito } from '../auth/cognito';
import { ipAllowed, sapConnection, SapConn } from '../auth/sap';
import { securityEvent } from '../auth/login';
import { TtlCache } from '../common/cache';
import { LIMITS, SharedLimiter } from '../common/shared';
import { log } from '../common/log';
import { AlmContext, AlmRequest, Ctx, Operation } from './context';
import { COGNITO, DB, LIMITER, SAP_CONNS } from './tokens';

// RFC 6749 5.2 오류(SAP OAuth 클라이언트가 읽음) + ALM 공통 오류 필드
function oauthError(res: Response, req: AlmRequest, status: number, error: string, description: string, code: string) {
  return res.status(status).type('application/json').json({
    error, error_description: description,
    type: `https://alm.bsgapps.com/errors/${code}`, title: error, status, code, detail: description, correlationId: req.alm.correlationId,
  });
}

@Controller()
export class SapController {
  constructor(@Inject(DB) private db: Db, @Inject(COGNITO) private cognito: Cognito, @Inject(SAP_CONNS) private conns: TtlCache<SapConn>,
              @Inject(LIMITER) private limiter: SharedLimiter) {}

  @Post('oauth/token')
  @HttpCode(200)
  @Operation('sapToken')
  async token(@Req() req: AlmRequest, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache');
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (b.grant_type !== 'client_credentials') return oauthError(res, req, 400, 'unsupported_grant_type', 'grant_type=client_credentials만 지원합니다', 'ALM-E100');
    if (b.scope !== undefined && b.scope !== '' && b.scope !== 'sap.api') return oauthError(res, req, 400, 'invalid_scope', 'scope는 sap.api입니다', 'ALM-E100');
    // client_secret_basic(권장) 또는 client_secret_post
    let id: string | undefined, secret: string | undefined;
    const basic = /^Basic (.+)$/i.exec(req.header('authorization') ?? '');
    if (basic) {
      const raw = Buffer.from(basic[1], 'base64').toString();
      const i = raw.indexOf(':');
      try { if (i > 0) { id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1)); } } catch { /* 형식 오류 → invalid_client */ }
    } else if (typeof b.client_id === 'string' && typeof b.client_secret === 'string') { id = b.client_id; secret = b.client_secret; }
    if (!id || !secret) return oauthError(res, req, 401, 'invalid_client', '클라이언트 인증 정보가 없습니다', 'ALM-E402');

    const wait = await this.limiter.hit(`sap-token:${id.slice(0, 64)}`, LIMITS.sapToken);   // 09 6.6: 클라이언트당 분당 10회(모든 작업 합계)
    if (wait) { res.setHeader('Retry-After', String(wait)); return oauthError(res, req, 429, 'slow_down', '토큰 발급 호출이 너무 많습니다', 'ALM-E429'); }

    const conn = await sapConnection(this.db, id);
    if (!conn) {
      // 테넌트를 알 수 없으므로 CloudWatch에만(09 7장)
      log.warn('sap token unknown client', { clientId: id.slice(0, 40), ip: req.alm.ip, correlationId: req.alm.correlationId });
      return oauthError(res, req, 401, 'invalid_client', '클라이언트 인증에 실패했습니다', 'ALM-E402');
    }
    const fail = async (reason: string, extra?: Record<string, unknown>) => {
      log.warn('sap token denied', { reason, clientId: id, ip: req.alm.ip, correlationId: req.alm.correlationId, ...extra });
      await this.db.withTx({ tenantId: conn.tenantId, actorType: 'SAP', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
        (c) => securityEvent(c, { tenantId: conn.tenantId, type: 'SAP_AUTH_FAILED', actorType: 'SAP', channel: 'SAP', target: conn.connectionId,
          meta: { clientId: id, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId }, detail: { reason, ...extra } }))
        .catch((e) => log.error('security_event write failed', { err: String(e) }));
    };
    if (!ipAllowed(req.alm.ip, conn.allowedCidrs)) {
      await fail('IP_NOT_ALLOWED');
      return oauthError(res, req, 403, 'access_denied', '허용되지 않은 출발지 IP입니다', 'ALM-E401');
    }
    const r = await this.cognito.clientCredentials(id, secret);
    if (!r.ok) {
      await fail('COGNITO_REJECTED', { status: r.status, error: r.error });
      return r.status >= 500
        ? oauthError(res, req, 502, 'temporarily_unavailable', '인증 서버 응답 오류', 'ALM-E502')
        : oauthError(res, req, 401, 'invalid_client', '클라이언트 인증에 실패했습니다', 'ALM-E402');
    }
    await this.db.withTx({ tenantId: conn.tenantId, actorType: 'SAP', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
      (c) => c.query('UPDATE sap_connection SET last_call_at = now() WHERE id = $1', [conn.connectionId])).catch(() => undefined);
    this.conns.delete(id);   // 연결 상태 변경을 다음 호출에 반영
    return res.status(200).json({ access_token: r.token.access_token, token_type: 'Bearer', expires_in: r.token.expires_in, scope: 'sap.api' });
  }

  @Get('sap/ping')
  @Operation('sapPing')
  ping(@Ctx() ctx: AlmContext) {
    const s = ctx.sap!;
    return { status: 'UP', serverTime: new Date().toISOString(), tenantCode: s.tenantCode, companyCodes: [s.companyCode] };
  }
}
