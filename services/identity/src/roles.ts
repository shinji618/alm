// 제품별 역할 부여(role_assignment + role_assignment_scope). ALM platform/identity/roles.ts·users.ts의 규칙을 제품 카탈로그로 일반화
import { Tx } from './db';
import { E } from './errors';
import { Check, UUID } from './validate';
import { Catalog, scopeKey, ScopeMap, sodConflicts, SodHit } from './catalog';

export interface Assignment { role: string; scope: ScopeMap; validFrom?: string; validUntil?: string }
export const VALID_NOW = `(r.valid_from IS NULL OR r.valid_from <= current_date) AND (r.valid_until IS NULL OR r.valid_until >= current_date)`;
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;

// 사용자별 제품 역할(카탈로그 순서, 같은 역할은 범위 키 순). validOnly면 지금 유효한 것만
export async function loadRoles(c: Tx, userIds: string[], product: string, cat: Catalog, validOnly = false): Promise<Map<string, Assignment[]>> {
  const m = new Map<string, Assignment[]>(userIds.map((i) => [i, []]));
  if (!userIds.length) return m;
  const rows = (await c.query(`
    SELECT r.id::text, r.user_id::text, r.role, r.scope_key, to_char(r.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(r.valid_until, 'YYYY-MM-DD') AS valid_until,
           coalesce((SELECT json_object_agg(s.dimension, s.value) FROM role_assignment_scope s WHERE s.assignment_id = r.id), '{}')::text AS scope
      FROM role_assignment r
     WHERE r.product_code = $1 AND r.user_id IN (SELECT (jsonb_array_elements_text($2::jsonb))::uuid) ${validOnly ? `AND ${VALID_NOW}` : ''}`,
    [product, JSON.stringify(userIds)])).rows;
  const rank = new Map(cat.roles.map((r, i) => [r.code, i]));
  rows.sort((a, b) => (rank.get(a.role) ?? 99) - (rank.get(b.role) ?? 99) || (a.scope_key < b.scope_key ? -1 : a.scope_key > b.scope_key ? 1 : 0));
  for (const r of rows) m.get(r.user_id)?.push(strip({ role: r.role, scope: JSON.parse(r.scope), validFrom: r.valid_from ?? undefined, validUntil: r.valid_until ?? undefined }));
  return m;
}

const today = () => new Date().toISOString().slice(0, 10);

export function parseAssignments(body: unknown, cat: Catalog, now = today()): Assignment[] {
  const k = new Check(body), o = k.obj();
  const list = k.arr(o, 'roles', { required: true, max: 50 });
  const out: Assignment[] = [];
  list.forEach((x, i) => {
    const f = (n: string) => `roles[${i}].${n}`;
    const r = k.obj(x, `roles[${i}]`);
    const role = k.str(r, 'role', { required: true, field: f('role') });
    const def = cat.roles.find((d) => d.code === role);
    if (role && !def) k.fail(f('role'), '알 수 없는 역할');
    const scope: ScopeMap = {};
    const so = r.scope === undefined || r.scope === null ? {} : k.obj(r.scope, f('scope'));
    for (const key of Object.keys(so)) {
      const sd = cat.scopeDimensions.find((d) => d.dimension === key);
      if (!sd) { k.fail(f(`scope.${key}`), '알 수 없는 범위 차원'); continue; }
      const val = k.str(so, key, { max: sd.max, field: f(`scope.${key}`) });
      if (val) scope[key] = val;
    }
    const v: Assignment = { role: role ?? '', scope, validFrom: k.date(r, 'validFrom', f('validFrom')), validUntil: k.date(r, 'validUntil', f('validUntil')) };
    if (v.validFrom && v.validUntil && v.validFrom > v.validUntil) k.fail(f('validUntil'), '유효 시작일보다 앞설 수 없습니다');
    for (const dim of def?.requiredScope ?? []) {
      const sd = cat.scopeDimensions.find((d) => d.dimension === dim);
      if (!scope[dim]) k.fail(f(`scope.${dim}`), `${def!.name}은(는) ${sd?.label ?? dim}이(가) 필수입니다`);
    }
    if (def?.requireValidUntil && !v.validUntil) k.fail(f('validUntil'), `${def.name}은(는) 유효 종료일이 필수입니다`);
    if (def?.maxValidYears && v.validUntil) {
      const max = new Date(`${now}T00:00:00Z`); max.setUTCFullYear(max.getUTCFullYear() + def.maxValidYears);
      if (v.validUntil > max.toISOString().slice(0, 10)) k.fail(f('validUntil'), `${def.name} 유효기간은 최대 ${def.maxValidYears}년입니다`);
    }
    out.push(v);
  });
  for (const ex of cat.exclusiveRoles) if (out.some((r) => r.role === ex) && out.some((r) => r.role !== ex))
    k.fail('roles', `${cat.roles.find((d) => d.code === ex)?.name ?? ex}은(는) 다른 역할과 함께 줄 수 없습니다`);
  const keys = out.map((r) => `${r.role}|${scopeKey(r.scope)}`);
  if (new Set(keys).size !== keys.length) k.fail('roles', '같은 역할·범위가 중복되었습니다');
  k.done();
  return out;
}

// 대상이 지금 유효한 관리자 역할인데, 그 밖에 활성·유효한 관리자가 없으면 마지막 관리자(H-04)
export async function isLastAdmin(c: Tx, userId: string, product: string, cat: Catalog): Promise<boolean> {
  const r = (await c.query(`
    SELECT coalesce(bool_or(r.user_id = $1::uuid), false) AS me, count(DISTINCT r.user_id) FILTER (WHERE r.user_id <> $1::uuid)::int AS others
      FROM role_assignment r JOIN app_user u ON u.id = r.user_id
     WHERE r.product_code = $2 AND r.role = $3 AND u.is_active AND ${VALID_NOW}`, [userId, product, cat.adminRole])).rows[0];
  return !!r.me && Number(r.others) === 0;
}

export async function deleteAssignments(c: Tx, userId: string, product?: string): Promise<number> {
  const r = await c.query(`DELETE FROM role_assignment WHERE user_id = $1::uuid ${product ? 'AND product_code = $2' : ''}`, product ? [userId, product] : [userId]);
  return r.rowCount;
}

// 전체 교체. actorId(제품의 처리자)가 자기 자신이면 거부(H-03), 마지막 관리자 보호(H-04). SoD는 경고로 돌려준다
export async function putAssignments(c: Tx, tenantId: string, userId: string, product: string, cat: Catalog, actorId: string | undefined, body: unknown)
  : Promise<{ roles: Assignment[]; sod: SodHit[] }> {
  const roles = parseAssignments(body, cat);
  if (!UUID.test(userId)) throw E.notFound('사용자를 찾을 수 없습니다');
  if (!(await c.query('SELECT 1 FROM app_user WHERE id = $1::uuid FOR UPDATE', [userId])).rowCount) throw E.notFound('사용자를 찾을 수 없습니다');
  if (actorId && actorId === userId) throw E.sod('자기 자신의 역할은 바꿀 수 없습니다(다른 관리자가 처리)');
  const now = today();
  const validNow = (r: Assignment) => (!r.validFrom || r.validFrom <= now) && (!r.validUntil || r.validUntil >= now);
  if (!roles.some((r) => r.role === cat.adminRole && validNow(r)) && (await isLastAdmin(c, userId, product, cat))) throw E.lastAdmin();
  await deleteAssignments(c, userId, product);
  for (const r of roles) {
    const id = (await c.query(`INSERT INTO role_assignment (tenant_id, user_id, product_code, role, scope_key, valid_from, valid_until, created_by, updated_by)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8::uuid, $8::uuid) RETURNING id::text`,
      [tenantId, userId, product, r.role, scopeKey(r.scope), r.validFrom ?? null, r.validUntil ?? null, actorId ?? null])).rows[0].id;
    for (const [d, v] of Object.entries(r.scope))
      await c.query(`INSERT INTO role_assignment_scope (tenant_id, assignment_id, dimension, value) VALUES ($1::uuid, $2::uuid, $3, $4)`, [tenantId, id, d, v]);
  }
  const saved = (await loadRoles(c, [userId], product, cat)).get(userId)!;
  return { roles: saved, sod: sodConflicts(saved.filter(validNow), cat) };
}

export async function listSodConflicts(c: Tx, product: string, cat: Catalog) {
  const users = (await c.query(`SELECT DISTINCT u.id::text, u.display_name FROM app_user u JOIN role_assignment r ON r.user_id = u.id
     WHERE u.is_active AND r.product_code = $1 AND ${VALID_NOW} ORDER BY u.display_name, u.id::text`, [product])).rows;
  const roles = await loadRoles(c, users.map((u) => u.id), product, cat, true);
  return { items: users.flatMap((u) => sodConflicts(roles.get(u.id)!, cat)
    .map((h) => ({ userId: u.id, displayName: u.display_name, roles: h.roles, rule: h.rule, description: h.description }))) };
}
