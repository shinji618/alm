// 테넌트·도메인·첫 관리자 등록(런북 13 6장). 관리 화면(3.4 2차) 전까지 운영자가 migrate 작업 정의로 실행한다.
//   node dist/main seed '{"tenant":{"code":"TEST","name":"Okta 시험","idpType":"OIDC"},"domains":["example.com"],
//                        "users":[{"email":"a@example.com","displayName":"홍길동","roles":["SYS_ADMIN"]}]}'
// 소유자(마스터)로 접속한다: tenant·tenant_domain은 앱 계정이 쓸 수 없다(09 8장). 다시 실행해도 같은 결과(멱등).
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { log } from '../common/log';

const ROLES = ['SYS_ADMIN', 'ASSET_MANAGER', 'DEPT_MANAGER', 'ASSET_ACCOUNTANT', 'COUNTER', 'EMPLOYEE', 'AUDITOR'] as const;

export interface SeedInput {
  tenant: { code: string; name: string; idpType: 'SAML' | 'OIDC'; jitProvision?: boolean; timeZone?: string };
  domains: string[];
  users?: { email: string; displayName: string; locale?: 'en' | 'ko'; roles: string[]; validUntil?: string }[];
}

export function parseSeed(raw: string | undefined): SeedInput {
  if (!raw) throw new Error('seed 입력(JSON)이 없다: node dist/main seed \'{…}\'');
  const s = JSON.parse(raw) as SeedInput;
  if (!/^[A-Z0-9-]{1,18}$/.test(s.tenant?.code ?? '')) throw new Error('tenant.code: 대문자·숫자·하이픈 1~18자');
  if (!['SAML', 'OIDC'].includes(s.tenant.idpType)) throw new Error('tenant.idpType: SAML 또는 OIDC');
  if (!s.tenant.name) throw new Error('tenant.name이 없다');
  if (!Array.isArray(s.domains) || !s.domains.length) throw new Error('domains: 이메일 도메인 1개 이상');
  for (const d of s.domains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error(`domains: ${d}는 소문자 도메인이어야 한다`);
  for (const u of s.users ?? []) {
    if (!/^[^@\s]+@[^@\s]+$/.test(u.email)) throw new Error(`users.email: ${u.email}`);
    for (const r of u.roles) if (!(ROLES as readonly string[]).includes(r)) throw new Error(`users.roles: ${r}`);
    if (u.roles.includes('AUDITOR') && !u.validUntil) throw new Error('AUDITOR는 validUntil이 필요하다');
  }
  return s;
}

export async function seed(c: Client, s: SeedInput): Promise<{ tenantId: string; users: number }> {
  const t = s.tenant;
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.actor_type', 'SYSTEM', true)`);
    const tenantId = (await c.query(
      `INSERT INTO tenant (id, code, name, idp_type, idp_provider_name, jit_provision, time_zone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, idp_type = EXCLUDED.idp_type, jit_provision = EXCLUDED.jit_provision,
         time_zone = EXCLUDED.time_zone, updated_at = now(), version = tenant.version + 1
       RETURNING id`,
      [randomUUID(), t.code, t.name, t.idpType, `T-${t.code}`, t.jitProvision ?? false, t.timeZone ?? 'America/New_York'],
    )).rows[0].id as string;
    for (const d of s.domains) {
      const r = await c.query(
        `INSERT INTO tenant_domain (id, tenant_id, domain) VALUES ($1, $2, $3)
         ON CONFLICT (domain) DO UPDATE SET is_active = true WHERE tenant_domain.tenant_id = EXCLUDED.tenant_id RETURNING id`,
        [randomUUID(), tenantId, d.toLowerCase()]);
      if (!r.rowCount) throw new Error(`도메인 ${d}는 다른 테넌트에 등록되어 있다`);
    }
    for (const u of s.users ?? []) {
      const userId = (await c.query(
        `INSERT INTO app_user (id, tenant_id, email, display_name, locale) VALUES ($1, $2, lower($3), $4, $5)
         ON CONFLICT (tenant_id, email) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = true, updated_at = now()
         RETURNING id`,
        [randomUUID(), tenantId, u.email, u.displayName, u.locale ?? 'ko'],
      )).rows[0].id as string;
      for (const role of u.roles) {
        await c.query(
          `INSERT INTO user_role (id, tenant_id, user_id, role, valid_until) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, role, company_id, site_id, cost_center_id) DO UPDATE SET valid_until = EXCLUDED.valid_until`,
          [randomUUID(), tenantId, userId, role, u.validUntil ?? null]);
      }
    }
    await c.query('COMMIT');
    log.info('seed done', { tenant: t.code, tenantId, domains: s.domains, users: (s.users ?? []).map((u) => u.email.replace(/^(.).*@/, '$1***@')) });
    return { tenantId, users: s.users?.length ?? 0 };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
