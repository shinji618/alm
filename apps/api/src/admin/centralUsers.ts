// 사용자·역할 변경을 중앙 ID 서비스로 보내고(원본), 결과를 ALM 미러에 반영한다(WBS 3.13).
// 입력 검증·범위 값 확인(코스트센터 등 ALM 마스터)은 ALM이 먼저 하고, H-03·H-04·H-10·SoD는 중앙이 판정한다. 프로필(부서·코스트센터·전화)은 ALM에만 있다.
import { PoolClient } from 'pg';
import { Central, CentralRole } from '../auth/central';
import { E } from '../common/errors';
import { UUID } from '../common/validate';
import { IdentityAdapter } from '../platform/identity/adapter';
import { getUser, parseRoles, parseUser, PatchResult, RolesResult, UserRow } from '../platform/identity/users';
import { mirrorCentralUser, mirrorRoles, mirrorUser } from './identityMirror';

export interface CentralCtx { central: Central; tenantId: string; tenantCode: string; actorId: string }

export async function createUserCentral(c: PoolClient, a: IdentityAdapter, x: CentralCtx, body: unknown): Promise<UserRow> {
  const v = parseUser(a, body, false);
  await a.profile?.validate(c, v.profile);
  const u = await x.central.createUser(x.tenantCode, x.actorId, { email: v.email!, displayName: v.displayName!,
    ...(v.employeeNo ? { employeeNo: v.employeeNo } : {}), ...(v.isActive !== undefined ? { isActive: v.isActive } : {}) });
  await mirrorCentralUser(c, x.tenantId, u);
  await a.profile?.save(c, x.tenantId, u.id, x.actorId, v.profile);
  return getUser(c, a, u.id);
}

export async function patchUserCentral(c: PoolClient, a: IdentityAdapter, x: CentralCtx, id: string, body: unknown): Promise<PatchResult> {
  const v = parseUser(a, body, true);
  if (!UUID.test(id)) throw E.notFound();
  await a.profile?.validate(c, v.profile);
  const core = Object.fromEntries(Object.entries({ email: v.email, displayName: v.displayName, employeeNo: v.employeeNo, isActive: v.isActive })
    .filter(([, val]) => val !== undefined));
  let rolesCleared = false;
  if (Object.keys(core).length) {
    const u = await x.central.patchUser(x.tenantCode, id, x.actorId, core);
    rolesCleared = u.rolesCleared;
    await mirrorCentralUser(c, x.tenantId, u);
  } else if (!(await c.query('SELECT 1 FROM app_user WHERE id = $1', [id])).rowCount) throw E.notFound();
  await a.profile?.save(c, x.tenantId, id, x.actorId, v.profile);
  return { user: await getUser(c, a, id), rolesCleared };
}

export async function putUserRolesCentral(c: PoolClient, a: IdentityAdapter, x: CentralCtx, id: string, body: unknown): Promise<RolesResult> {
  const roles = parseRoles(body, a);
  if (!UUID.test(id)) throw E.notFound();
  for (const [i, r] of roles.entries()) await a.checkScope(c, r.scope, i);
  const r = await x.central.putRoles(x.tenantCode, id, x.actorId, roles);
  await ensureMirrored(c, x, id);
  await mirrorRoles(c, x.tenantId, id, r.roles);
  return { user: await getUser(c, a, id), sod: r.sod };
}

// 중앙의 현재 역할에 변경을 적용(부서 관리자 지정·해제 등). 결과 역할을 미러에 반영
export async function updateRolesCentral(c: PoolClient, x: CentralCtx, userId: string, mutate: (roles: CentralRole[]) => CentralRole[]) {
  const u = await x.central.getUser(x.tenantCode, userId);
  if (!u) throw E.notFound('사용자를 찾을 수 없습니다');
  const r = await x.central.putRoles(x.tenantCode, userId, x.actorId, mutate(u.roles));
  await mirrorUser(c, x.tenantId, { id: u.id, email: u.email, displayName: u.displayName, employeeNo: u.employeeNo, isActive: u.isActive });
  await mirrorRoles(c, x.tenantId, userId, r.roles);
  return r;
}

// 미러에 없는 사용자(다른 제품에서 만든 사용자 등)를 먼저 옮긴다
async function ensureMirrored(c: PoolClient, x: CentralCtx, id: string) {
  if ((await c.query('SELECT 1 FROM app_user WHERE id = $1', [id])).rowCount) return;
  const u = await x.central.getUser(x.tenantCode, id);
  if (!u) throw E.notFound();
  await mirrorCentralUser(c, x.tenantId, u);
}
