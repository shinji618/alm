// 토큰 username → 테넌트·사용자·역할·권한(09 6.3). 60초 캐시(역할 회수는 최대 60초 뒤 반영)
import { PoolClient } from 'pg';
import { Db } from '../../db/pool';
import { catalog, effectiveRoles, permissionsOf, Scope } from './permissions';
import { RoleScope } from './adapter';
import { loadRoles } from './roles';

export type { RoleScope } from './adapter';

export interface Principal {
  tenantId: string; tenantCode: string; userId: string; email: string; displayName: string; locale: string;
  roles: RoleScope[]; effectiveRoles: string[]; permissions: Map<string, Scope[]>;
}
export interface TenantMatch { tenant_id: string; idp_subject: string; jit_provision: boolean }

export async function tenantOf(db: Db, username: string): Promise<TenantMatch | undefined> {
  return (await db.query<TenantMatch>('SELECT * FROM auth_tenant_by_username($1)', [username]))[0];
}

// 같은 트랜잭션(SET LOCAL app.tenant_id 된 상태)에서 부른다
export async function loadPrincipal(c: PoolClient, userId: string): Promise<Principal | undefined> {
  const u = (await c.query(
    `SELECT u.id, u.tenant_id, t.code AS tenant_code, u.email, u.display_name, u.locale, u.is_active
       FROM app_user u JOIN tenant t ON t.id = u.tenant_id WHERE u.id = $1`, [userId])).rows[0];
  if (!u || !u.is_active) return undefined;
  const roles: RoleScope[] = (await loadRoles(c, [userId], true)).get(userId)!;
  // 배타 역할(감사인): 있었는데(만료 포함) 지금 유효하지 않으면 EMPLOYEE로 내려가지 않고 거부(openapi authCallback)
  const ex = catalog().exclusiveRoles;
  if (ex.length) {
    const had = (await c.query('SELECT 1 FROM user_role WHERE user_id = $1 AND role = ANY($2)', [userId, ex])).rowCount! > 0;
    if (had && !roles.some((r) => ex.includes(r.role))) return undefined;
  }
  const eff = effectiveRoles(roles.map((r) => r.role));
  return { tenantId: u.tenant_id, tenantCode: u.tenant_code, userId: u.id, email: u.email, displayName: u.display_name,
    locale: u.locale, roles, effectiveRoles: eff, permissions: permissionsOf(eff) };
}

export class PrincipalCache {
  private m = new Map<string, { p: Principal | null; at: number }>();
  constructor(private ttlMs = 60_000, private max = 5_000) {}
  async get(key: string, load: () => Promise<Principal | undefined>): Promise<Principal | undefined> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.p ?? undefined;
    const p = await load();
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(key, { p: p ?? null, at: Date.now() });
    return p;
  }
  clear(key?: string) { if (key) this.m.delete(key); else this.m.clear(); }
  // 관리 화면에서 사용자·역할을 바꾸면 이 인스턴스의 캐시는 바로 지운다(다른 api 작업은 60초 안에 반영)
  clearUser(userId: string) { for (const [k, v] of this.m) if (v.p?.userId === userId) this.m.delete(k); }
}
