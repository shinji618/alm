// 구조화 로그(JSON 한 줄). 토큰·쿠키·비밀은 남기지 않는다(09 10장) — 가리는 규칙은 세 제품 공통 패키지(통합 WBS 7.1)
import { scrub } from '@shinji618/platform-http';

const role = () => process.env.APP_ROLE || process.argv[2] || 'api';
function write(level: string, msg: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, role: role(), msg, ...(extra ? (scrub(extra) as object) : {}) }));
}
export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};
