// Cognito 호스티드 엔드포인트(auth.<영역>)와 JWT 검증. 웹 클라이언트는 비밀이 있어 Basic 인증으로 토큰을 받는다.
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Config } from '../config';
import { AlmError, E } from '../common/errors';

export interface TokenSet { access_token: string; id_token?: string; refresh_token?: string; expires_in: number; token_type: string }
export interface AccessClaims { sub: string; username: string; client_id: string; token_use: 'access'; scope?: string; exp: number }
export interface IdClaims {
  sub: string; 'cognito:username': string; email?: string; email_verified?: boolean | string; name?: string;
  identities?: { providerName: string; providerType: string; userId: string }[];
}

type Fetch = typeof fetch;

export class Cognito {
  readonly base: string;
  readonly redirectUri: string;
  private accessVerifier;
  private idVerifier;

  constructor(private cfg: Config, private http: Fetch = fetch) {
    this.base = `https://${cfg.cognito.domain}`;
    this.redirectUri = `${cfg.appOrigin}/api/v1/auth/callback`;
    const clientIds = [cfg.cognito.webClientId, cfg.cognito.pdaClientId].filter(Boolean);
    this.accessVerifier = CognitoJwtVerifier.create({ userPoolId: cfg.cognito.userPoolId, tokenUse: 'access', clientId: clientIds });
    this.idVerifier = CognitoJwtVerifier.create({ userPoolId: cfg.cognito.userPoolId, tokenUse: 'id', clientId: cfg.cognito.webClientId });
  }

  authorizeUrl(p: { idp: string; state: string; challenge: string }): string {
    const q = new URLSearchParams({
      response_type: 'code', client_id: this.cfg.cognito.webClientId, redirect_uri: this.redirectUri,
      scope: 'openid email profile', identity_provider: p.idp, state: p.state,
      code_challenge: p.challenge, code_challenge_method: 'S256',
    });
    return `${this.base}/oauth2/authorize?${q}`;
  }

  logoutUrl(): string {
    const q = new URLSearchParams({ client_id: this.cfg.cognito.webClientId, logout_uri: `${this.cfg.appOrigin}/signed-out` });
    return `${this.base}/logout?${q}`;
  }

  private basic() {
    return 'Basic ' + Buffer.from(`${this.cfg.cognito.webClientId}:${this.cfg.cognito.webClientSecret}`).toString('base64');
  }

  private async post(path: string, body: Record<string, string>): Promise<Response> {
    return this.http(`${this.base}${path}`, {
      method: 'POST', body: new URLSearchParams(body),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: this.basic() },
      signal: AbortSignal.timeout(10_000),
    });
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const r = await this.post('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier });
    if (!r.ok) throw new AlmError(400, 'ALM-E100', '로그인 코드가 만료되었거나 잘못되었습니다', { status: r.status, error: await errorOf(r) });
    return (await r.json()) as TokenSet;
  }

  // 리프레시 만료·회수(invalid_grant)는 401 → 로그인 화면
  async refresh(refreshToken: string): Promise<TokenSet> {
    const r = await this.post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: refreshToken });
    if (r.status === 400) throw E.unauthenticated('세션이 만료되었습니다. 다시 로그인하세요');
    if (!r.ok) throw new AlmError(502, 'ALM-E502', '인증 서버 응답 오류', { status: r.status });
    return (await r.json()) as TokenSet;
  }

  async revoke(refreshToken: string): Promise<void> {
    const r = await this.post('/oauth2/revoke', { token: refreshToken });
    if (!r.ok && r.status !== 400) throw new AlmError(502, 'ALM-E502', '인증 서버 응답 오류', { status: r.status });
  }

  verifyAccess(token: string): Promise<AccessClaims> { return this.accessVerifier.verify(token) as unknown as Promise<AccessClaims>; }
  verifyId(token: string): Promise<IdClaims> { return this.idVerifier.verify(token) as unknown as Promise<IdClaims>; }
}

async function errorOf(r: Response): Promise<string> {
  try { return ((await r.json()) as { error?: string }).error ?? ''; } catch { return ''; }
}
