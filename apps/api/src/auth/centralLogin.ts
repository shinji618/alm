// 로그인 완료를 중앙 ID 서비스에 위임(WBS 3.13). 중앙이 테넌트·사용자·역할을 판정하고, ALM은 결과를 미러에 반영한 뒤 principal을 만든다.
// 보안 이벤트는 중앙(전 제품 공통)과 ALM(기존 화면·감사) 양쪽에 남긴다.
import { Db } from '../db/pool';
import { Central } from './central';
import { mirrorRoles, mirrorUser } from '../admin/identityMirror';
import { IdentityIn, LoginResult, RequestMeta, securityEvent } from '../platform/identity/login';
import { loadPrincipal, TenantMatch } from '../platform/identity/principal';

type Reason = Extract<LoginResult, { ok: false }>['reason'];
const REASONS: Record<string, Reason> = { INACTIVE: 'INACTIVE', NO_VALID_ROLE: 'NO_VALID_ROLE', EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED' };   // 그 밖(NO_TENANT·PRODUCT_NOT_ENABLED·NO_USER) → NO_USER

export async function centralLogin(db: Db, central: Central, t: TenantMatch & { tenant_code?: string }, id: IdentityIn, meta: RequestMeta): Promise<LoginResult> {
  const r = await central.login({ username: id.username, email: id.email, emailVerified: id.emailVerified, name: id.name, idpType: id.idpType });
  return db.withTx({ tenantId: t.tenant_id, actorType: meta.channel === 'PDA' ? 'PDA' : 'USER', correlationId: meta.correlationId }, async (c) => {
    const deny = async (reason: Reason, detail: Record<string, unknown>, userId?: string) => {
      await securityEvent(c, { tenantId: t.tenant_id, type: 'LOGIN_DENIED', actorId: userId, meta, channel: meta.channel,
        target: id.email ? id.email.replace(/^(.).*@/, '$1***@') : undefined, detail: { reason, idp: id.idpType, central: true, ...detail } });
      return { ok: false, reason } as const;
    };
    if (!r.ok) return deny(REASONS[r.reason] ?? 'NO_USER', { centralReason: r.reason });
    // 중앙 테넌트 코드와 ALM 테넌트(사용자명 T-<코드>_…에서 찾음)가 같아야 한다
    const code = (await c.query('SELECT code FROM tenant WHERE id = $1', [t.tenant_id])).rows[0]?.code;
    if (code !== r.tenant.code) return deny('NO_USER', { centralTenant: r.tenant.code });
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [r.user.id]);
    await mirrorUser(c, t.tenant_id, { id: r.user.id, email: r.user.email, displayName: r.user.displayName, employeeNo: r.user.employeeNo,
      isActive: true, idpSubject: t.idp_subject, touchLogin: true });
    await mirrorRoles(c, t.tenant_id, r.user.id, r.roles);
    const principal = await loadPrincipal(c, r.user.id);
    if (!principal) return deny('NO_VALID_ROLE', {}, r.user.id);
    await securityEvent(c, { tenantId: t.tenant_id, type: 'LOGIN', actorId: r.user.id, meta, channel: meta.channel,
      detail: { created: r.created, linked: r.linked, idp: id.idpType, central: true } });
    return { ok: true, principal, created: r.created, linked: r.linked } as const;
  });
}
