// 로그인 완료(6.1): 제품 백엔드가 Cognito 로그인(ID 토큰 검증) 뒤 호출한다. ALM platform/identity/login.ts의 판정과 같다.
//   사용자명(T-<테넌트>_<IdP 사용자 ID>) → 테넌트, 테넌트가 이 제품을 쓰는지, 사용자 찾기(연결된 사용자 → 미리 등록된 이메일 → JIT 생성),
//   활성 여부, 이 제품의 유효 역할(배타 역할 만료면 거부). 결과는 보안 이벤트로 남긴다
import { Db, Tx } from './db';
import { E } from './errors';
import { Check } from './validate';
import { Catalog } from './catalog';
import { Assignment, loadRoles } from './roles';
import { Events } from './events';

export type DenyReason = 'NO_TENANT' | 'PRODUCT_NOT_ENABLED' | 'NO_USER' | 'INACTIVE' | 'NO_VALID_ROLE' | 'EMAIL_UNVERIFIED';
export type LoginResult =
  | { ok: true; tenant: { id: string; code: string }; user: { id: string; email: string; displayName: string; employeeNo?: string }; roles: Assignment[]; created: boolean; linked: boolean }
  | { ok: false; reason: DenyReason };

interface LoginIn { username: string; email?: string; emailVerified: boolean; name?: string; idpType: string }
function parse(body: unknown): LoginIn {
  const k = new Check(body), o = k.obj();
  const v = { username: k.str(o, 'username', { required: true, max: 255, pattern: /^T-[A-Z0-9-]{1,20}_\S+$/ }) ?? '',
    email: k.str(o, 'email', { max: 254 })?.toLowerCase(), emailVerified: k.bool(o, 'emailVerified') ?? false,
    name: k.str(o, 'name', { max: 100 }), idpType: k.str(o, 'idpType', { required: true, max: 10 }) ?? '' };
  k.done();
  return v;
}

async function event(c: Tx, tenantId: string, type: 'LOGIN' | 'LOGIN_DENIED', product: string, clientId: string, userId: string | null, target: string | null, detail: object) {
  await c.query(`INSERT INTO security_event (tenant_id, event_type, user_id, product_code, client_id, target, detail) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)`,
    [tenantId, type, userId, product, clientId, target, detail]);
}
const mask = (email?: string) => (email ? email.replace(/^(.).*@/, '$1***@') : null);

export async function completeLogin(db: Db, product: string, cat: Catalog, clientId: string, body: unknown, ev: Events): Promise<LoginResult> {
  const v = parse(body);
  const t = await db.withTx({}, async (c) => (await c.query(`SELECT tenant_id::text, tenant_code, jit_provision, is_active FROM tenant_by_username($1)`, [v.username])).rows[0]);
  if (!t || !t.is_active) return { ok: false, reason: 'NO_TENANT' };
  return db.withTx({ tenantId: t.tenant_id, actor: `login:${product}` }, async (c) => {
    const deny = async (reason: DenyReason, userId: string | null = null) => {
      await event(c, t.tenant_id, 'LOGIN_DENIED', product, clientId, userId, mask(v.email), { reason, idp: v.idpType });
      return { ok: false, reason } as const;
    };
    if (!(await c.query(`SELECT 1 FROM tenant_product WHERE tenant_id = $1::uuid AND product_code = $2`, [t.tenant_id, product])).rowCount) return deny('PRODUCT_NOT_ENABLED');
    let created = false, linked = false;
    let user = (await c.query(`SELECT id::text, is_active FROM app_user WHERE idp_subject = $1`, [v.username])).rows[0];
    if (!user && v.email) {
      const pre = (await c.query(`SELECT id::text, is_active FROM app_user WHERE email = $1 AND idp_subject IS NULL`, [v.email])).rows[0];
      if (pre && !(v.emailVerified || v.idpType === 'SAML')) return deny('EMAIL_UNVERIFIED');
      if (pre) { user = pre; linked = true; }
    }
    if (!user && t.jit_provision && v.email) {
      user = (await c.query(`INSERT INTO app_user (tenant_id, email, display_name, idp_subject) VALUES ($1::uuid, $2, $3, $4) RETURNING id::text, is_active`,
        [t.tenant_id, v.email, v.name || v.email, v.username])).rows[0];
      created = true;
    }
    if (!user) return deny('NO_USER');
    if (!user.is_active) return deny('INACTIVE', user.id);
    const u = (await c.query(`UPDATE app_user SET idp_subject = $2, email = coalesce($3, email), display_name = coalesce(nullif($4, ''), display_name),
        last_login_at = now(), updated_at = now() WHERE id = $1::uuid RETURNING id::text, email, display_name, employee_no`,
      [user.id, v.username, v.email ?? null, v.name ?? null])).rows[0];
    const roles = (await loadRoles(c, [user.id], product, cat, true)).get(user.id)!;
    // 배타 역할(감사인): 부여된 적이 있는데 지금 유효하지 않으면 암묵 역할로 내려가지 않고 거부
    if (cat.exclusiveRoles.length) {
      const had = (await c.query(`SELECT 1 FROM role_assignment WHERE user_id = $1::uuid AND product_code = $2 AND role IN (SELECT jsonb_array_elements_text($3::jsonb))`,
        [user.id, product, JSON.stringify(cat.exclusiveRoles)])).rowCount > 0;
      if (had && !roles.some((r) => cat.exclusiveRoles.includes(r.role))) return deny('NO_VALID_ROLE', user.id);
    }
    await event(c, t.tenant_id, 'LOGIN', product, clientId, user.id, null, { created, linked, idp: v.idpType });
    if (created) ev.add({ type: 'user.created', tenantId: t.tenant_id, tenantCode: t.tenant_code, userId: user.id });
    else if (linked) ev.add({ type: 'user.updated', tenantId: t.tenant_id, tenantCode: t.tenant_code, userId: user.id });
    return { ok: true, tenant: { id: t.tenant_id, code: t.tenant_code },
      user: { id: u.id, email: u.email, displayName: u.display_name, ...(u.employee_no ? { employeeNo: u.employee_no } : {}) }, roles, created, linked } as const;
  });
}

export const loginError = (r: Extract<LoginResult, { ok: false }>) => Object.assign(E.forbidden(`로그인할 수 없습니다: ${r.reason}`), { reason: r.reason });
