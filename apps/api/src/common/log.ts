// 구조화 로그(JSON 한 줄). 토큰·쿠키·비밀은 남기지 않는다(09 10장)
const role = () => process.env.APP_ROLE || process.argv[2] || 'api';
const SECRET_KEYS = /token|secret|password|cookie|authorization|code_verifier/i;
function scrub(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(scrub);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : scrub(x)]));
}
function write(level: string, msg: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, role: role(), msg, ...(extra ? (scrub(extra) as object) : {}) }));
}
export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};
