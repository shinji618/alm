// 중앙 ID 서비스의 사용자·역할을 ALM DB에 같은 ID로 옮겨 둔다(미러, WBS 3.13). ALM의 SQL(담당자·요청자·승인자·부서 관리자 판정)은 이 사본을 읽는다.
// 갱신 시점: 로그인 완료, ALM 관리 화면의 변경(중앙 반영 뒤), 중앙 변경 이벤트(SQS), 이관
import { PoolClient } from 'pg';
import { CentralRole, CentralUser } from '../auth/central';
import { deleteUserRoles, insertUserRole } from '../platform/identity/roles';
import { scopeKey } from '../platform/identity/adapter';

export interface MirrorUser { id: string; email: string; displayName: string; employeeNo?: string; isActive?: boolean; idpSubject?: string; touchLogin?: boolean }

// 테넌트 트랜잭션(withTx tenantId) 안에서 부른다
export async function mirrorUser(c: PoolClient, tenantId: string, u: MirrorUser) {
  await c.query(`
    INSERT INTO app_user (id, tenant_id, email, display_name, employee_no, is_active, idp_subject, last_login_at)
    VALUES ($1, $2, lower($3), $4, $5, coalesce($6, true), $7, CASE WHEN $8 THEN now() END)
    ON CONFLICT (id) DO UPDATE SET email = lower($3), display_name = $4, employee_no = $5, is_active = coalesce($6, app_user.is_active),
      idp_subject = coalesce($7, app_user.idp_subject), last_login_at = CASE WHEN $8 THEN now() ELSE app_user.last_login_at END,
      updated_at = now(), version = app_user.version + 1`,
    [u.id, tenantId, u.email, u.displayName, u.employeeNo ?? null, u.isActive ?? null, u.idpSubject ?? null, !!u.touchLogin]);
}

// 중앙의 ALM 역할 전체에 맞춘다. 같은 역할·범위의 행은 그대로 두고(행 ID 유지 — 부서 관리자 화면이 행 ID를 쓴다) 기간만 고친다
export async function mirrorRoles(c: PoolClient, tenantId: string, userId: string, roles: CentralRole[]): Promise<boolean> {
  const cur = (await c.query(`SELECT id, role, scope_key, to_char(valid_from, 'YYYY-MM-DD') AS vf, to_char(valid_until, 'YYYY-MM-DD') AS vu
    FROM user_role WHERE user_id = $1`, [userId])).rows;
  const want = new Map(roles.map((r) => [`${r.role}|${scopeKey(r.scope ?? {})}`, r]));
  let changed = false;
  for (const row of cur) {
    const r = want.get(`${row.role}|${row.scope_key}`);
    if (!r) { await deleteUserRoles(c, 'r.id = $1', [row.id]); changed = true; continue; }
    want.delete(`${row.role}|${row.scope_key}`);
    if ((r.validFrom ?? null) !== row.vf || (r.validUntil ?? null) !== row.vu) {
      await c.query(`UPDATE user_role SET valid_from = $2, valid_until = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
        [row.id, r.validFrom ?? null, r.validUntil ?? null]);
      changed = true;
    }
  }
  for (const r of want.values()) { await insertUserRole(c, tenantId, userId, null, { role: r.role, scope: r.scope ?? {}, validFrom: r.validFrom, validUntil: r.validUntil }); changed = true; }
  return changed;
}

export async function mirrorCentralUser(c: PoolClient, tenantId: string, u: CentralUser) {
  await mirrorUser(c, tenantId, { id: u.id, email: u.email, displayName: u.displayName, employeeNo: u.employeeNo, isActive: u.isActive });
  await mirrorRoles(c, tenantId, u.id, u.roles);
}
