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
export const RESOURCE_SERVER = 'alm-api';   // infra auth-stack resourceServerId
export const SAP_SCOPE = `${RESOURCE_SERVER}/sap.api`;

export class Cognito {
  readonly base: string;
  readonly redirectUri: string;
  private accessVerifier;
  private idVerifier;

  constructor(private cfg: Config, private http: Fetch = fetch) {
    this.base = `https://${cfg.cognito.domain}`;
    this.redirectUri = `${cfg.appOrigin}/api/v1/auth/callback`;
    // 웹·PDA·SAP(연결마다 클라이언트가 생김) 토큰을 모두 받는다. 어느 클라이언트가 어느 API를 부를 수 있는지는 가드의 채널 확인(E407)이 정한다
    this.accessVerifier = CognitoJwtVerifier.create({ userPoolId: cfg.cognito.userPoolId, tokenUse: 'access', clientId: null });
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

  // PDA 첫 로그인: 액세스 토큰에는 이메일이 없어 userInfo로 받는다(범위 openid email profile)
  async userInfo(accessToken: string): Promise<{ email?: string; email_verified?: boolean | string; name?: string; identities?: string }> {
    const r = await this.http(`${this.base}/oauth2/userInfo`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new AlmError(502, 'ALM-E502', '인증 서버 응답 오류', { status: r.status });
    return (await r.json()) as { email?: string; email_verified?: boolean | string; name?: string };
  }

  // SAP client_credentials: SAP이 보낸 비밀로 Cognito에 그대로 요청(ALM은 비밀을 저장하지 않음). 범위 sap.api → alm-api/sap.api
  async clientCredentials(clientId: string, clientSecret: string): Promise<{ ok: true; token: TokenSet } | { ok: false; status: number; error: string }> {
    const r = await this.http(`${this.base}/oauth2/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', scope: `${RESOURCE_SERVER}/sap.api` }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64') },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return { ok: true, token: (await r.json()) as TokenSet };
    return { ok: false, status: r.status, error: await errorOf(r) };
  }

  verifyAccess(token: string): Promise<AccessClaims> { return this.accessVerifier.verify(token) as unknown as Promise<AccessClaims>; }
  verifyId(token: string): Promise<IdClaims> { return this.idVerifier.verify(token) as unknown as Promise<IdClaims>; }
}

async function errorOf(r: Response): Promise<string> {
  try { return ((await r.json()) as { error?: string }).error ?? ''; } catch { return ''; }
}
