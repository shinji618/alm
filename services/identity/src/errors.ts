// 오류 응답: { code, message, errors? }. HTTP 상태와 코드(ID-Exxx)
export interface FieldError { field: string; message: string }
export class IdError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors?: FieldError[]) { super(message); }
}
export const E = {
  bad: (message: string, errors?: FieldError[]) => new IdError(400, 'ID-E100', message, errors),
  unauthenticated: (m = '인증이 필요합니다') => new IdError(401, 'ID-E401', m),
  forbidden: (m = '권한이 없습니다') => new IdError(403, 'ID-E403', m),
  notFound: (m = '찾을 수 없습니다') => new IdError(404, 'ID-E404', m),
  conflict: (m: string) => new IdError(409, 'ID-E409', m),
  version: () => new IdError(409, 'ID-E410', '다른 사람이 먼저 바꿨습니다. 다시 읽고 시도하세요'),
  sod: (m: string) => new IdError(409, 'ID-E420', m),            // 자기 변경 금지(H-03)
  lastAdmin: () => new IdError(409, 'ID-E421', '마지막 관리자의 관리자 역할은 회수·비활성화할 수 없습니다'),  // H-04
};
