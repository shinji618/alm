// 사용자·역할 관리(openapi listUsers·createUser·patchUser·putUserRoles·listSodConflicts, 09 설계서 2·5장)
// 모든 함수는 테넌트 트랜잭션(withTx) 안에서 부른다. 변경 이력은 DB 감사 트리거가 audit_log에 남긴다.
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Check, EMAIL, UUID } from '../../common/validate';
import { E } from '../../common/errors';
import { catalog } from './permissions';
import { IdentityAdapter, RoleScope, scopeKey, ScopeMap, strip, toApiRole } from './adapter';
import { deleteUserRoles, insertUserRole, loadRoles, VALID_NOW } from './roles';
import { sodConflicts, SodHit } from './sod';

export const roleCodes = () => catalog().roles.map((r) => r.code);

export interface UserRow {
  id: string; email: string; displayName: string; roles: Record<string, unknown>[]; isActive: boolean; lastLoginAt?: string;
  [profile: string]: unknown;
}

const today = () => new Date().toISOString().slice(0, 10);

const userSql = (a: IdentityAdapter) => `
  SELECT u.id, u.email, u.display_name, u.is_active, u.last_login_at, u.idp_subject${a.profile ? `, ${a.profile.selectSql}` : ''}
    FROM app_user u ${a.profile?.joinSql ?? ''}`;
function toRow(a: IdentityAdapter, u: Record<string, unknown>, roles: RoleScope[]): UserRow {
  return strip({ id: u.id as string, email: u.email as string, displayName: u.display_name as string,
    ...(a.profile?.toRow(u) ?? {}), roles: roles.map((r) => toApiRole(a, r)), isActive: u.is_active as boolean,
    lastLoginAt: u.last_login_at ? (u.last_login_at as Date).toISOString() : undefined }) as UserRow;
}

export async function getUser(c: PoolClient, a: IdentityAdapter, id: string): Promise<UserRow> {
  if (!UUID.test(id)) throw E.notFound();
  const u = (await c.query(`${userSql(a)} WHERE u.id = $1`, [id])).rows[0];
  if (!u) throw E.notFound();
  return toRow(a, u, (await loadRoles(c, [id])).get(id)!);
}

// ---- 목록 ----
export async function listUsers(c: PoolClient, a: IdentityAdapter, q: { q?: string; role?: string; page?: string; pageSize?: string; sort?: string }) {
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(q.pageSize ?? '50', 10) || 50));
  const where: string[] = [], args: unknown[] = [];
  if (q.q?.trim()) {
    args.push(`%${q.q.trim().replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    where.push(`(u.email ILIKE $${args.length} OR u.display_name ILIKE $${args.length} OR u.employee_no ILIKE $${args.length})`);
  }
  if (q.role) {
    if (!roleCodes().includes(q.role)) throw E.badRequest('role 값이 올바르지 않습니다');
    args.push(q.role);
    where.push(`EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role = $${args.length} AND ${VALID_NOW})`);
  }
  const desc = q.sort?.startsWith('-');
  const SORTS: Record<string, string> = { displayName: 'u.display_name', email: 'u.email', lastLoginAt: 'u.last_login_at', ...(a.profile?.sorts ?? {}) };
  const col = SORTS[(q.sort ?? 'displayName').replace(/^-/, '')];
  if (!col) throw E.badRequest(`sort는 ${Object.keys(SORTS).join('·')} 중 하나(앞에 -면 내림차순)`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await c.query(`SELECT count(*)::int AS n FROM app_user u ${a.profile?.joinSql ?? ''} ${w}`, args)).rows[0].n as number;
  const rows = (await c.query(`${userSql(a)} ${w} ORDER BY ${col} ${desc ? 'DESC' : 'ASC'} NULLS LAST, u.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args)).rows;
  const roles = await loadRoles(c, rows.map((r) => r.id));
  return { items: rows.map((u) => toRow(a, u, roles.get(u.id)!)), page, pageSize, total };
}

// ---- 등록·수정 ----
export interface UserIn { email?: string; displayName?: string; employeeNo?: string; isActive?: boolean; profile: Record<string, unknown> }
export function parseUser(a: IdentityAdapter, body: unknown, partial: boolean): UserIn {
  const k = new Check(body), o = k.obj();
  const v: UserIn = {
    email: k.str(o, 'email', { required: !partial, max: 254, pattern: EMAIL })?.toLowerCase(),
    displayName: k.str(o, 'displayName', { required: !partial, max: 100 }),
    employeeNo: k.str(o, 'employeeNo', { max: 20 }),
    isActive: k.bool(o, 'isActive'),
    profile: a.profile?.parse(k, o) ?? {},
  };
  k.done();
  return v;
}

const isUnique = (e: unknown, constraint: string) =>
  (e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint?.includes(constraint);

export async function createUser(c: PoolClient, a: IdentityAdapter, tenantId: string, actorId: string, body: unknown): Promise<UserRow> {
  const v = parseUser(a, body, false);
  await a.profile?.validate(c, v.profile);
  const id = randomUUID();
  await c.query('SAVEPOINT u');
  try {
    await c.query(
      `INSERT INTO app_user (id, tenant_id, email, display_name, employee_no, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, tenantId, v.email, v.displayName, v.employeeNo ?? null, v.isActive ?? true, actorId]);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT u');
    if (isUnique(e, 'email')) throw E.duplicate('같은 이메일의 사용자가 이미 있습니다');
    throw e;
  }
  await a.profile?.save(c, tenantId, id, actorId, v.profile);
  return getUser(c, a, id);
}

export interface PatchResult { user: UserRow; rolesCleared: boolean }
export async function patchUser(c: PoolClient, a: IdentityAdapter, tenantId: string, id: string, actorId: string, body: unknown): Promise<PatchResult> {
  const v = parseUser(a, body, true);
  if (!UUID.test(id)) throw E.notFound();
  const cur = (await c.query('SELECT id, email, idp_subject, is_active FROM app_user WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound();
  await a.profile?.validate(c, v.profile);
  let rolesCleared = false;
  if (v.email && v.email !== cur.email) {
    if (cur.idp_subject) throw E.badRequest('로그인한 적이 있는(IdP 연결된) 사용자의 이메일은 바꿀 수 없습니다. IdP에서 바꾸면 다음 로그인 때 반영됩니다',
      { errors: [{ field: 'email', code: 'ALM-E100', message: 'IdP 연결된 사용자' }] });
    // H-10: 미연결 사용자의 이메일을 바꾸면 역할을 모두 지운다(다른 계정으로 역할이 넘어가는 것을 막음)
    rolesCleared = (await deleteUserRoles(c, 'r.user_id = $1', [id])) > 0;
  }
  if (v.isActive === false && cur.is_active) {
    if (id === actorId) throw E.sod('자기 자신은 비활성화할 수 없습니다(다른 시스템 관리자가 처리)');
    if (await isLastAdmin(c, id)) throw E.lastAdmin();
  }
  const sets: string[] = [], args: unknown[] = [id];
  const put = (col: string, val: unknown) => { if (val !== undefined) { args.push(val); sets.push(`${col} = $${args.length}`); } };
  put('email', v.email); put('display_name', v.displayName); put('employee_no', v.employeeNo); put('is_active', v.isActive);
  if (sets.length) {
    args.push(actorId);
    await c.query('SAVEPOINT u');
    try {
      await c.query(`UPDATE app_user SET ${sets.join(', ')}, updated_at = now(), updated_by = $${args.length}, version = version + 1 WHERE id = $1`, args);
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT u');
      if (isUnique(e, 'email')) throw E.duplicate('같은 이메일의 사용자가 이미 있습니다');
      throw e;
    }
  }
  await a.profile?.save(c, tenantId, id, actorId, v.profile);
  return { user: await getUser(c, a, id), rolesCleared };
}

// 대상이 지금 유효한 SYS_ADMIN인데, 그 밖에 활성·유효한 SYS_ADMIN이 없으면 마지막 관리자
async function isLastAdmin(c: PoolClient, id: string): Promise<boolean> {
  const r = (await c.query(
    `SELECT bool_or(r.user_id = $1) AS me, count(DISTINCT r.user_id) FILTER (WHERE r.user_id <> $1)::int AS others
       FROM user_role r JOIN app_user u ON u.id = r.user_id
      WHERE r.role = $2 AND u.is_active AND ${VALID_NOW}`, [id, catalog().adminRole])).rows[0];
  return !!r.me && r.others === 0;
}

// ---- 역할 전체 교체 ----
interface RoleIn { role: string; scope: ScopeMap; validFrom?: string; validUntil?: string }
export function parseRoles(body: unknown, a: IdentityAdapter, now = today()): RoleIn[] {
  const cat = catalog();
  const k = new Check(body), o = k.obj();
  const list = k.arr(o, 'roles', { required: true, max: 50 });
  const out: RoleIn[] = [];
  list.forEach((x, i) => {
    const f = (n: string) => `roles[${i}].${n}`;
    const r = k.obj(x, `roles[${i}]`);
    const role = k.str(r, 'role', { required: true, field: f('role') });
    const def = cat.roles.find((d) => d.code === role);
    if (role && !def) k.fail(f('role'), '알 수 없는 역할');
    const scope: ScopeMap = {};
    for (const sf of a.scopeFields) { const val = k.str(r, sf.field, { max: sf.max, field: f(sf.field) }); if (val) scope[sf.dimension] = val; }
    const v: RoleIn = { role: role ?? '', scope, validFrom: k.date(r, 'validFrom', f('validFrom')), validUntil: k.date(r, 'validUntil', f('validUntil')) };
    if (v.validFrom && v.validUntil && v.validFrom > v.validUntil) k.fail(f('validUntil'), '유효 시작일보다 앞설 수 없습니다');
    for (const dim of def?.requiredScope ?? []) {
      const sf = a.scopeFields.find((x) => x.dimension === dim)!;
      if (!scope[dim]) k.fail(f(sf.field), `${def!.name}은(는) ${sf.label}이(가) 필수입니다`);
    }
    if (def?.requireValidUntil && !v.validUntil) k.fail(f('validUntil'), `${def.name}은(는) 유효 종료일이 필수입니다`);
    if (def?.maxValidYears && v.validUntil) {
      const max = new Date(`${now}T00:00:00Z`); max.setUTCFullYear(max.getUTCFullYear() + def.maxValidYears);
      if (v.validUntil > max.toISOString().slice(0, 10)) k.fail(f('validUntil'), `${def.name} 유효기간은 최대 ${def.maxValidYears}년입니다`);
    }
    out.push(v);
  });
  // H-05: 배타 역할(감사인)은 다른 역할과 함께 가질 수 없다
  for (const ex of cat.exclusiveRoles) if (out.some((r) => r.role === ex) && out.some((r) => r.role !== ex))
    k.fail('roles', `${cat.roles.find((d) => d.code === ex)?.name ?? ex}은(는) 다른 역할과 함께 줄 수 없습니다`);
  const keys = out.map((r) => `${r.role}|${scopeKey(r.scope)}`);
  if (new Set(keys).size !== keys.length) k.fail('roles', '같은 역할·범위가 중복되었습니다');
  k.done();
  return out;
}

export interface RolesResult { user: UserRow; sod: SodHit[] }
export async function putUserRoles(c: PoolClient, a: IdentityAdapter, tenantId: string, id: string, actorId: string, body: unknown): Promise<RolesResult> {
  const roles = parseRoles(body, a);
  if (!UUID.test(id)) throw E.notFound();
  if (!(await c.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [id])).rowCount) throw E.notFound();
  if (id === actorId) throw E.sod('자기 자신의 역할은 바꿀 수 없습니다(다른 시스템 관리자가 처리)');   // H-03
  const now = today();
  const validAdmin = roles.some((r) => r.role === catalog().adminRole && (!r.validFrom || r.validFrom <= now) && (!r.validUntil || r.validUntil >= now));
  if (!validAdmin && (await isLastAdmin(c, id))) throw E.lastAdmin();                                  // H-04
  for (const [i, r] of roles.entries()) await a.checkScope(c, r.scope, i);
  await deleteUserRoles(c, 'r.user_id = $1', [id]);
  for (const r of roles) await insertUserRole(c, tenantId, id, actorId, r);
  const user = await getUser(c, a, id);
  const active = roles.filter((r) => (!r.validFrom || r.validFrom <= now) && (!r.validUntil || r.validUntil >= now));
  return { user, sod: sodConflicts(active) };
}

// ---- 직무 충돌 점검 ----
export async function listSodConflicts(c: PoolClient) {
  const ids = (await c.query(`SELECT DISTINCT u.id FROM app_user u JOIN user_role r ON r.user_id = u.id WHERE u.is_active AND ${VALID_NOW}`)).rows.map((r) => r.id as string);
  const names = new Map((await c.query('SELECT id, display_name FROM app_user WHERE id = ANY($1)', [ids])).rows.map((r) => [r.id as string, r.display_name as string]));
  const roles = await loadRoles(c, ids, true);
  const items = ids.sort((x, y) => (names.get(x)! < names.get(y)! ? -1 : names.get(x)! > names.get(y)! ? 1 : x < y ? -1 : 1)).flatMap((userId) =>
    sodConflicts(roles.get(userId)!).map((h) => ({ userId, displayName: names.get(userId)!, roles: h.roles, rule: h.rule, description: h.description })));
  return { items };
}
