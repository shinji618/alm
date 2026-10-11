// 사용자·역할 관리(openapi listUsers·createUser·patchUser·putUserRoles·listSodConflicts, 09 설계서 2·5장)
// 모든 함수는 테넌트 트랜잭션(withTx) 안에서 부른다. 변경 이력은 DB 감사 트리거가 audit_log에 남긴다.
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Check, EMAIL, UUID } from '../common/validate';
import { E } from '../common/errors';
import { RoleScope } from '../auth/principal';
import { sodConflicts, SodHit } from './sod';

export const ROLES = ['SYS_ADMIN', 'ASSET_MANAGER', 'DEPT_MANAGER', 'ASSET_ACCOUNTANT', 'COUNTER', 'EMPLOYEE', 'AUDITOR'];

export interface UserRow {
  id: string; email: string; displayName: string; department?: string; costCenterCode?: string;
  roles: RoleScope[]; isActive: boolean; lastLoginAt?: string;
}

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d as string | null) ?? undefined);
const today = () => new Date().toISOString().slice(0, 10);

const ROLE_SQL = `
  SELECT r.user_id, r.role, co.company_code, s.site_code, cc.cost_center_code, r.valid_from, r.valid_until
    FROM user_role r
    LEFT JOIN company co ON co.id = r.company_id
    LEFT JOIN site s ON s.id = r.site_id
    LEFT JOIN cost_center cc ON cc.id = r.cost_center_id`;
const toScope = (r: Record<string, unknown>): RoleScope => strip({ role: r.role as string, companyCode: r.company_code as string,
  siteCode: r.site_code as string, costCenterCode: r.cost_center_code as string, validFrom: day(r.valid_from), validUntil: day(r.valid_until) });
const VALID_NOW = `(r.valid_from IS NULL OR r.valid_from <= current_date) AND (r.valid_until IS NULL OR r.valid_until >= current_date)`;

async function rolesOf(c: PoolClient, ids: string[]): Promise<Map<string, RoleScope[]>> {
  const m = new Map<string, RoleScope[]>(ids.map((i) => [i, []]));
  if (!ids.length) return m;
  for (const r of (await c.query(`${ROLE_SQL} WHERE r.user_id = ANY($1) ORDER BY r.role, cc.cost_center_code NULLS FIRST`, [ids])).rows)
    m.get(r.user_id)!.push(toScope(r));
  return m;
}

const USER_SQL = `
  SELECT u.id, u.email, u.display_name, u.department, cc.cost_center_code, u.is_active, u.last_login_at, u.idp_subject
    FROM app_user u LEFT JOIN cost_center cc ON cc.id = u.cost_center_id`;
function toRow(u: Record<string, unknown>, roles: RoleScope[]): UserRow {
  return strip({ id: u.id as string, email: u.email as string, displayName: u.display_name as string, department: u.department as string,
    costCenterCode: u.cost_center_code as string, roles, isActive: u.is_active as boolean,
    lastLoginAt: u.last_login_at ? (u.last_login_at as Date).toISOString() : undefined });
}

export async function getUser(c: PoolClient, id: string): Promise<UserRow> {
  if (!UUID.test(id)) throw E.notFound();
  const u = (await c.query(`${USER_SQL} WHERE u.id = $1`, [id])).rows[0];
  if (!u) throw E.notFound();
  return toRow(u, (await rolesOf(c, [id])).get(id)!);
}

// ---- 목록 ----
const SORTS: Record<string, string> = { displayName: 'u.display_name', email: 'u.email', lastLoginAt: 'u.last_login_at', department: 'u.department' };
export async function listUsers(c: PoolClient, q: { q?: string; role?: string; page?: string; pageSize?: string; sort?: string }) {
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(q.pageSize ?? '50', 10) || 50));
  const where: string[] = [], args: unknown[] = [];
  if (q.q?.trim()) {
    args.push(`%${q.q.trim().replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    where.push(`(u.email ILIKE $${args.length} OR u.display_name ILIKE $${args.length} OR u.employee_no ILIKE $${args.length})`);
  }
  if (q.role) {
    if (!ROLES.includes(q.role)) throw E.badRequest('role 값이 올바르지 않습니다');
    args.push(q.role);
    where.push(`EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role = $${args.length}::role_code AND ${VALID_NOW})`);
  }
  const desc = q.sort?.startsWith('-');
  const col = SORTS[(q.sort ?? 'displayName').replace(/^-/, '')];
  if (!col) throw E.badRequest(`sort는 ${Object.keys(SORTS).join('·')} 중 하나(앞에 -면 내림차순)`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await c.query(`SELECT count(*)::int AS n FROM app_user u ${w}`, args)).rows[0].n as number;
  const rows = (await c.query(`${USER_SQL} ${w} ORDER BY ${col} ${desc ? 'DESC' : 'ASC'} NULLS LAST, u.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args)).rows;
  const roles = await rolesOf(c, rows.map((r) => r.id));
  return { items: rows.map((u) => toRow(u, roles.get(u.id)!)), page, pageSize, total };
}

// ---- 등록·수정 ----
interface UserIn { email?: string; displayName?: string; employeeNo?: string; department?: string; costCenterId?: string; isActive?: boolean }
function parseUser(body: unknown, partial: boolean): UserIn {
  const k = new Check(body), o = k.obj();
  const v: UserIn = {
    email: k.str(o, 'email', { required: !partial, max: 254, pattern: EMAIL })?.toLowerCase(),
    displayName: k.str(o, 'displayName', { required: !partial, max: 100 }),
    employeeNo: k.str(o, 'employeeNo', { max: 20 }),
    department: k.str(o, 'department', { max: 100 }),
    costCenterId: k.str(o, 'costCenterId', { pattern: UUID }),
    isActive: k.bool(o, 'isActive'),
  };
  k.done();
  return v;
}

async function checkCostCenter(c: PoolClient, id?: string) {
  if (id && !(await c.query('SELECT 1 FROM cost_center WHERE id = $1', [id])).rowCount)
    throw E.badRequest('없는 코스트센터입니다', { errors: [{ field: 'costCenterId', code: 'ALM-E100', message: '없는 코스트센터' }] });
}
const isUnique = (e: unknown, constraint: string) =>
  (e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint?.includes(constraint);

export async function createUser(c: PoolClient, tenantId: string, actorId: string, body: unknown): Promise<UserRow> {
  const v = parseUser(body, false);
  await checkCostCenter(c, v.costCenterId);
  const id = randomUUID();
  await c.query('SAVEPOINT u');
  try {
    await c.query(
      `INSERT INTO app_user (id, tenant_id, email, display_name, employee_no, department, cost_center_id, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, tenantId, v.email, v.displayName, v.employeeNo ?? null, v.department ?? null, v.costCenterId ?? null, v.isActive ?? true, actorId]);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT u');
    if (isUnique(e, 'email')) throw E.duplicate('같은 이메일의 사용자가 이미 있습니다');
    throw e;
  }
  return getUser(c, id);
}

export interface PatchResult { user: UserRow; rolesCleared: boolean }
export async function patchUser(c: PoolClient, id: string, actorId: string, body: unknown): Promise<PatchResult> {
  const v = parseUser(body, true);
  if (!UUID.test(id)) throw E.notFound();
  const cur = (await c.query('SELECT id, email, idp_subject, is_active FROM app_user WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound();
  await checkCostCenter(c, v.costCenterId);
  let rolesCleared = false;
  if (v.email && v.email !== cur.email) {
    if (cur.idp_subject) throw E.badRequest('로그인한 적이 있는(IdP 연결된) 사용자의 이메일은 바꿀 수 없습니다. IdP에서 바꾸면 다음 로그인 때 반영됩니다',
      { errors: [{ field: 'email', code: 'ALM-E100', message: 'IdP 연결된 사용자' }] });
    // H-10: 미연결 사용자의 이메일을 바꾸면 역할을 모두 지운다(다른 계정으로 역할이 넘어가는 것을 막음)
    rolesCleared = ((await c.query('DELETE FROM user_role WHERE user_id = $1', [id])).rowCount ?? 0) > 0;
  }
  if (v.isActive === false && cur.is_active) {
    if (id === actorId) throw E.sod('자기 자신은 비활성화할 수 없습니다(다른 시스템 관리자가 처리)');
    if (await isLastAdmin(c, id)) throw E.lastAdmin();
  }
  const sets: string[] = [], args: unknown[] = [id];
  const put = (col: string, val: unknown) => { if (val !== undefined) { args.push(val); sets.push(`${col} = $${args.length}`); } };
  put('email', v.email); put('display_name', v.displayName); put('employee_no', v.employeeNo); put('department', v.department);
  put('cost_center_id', v.costCenterId); put('is_active', v.isActive);
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
  return { user: await getUser(c, id), rolesCleared };
}

// 대상이 지금 유효한 SYS_ADMIN인데, 그 밖에 활성·유효한 SYS_ADMIN이 없으면 마지막 관리자
async function isLastAdmin(c: PoolClient, id: string): Promise<boolean> {
  const r = (await c.query(
    `SELECT bool_or(r.user_id = $1) AS me, count(DISTINCT r.user_id) FILTER (WHERE r.user_id <> $1)::int AS others
       FROM user_role r JOIN app_user u ON u.id = r.user_id
      WHERE r.role = 'SYS_ADMIN' AND u.is_active AND ${VALID_NOW}`, [id])).rows[0];
  return !!r.me && r.others === 0;
}

// ---- 역할 전체 교체 ----
interface RoleIn { role: string; companyCode?: string; siteCode?: string; costCenterCode?: string; validFrom?: string; validUntil?: string }
export function parseRoles(body: unknown, now = today()): RoleIn[] {
  const k = new Check(body), o = k.obj();
  const list = k.arr(o, 'roles', { required: true, max: 50 });
  const out: RoleIn[] = [];
  list.forEach((x, i) => {
    const f = (n: string) => `roles[${i}].${n}`;
    const r = k.obj(x, `roles[${i}]`);
    const role = k.str(r, 'role', { required: true, field: f('role') });
    if (role && !ROLES.includes(role)) k.fail(f('role'), '알 수 없는 역할');
    const v: RoleIn = { role: role ?? '',
      companyCode: k.str(r, 'companyCode', { max: 4, field: f('companyCode') }), siteCode: k.str(r, 'siteCode', { max: 10, field: f('siteCode') }),
      costCenterCode: k.str(r, 'costCenterCode', { max: 10, field: f('costCenterCode') }),
      validFrom: k.date(r, 'validFrom', f('validFrom')), validUntil: k.date(r, 'validUntil', f('validUntil')) };
    if (v.validFrom && v.validUntil && v.validFrom > v.validUntil) k.fail(f('validUntil'), '유효 시작일보다 앞설 수 없습니다');
    if (role === 'DEPT_MANAGER' && !v.costCenterCode) k.fail(f('costCenterCode'), '부서 관리자는 코스트센터가 필수입니다');
    if (role === 'AUDITOR') {
      const max = new Date(`${now}T00:00:00Z`); max.setUTCFullYear(max.getUTCFullYear() + 1);
      if (!v.validUntil) k.fail(f('validUntil'), '감사인은 유효 종료일이 필수입니다');
      else if (v.validUntil > max.toISOString().slice(0, 10)) k.fail(f('validUntil'), '감사인 유효기간은 최대 1년입니다');
    }
    out.push(v);
  });
  // H-05: 감사인은 다른 역할과 함께 가질 수 없다
  if (out.some((r) => r.role === 'AUDITOR') && out.some((r) => r.role !== 'AUDITOR')) k.fail('roles', '감사인은 다른 역할과 함께 줄 수 없습니다');
  const keys = out.map((r) => [r.role, r.companyCode, r.siteCode, r.costCenterCode].join('|'));
  if (new Set(keys).size !== keys.length) k.fail('roles', '같은 역할·범위가 중복되었습니다');
  k.done();
  return out;
}

async function resolveScope(c: PoolClient, r: RoleIn, i: number) {
  const one = async (sql: string, code: string | undefined, field: string) => {
    if (!code) return null;
    const rows = (await c.query(sql, [code])).rows;
    if (rows.length !== 1) throw E.badRequest(rows.length ? `${code}가 여러 건입니다` : `없는 코드입니다: ${code}`,
      { errors: [{ field: `roles[${i}].${field}`, code: 'ALM-E100', message: rows.length ? '여러 건' : '없는 코드' }] });
    return rows[0].id as string;
  };
  return {
    companyId: await one('SELECT id FROM company WHERE company_code = $1', r.companyCode, 'companyCode'),
    siteId: await one('SELECT id FROM site WHERE site_code = $1', r.siteCode, 'siteCode'),
    costCenterId: await one('SELECT id FROM cost_center WHERE cost_center_code = $1', r.costCenterCode, 'costCenterCode'),
  };
}

export interface RolesResult { user: UserRow; sod: SodHit[] }
export async function putUserRoles(c: PoolClient, tenantId: string, id: string, actorId: string, body: unknown): Promise<RolesResult> {
  const roles = parseRoles(body);
  if (!UUID.test(id)) throw E.notFound();
  if (!(await c.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [id])).rowCount) throw E.notFound();
  if (id === actorId) throw E.sod('자기 자신의 역할은 바꿀 수 없습니다(다른 시스템 관리자가 처리)');   // H-03
  const now = today();
  const validAdmin = roles.some((r) => r.role === 'SYS_ADMIN' && (!r.validFrom || r.validFrom <= now) && (!r.validUntil || r.validUntil >= now));
  if (!validAdmin && (await isLastAdmin(c, id))) throw E.lastAdmin();                                  // H-04
  const scoped = await Promise.all(roles.map((r, i) => resolveScope(c, r, i)));
  await c.query('DELETE FROM user_role WHERE user_id = $1', [id]);
  for (const [i, r] of roles.entries()) {
    const s = scoped[i];
    await c.query(
      `INSERT INTO user_role (id, tenant_id, user_id, role, company_id, site_id, cost_center_id, valid_from, valid_until, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [randomUUID(), tenantId, id, r.role, s.companyId, s.siteId, s.costCenterId, r.validFrom ?? null, r.validUntil ?? null, actorId]);
  }
  const user = await getUser(c, id);
  const active = roles.filter((r) => (!r.validFrom || r.validFrom <= now) && (!r.validUntil || r.validUntil >= now));
  return { user, sod: sodConflicts(active) };
}

// ---- 직무 충돌 점검 ----
export async function listSodConflicts(c: PoolClient) {
  const rows = (await c.query(
    `SELECT u.id, u.display_name, r.role, cc.cost_center_code
       FROM user_role r JOIN app_user u ON u.id = r.user_id LEFT JOIN cost_center cc ON cc.id = r.cost_center_id
      WHERE u.is_active AND ${VALID_NOW} ORDER BY u.display_name, u.id`)).rows;
  type Entry = { name: string; roles: { role: string; costCenterCode?: string }[] };
  const by = new Map<string, Entry>();
  for (const r of rows) {
    const e: Entry = by.get(r.id) ?? { name: r.display_name, roles: [] };
    e.roles.push({ role: r.role, costCenterCode: r.cost_center_code });
    by.set(r.id, e);
  }
  const items = [...by.entries()].flatMap(([userId, e]) =>
    sodConflicts(e.roles).map((h) => ({ userId, displayName: e.name, roles: h.roles, rule: h.rule, description: h.description })));
  return { items };
}
