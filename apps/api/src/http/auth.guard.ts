// 인증·채널·권한 가드(09 6.3·7장). 순서: 액세스 토큰 검증 → 채널(클라이언트 ID) → 주체(60초 캐시) → 권한 키
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Config } from '../config';
import { Db } from '../db/pool';
import { Cognito } from '../auth/cognito';
import { permissionFor } from '../auth/permissions';
import { loadPrincipal, PrincipalCache, tenantOf } from '../auth/principal';
import { securityEvent } from '../auth/login';
import { E } from '../common/errors';
import { log } from '../common/log';
import { AlmRequest, OPERATION, PUBLIC } from './context';
import { CONFIG, COGNITO, DB, PRINCIPALS } from './tokens';

export type Channel = 'WEB' | 'PDA' | 'SAP';
export const channelOfPath = (path: string): Channel =>
  path.startsWith('/api/v1/pda/') ? 'PDA' : path.startsWith('/api/v1/sap/') ? 'SAP' : 'WEB';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, @Inject(CONFIG) private cfg: Config, @Inject(DB) private db: Db,
              @Inject(COGNITO) private cognito: Cognito, @Inject(PRINCIPALS) private cache: PrincipalCache) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const op = this.reflector.get<string>(OPERATION, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<AlmRequest>();
    if (this.reflector.get<boolean>(PUBLIC, ctx.getHandler())) return true;   // 상태 확인 등 운영 경로
    if (op === undefined) throw E.forbidden('작업 ID가 없는 경로');              // 실수로 빠진 경로는 막는다(기본 거부)
    const perm = permissionFor(op);
    if (perm === null) return true;                          // 로그인 단계(authLogin 등)
    if (perm === undefined) throw E.forbidden(`권한 카탈로그에 없는 작업: ${op}`);

    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!m) throw E.unauthenticated();
    const claims = await this.cognito.verifyAccess(m[1]).catch(() => { throw E.unauthenticated('토큰이 만료되었거나 잘못되었습니다'); });
    req.alm.claims = claims;

    const channel = channelOfPath(req.path);
    const expected = channel === 'PDA' ? this.cfg.cognito.pdaClientId : channel === 'WEB' ? this.cfg.cognito.webClientId : undefined;
    if (!expected || claims.client_id !== expected) throw E.channel();

    const principal = await this.cache.get(claims.username, async () => {
      const t = await tenantOf(this.db, claims.username);
      if (!t) return undefined;
      return this.db.withTx({ tenantId: t.tenant_id, actorType: 'USER', correlationId: req.alm.correlationId }, async (c) => {
        const u = (await c.query('SELECT id FROM app_user WHERE idp_subject = $1', [t.idp_subject])).rows[0];
        return u ? loadPrincipal(c, u.id) : undefined;
      });
    });
    if (!principal) throw E.loginDenied('사용할 수 없는 사용자입니다(미등록·비활성·유효한 역할 없음)');   // openapi patchUser: 비활성은 403 ALM-E405
    req.alm.principal = principal;

    if (!principal.permissions.has(perm)) {
      log.warn('access denied', { op, perm, userId: principal.userId, correlationId: req.alm.correlationId });
      await this.db.withTx({ tenantId: principal.tenantId, userId: principal.userId, actorType: 'USER', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
        (c) => securityEvent(c, { tenantId: principal.tenantId, type: 'ACCESS_DENIED', actorId: principal.userId, channel,
          meta: { clientId: claims.client_id, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId },
          target: `${req.method} ${req.path}`, detail: { operation: op, permission: perm } }))
        .catch((e) => log.error('security_event write failed', { err: String(e) }));
      throw E.forbidden();
    }
    return true;
  }
}
