// Cognito 호스티드 엔드포인트(auth.<영역>)와 액세스 토큰 검증(PDA·SAP·Portal 채널). 웹 로그인(인가 코드·토큰 갱신)은 플랫폼 공통 로그인으로 옮겨 7.1에서 지웠다.
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Config } from '../config';
import { AlmError } from '../common/errors';

export interface TokenSet { access_token: string; id_token?: string; refresh_token?: string; expires_in: number; token_type: string }
export interface AccessClaims { sub: string; username: string; client_id: string; token_use: 'access'; scope?: string; exp: number }
type Fetch = typeof fetch;
export const RESOURCE_SERVER = 'alm-api';   // infra auth-stack resourceServerId
export const SAP_SCOPE = `${RESOURCE_SERVER}/sap.api`;
// 중앙 ID의 SAP 연결이 주는 범위(<제품 코드>/sap.api). 중앙 ID를 쓰는 환경(공유 플랫폼)에서만 받는다 — 토큰은 SAP가 플랫폼의 /oauth/token에서 받는다
export const CENTRAL_SAP_SCOPE = 'alm/sap.api';

export class Cognito {
  readonly base: string;
  readonly sapBase: string;
  private accessVerifier;

  constructor(cfg: Config, private http: Fetch = fetch) {
    this.base = `https://${cfg.cognito.domain}`;
    this.sapBase = `https://${cfg.sapCognito?.domain ?? cfg.cognito.domain}`;
    // 웹·PDA·SAP(연결마다 클라이언트가 생김) 토큰을 모두 받는다. 어느 클라이언트가 어느 API를 부를 수 있는지는 가드의 채널 확인(E407)이 정한다
    // 사용자 풀과 SAP 풀이 다르면(중앙 ID 전환 뒤) 두 풀의 토큰을 모두 받는다. 채널(클라이언트 ID·범위) 확인은 가드가 한다
    const pools = [...new Set([cfg.cognito.userPoolId, cfg.sapCognito?.userPoolId].filter((x): x is string => !!x))];
    this.accessVerifier = CognitoJwtVerifier.create(pools.map((userPoolId) => ({ userPoolId, tokenUse: 'access' as const, clientId: null })));
  }

  // PDA 첫 로그인: 액세스 토큰에는 이메일이 없어 userInfo로 받는다(범위 openid email profile)
  async userInfo(accessToken: string): Promise<{ email?: string; email_verified?: boolean | string; name?: string; identities?: string }> {
    const r = await this.http(`${this.base}/oauth2/userInfo`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new AlmError(502, 'ALM-E502', '인증 서버 응답 오류', { status: r.status });
    return (await r.json()) as { email?: string; email_verified?: boolean | string; name?: string };
  }

  // SAP client_credentials: SAP이 보낸 비밀로 Cognito에 그대로 요청(ALM은 비밀을 저장하지 않음). 범위 sap.api → alm-api/sap.api
  async clientCredentials(clientId: string, clientSecret: string): Promise<{ ok: true; token: TokenSet } | { ok: false; status: number; error: string }> {
    const r = await this.http(`${this.sapBase}/oauth2/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', scope: `${RESOURCE_SERVER}/sap.api` }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64') },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return { ok: true, token: (await r.json()) as TokenSet };
    return { ok: false, status: r.status, error: await errorOf(r) };
  }

  verifyAccess(token: string): Promise<AccessClaims> { return this.accessVerifier.verify(token) as unknown as Promise<AccessClaims>; }
}

async function errorOf(r: Response): Promise<string> {
  try { return ((await r.json()) as { error?: string }).error ?? ''; } catch { return ''; }
}
