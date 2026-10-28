// 중앙 ID 서비스 클라이언트(WBS 3.13, 17 문서 6장). ALM 백엔드 클라이언트(alm-backend, client_credentials)로 토큰을 받아 호출한다.
// 중앙이 사용자·역할의 원본이고 ALM DB(app_user·user_role)는 같은 ID의 사본(미러)이다(3.13 결정).
import { AlmError, E } from '../common/errors';
import { log } from '../common/log';

export interface CentralConfig { url: string; tokenUrl: string; clientId: string; clientSecret: string }
export interface CentralRole { role: string; scope: Record<string, string>; validFrom?: string; validUntil?: string }
export interface CentralUser { id: string; email: string; displayName: string; employeeNo?: string; isActive: boolean; linked: boolean; lastLoginAt?: string; version: number; roles: CentralRole[] }
export interface LoginIn { username: string; email?: string; emailVerified: boolean; name?: string; idpType: string }
export type CentralLogin =
  | { ok: true; tenant: { id: string; code: string }; user: { id: string; email: string; displayName: string; employeeNo?: string }; roles: CentralRole[]; created: boolean; linked: boolean }
  | { ok: false; reason: string };
export interface ImportUser { id: string; email: string; displayName: string; employeeNo?: string; isActive: boolean; idpSubject?: string; lastLoginAt?: string; roles: CentralRole[] }

// ALM이 쓰는 중앙 API(시험에서는 가짜로 바꾼다)
export interface Central {
  login(body: LoginIn): Promise<CentralLogin>;
  getUser(tenantCode: string, userId: string): Promise<CentralUser | undefined>;
  createUser(tenantCode: string, actorId: string, body: { email: string; displayName: string; employeeNo?: string; isActive?: boolean }): Promise<CentralUser>;
  patchUser(tenantCode: string, userId: string, actorId: string, body: Record<string, unknown>): Promise<CentralUser & { rolesCleared: boolean }>;
  putRoles(tenantCode: string, userId: string, actorId: string, roles: CentralRole[]): Promise<{ roles: CentralRole[]; sod: { rule: string; roles: string[]; description: string }[] }>;
  importUsers(tenantCode: string, users: ImportUser[]): Promise<{ created: number; updated: number; skipped: { id: string; reason: string }[] }>;
}

// 중앙 오류 → ALM 오류(같은 의미의 코드로)
function mapError(status: number, b: { code?: string; message?: string; errors?: { field: string; message: string }[] }): AlmError {
  const m = b.message ?? '중앙 ID 서비스 오류';
  switch (b.code) {
    case 'ID-E100': return E.badRequest(m, { errors: (b.errors ?? []).map((x) => ({ field: x.field, code: 'ALM-E100', message: x.message })) });
    case 'ID-E404': return E.notFound(m);
    case 'ID-E409': return E.duplicate(m);
    case 'ID-E410': return new AlmError(409, 'ALM-E409', m);
    case 'ID-E420': return E.sod(m);
    case 'ID-E421': return E.lastAdmin();
    default: return new AlmError(502, 'ALM-E502', `중앙 ID 서비스 응답 오류(${status})`, { code: b.code });
  }
}

export class CentralClient implements Central {
  private token?: { value: string; until: number };
  constructor(private cfg: CentralConfig, private http: typeof fetch = fetch) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const r = await this.http(this.cfg.tokenUrl, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'id-api/read id-api/write' }) });
    if (!r.ok) throw new AlmError(502, 'ALM-E502', '중앙 ID 서비스 인증 실패', { status: r.status });
    const t = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, until: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  async call<T>(method: string, path: string, body?: unknown, actorId?: string): Promise<{ status: number; body: T }> {
    const send = async () => this.http(`${this.cfg.url}${path}`, { method, signal: AbortSignal.timeout(30_000),   // Aurora 일시정지 재개(DEV)
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json', ...(actorId ? { 'x-actor-id': actorId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let r = await send();
    if (r.status === 401) { this.token = undefined; r = await send(); }   // 토큰 회수·만료 경계
    const text = await r.text();
    const b = text ? JSON.parse(text) : undefined;
    if (r.status >= 500) log.error('central call failed', { method, path: path.replace(/[0-9a-f-]{36}/g, ':id'), status: r.status, code: b?.code });
    return { status: r.status, body: b as T };
  }
  private async ok<T>(method: string, path: string, body?: unknown, actorId?: string): Promise<T> {
    const r = await this.call<T>(method, path, body, actorId);
    if (r.status >= 400) throw mapError(r.status, r.body as never);
    return r.body;
  }

  async login(body: LoginIn): Promise<CentralLogin> {
    const r = await this.call<CentralLogin & { code?: string; reason?: string }>('POST', '/v1/login/complete', body);
    if (r.status === 403 && r.body?.reason) return { ok: false, reason: r.body.reason };
    if (r.status >= 400) throw mapError(r.status, r.body as never);
    return r.body;
  }
  async getUser(t: string, id: string) {
    const r = await this.call<CentralUser>('GET', `/v1/tenants/${encodeURIComponent(t)}/users/${id}`);
    if (r.status === 404) return undefined;
    if (r.status >= 400) throw mapError(r.status, r.body as never);
    return r.body;
  }
  createUser(t: string, actorId: string, body: object) { return this.ok<CentralUser>('POST', `/v1/tenants/${encodeURIComponent(t)}/users`, body, actorId); }
  patchUser(t: string, id: string, actorId: string, body: object) { return this.ok<CentralUser & { rolesCleared: boolean }>('PATCH', `/v1/tenants/${encodeURIComponent(t)}/users/${id}`, body, actorId); }
  putRoles(t: string, id: string, actorId: string, roles: CentralRole[]) {
    return this.ok<{ roles: CentralRole[]; sod: { rule: string; roles: string[]; description: string }[] }>('PUT', `/v1/tenants/${encodeURIComponent(t)}/users/${id}/roles`, { roles }, actorId);
  }
  importUsers(t: string, users: ImportUser[]) { return this.ok<{ created: number; updated: number; skipped: { id: string; reason: string }[] }>('POST', `/v1/tenants/${encodeURIComponent(t)}/import`, { users }); }
}
