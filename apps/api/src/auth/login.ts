// 로그인 콜백의 사용자 판정(openapi authCallback, 09 6.3). 컨트롤러와 분리해 DB만으로 시험한다.
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Db } from '../db/pool';
import { loadPrincipal, Principal, TenantMatch } from './principal';

export interface IdentityIn {
  username: string;               // Cognito username = '<T-테넌트>_<IdP 사용자 ID>'
  email?: string;
  emailVerified: boolean;         // ID 토큰 email_verified (SAML은 IdP가 보증하므로 true로 본다)
  name?: string;
  idpType: 'SAML' | 'OIDC' | string;
}
export interface RequestMeta { clientId: string; ip?: string; userAgent?: string; correlationId: string; channel?: 'WEB' | 'PDA' }
export type LoginResult =
  | { ok: true; principal: Principal; created: boolean; linked: boolean }
  | { ok: false; reason: 'NO_USER' | 'INACTIVE' | 'NO_VALID_ROLE' | 'EMAIL_UNVERIFIED' };

export async function securityEvent(c: PoolClient, e: {
  tenantId: string; type: 'LOGIN' | 'LOGIN_DENIED' | 'LOGOUT' | 'ACCESS_DENIED' | 'DEVICE_BLOCKED' | 'SAP_AUTH_FAILED'; actorId?: string; meta: Partial<RequestMeta>;
  actorType?: 'USER' | 'SAP' | 'PDA';
  target?: string; detail?: Record<string, unknown>; channel?: 'WEB' | 'PDA' | 'SAP';
}) {
  await c.query(
    `INSERT INTO security_event (id, tenant_id, event_type, actor_id, actor_type, channel, client_id, ip_address, user_agent, target, detail, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [randomUUID(), e.tenantId, e.type, e.actorId ?? null, e.actorType ?? 'USER', e.channel ?? 'WEB', e.meta.clientId ?? null, validIp(e.meta.ip),
      e.meta.userAgent?.slice(0, 300) ?? null, e.target ?? null, e.detail ? JSON.stringify(e.detail) : null, validUuid(e.meta.correlationId)],
  );
}

const validUuid = (s?: string) => (s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null);
const validIp = (s?: string) => (s && /^[0-9a-f.:]+$/i.test(s) ? s.replace(/^::ffff:/, '') : null);

export async function completeLogin(db: Db, t: TenantMatch, id: IdentityIn, meta: RequestMeta): Promise<LoginResult> {
  return db.withTx({ tenantId: t.tenant_id, actorType: meta.channel === 'PDA' ? 'PDA' : 'USER', correlationId: meta.correlationId, clientIp: validIp(meta.ip) ?? undefined }, async (c) => {
    let created = false, linked = false;
    let user = (await c.query('SELECT id, is_active FROM app_user WHERE idp_subject = $1', [t.idp_subject])).rows[0];
    if (!user && id.email) {
      // 미리 등록된 사용자(관리자가 이메일로 등록, idp_subject 비어 있음)에 연결 — 이메일이 검증된 경우만
      const pre = (await c.query('SELECT id, is_active FROM app_user WHERE lower(email) = lower($1) AND idp_subject IS NULL', [id.email])).rows[0];
      if (pre && !(id.emailVerified || id.idpType === 'SAML')) return deny(c, t, meta, 'EMAIL_UNVERIFIED', id);
      if (pre) { user = pre; linked = true; }
    }
    if (!user && t.jit_provision && id.email) {
      user = (await c.query(
        `INSERT INTO app_user (id, tenant_id, email, display_name, idp_subject) VALUES ($1, $2, lower($3), $4, $5) RETURNING id, is_active`,
        [randomUUID(), t.tenant_id, id.email, id.name || id.email, t.idp_subject])).rows[0];
      created = true;
    }
    if (!user) return deny(c, t, meta, 'NO_USER', id);
    if (!user.is_active) return deny(c, t, meta, 'INACTIVE', id, user.id);
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
    await c.query(
      `UPDATE app_user SET idp_subject = $2, email = coalesce(lower($3), email), display_name = coalesce(nullif($4, ''), display_name),
              last_login_at = now(), updated_at = now(), updated_by = $1
        WHERE id = $1`, [user.id, t.idp_subject, id.email ?? null, id.name ?? null]);
    const principal = await loadPrincipal(c, user.id);
    if (!principal) return deny(c, t, meta, 'NO_VALID_ROLE', id, user.id);
    await securityEvent(c, { tenantId: t.tenant_id, type: 'LOGIN', actorId: user.id, meta, channel: meta.channel, detail: { created, linked, idp: id.idpType } });
    return { ok: true, principal, created, linked } as const;
  });
}

async function deny(c: PoolClient, t: TenantMatch, meta: RequestMeta, reason: Extract<LoginResult, { ok: false }>['reason'], id: IdentityIn, userId?: string) {
  await securityEvent(c, { tenantId: t.tenant_id, type: 'LOGIN_DENIED', actorId: userId, meta, channel: meta.channel,
    target: id.email ? id.email.replace(/^(.).*@/, '$1***@') : undefined, detail: { reason, idp: id.idpType } });
  return { ok: false, reason } as const;
}

// 웹 앱 셸이 쓰는 사용자 정보(openapi Me)
export function toMe(p: Principal, navCounts: Record<string, number> = {}) {
  return {
    userId: p.userId, displayName: p.displayName, email: p.email, locale: p.locale, tenantCode: p.tenantCode,
    // 유효 역할만(감사인이면 감사인만) + 암묵 EMPLOYEE
    roles: [...p.roles.filter((r) => p.effectiveRoles.includes(r.role)),
      ...p.effectiveRoles.filter((e) => !p.roles.some((r) => r.role === e)).map((role) => ({ role }))],
    permissions: [...p.permissions.keys()].sort(), navCounts,
  };
}
