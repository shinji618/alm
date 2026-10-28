// BFF 로그인(openapi authLogin·authCallback·authRefresh·authLogout, 09 6.4)과 PDA 로그인 설정(authPdaConfig). 서버 세션 저장소 없이 암호화 쿠키만 쓴다.
import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Config } from '../config';
import { Db } from '../db/pool';
import { Cognito } from '../auth/cognito';
import { open, randomToken, s256, seal } from '../auth/crypto';
import { completeLogin, securityEvent, toMe } from '../platform/identity/login';
import { almIdentity } from '../admin/identityAdapter';
import { PrincipalCache, tenantOf, loadPrincipal } from '../platform/identity/principal';
import { AlmError, E } from '../common/errors';
import { log } from '../common/log';
import { AlmRequest, Operation } from './context';
import { CONFIG, COGNITO, DB, PRINCIPALS, CENTRAL } from './tokens';
import type { Central } from '../auth/central';
import { centralLogin } from '../auth/centralLogin';

const PATH = '/api/v1/auth';
const PKCE = 'alm_pkce', RT = 'alm_rt';
const PKCE_TTL = 300, RT_TTL = 8 * 3600;

interface PkceCookie { v: string; s: string; r: string }
interface RtCookie { rt: string; t: string; u: string; n: string }   // 리프레시 토큰, 테넌트, 사용자, Cognito username

// returnTo는 같은 사이트의 상대 경로만(오픈 리다이렉트 방지)
export function safeReturnTo(v: unknown): string {
  return typeof v === 'string' && /^\/(?![/\\])[^\s]*$/.test(v) && v.length <= 512 ? v : '/';
}
export const domainOf = (email: string) => {
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(email.trim());
  return m?.[1].toLowerCase();
};

@Controller('auth')
export class AuthController {
  constructor(@Inject(CONFIG) private cfg: Config, @Inject(DB) private db: Db, @Inject(COGNITO) private cognito: Cognito,
              @Inject(PRINCIPALS) private cache: PrincipalCache, @Inject(CENTRAL) private central: Central | null) {}

  private cookie(res: Response, name: string, value: string, maxAgeSec: number, sameSite: 'lax' | 'strict') {
    res.cookie(name, value, { httpOnly: true, secure: true, sameSite, path: PATH, maxAge: maxAgeSec * 1000 });
  }
  private clear(res: Response, name: string, sameSite: 'lax' | 'strict') {
    res.clearCookie(name, { httpOnly: true, secure: true, sameSite, path: PATH });
  }

  @Get('login')
  @Operation('authLogin')
  async login(@Query('email') email: string, @Query('returnTo') returnTo: string, @Req() req: AlmRequest, @Res() res: Response) {
    const domain = typeof email === 'string' ? domainOf(email) : undefined;
    if (!domain) throw E.badRequest('이메일 형식이 아닙니다');
    const idp = (await this.db.query<{ idp: string | null }>('SELECT auth_idp_by_domain($1) AS idp', [domain]))[0]?.idp;
    if (!idp) {
      // 고객사 여부를 드러내지 않는다: 같은 문구, 기록은 CloudWatch에만(테넌트를 몰라 security_event에 못 남김)
      log.warn('login unknown domain', { domain, ip: req.alm.ip, correlationId: req.alm.correlationId });
      throw E.loginDenied('등록된 회사 계정이 아닙니다. 관리자에게 문의하세요');
    }
    const verifier = randomToken(48), state = randomToken(24);
    this.cookie(res, PKCE, seal(this.cfg.cookieKeys, PKCE, { v: verifier, s: state, r: safeReturnTo(returnTo) }, PKCE_TTL), PKCE_TTL, 'lax');
    res.redirect(302, this.cognito.authorizeUrl({ idp, state, challenge: s256(verifier) }));
  }

  // PDA 로그인 설정(AppAuth, 09 6.5): 이메일 도메인 → 테넌트 IdP. PKCE·토큰 교환은 앱이 Cognito와 직접(공개 클라이언트)
  @Get('pda-config')
  @Operation('authPdaConfig')
  async pdaConfig(@Query('email') email: string, @Req() req: AlmRequest) {
    const domain = typeof email === 'string' ? domainOf(email) : undefined;
    if (!domain) throw E.badRequest('이메일 형식이 아닙니다');
    const idp = (await this.db.query<{ idp: string | null }>('SELECT auth_idp_by_domain($1) AS idp', [domain]))[0]?.idp;
    if (!idp || !this.cfg.cognito.pdaClientId) {
      log.warn('pda login unknown domain', { domain, ip: req.alm.ip, correlationId: req.alm.correlationId });
      throw E.loginDenied('등록된 회사 계정이 아닙니다. 관리자에게 문의하세요');
    }
    const b = this.cognito.base;
    return { authorizationEndpoint: `${b}/oauth2/authorize`, tokenEndpoint: `${b}/oauth2/token`, revocationEndpoint: `${b}/oauth2/revoke`,
      endSessionEndpoint: `${b}/logout`, clientId: this.cfg.cognito.pdaClientId, redirectUri: 'com.bsg.alm://auth', identityProvider: idp,
      scopes: ['openid', 'email', 'profile'] };
  }

  @Get('callback')
  @Operation('authCallback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string,
                 @Req() req: AlmRequest, @Res() res: Response) {
    const pk = open<PkceCookie>(this.cfg.cookieKeys, PKCE, req.cookies?.[PKCE]);
    this.clear(res, PKCE, 'lax');
    if (error) throw new AlmError(400, 'ALM-E100', '로그인이 취소되었거나 IdP에서 거부되었습니다', { error });
    if (!pk || typeof state !== 'string' || pk.s !== state) throw E.badRequest('로그인 시간이 지났습니다. 다시 로그인하세요');
    if (typeof code !== 'string' || !code) throw E.badRequest('인가 코드가 없습니다');

    const tokens = await this.cognito.exchangeCode(code, pk.v);
    const access = await this.cognito.verifyAccess(tokens.access_token);
    const id = tokens.id_token ? await this.cognito.verifyId(tokens.id_token) : undefined;
    const meta = { clientId: access.client_id, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId };
    const t = await tenantOf(this.db, access.username);
    if (!t) {
      log.warn('login no tenant', { username: access.username.replace(/_.*/, '_…'), correlationId: meta.correlationId });
      await this.cognito.revoke(tokens.refresh_token ?? '').catch(() => undefined);
      throw E.loginDenied();
    }
    const who = {
      username: access.username, email: id?.email, name: id?.name,
      emailVerified: id?.email_verified === true || id?.email_verified === 'true',
      idpType: id?.identities?.[0]?.providerType ?? 'OIDC',
    };
    // 중앙 ID 서비스가 설정되어 있으면 판정을 위임하고 결과를 미러에 반영한다(3.13)
    const r = this.central ? await centralLogin(this.db, this.central, t, who, meta) : await completeLogin(this.db, t, who, meta);
    if (!r.ok) {
      log.warn('login denied', { reason: r.reason, correlationId: meta.correlationId });
      if (tokens.refresh_token) await this.cognito.revoke(tokens.refresh_token).catch(() => undefined);
      throw E.loginDenied();
    }
    this.cache.clear(access.username);
    if (!tokens.refresh_token) throw new AlmError(502, 'ALM-E502', '리프레시 토큰이 없습니다');
    this.cookie(res, RT, seal(this.cfg.cookieKeys, RT, { rt: tokens.refresh_token, t: t.tenant_id, u: r.principal.userId, n: access.username } satisfies RtCookie, RT_TTL), RT_TTL, 'strict');
    log.info('login', { userId: r.principal.userId, tenant: r.principal.tenantCode, created: r.created, linked: r.linked, correlationId: meta.correlationId });
    res.redirect(302, `${this.cfg.appOrigin}${pk.r}`);
  }

  // CSRF: 사용자 지정 헤더 + Origin(웹 도메인). 쿠키는 SameSite=Strict
  private csrf(req: AlmRequest) {
    if (req.header('x-alm-csrf') !== '1' || req.header('origin') !== this.cfg.appOrigin) throw E.forbidden('요청 출처를 확인할 수 없습니다');
  }

  @Post('refresh')
  @HttpCode(200)
  @Operation('authRefresh')
  async refresh(@Req() req: AlmRequest) {
    this.csrf(req);
    const c = open<RtCookie>(this.cfg.cookieKeys, RT, req.cookies?.[RT]);
    if (!c) throw E.unauthenticated('세션이 만료되었습니다. 다시 로그인하세요');
    const t = await this.cognito.refresh(c.rt);
    return { accessToken: t.access_token, expiresIn: t.expires_in, tokenType: 'Bearer' as const };
  }

  @Post('logout')
  @HttpCode(200)
  @Operation('authLogout')
  async logout(@Req() req: AlmRequest, @Res({ passthrough: true }) res: Response) {
    this.csrf(req);
    const c = open<RtCookie>(this.cfg.cookieKeys, RT, req.cookies?.[RT]);
    this.clear(res, RT, 'strict');
    if (c) {
      await this.cognito.revoke(c.rt).catch((e) => log.warn('revoke failed', { err: String(e), correlationId: req.alm.correlationId }));
      this.cache.clear(c.n);
      await this.db.withTx({ tenantId: c.t, userId: c.u, actorType: 'USER', correlationId: req.alm.correlationId, clientIp: req.alm.ip },
        (tx) => securityEvent(tx, { tenantId: c.t, type: 'LOGOUT', actorId: c.u,
          meta: { clientId: this.cfg.cognito.webClientId, ip: req.alm.ip, userAgent: req.alm.userAgent, correlationId: req.alm.correlationId } }))
        .catch((e) => log.error('logout event failed', { err: String(e) }));
    }
    return { logoutUrl: this.cognito.logoutUrl() };
  }

  // DEV·QA 확인용: 쿠키만으로 로그인 결과(Me)를 본다. 웹 앱 셸(3.5) 연결 전 브라우저 주소창에서 확인. 운영에서는 404
  @Get('session')
  @Operation('authRefresh')
  async session(@Req() req: AlmRequest) {
    if (this.cfg.env === 'prd') throw E.notFound();
    const c = open<RtCookie>(this.cfg.cookieKeys, RT, req.cookies?.[RT]);
    if (!c) throw E.unauthenticated('로그인 쿠키가 없습니다. /api/v1/auth/login?email=… 으로 먼저 로그인하세요');
    const t = await this.cognito.refresh(c.rt);
    const access = await this.cognito.verifyAccess(t.access_token);
    const p = await this.db.withTx({ tenantId: c.t, userId: c.u, actorType: 'USER', correlationId: req.alm.correlationId },
      (tx) => loadPrincipal(tx, c.u));
    if (!p) throw E.unauthenticated('사용할 수 없는 사용자입니다');
    return { ...toMe(p, almIdentity), token: { username: access.username, clientId: access.client_id, expiresIn: t.expires_in } };
  }
}
