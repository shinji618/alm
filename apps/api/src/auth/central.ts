// 중앙 ID 서비스 클라이언트(WBS 3.13, 17 문서 6장). ALM 백엔드 클라이언트(alm-backend, client_credentials)로 토큰을 받아 호출한다.
// 중앙이 사용자·역할의 원본이고 ALM DB(app_user·user_role)는 같은 ID의 사본(미러)이다(3.13 결정).
// 통신(토큰 보관·401 재시도·시간 제한)은 세 제품 공통 패키지 @shinji618/platform-central-id가 한다(통합 WBS 7.1).
// 여기에는 ALM이 쓰는 모양(Central)과 중앙 오류 → ALM 오류 코드 변환만 둔다.
import { CentralIdClient, CentralIdError } from '@shinji618/platform-central-id';
import type { CentralLogin, CentralRole, CentralUser, ImportUser } from '@shinji618/platform-central-id';
import { AlmError, E } from '../common/errors';
import { log } from '../common/log';

export type { CentralLogin, CentralRole, CentralUser, ImportUser };
export interface CentralConfig { url: string; tokenUrl: string; clientId: string; clientSecret: string }
export interface LoginIn { username: string; email?: string; emailVerified: boolean; name?: string; idpType: string }

// ALM이 쓰는 중앙 API(시험에서는 가짜로 바꾼다)
export interface Central {
  login(body: LoginIn): Promise<CentralLogin>;
  getUser(tenantCode: string, userId: string): Promise<CentralUser | undefined>;
  createUser(tenantCode: string, actorId: string, body: { email: string; displayName: string; employeeNo?: string; isActive?: boolean }): Promise<CentralUser>;
  patchUser(tenantCode: string, userId: string, actorId: string, body: Record<string, unknown>): Promise<CentralUser & { rolesCleared: boolean }>;
  putRoles(tenantCode: string, userId: string, actorId: string, roles: CentralRole[]): Promise<{ roles: CentralRole[]; sod: { rule: string; roles: string[]; description: string }[] }>;
  importUsers(tenantCode: string, users: ImportUser[]): Promise<{ created: number; updated: number; skipped: { id: string; reason: string }[] }>;
}

// 중앙 오류 → ALM 오류(같은 의미의 코드로). 통신 실패·5xx·모르는 코드는 502
function mapError(e: unknown): unknown {
  if (!(e instanceof CentralIdError)) return e;
  const m = e.detail?.message ?? '중앙 ID 서비스 오류';
  switch (e.code) {
    case 'ID-E100': return E.badRequest(m, { errors: (e.detail?.errors ?? []).map((x) => ({ field: x.field, code: 'ALM-E100', message: x.message })) });
    case 'ID-E404': return E.notFound(m);
    case 'ID-E409': return E.duplicate(m);
    case 'ID-E410': return new AlmError(409, 'ALM-E409', m);
    case 'ID-E420': return E.sod(m);
    case 'ID-E421': return E.lastAdmin();
  }
  if (e.status === undefined || e.status >= 500) log.error('central call failed', { err: e.message, status: e.status, code: e.code });
  return new AlmError(502, 'ALM-E502', e.status === undefined ? '중앙 ID 서비스에 연결하지 못했습니다' : `중앙 ID 서비스 응답 오류(${e.status})`, { code: e.code });
}
const mapped = <T>(p: Promise<T>): Promise<T> => p.catch((e) => { throw mapError(e); });

export class CentralClient implements Central {
  private readonly c: CentralIdClient;
  constructor(cfg: CentralConfig, http: typeof fetch = fetch) {
    this.c = new CentralIdClient({ ...cfg, scope: 'id-api/read id-api/write' }, { fetch: http });
  }
  login(body: LoginIn) { return mapped(this.c.loginComplete(body)); }
  getUser(t: string, id: string) { return mapped(this.c.getUser(t, id)); }
  createUser(t: string, actorId: string, body: { email: string; displayName: string; employeeNo?: string; isActive?: boolean }) { return mapped(this.c.createUser(t, body, actorId)); }
  async patchUser(t: string, id: string, actorId: string, body: Record<string, unknown>) {
    const u = await mapped(this.c.patchUser(t, id, body, actorId));
    return { ...u, rolesCleared: u.rolesCleared === true };
  }
  putRoles(t: string, id: string, actorId: string, roles: CentralRole[]) { return mapped(this.c.putRoles(t, id, roles, actorId)); }
  importUsers(t: string, users: ImportUser[]) { return mapped(this.c.importUsers(t, users)); }
}
