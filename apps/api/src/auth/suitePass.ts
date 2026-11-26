// 공유 플랫폼(suite) 통행증(통합 WBS 5.4·7.1). 로그인은 플랫폼이 한 번 처리하고(app 주소의 /auth/*), 제품에는 5분짜리 서명된 JWT(ES256)를
// 쿠키 `__Secure-suite_pass`(Path=/alm)로 준다. 검사(서명·발급자·대상·만료)는 세 제품 공통 패키지 @shinji618/platform-auth가 한다.
// 여기에는 ALM의 설정(대상 제품 = alm)만 둔다. 계약: pas-suite README "플랫폼 공통 로그인과 공통 틀"
import { SuitePassVerifier as PlatformVerifier, suiteAuthConfig as platformConfig } from '@shinji618/platform-auth';

export { CSRF_HEADER, csrfMatches, needsCsrf, PASS_COOKIE, PassError } from '@shinji618/platform-auth';
export type { PassClaims } from '@shinji618/platform-auth';
export const PRODUCT = 'alm';

export interface SuitePassConfig { issuer: string; jwksUrl: string }

// 대상 제품은 항상 alm — 다른 제품의 통행증은 받지 않는다
export class SuitePassVerifier extends PlatformVerifier {
  constructor(cfg: SuitePassConfig, fetchFn?: typeof fetch, now?: () => number) { super({ ...cfg, audience: PRODUCT }, fetchFn, now); }
}

// 통행증 모드인가(SUITE_AUTH=1). 켜져 있으면 발급자 주소가 꼭 있어야 한다 — 없으면 조용히 넘어가지 않고 기동을 막는다
export function suiteAuthConfig(env: NodeJS.ProcessEnv = process.env): SuitePassConfig | undefined {
  const c = platformConfig(PRODUCT, env);
  return c && { issuer: c.issuer, jwksUrl: c.jwksUrl };
}
