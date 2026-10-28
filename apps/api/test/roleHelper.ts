// 시험용 역할 부여: user_role + user_role_scope(범위는 id로 받아 코드로 푼다)
export type Q = (sql: string, args?: unknown[]) => Promise<unknown>;
const TBL: Record<string, [string, string]> = { company: ['company', 'company_code'], site: ['site', 'site_code'], costCenter: ['cost_center', 'cost_center_code'] };
const rowsOf = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? r) as Record<string, unknown>[];

async function codes(q: Q, ids: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [dim, id] of Object.entries(ids)) {
    const [t, col] = TBL[dim];
    out[dim] = rowsOf(await q(`SELECT ${col} AS v FROM ${t} WHERE id = $1`, [id]))[0].v as string;
  }
  return out;
}
const keyOf = (s: Record<string, string>) => Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]) => `${d}=${v}`).join('|');

async function putScope(q: Q, tenantId: string, roleId: string, scope: Record<string, string>) {
  for (const [d, v] of Object.entries(scope))
    await q(`INSERT INTO user_role_scope (id, tenant_id, user_role_id, dimension, value) VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [tenantId, roleId, d, v]);
  await q(`UPDATE user_role SET scope_key = $2 WHERE id = $1`, [roleId, keyOf(scope)]);
}

export async function addRole(q: Q, tenantId: string, userId: string, role: string, scopeIds: Record<string, string> = {}) {
  const scope = await codes(q, scopeIds);
  const r = rowsOf(await q(`INSERT INTO user_role (id, tenant_id, user_id, role, scope_key) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [tenantId, userId, role, keyOf(scope)]));
  await putScope(q, tenantId, r[0].id as string, scope);
}

// 이메일 사용자의 기존 역할 행에 범위를 단다(범위 없던 행에만)
export async function setRoleScopeByEmail(q: Q, email: string, scopeIds: Record<string, string>) {
  const scope = await codes(q, scopeIds);
  for (const r of rowsOf(await q(`SELECT r.id, r.tenant_id FROM user_role r JOIN app_user u ON u.id = r.user_id WHERE u.email = $1`, [email])))
    await putScope(q, r.tenant_id as string, r.id as string, scope);
}
