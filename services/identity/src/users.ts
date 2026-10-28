// 사용자(테넌트 범위, RLS). 제품 관리 화면이 대행 호출한다. 역할은 호출한 제품의 것만 보여 준다
import { Tx } from './db';
import { E } from './errors';
import { Check, EMAIL, UUID } from './validate';
import { Catalog } from './catalog';
import { Assignment, deleteAssignments, isLastAdmin, loadRoles, VALID_NOW } from './roles';
import { getProduct } from './products';

export interface User { id: string; email: string; displayName: string; employeeNo?: string; isActive: boolean; linked: boolean; lastLoginAt?: string; version: number; roles: Assignment[] }
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;
const SELECT = `SELECT u.id::text, u.email, u.display_name, u.employee_no, u.is_active, u.idp_subject IS NOT NULL AS linked, u.version,
  to_char(u.last_login_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_login_at FROM app_user u`;
const toUser = (u: Record<string, any>, roles: Assignment[]): User => strip({ id: u.id, email: u.email, displayName: u.display_name,
  employeeNo: u.employee_no ?? undefined, isActive: u.is_active, linked: u.linked, lastLoginAt: u.last_login_at ?? undefined, version: Number(u.version), roles });

export async function getUser(c: Tx, id: string, product: string, cat: Catalog): Promise<User> {
  if (!UUID.test(id)) throw E.notFound('사용자를 찾을 수 없습니다');
  const u = (await c.query(`${SELECT} WHERE u.id = $1::uuid`, [id])).rows[0];
  if (!u) throw E.notFound('사용자를 찾을 수 없습니다');
  return toUser(u, (await loadRoles(c, [id], product, cat)).get(id)!);
}

const SORTS: Record<string, string> = { displayName: 'u.display_name', email: 'u.email', lastLoginAt: 'u.last_login_at' };
export async function listUsers(c: Tx, product: string, cat: Catalog, q: Record<string, string | undefined>) {
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(q.pageSize ?? '50', 10) || 50));
  const where: string[] = [], args: unknown[] = [];
  if (q.q?.trim()) {
    args.push(`%${q.q.trim().slice(0, 100).replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    where.push(`(u.email ILIKE $${args.length} OR u.display_name ILIKE $${args.length} OR u.employee_no ILIKE $${args.length})`);
  }
  if (q.role) {
    if (!cat.roles.some((r) => r.code === q.role)) throw E.bad('role 값이 올바르지 않습니다');
    args.push(product, q.role);
    where.push(`EXISTS (SELECT 1 FROM role_assignment r WHERE r.user_id = u.id AND r.product_code = $${args.length - 1} AND r.role = $${args.length} AND ${VALID_NOW})`);
  }
  if (q.active === 'true' || q.active === 'false') where.push(`u.is_active = ${q.active}`);
  const desc = q.sort?.startsWith('-'), col = SORTS[(q.sort ?? 'displayName').replace(/^-/, '')];
  if (!col) throw E.bad(`sort는 ${Object.keys(SORTS).join('·')} 중 하나(앞에 -면 내림차순)`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await c.query(`SELECT count(*)::int AS n FROM app_user u ${w}`, args)).rows[0].n);
  const rows = (await c.query(`${SELECT} ${w} ORDER BY ${col} ${desc ? 'DESC' : 'ASC'} NULLS LAST, u.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args)).rows;
  const roles = await loadRoles(c, rows.map((r) => r.id), product, cat);
  return { items: rows.map((u) => toUser(u, roles.get(u.id)!)), page, pageSize, total };
}

interface UserIn { email?: string; displayName?: string; employeeNo?: string | null; isActive?: boolean; version?: number }
function parse(body: unknown, partial: boolean): UserIn {
  const k = new Check(body), o = k.obj();
  const v: UserIn = { email: k.str(o, 'email', { required: !partial, max: 254, pattern: EMAIL })?.toLowerCase(),
    displayName: k.str(o, 'displayName', { required: !partial, max: 100 }), employeeNo: k.str(o, 'employeeNo', { max: 20 }),
    isActive: k.bool(o, 'isActive'), version: k.int(o, 'version', { min: 1 }) };
  if (o.employeeNo === null) v.employeeNo = null;
  k.done();
  return v;
}

export async function createUser(c: Tx, tenantId: string, actorId: string | undefined, product: string, cat: Catalog, body: unknown): Promise<User> {
  const v = parse(body, false);
  if ((await c.query('SELECT 1 FROM app_user WHERE email = $1', [v.email])).rowCount) throw E.conflict('같은 이메일의 사용자가 이미 있습니다');
  const id = (await c.query(`INSERT INTO app_user (tenant_id, email, display_name, employee_no, is_active, created_by, updated_by)
    VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $6::uuid) RETURNING id::text`, [tenantId, v.email, v.displayName, v.employeeNo ?? null, v.isActive ?? true, actorId ?? null])).rows[0].id;
  return getUser(c, id, product, cat);
}

export interface PatchResult { user: User; rolesCleared: boolean; deactivated: boolean }
export async function patchUser(c: Tx, id: string, actorId: string | undefined, product: string, cat: Catalog, body: unknown): Promise<PatchResult> {
  const v = parse(body, true);
  if (!UUID.test(id)) throw E.notFound('사용자를 찾을 수 없습니다');
  const cur = (await c.query('SELECT id, email, idp_subject, is_active, version FROM app_user WHERE id = $1::uuid FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound('사용자를 찾을 수 없습니다');
  if (v.version !== undefined && v.version !== Number(cur.version)) throw E.version();
  let rolesCleared = false;
  if (v.email && v.email !== cur.email) {
    if (cur.idp_subject) throw E.bad('로그인한 적이 있는(IdP 연결된) 사용자의 이메일은 바꿀 수 없습니다. IdP에서 바꾸면 다음 로그인 때 반영됩니다',
      [{ field: 'email', message: 'IdP 연결된 사용자' }]);
    if ((await c.query('SELECT 1 FROM app_user WHERE email = $1 AND id <> $2::uuid', [v.email, id])).rowCount) throw E.conflict('같은 이메일의 사용자가 이미 있습니다');
    // H-10: 미연결 사용자의 이메일을 바꾸면 모든 제품의 역할을 지운다(다른 사람에게 역할이 넘어가는 것을 막음)
    rolesCleared = (await deleteAssignments(c, id)) > 0;
  }
  const deactivated = v.isActive === false && cur.is_active;
  if (deactivated) {
    if (actorId && id === actorId) throw E.sod('자기 자신은 비활성화할 수 없습니다(다른 관리자가 처리)');
    // 이 사용자가 마지막 관리자인 제품이 하나라도 있으면 거부
    const products = (await c.query(`SELECT DISTINCT product_code FROM role_assignment WHERE user_id = $1::uuid`, [id])).rows.map((r) => r.product_code as string);
    for (const p of products) if (await isLastAdmin(c, id, p, p === product ? cat : (await getProduct(c, p)).catalog)) throw E.lastAdmin();
  }
  await c.query(`UPDATE app_user SET email = coalesce($2, email), display_name = coalesce($3, display_name),
      employee_no = CASE WHEN $4::boolean THEN $5::varchar ELSE employee_no END, is_active = coalesce($6, is_active),
      updated_at = now(), updated_by = $7::uuid, version = version + 1 WHERE id = $1::uuid`,
    [id, v.email ?? null, v.displayName ?? null, v.employeeNo !== undefined, v.employeeNo ?? null, v.isActive ?? null, actorId ?? null]);
  return { user: await getUser(c, id, product, cat), rolesCleared, deactivated };
}
