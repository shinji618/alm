// 인증·채널·권한 가드(09 6.3·7장). 순서: 액세스 토큰 → 채널(클라이언트 ID) → 주체(60초 캐시)·PDA 기기·SAP 연결 → 권한 키
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Config } from '../config';
import { Db } from '../db/pool';
import { AccessClaims, Cognito, SAP_SCOPE } from '../auth/cognito';
import { permissionFor } from '../platform/identity/permissions';
import { loadPrincipal, Principal, PrincipalCache, tenantOf } from '../platform/identity/principal';
import { completeLogin, securityEvent } from '../platform/identity/login';
import { ipAllowed, sapConnection, SapConn } from '../auth/sap';
import { AlmError, E } from '../common/errors';
import { TtlCache } from '../common/cache';
import { LIMITS, SharedLimiter } from '../common/shared';
import { log } from '../common/log';
import { AlmRequest, OPERATION, PUBLIC } from './context';
import { CONFIG, COGNITO, DB, LIMITER, PRINCIPALS, SAP_CONNS, CENTRAL } from './tokens';
import type { Central } from '../auth/central';
import { centralLogin } from '../auth/centralLogin';
import type { Response } from 'express';

export type Channel = 'WEB' | 'PDA' | 'SAP';
export const channelOfPath = (path: string): Channel =>
  path.startsWith('/api/v1/pda/') ? 'PDA' : path.startsWith('/api/v1/sap/') ? 'SAP' : 'WEB';

const DEVICE = /^[A-Za-z0-9._:-]{1,40}$/;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, @Inject(CONFIG) private cfg: Config, @Inject(DB) private db: Db,
              @Inject(COGNITO) private cognito: Cognito, @Inject(PRINCIPALS) private cache: PrincipalCache,
              @Inject(SAP_CONNS) private sapConns: TtlCache<SapConn>, @Inject(LIMITER) private limiter: SharedLimiter,
              @Inject(CENTRAL) private central: Central | null) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const op = this.reflector.get<string>(OPERATION, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<AlmRequest>();
    if (this.reflector.get<boolean>(PUBLIC, ctx.getHandler())) return true;   // 상태 확인 등 운영 경로
    if (op === undefined) throw E.forbidden('작업 ID가 없는 경로');              // 실수로 빠진 경로는 막는다(기본 거부)
    const perm = permissionFor(op);
    if (perm === null) return true;                          // 로그인 단계(authLogin, sapToken 등)
    if (perm === undefined) throw E.forbidden(`권한 카탈로그에 없는 작업: ${op}`);

    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!m) throw E.unauthenticated();
    const claims = await this.cognito.verifyAccess(m[1]).catch(() => { throw E.unauthenticated('토큰이 만료되었거나 잘못되었습니다'); });
    req.alm.claims = claims;
    const channel = channelOfPath(req.path);
    req.alm.channel = channel;

    if (channel === 'SAP') return this.sap(req, claims, String(perm), ctx.switchToHttp().getResponse<Response>());

    // 웹 → alm-web, /pda/* → alm-pda (ST03: PDA 토큰으로 웹 API 403 ALM-E407)
    const expected = channel === 'PDA' ? this.cfg.cognito.pdaClientId : this.cfg.cognito.webClientId;
    if (!expected || claims.client_id !== expected) throw E.channel();

    let principal = await this.cache.get(claims.username, () => this.resolve(claims.username, req));
    if (!principal && channel === 'PDA') principal = await this.pdaFirstLogin(m[1], claims, req);
    if (!principal) throw E.loginDenied('사용할 수 없는 사용자입니다(미등록·비활성·유효한 역할 없음)');
    req.alm.principal = principal;

    if (channel === 'PDA') await this.device(req, principal, claims, op);
    await this.limit(ctx.switchToHttp().getResponse<Response>(), [
      [`u:${channel === 'PDA' ? 'pda' : 'web'}:${principal.userId}`, channel === 'PDA' ? LIMITS.pdaUser : LIMITS.webUser],
      [`t:${principal.tenantId}`, LIMITS.tenant]]);

    if (!(Array.isArray(perm) ? perm.some((x) => principal!.permissions.has(x)) : principal.permissions.has(perm))) {
      log.warn('access denied', { op, perm, userId: principal.userId, correlationId: req.alm.correlationId });
      await this.event(principal.tenantId, req, { type: 'ACCESS_DENIED', actorId: principal.userId, channel,
        target: `${req.method} ${req.path}`, detail: { operation: op, permission: perm } });
      throw E.forbidden();
    }
    return true;
  }

  private resolve(username: string, req: AlmRequest): Promise<Principal | undefined> {
    return tenantOf(this.db, username).then((t) => t && this.db.withTx({ tenantId: t.tenant_id, actorType: 'USER', correlationId: req.alm.correlationId }, async (c) => {
      const u = (await c.query('SELECT id FROM app_user WHERE idp_subject = $1', [t.idp_subject])).rows[0];
      return u ? loadPrincipal(c, u.id) : undefined;
    }));
  }

  // PDA로 처음 로그인한 사용자(웹 로그인 전): userInfo의 이메일로 미리 등록된 사용자에 연결(웹 콜백과 같은 규칙, 09 6.2)
  private async pdaFirstLogin(token: string, claims: AccessClaims, req: AlmRequest): Promise<Principal | undefined> {
    const t = await tenantOf(this.db, claims.username);
    if (!t) return undefined;
    const info = await this.cognito.userInfo(token);
    let idpType = 'OIDC';
    try { idpType = (JSON.parse(String(info.identities ?? '[]'))[0]?.providerType as string) ?? 'OIDC'; } catch { /* 기본 OIDC */ }
    const who = { username: claims.username, email: info.email, name: info.name, idpType,
      emailVerified: info.email_verified === true || info.email_verified === 'true' };
    const meta = { clientId: claims.client_id, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId, channel: 'PDA' as const };
    const r = this.central ? await centralLogin(this.db, this.central, t, who, meta) : await completeLogin(this.db, t, who, meta);
    this.cache.clear(claims.username);
    if (!r.ok) { log.warn('pda login denied', { reason: r.reason, correlationId: req.alm.correlationId }); return undefined; }
    req.alm.loginRecorded = true;
    return r.principal;
  }

  // 09 6.5: 모든 PDA API는 X-Device-Id 필수. 등록 안 된·비활성 기기는 403 ALM-E406 + DEVICE_BLOCKED(등록 API는 처음 보는 기기 허용)
  private async device(req: AlmRequest, p: Principal, claims: AccessClaims, op: string) {
    const serial = req.header('x-device-id')?.trim();
    if (!serial || !DEVICE.test(serial)) throw new AlmError(400, 'ALM-E101', 'X-Device-Id(기기 시리얼) 헤더가 필요합니다');
    const d = await this.db.withTx({ tenantId: p.tenantId, userId: p.userId, actorType: 'PDA', correlationId: req.alm.correlationId },
      async (c) => (await c.query('SELECT id, is_active FROM pda_device WHERE device_serial = $1', [serial])).rows[0] as { id: string; is_active: boolean } | undefined);
    req.alm.device = { id: d?.id, serial };
    if (d?.is_active || (!d && op === 'pdaRegisterDevice')) return;
    await this.event(p.tenantId, req, { type: 'DEVICE_BLOCKED', actorId: p.userId, channel: 'PDA', actorType: 'PDA',
      target: serial, detail: { reason: d ? 'INACTIVE' : 'NOT_REGISTERED', operation: op, clientId: claims.client_id } });
    throw new AlmError(403, 'ALM-E406', d ? '사용이 중지된 기기입니다. 관리자에게 문의하세요' : '등록되지 않은 기기입니다. 앱에서 기기 등록을 먼저 하세요');
  }

  // 09 6.6: 토큰 범위 sap.api → client_id로 연결 → 허용 IP·시스템 ID·회사코드
  private async sap(req: AlmRequest, claims: AccessClaims, perm: string, res: Response): Promise<boolean> {
    const scopes = (claims.scope ?? '').split(' ');
    if (!scopes.includes(SAP_SCOPE)) throw E.channel();
    const conn = await this.sapConns.get(claims.client_id, () => sapConnection(this.db, claims.client_id));
    if (!conn) throw E.channel('등록된 SAP 연결의 클라이언트가 아닙니다');
    req.alm.sap = conn;
    const deny = async (reason: string, message: string) => {
      log.warn('sap call denied', { reason, clientId: conn.clientId, ip: req.alm.ip, correlationId: req.alm.correlationId });
      await this.event(conn.tenantId, req, { type: 'SAP_AUTH_FAILED', channel: 'SAP', actorType: 'SAP', target: conn.connectionId,
        detail: { reason, clientId: conn.clientId } });
      throw new AlmError(403, 'ALM-E401', message);
    };
    if (!ipAllowed(req.alm.ip, conn.allowedCidrs)) await deny('IP_NOT_ALLOWED', '허용되지 않은 출발지 IP입니다');
    const sys = req.header('x-sap-system')?.trim();
    if (sys && sys !== conn.systemId) await deny('SYSTEM_MISMATCH', `X-SAP-System이 연결(${conn.systemId})과 다릅니다`);
    const cc = req.header('x-company-code')?.trim();
    if (cc && cc !== conn.companyCode) await deny('COMPANY_MISMATCH', '이 연결에 허용되지 않은 회사코드입니다');
    if (perm !== 'sap.api') throw E.forbidden();
    await this.limit(res, [[`sap:${conn.clientId}`, LIMITS.sapClient], [`t:${conn.tenantId}`, LIMITS.tenant]]);
    return true;
  }

  // 10 정의서 6.4: 사용자·SAP 클라이언트·테넌트 분당 한도. 모든 api 작업이 같은 카운터(Valkey)를 본다
  private async limit(res: Response, checks: [string, number][]) {
    for (const [key, max] of checks) {
      const wait = await this.limiter.hit(key, max);
      if (wait) {
        res.setHeader('Retry-After', String(wait));
        throw new AlmError(429, 'ALM-E429', `호출이 너무 많습니다. ${wait}초 뒤 다시 시도하세요`, { retryAfter: wait });
      }
    }
  }

  private event(tenantId: string, req: AlmRequest, e: Omit<Parameters<typeof securityEvent>[1], 'tenantId' | 'meta'>) {
    return this.db.withTx({ tenantId, userId: e.actorId, actorType: e.actorType ?? 'USER', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
      (c) => securityEvent(c, { ...e, tenantId, meta: { clientId: req.alm.claims?.client_id, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId } }))
      .catch((err) => log.error('security_event write failed', { err: String(err) }));
  }
}
