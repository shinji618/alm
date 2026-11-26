// 로그인 경로(openapi authLogin·authCallback·authRefresh·authLogout)와 PDA 로그인 설정(authPdaConfig).
// 웹 로그인은 플랫폼 공통 로그인이 처리한다(통합 WBS 5.4). ALM 자체 웹 로그인(BFF: 인가 코드·암호화 쿠키·토큰 갱신)은 7.1에서 지웠다 —
// login은 플랫폼 로그인 화면으로 보내고, 나머지 BFF 경로는 404다. PDA는 앱이 Cognito와 직접 로그인하므로 설정 조회가 그대로 있다.
import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Config } from '../config';
import { Db } from '../db/pool';
import { Cognito } from '../auth/cognito';
import { AlmError, E } from '../common/errors';
import { log } from '../common/log';
import { AlmRequest, Operation } from './context';
import { CONFIG, COGNITO, DB } from './tokens';

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
  constructor(@Inject(CONFIG) private cfg: Config, @Inject(DB) private db: Db, @Inject(COGNITO) private cognito: Cognito) {}

  @Get('login')
  @Operation('authLogin')
  login(@Query('returnTo') returnTo: string, @Res() res: Response) {
    // 통행증 설정이 없는 환경(로컬·시험)에는 웹 로그인이 없다 — 조용히 넘어가지 않고 알린다
    if (!this.cfg.suite) throw new AlmError(503, 'ALM-E503', '웹 로그인은 플랫폼 공통 로그인으로만 됩니다(SUITE_AUTH 설정 없음)');
    return res.redirect(302, `${this.cfg.suite.issuer}/login?returnTo=${encodeURIComponent('/alm' + safeReturnTo(returnTo))}`);
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

  // 옛 BFF 경로: 명세에는 남아 있지만 동작하지 않는다(공유 플랫폼으로 옮긴 뒤로 계속 404였다)
  @Get('callback') @Operation('authCallback') callback(): never { throw E.notFound(); }
  @Post('refresh') @HttpCode(200) @Operation('authRefresh') refresh(): never { throw E.notFound(); }
  @Post('logout') @HttpCode(200) @Operation('authLogout') logout(): never { throw E.notFound(); }
  @Get('session') @Operation('authRefresh') session(): never { throw E.notFound(); }
}
