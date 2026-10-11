// 오류 응답 형식 { code, message } — 06 API 명세서 공통 규격
export class AlmError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: Record<string, unknown>) { super(message); }
}
export const E = {
  unauthenticated: (m = '인증이 필요합니다') => new AlmError(401, 'ALM-E402', m),
  forbidden: (m = '권한이 없습니다') => new AlmError(403, 'ALM-E401', m),
  loginDenied: (m = '로그인할 수 없는 사용자입니다') => new AlmError(403, 'ALM-E405', m),
  channel: (m = '이 클라이언트로 호출할 수 없는 API입니다') => new AlmError(403, 'ALM-E407', m),
  badRequest: (m: string, detail?: Record<string, unknown>) => new AlmError(400, 'ALM-E100', m, detail),
  required: (field: string) => new AlmError(400, 'ALM-E101', `필수 값이 없습니다: ${field}`, { field }),
  sod: (m: string) => new AlmError(403, 'ALM-E403', m),
  lastAdmin: () => new AlmError(409, 'ALM-E319', '마지막 시스템 관리자는 역할을 빼거나 비활성화할 수 없습니다'),
  duplicate: (m: string) => new AlmError(409, 'ALM-E321', m),
  notFound: (m = '찾을 수 없습니다') => new AlmError(404, 'ALM-E404', m),
};
