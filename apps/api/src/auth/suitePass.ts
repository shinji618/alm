// 공유 플랫폼(suite) 통행증(통합 WBS 5.4). 로그인은 플랫폼이 한 번 처리하고(app 주소의 /auth/*), 제품에는 5분짜리 서명된 JWT(ES256)를
// 쿠키 `__Secure-suite_pass`(Path=/alm)로 준다. 여기서는 서명·발급자·대상·만료만 검사한다 — 세션 저장소가 없다.
// 계약: pas-suite README "플랫폼 공통 로그인과 공통 틀". Portal의 suite-pass.ts와 같은 규칙이다.
import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import type { CentralRole } from './central';

export const PASS_COOKIE = '__Secure-suite_pass';
export const CSRF_HEADER = 'x-suite-csrf';
export const PRODUCT = 'alm';

export interface PassClaims {
  iss: string; aud: string; sub: string; sid: string; tid: string; tcd: string; email: string; name: string;
  roles: CentralRole[]; rolesOmitted?: boolean; csrf: string; iat: number; exp: number;
}
export class PassError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export interface SuitePassConfig { issuer: string; jwksUrl: string }
type Jwk = { kty: string; crv?: string; x?: string; y?: string; kid?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export class SuitePassVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private loading?: Promise<void>;
  constructor(private readonly cfg: SuitePassConfig, private readonly fetchFn: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  // 공개 키 목록. 10분 캐시, 모르는 kid가 오면 다시 읽되 30초에 한 번까지만(위조 토큰으로 조회를 폭주시키지 못하게)
  private async load(force: boolean): Promise<void> {
    const age = this.now() - this.fetchedAt;
    if (this.keys.size && (force ? age < 30_000 : age < 600_000)) return;
    this.loading ??= (async () => {
      try {
        const r = await this.fetchFn(this.cfg.jwksUrl, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new PassError('JWKS', `jwks ${r.status}`);
        const body = (await r.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const k of body.keys ?? []) {
          if (k.kty !== 'EC' || k.crv !== 'P-256' || !k.kid || !k.x || !k.y) continue;   // ES256 키만
          next.set(k.kid, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' }));
        }
        if (!next.size) throw new PassError('JWKS', 'jwks에 쓸 수 있는 키가 없습니다');
        this.keys = next; this.fetchedAt = this.now();
      } catch (e) {
        throw e instanceof PassError ? e : new PassError('JWKS', `jwks를 읽지 못했습니다: ${String(e)}`);
      } finally { this.loading = undefined; }
    })();
    await this.loading;
  }

  async verify(token: string | undefined): Promise<PassClaims> {
    if (!token || token.length > 4096) throw new PassError('NO_PASS', '통행증이 없습니다');
    const parts = token.split('.');
    if (parts.length !== 3) throw new PassError('FORMAT', '형식이 올바르지 않습니다');
    const [h, p, s] = parts as [string, string, string];
    let head: { alg?: unknown; kid?: unknown }, c: Record<string, unknown>;
    try { head = JSON.parse(Buffer.from(h, 'base64url').toString()); c = JSON.parse(Buffer.from(p, 'base64url').toString()); }
    catch { throw new PassError('FORMAT', '형식이 올바르지 않습니다'); }
    if (!head || typeof head !== 'object' || !c || typeof c !== 'object') throw new PassError('FORMAT', '형식이 올바르지 않습니다');
    // 알고리즘은 ES256 하나만(none·HS256 등으로 바꿔치기 방지)
    if (head.alg !== 'ES256' || typeof head.kid !== 'string') throw new PassError('ALG', '서명 방식이 올바르지 않습니다');
    await this.load(false);
    let key = this.keys.get(head.kid);
    if (!key) { await this.load(true); key = this.keys.get(head.kid); }
    if (!key) throw new PassError('KID', '알 수 없는 서명 키입니다');
    const sig = Buffer.from(s, 'base64url');
    if (sig.length !== 64 || !verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, sig)) throw new PassError('SIGNATURE', '서명이 올바르지 않습니다');
    const nowSec = this.now() / 1000;
    if (c.iss !== this.cfg.issuer) throw new PassError('ISS', '발급자가 다릅니다');
    if (c.aud !== PRODUCT) throw new PassError('AUD', '다른 제품의 통행증입니다');
    if (typeof c.exp !== 'number' || c.exp <= nowSec) throw new PassError('EXPIRED', '통행증이 만료되었습니다');
    if (typeof c.iat !== 'number' || c.iat > nowSec + 60 || c.exp - c.iat > 3600) throw new PassError('TIME', '발급 시각이 올바르지 않습니다');
    if (!str(c.sub, 36) || !UUID.test(c.sub) || !str(c.tid, 36) || !UUID.test(c.tid) || !str(c.tcd, 20) || !str(c.sid, 64) || !str(c.email, 320)
      || !str(c.csrf, 128) || typeof c.name !== 'string' || !Array.isArray(c.roles)) throw new PassError('CLAIMS', '통행증 내용이 올바르지 않습니다');
    const roles = (c.roles as unknown[]).filter((r): r is CentralRole => !!r && typeof (r as CentralRole).role === 'string')
      .map((r) => ({ role: r.role, scope: r.scope && typeof r.scope === 'object' ? r.scope : {}, ...(typeof r.validFrom === 'string' ? { validFrom: r.validFrom } : {}),
        ...(typeof r.validUntil === 'string' ? { validUntil: r.validUntil } : {}) }));
    return { iss: c.iss as string, aud: c.aud as string, sub: (c.sub as string).toLowerCase(), sid: c.sid as string, tid: (c.tid as string).toLowerCase(), tcd: c.tcd as string,
      email: c.email as string, name: c.name as string, roles, ...(c.rolesOmitted === true ? { rolesOmitted: true } : {}), csrf: c.csrf as string, iat: c.iat, exp: c.exp };
  }
}

// 통행증 모드인가(SUITE_AUTH=1). 켜져 있으면 발급자 주소가 꼭 있어야 한다 — 없으면 조용히 예전 방식으로 떨어지지 않고 기동을 막는다
export function suiteAuthConfig(env: NodeJS.ProcessEnv = process.env): SuitePassConfig | undefined {
  if (env.SUITE_AUTH !== '1') return undefined;
  const issuer = (env.SUITE_ORIGIN ?? '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(issuer)) throw new Error('SUITE_AUTH=1 이면 SUITE_ORIGIN(https://app…)이 필요합니다');
  const jwksUrl = env.SUITE_JWKS_URL || `${issuer}/auth/jwks.json`;
  if (!/^https:\/\//.test(jwksUrl)) throw new Error('SUITE_JWKS_URL은 https 주소여야 합니다');
  return { issuer, jwksUrl };
}
