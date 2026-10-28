// 중앙 ID 서비스 ↔ ALM 미러 동기화(WBS 3.13)
//   이벤트(worker): 중앙 SNS → ALM SQS(원문 전달). 사용자 변경·역할 변경이면 그 사용자를 중앙에서 다시 읽어 미러에 반영
//   이관(ops identity-migrate): ALM 사용자·역할을 같은 ID로 중앙에 올린다(테넌트·도메인·SSO는 플랫폼 관리로 먼저 등록)
import { PoolClient } from 'pg';
import { Db } from '../db/pool';
import { Central, ImportUser } from '../auth/central';
import { log } from '../common/log';
import type { Job } from '../worker/worker';
import { loadRoles } from '../platform/identity/roles';
import { mirrorCentralUser } from './identityMirror';

// 중앙 테넌트 코드 → ALM 테넌트 ID(보안 정의 함수로 RLS 없이 찾는다)
async function almTenantId(db: Db, code: string): Promise<string | undefined> {
  return (await db.query<{ tenant_id: string }>('SELECT tenant_id FROM auth_tenant_by_username($1)', [`T-${code}_x`]))[0]?.tenant_id;
}

export async function refreshUser(db: Db, central: Central, tenantCode: string, userId: string): Promise<'updated' | 'deactivated' | 'skipped'> {
  const tenantId = await almTenantId(db, tenantCode);
  if (!tenantId) return 'skipped';                       // ALM을 쓰지 않는 테넌트
  const u = await central.getUser(tenantCode, userId);
  return db.withTx({ tenantId, actorType: 'SYSTEM' }, async (c) => {
    if (!u) {
      // 중앙에서 사라졌거나 보이지 않으면 비활성화(행은 ALM 업무 데이터가 참조하므로 지우지 않는다)
      const r = await c.query('UPDATE app_user SET is_active = false, updated_at = now(), version = version + 1 WHERE id = $1 AND is_active', [userId]);
      return r.rowCount ? 'deactivated' : 'skipped';
    }
    await mirrorCentralUser(c, tenantId, u);
    return 'updated';
  });
}

export function identityEventHandlers(db: Db, central: Central, onChange: (userId: string) => void = () => undefined) {
  const user = async (j: Job) => {
    if (typeof j.tenantCode !== 'string' || typeof j.userId !== 'string') return;
    if (j.type === 'assignment.changed' && j.product && j.product !== 'alm') return;   // 다른 제품의 역할
    const r = await refreshUser(db, central, j.tenantCode, j.userId);
    log.info('identity event applied', { type: j.type, result: r });
    onChange(j.userId);
  };
  return { 'user.created': user, 'user.updated': user, 'user.deactivated': user, 'assignment.changed': user,
    'tenant.updated': async (j: Job) => { log.info('identity event: tenant updated', { tenantCode: j.tenantCode }); } };
}

// ---- 이관: ALM → 중앙(같은 ID) ----
export async function exportUsers(c: Pick<PoolClient, 'query'>, tenantId: string): Promise<ImportUser[]> {
  const t = (await c.query('SELECT idp_provider_name FROM tenant WHERE id = $1', [tenantId])).rows[0];
  const users = (await c.query(`SELECT id, email, display_name, employee_no, is_active, idp_subject, last_login_at FROM app_user WHERE tenant_id = $1 ORDER BY email`, [tenantId])).rows;
  const roles = await loadRoles(c, users.map((u) => u.id));
  return users.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, ...(u.employee_no ? { employeeNo: u.employee_no } : {}),
    isActive: u.is_active, ...(u.idp_subject ? { idpSubject: `${t.idp_provider_name}_${u.idp_subject}` } : {}),
    ...(u.last_login_at ? { lastLoginAt: (u.last_login_at as Date).toISOString() } : {}),
    roles: roles.get(u.id)!.map((r) => ({ role: r.role, scope: r.scope, ...(r.validFrom ? { validFrom: r.validFrom } : {}), ...(r.validUntil ? { validUntil: r.validUntil } : {}) })) }));
}

// 소유자 연결(RLS 우회)로 모든 테넌트를 읽어 중앙에 올린다. 다시 실행해도 된다(중앙이 ID로 갱신)
export async function migrateToCentral(c: Pick<PoolClient, 'query'>, central: Central, only?: string) {
  const tenants = (await c.query(`SELECT id, code FROM tenant WHERE is_active ${only ? 'AND code = $1' : ''} ORDER BY code`, only ? [only] : [])).rows;
  const out: { tenant: string; users: number; created?: number; updated?: number; skipped?: { id: string; reason: string }[]; error?: string }[] = [];
  for (const t of tenants) {
    const users = await exportUsers(c, t.id);
    try { out.push({ tenant: t.code, users: users.length, ...(await central.importUsers(t.code, users)) }); }
    catch (e) { out.push({ tenant: t.code, users: users.length, error: String((e as Error).message ?? e) }); }
  }
  return out;
}
