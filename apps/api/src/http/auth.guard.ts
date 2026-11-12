// 인증·채널·권한 가드(09 6.3·7장). 순서: 액세스 토큰 → 채널(클라이언트 ID) → 주체(60초 캐시)·PDA 기기·SAP 연결 → 권한 키
// 통행증 모드(SUITE_AUTH=1, 통합 WBS 5.4): 웹 채널만 액세스 토큰 대신 플랫폼 통행증 쿠키로 인증한다. PDA·SAP·Portal 채널은 그대로 토큰이다
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
import { CONFIG, COGNITO, DB, LIMITER, PRINCIPALS, SAP_CONNS, CENTRAL, SUITE_PASS } from './tokens';
import { CSRF_HEADER, PASS_COOKIE, PassClaims, PassError, SuitePassVerifier } from '../auth/suitePass';
import { mirrorRoles, mirrorUser } from '../admin/identityMirror';
import { catalog } from '../platform/identity/permissions';
import type { Central } from '../auth/central';
import { centralLogin } from '../auth/centralLogin';
import type { Response } from 'express';

export type Channel = 'WEB' | 'PDA' | 'SAP' | 'PORTAL';
export const channelOfPath = (path: string): Channel =>
  path.startsWith('/api/v1/pda/') ? 'PDA' : path.startsWith('/api/v1/sap/') ? 'SAP' : path.startsWith('/api/v1/portal/') ? 'PORTAL' : 'WEB';

const DEVICE = /^[A-Za-z0-9._:-]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 사용자 문맥 없이 클라이언트만 확인하는 Portal 작업(매니페스트는 별도). 수명주기 훅은 R1에서 501만 돌려준다
export const PORTAL_APP_LEVEL = new Set(['portalTenantExport', 'portalTenantImport', 'portalErase', 'portalGetJob']);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, @Inject(CONFIG) private cfg: Config, @Inject(DB) private db: Db,
              @Inject(COGNITO) private cognito: Cognito, @Inject(PRINCIPALS) private cache: PrincipalCache,
              @Inject(SAP_CONNS) private sapConns: TtlCache<SapConn>, @Inject(LIMITER) private limiter: SharedLimiter,
              @Inject(CENTRAL) private central: Central | null, @Inject(SUITE_PASS) private pass: SuitePassVerifier | null) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const op = this.reflector.get<string>(OPERATION, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<AlmRequest>();
    if (this.reflector.get<boolean>(PUBLIC, ctx.getHandler())) return true;   // 상태 확인 등 운영 경로
    if (op === undefined) throw E.forbidden('작업 ID가 없는 경로');              // 실수로 빠진 경로는 막는다(기본 거부)
    const perm = permissionFor(op);
    if (perm === null) return true;                          // 로그인 단계(authLogin, sapToken 등)
    if (perm === undefined) throw E.forbidden(`권한 카탈로그에 없는 작업: ${op}`);

    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    const channel = channelOfPath(req.path);
    req.alm.channel = channel;
    // 통행증 모드의 웹 채널: 토큰이 없으면 통행증 쿠키로 인증한다(토큰을 보내면 아래 채널 확인에서 거절된다 — 웹 클라이언트가 없다)
    if (this.pass && channel === 'WEB' && !m) {
      const principal = await this.passPrincipal(req);
      if (!principal) throw E.loginDenied('사용할 수 없는 사용자입니다(미등록·비활성·유효한 역할 없음)');
      return this.authorize(ctx, req, principal, channel, op, perm);
    }
    if (!m) throw E.unauthenticated();
    const claims = await this.cognito.verifyAccess(m[1]).catch(() => { throw E.unauthenticated('토큰이 만료되었거나 잘못되었습니다'); });
    req.alm.claims = claims;

    if (channel === 'SAP') return this.sap(req, claims, String(perm), ctx.switchToHttp().getResponse<Response>());
    if (channel === 'PORTAL') return this.portal(req, claims, op, String(perm), ctx.switchToHttp().getResponse<Response>());

    // 웹 → alm-web, /pda/* → alm-pda (ST03: PDA 토큰으로 웹 API 403 ALM-E407)
    const expected = channel === 'PDA' ? this.cfg.cognito.pdaClientId : this.cfg.cognito.webClientId;
    if (!expected || claims.client_id !== expected) throw E.channel();

    let principal = await this.cache.get(claims.username, () => this.resolve(claims.username, req));
    if (!principal && channel === 'PDA') principal = await this.pdaFirstLogin(m[1], claims, req);
    if (!principal) throw E.loginDenied('사용할 수 없는 사용자입니다(미등록·비활성·유효한 역할 없음)');
    if (channel === 'PDA') { req.alm.principal = principal; await this.device(req, principal, claims, op); }
    return this.authorize(ctx, req, principal, channel, op, perm);
  }

  // 호출 제한 → 권한 키(웹·PDA 공통)
  private async authorize(ctx: ExecutionContext, req: AlmRequest, principal: Principal, channel: 'WEB' | 'PDA', op: string, perm: string | string[]): Promise<boolean> {
    req.alm.principal = principal;
    await this.limit(ctx.switchToHttp().getResponse<Response>(), [
      [`u:${channel === 'PDA' ? 'pda' : 'web'}:${principal.userId}`, channel === 'PDA' ? LIMITS.pdaUser : LIMITS.webUser],
      [`t:${principal.tenantId}`, LIMITS.tenant]]);

    if (!(Array.isArray(perm) ? perm.some((x) => principal.permissions.has(x)) : principal.permissions.has(perm))) {
      log.warn('access denied', { op, perm, userId: principal.userId, correlationId: req.alm.correlationId });
      await this.event(principal.tenantId, req, { type: 'ACCESS_DENIED', actorId: principal.userId, channel,
        target: `${req.method} ${req.path}`, detail: { operation: op, permission: perm } });
      throw E.forbidden();
    }
    return true;
  }

  // 통행증 → 주체. 테넌트 = 통행증의 중앙 테넌트 ID에 연결된 ALM 테넌트(0021), 사용자 = 통행증의 sub(중앙 사용자 ID = app_user.id)
  private async passPrincipal(req: AlmRequest): Promise<Principal | undefined> {
    let p: PassClaims;
    try { p = await this.pass!.verify(req.cookies?.[PASS_COOKIE]); }
    catch (e) {
      if (e instanceof PassError && e.code === 'JWKS') {   // 플랫폼 공개 키를 못 읽음 — 사용자 탓이 아니다
        log.error('suite pass jwks failed', { err: e.message, correlationId: req.alm.correlationId });
        throw new AlmError(502, 'ALM-E502', '플랫폼 인증 키를 읽지 못했습니다. 잠시 뒤 다시 시도하세요');
      }
      if (!(e instanceof PassError)) log.error('suite pass verify failed', { err: String(e), correlationId: req.alm.correlationId });
      throw E.unauthenticated('통행증이 없거나 만료되었습니다');   // 401 → 화면(shell.js)이 통행증을 갱신하고 한 번 다시 부른다
    }
    req.alm.pass = p;
    // 변경 요청은 X-Suite-Csrf 헤더가 통행증의 csrf와 같아야 한다(플랫폼 계약)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.header(CSRF_HEADER) !== p.csrf) throw E.forbidden('요청 출처를 확인할 수 없습니다');
    const tenantId = (await this.db.query<{ id: string | null }>('SELECT auth_tenant_by_central_id($1) AS id', [p.tid]))[0]?.id;
    if (!tenantId) {
      log.warn('suite pass: tenant not linked', { tenant: p.tcd, correlationId: req.alm.correlationId });
      throw E.loginDenied('이 회사는 ALM에 등록되어 있지 않습니다. 관리자에게 문의하세요');
    }
    const tx = { tenantId, userId: p.sub, actorType: 'USER' as const, correlationId: req.alm.correlationId, clientIp: req.alm.ip };
    return this.cache.get(`pass:${tenantId}:${p.sub}`, async () =>
      (await this.db.withTx(tx, (c) => loadPrincipal(c, p.sub))) ?? this.passProvision(req, tenantId, p));
  }

  // ALM에 사본(미러)이 없거나 쓸 수 없는 상태 — 통행증은 플랫폼이 "지금 이 제품에 들어올 수 있다"고 확인한 것이므로 중앙의 값으로 사본을 맞춘다.
  // 중앙 ID가 연결돼 있으면 거기서 읽고(변경 이벤트와 같은 값), 없으면 통행증의 역할(암묵 역할 제외)을 쓴다
  private async passProvision(req: AlmRequest, tenantId: string, p: PassClaims): Promise<Principal | undefined> {
    try {
      let user = { id: p.sub, email: p.email, displayName: p.name || p.email, employeeNo: undefined as string | undefined };
      let roles = p.roles.filter((r) => r.role !== catalog().implicit.role);
      if (this.central) {
        const u = await this.central.getUser(p.tcd, p.sub);
        if (!u || !u.isActive) return undefined;
        user = { id: u.id, email: u.email, displayName: u.displayName, employeeNo: u.employeeNo }; roles = u.roles;
      } else if (p.rolesOmitted) return undefined;
      return await this.db.withTx({ tenantId, userId: p.sub, actorType: 'USER', correlationId: req.alm.correlationId, clientIp: req.alm.ip }, async (c) => {
        await mirrorUser(c, tenantId, { ...user, isActive: true, touchLogin: true });
        await mirrorRoles(c, tenantId, p.sub, roles);
        const principal = await loadPrincipal(c, p.sub);
        if (principal) await securityEvent(c, { tenantId, type: 'LOGIN', actorId: p.sub, detail: { suite: true, provisioned: true },
          meta: { ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId } });
        return principal;
      });
    } catch (e) {
      log.error('suite pass provision failed', { err: String(e), userId: p.sub, correlationId: req.alm.correlationId });
      return undefined;
    }
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

  // 09 앱 연동 계약 §3: Portal 머신 클라이언트(portal-backend)만. 토큰은 사용자를 대표하지 않으므로 tenantId·userSub를 쿼리로 받아
  // "그 테넌트의 활성 사용자인가"를 확인하고, 그 사용자의 권한으로 읽기만 한다(쓰기 API는 이 채널에 없다).
  private async portal(req: AlmRequest, claims: AccessClaims, op: string, perm: string, res: Response): Promise<boolean> {
    const pc = this.cfg.portal;
    if (perm !== 'portal.feed' || !pc || !pc.clientIds.includes(claims.client_id)) throw E.channel('Portal 클라이언트가 아닙니다');
    if (pc.scope && !(claims.scope ?? '').split(' ').includes(pc.scope)) throw E.channel('Portal 피드 범위가 토큰에 없습니다');
    if (op === 'portalGetManifest' || PORTAL_APP_LEVEL.has(op)) return true;                       // 앱 수준 정보 — 사용자 문맥 없음
    const centralId = String(req.query.tenantId ?? ''), userSub = String(req.query.userSub ?? '');
    if (!UUID_RE.test(centralId) || !UUID_RE.test(userSub)) throw E.badRequest('tenantId와 userSub(uuid)가 필요합니다');
    // Portal이 보내는 tenantId는 중앙 ID의 테넌트 ID — ALM 테넌트 ID로 바꾼다(매핑이 없으면 그대로 두어 아래에서 거절됨)
    const tenantId = (await this.db.query<{ id: string | null }>('SELECT auth_tenant_by_central_id($1) AS id', [centralId]))[0]?.id ?? centralId;
    const principal = await this.cache.get(`portal:${tenantId}:${userSub}`, () => this.db.withTx(
      { tenantId, userId: userSub, actorType: 'USER', correlationId: req.alm.correlationId, clientIp: req.alm.ip }, (c) => loadPrincipal(c, userSub)));
    if (!principal) {
      log.warn('portal feed denied', { reason: 'USER_NOT_IN_TENANT', clientId: claims.client_id, correlationId: req.alm.correlationId });
      throw new AlmError(403, 'ALM-E401', '이 테넌트의 활성 사용자가 아닙니다', { reason: 'USER_NOT_IN_TENANT' });
    }
    req.alm.principal = principal;
    await this.limit(res, [[`portal:${tenantId}`, LIMITS.tenant]]);
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
