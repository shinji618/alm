// 역할 행 읽기·쓰기(user_role + user_role_scope). 범위는 차원·값 행으로 둔다
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { catalog } from './permissions';
import { RoleScope, scopeKey, ScopeMap, strip } from './adapter';

const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d as string | null) ?? undefined);
export const VALID_NOW = `(r.valid_from IS NULL OR r.valid_from <= current_date) AND (r.valid_until IS NULL OR r.valid_until >= current_date)`;

// 사용자별 역할 행(카탈로그 역할 순서, 같은 역할 안에서는 범위 키 순). validOnly면 지금 유효한 행만
export async function loadRoles(c: Pick<PoolClient, 'query'>, userIds: string[], validOnly = false): Promise<Map<string, RoleScope[]>> {
  const m = new Map<string, RoleScope[]>(userIds.map((i) => [i, []]));
  if (!userIds.length) return m;
  const rows = (await c.query(
    `SELECT r.id, r.user_id, r.role, r.scope_key, r.valid_from, r.valid_until FROM user_role r
      WHERE r.user_id = ANY($1) ${validOnly ? `AND ${VALID_NOW}` : ''}`, [userIds])).rows;
  const scopes = new Map<string, ScopeMap>();
  if (rows.length) for (const s of (await c.query(
    'SELECT user_role_id, dimension, value FROM user_role_scope WHERE user_role_id = ANY($1)', [rows.map((r) => r.id)])).rows)
    (scopes.get(s.user_role_id) ?? scopes.set(s.user_role_id, {}).get(s.user_role_id)!)[s.dimension as string] = s.value;
  const rank = new Map(catalog().roles.map((r, i) => [r.code, i]));
  rows.sort((a, b) => (rank.get(a.role) ?? 99) - (rank.get(b.role) ?? 99) || (a.scope_key < b.scope_key ? -1 : a.scope_key > b.scope_key ? 1 : 0));
  for (const r of rows) m.get(r.user_id)!.push(strip({ role: r.role as string, scope: scopes.get(r.id) ?? {},
    validFrom: day(r.valid_from), validUntil: day(r.valid_until) }));
  return m;
}

export async function insertUserRole(c: PoolClient, tenantId: string, userId: string, actorId: string | null,
  r: { role: string; scope: ScopeMap; validFrom?: string; validUntil?: string }): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO user_role (id, tenant_id, user_id, role, scope_key, valid_from, valid_until, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [id, tenantId, userId, r.role, scopeKey(r.scope), r.validFrom ?? null, r.validUntil ?? null, actorId]);
  for (const [dimension, value] of Object.entries(r.scope))
    await c.query(
      `INSERT INTO user_role_scope (id, tenant_id, user_role_id, dimension, value, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [randomUUID(), tenantId, id, dimension, value, actorId]);
  return id;
}

// 조건(user_role r 기준 WHERE 조각, 인자 포함)에 맞는 역할 행과 그 범위 행을 지운다
export async function deleteUserRoles(c: PoolClient, where: string, args: unknown[]): Promise<number> {
  await c.query(`DELETE FROM user_role_scope WHERE user_role_id IN (SELECT r.id FROM user_role r WHERE ${where})`, args);
  return (await c.query(`DELETE FROM user_role r WHERE ${where}`, args)).rowCount ?? 0;
}
