// 테넌트·도메인·첫 관리자 등록(런북 13 6장). 관리 화면(3.4 2차) 전까지 운영자가 migrate 작업 정의로 실행한다.
//   node dist/main seed '{"tenant":{"code":"TEST","name":"Okta 시험","idpType":"OIDC"},"domains":["example.com"],
//                        "users":[{"email":"a@example.com","displayName":"홍길동","roles":["SYS_ADMIN"]}]}'
// 소유자(마스터)로 접속한다: tenant·tenant_domain은 앱 계정이 쓸 수 없다(09 8장). 다시 실행해도 같은 결과(멱등).
import { randomUUID } from 'node:crypto';
import { seedFieldMappings } from '../sap/mappings';
import { Client } from 'pg';
import { roleCodes } from '../platform/identity/users';
import { log } from '../common/log';


export interface MasterSeed {
  sites?: { code: string; name: string; address?: string; timeZone?: string; sapLocation?: string }[];
  rooms?: { siteCode: string; code: string; name: string; floor?: string; isStorage?: boolean; sapRoomNo?: string }[];
  // assetClass: SAP 자산클래스 코드(IF-MD-01로 받은 값). 없으면 비워 둔다
  categories?: { code: string; name: string; parentCode?: string; assetClass?: string; usefulLifeYears?: number }[];
  models?: { categoryCode: string; manufacturer: string; name: string; partNo?: string }[];
  vendors?: { no: string; name: string; email?: string; phone?: string }[];
  labelTemplates?: { code: string; name: string; layout?: 'QR_CODE128' | 'QR_ONLY' | 'CODE128_ONLY'; zpl: string; isDefault?: boolean }[];
}

export interface SeedInput {
  // 마스터만 넣을 때는 tenant.code만 주면 된다(있는 테넌트, 이름·도메인은 그대로)
  tenant: { code: string; name?: string; idpType?: 'SAML' | 'OIDC'; jitProvision?: boolean; timeZone?: string };
  domains?: string[];
  users?: { email: string; displayName: string; locale?: 'en' | 'ko'; roles: string[]; validUntil?: string }[];
  // 회사코드: 원래 SAP 마스터 수신(IF-MD-01)으로 들어온다. 그 전 시험용으로만 넣는다(있으면 이름만 갱신)
  companies?: { code: string; name: string }[];
  // SAP 연결: client_id는 cognito-admin createSapClient로 발급한 값(비밀은 넣지 않음). 연결 관리 화면(7.x) 전까지 사용
  sapConnections?: { systemId: string; companyCode: string; clientId: string; clientAlias?: string; allowedCidrs?: string[] }[];
  // ALM 마스터(사이트·룸·카테고리·모델·공급사·라벨 템플릿): 마스터 화면(5.x) 전 DEV·QA 시험용. 키가 같으면 갱신
  masters?: MasterSeed;
}

export function parseSeed(raw: string | undefined): SeedInput {
  if (!raw) throw new Error('seed 입력(JSON)이 없다: node dist/main seed \'{…}\'');
  const s = JSON.parse(raw) as SeedInput;
  if (!/^[A-Z0-9-]{1,18}$/.test(s.tenant?.code ?? '')) throw new Error('tenant.code: 대문자·숫자·하이픈 1~18자');
  if (s.tenant.name !== undefined || s.domains !== undefined) {
    if (!['SAML', 'OIDC'].includes(s.tenant.idpType ?? '')) throw new Error('tenant.idpType: SAML 또는 OIDC');
    if (!s.tenant.name) throw new Error('tenant.name이 없다');
    if (!Array.isArray(s.domains) || !s.domains.length) throw new Error('domains: 이메일 도메인 1개 이상');
    for (const d of s.domains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error(`domains: ${d}는 소문자 도메인이어야 한다`);
  }
  const m = s.masters;
  const code = (v: unknown, max: number, what: string) => { if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(v) || v.length > max) throw new Error(`${what}: ${String(v)}`); };
  for (const x of m?.sites ?? []) { code(x.code, 10, 'masters.sites.code'); if (!x.name) throw new Error('masters.sites.name'); }
  for (const x of m?.rooms ?? []) { code(x.code, 10, 'masters.rooms.code'); code(x.siteCode, 10, 'masters.rooms.siteCode'); if (!x.name) throw new Error('masters.rooms.name'); }
  for (const x of m?.categories ?? []) { code(x.code, 20, 'masters.categories.code'); if (!x.name) throw new Error('masters.categories.name'); }
  for (const x of m?.models ?? []) { code(x.categoryCode, 20, 'masters.models.categoryCode'); if (!x.manufacturer || !x.name) throw new Error('masters.models.manufacturer·name'); }
  for (const x of m?.vendors ?? []) { code(x.no, 10, 'masters.vendors.no'); if (!x.name) throw new Error('masters.vendors.name'); }
  for (const x of m?.labelTemplates ?? []) { code(x.code, 20, 'masters.labelTemplates.code'); if (!x.zpl?.includes('^XA')) throw new Error('masters.labelTemplates.zpl: ZPL(^XA…^XZ)'); }
  for (const u of s.users ?? []) {
    if (!/^[^@\s]+@[^@\s]+$/.test(u.email)) throw new Error(`users.email: ${u.email}`);
    for (const r of u.roles) if (!roleCodes().includes(r)) throw new Error(`users.roles: ${r}`);
    if (u.roles.includes('AUDITOR') && !u.validUntil) throw new Error('AUDITOR는 validUntil이 필요하다');
  }
  for (const co of s.companies ?? []) {
    if (!/^[A-Z0-9]{1,4}$/.test(co.code)) throw new Error(`companies.code: ${co.code}는 SAP 회사코드(대문자·숫자 1~4자)`);
    if (!co.name || co.name.length > 25) throw new Error('companies.name: 1~25자');
  }
  for (const c of s.sapConnections ?? []) {
    if (!/^[A-Z0-9]{3}-\d{3}$/.test(c.systemId)) throw new Error(`sapConnections.systemId: ${c.systemId}는 SID-클라이언트(예: S4D-100)`);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(c.clientId)) throw new Error('sapConnections.clientId: Cognito 앱 클라이언트 ID');
    if (c.clientAlias !== undefined && !/^[A-Z0-9][A-Z0-9_-]{2,11}$/.test(c.clientAlias)) throw new Error('sapConnections.clientAlias: 대문자·숫자·_- 3~12자(SM59 기본 인증 사용자, 예: BSG-S4H100)');
    for (const cidr of c.allowedCidrs ?? []) if (!/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(cidr)) throw new Error(`sapConnections.allowedCidrs: ${cidr}`);
  }
  return s;
}

export async function seed(c: Client, s: SeedInput): Promise<{ tenantId: string; users: number }> {
  const t = s.tenant;
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.actor_type', 'SYSTEM', true)`);
    const existing = t.name === undefined ? (await c.query('SELECT id FROM tenant WHERE code = $1', [t.code])).rows[0]?.id as string | undefined : undefined;
    if (t.name === undefined && !existing) throw new Error(`테넌트 ${t.code}가 없다(name·idpType·domains와 함께 먼저 등록)`);
    const tenantId = existing ?? (await c.query(
      `INSERT INTO tenant (id, code, name, idp_type, idp_provider_name, jit_provision, time_zone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, idp_type = EXCLUDED.idp_type, jit_provision = EXCLUDED.jit_provision,
         time_zone = EXCLUDED.time_zone, updated_at = now(), version = tenant.version + 1
       RETURNING id`,
      [randomUUID(), t.code, t.name, t.idpType, `T-${t.code}`, t.jitProvision ?? false, t.timeZone ?? 'America/New_York'],
    )).rows[0].id as string;
    for (const d of s.domains ?? []) {
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
           ON CONFLICT (user_id, role, scope_key) DO UPDATE SET valid_until = EXCLUDED.valid_until`,
          [randomUUID(), tenantId, userId, role, u.validUntil ?? null]);
      }
    }
    for (const co of s.companies ?? []) {
      await c.query(
        `INSERT INTO company (id, tenant_id, company_code, name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, company_code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [randomUUID(), tenantId, co.code, co.name]);
    }
    for (const sc of s.sapConnections ?? []) {
      const co = (await c.query('SELECT id FROM company WHERE tenant_id = $1 AND company_code = $2', [tenantId, sc.companyCode])).rows[0];
      if (!co) throw new Error(`sapConnections: 회사코드 ${sc.companyCode}가 없다(companies에 함께 넣는다)`);
      await c.query(
        `INSERT INTO sap_connection (id, tenant_id, system_id, company_id, oauth_client_id, allowed_cidrs, client_alias) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, system_id, company_id) DO UPDATE SET oauth_client_id = EXCLUDED.oauth_client_id,
           allowed_cidrs = coalesce(EXCLUDED.allowed_cidrs, sap_connection.allowed_cidrs), client_alias = coalesce(EXCLUDED.client_alias, sap_connection.client_alias),
           is_active = true, updated_at = now()`,
        // allowedCidrs·clientAlias를 빼면 기존 값을 그대로 둔다(별칭만 추가할 때 허용 IP가 지워지지 않게)
        [randomUUID(), tenantId, sc.systemId, co.id, sc.clientId, sc.allowedCidrs ? JSON.stringify(sc.allowedCidrs) : null, sc.clientAlias ?? null]);
    }
    const mc = s.masters ? await seedMasters(c, tenantId, s.masters) : undefined;
    await seedFieldMappings(c, tenantId);   // 기본 필드 매핑(비어 있을 때만)
    await c.query('COMMIT');
    log.info('seed done', { tenant: t.code, tenantId, domains: s.domains ?? [], masters: mc, users: (s.users ?? []).map((u) => u.email.replace(/^(.).*@/, '$1***@')),
      companies: (s.companies ?? []).map((x) => x.code), sapConnections: (s.sapConnections ?? []).map((x) => `${x.systemId}/${x.companyCode}${x.clientAlias ? ` (${x.clientAlias})` : ''}`) });
    return { tenantId, users: s.users?.length ?? 0 };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

// ALM 마스터. 순서: 사이트 → 룸, 카테고리(상위 먼저) → 모델, 공급사, 라벨 템플릿. 같은 키는 갱신
async function seedMasters(c: Client, tenantId: string, m: MasterSeed) {
  const n = { sites: 0, rooms: 0, categories: 0, models: 0, vendors: 0, labelTemplates: 0, missingAssetClasses: [] as string[] };
  for (const x of m.sites ?? []) {
    await c.query(`INSERT INTO site (id, tenant_id, site_code, name, address, time_zone, sap_location) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, site_code) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, time_zone = EXCLUDED.time_zone,
        sap_location = EXCLUDED.sap_location, is_active = true, updated_at = now(), version = site.version + 1`,
    [randomUUID(), tenantId, x.code, x.name, x.address ?? null, x.timeZone ?? null, x.sapLocation ?? null]);
    n.sites++;
  }
  for (const x of m.rooms ?? []) {
    const site = (await c.query('SELECT id FROM site WHERE tenant_id = $1 AND site_code = $2', [tenantId, x.siteCode])).rows[0];
    if (!site) throw new Error(`masters.rooms: 사이트 ${x.siteCode}가 없다`);
    await c.query(`INSERT INTO room (id, tenant_id, site_id, room_code, name, floor, sap_room_no, barcode, is_storage) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, room_code) DO UPDATE SET site_id = EXCLUDED.site_id, name = EXCLUDED.name, floor = EXCLUDED.floor,
        sap_room_no = EXCLUDED.sap_room_no, is_storage = EXCLUDED.is_storage, is_active = true, updated_at = now(), version = room.version + 1`,
    [randomUUID(), tenantId, site.id, x.code, x.name, x.floor ?? null, x.sapRoomNo ?? null, `RM-${x.code}`, x.isStorage ?? false]);
    n.rooms++;
  }
  const cats = [...(m.categories ?? [])].sort((a, b) => Number(!!a.parentCode) - Number(!!b.parentCode));
  for (const x of cats) {
    const parent = x.parentCode ? (await c.query('SELECT id FROM category WHERE tenant_id = $1 AND category_code = $2', [tenantId, x.parentCode])).rows[0]?.id : null;
    if (x.parentCode && !parent) throw new Error(`masters.categories: 상위 ${x.parentCode}가 없다`);
    const cls = x.assetClass ? (await c.query('SELECT id FROM asset_class WHERE tenant_id = $1 AND class_code = $2', [tenantId, x.assetClass])).rows[0]?.id ?? null : null;
    if (x.assetClass && !cls) n.missingAssetClasses.push(`${x.code}:${x.assetClass}`);
    await c.query(`INSERT INTO category (id, tenant_id, category_code, name, parent_id, default_asset_class_id, useful_life_years) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, category_code) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id,
        default_asset_class_id = EXCLUDED.default_asset_class_id, useful_life_years = EXCLUDED.useful_life_years, is_active = true,
        updated_at = now(), version = category.version + 1`,
    [randomUUID(), tenantId, x.code, x.name, parent, cls, x.usefulLifeYears ?? null]);
    n.categories++;
  }
  for (const x of m.models ?? []) {
    const cat = (await c.query('SELECT id FROM category WHERE tenant_id = $1 AND category_code = $2', [tenantId, x.categoryCode])).rows[0];
    if (!cat) throw new Error(`masters.models: 카테고리 ${x.categoryCode}가 없다`);
    await c.query(`INSERT INTO model (id, tenant_id, category_id, manufacturer, model_name, part_no) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, manufacturer, model_name) DO UPDATE SET category_id = EXCLUDED.category_id, part_no = EXCLUDED.part_no,
        is_active = true, updated_at = now(), version = model.version + 1`,
    [randomUUID(), tenantId, cat.id, x.manufacturer, x.name, x.partNo ?? null]);
    n.models++;
  }
  for (const x of m.vendors ?? []) {
    await c.query(`INSERT INTO vendor (id, tenant_id, vendor_no, name, email, phone) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, vendor_no) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, is_active = true,
        updated_at = now(), version = vendor.version + 1`,
    [randomUUID(), tenantId, x.no, x.name, x.email ?? null, x.phone ?? null]);
    n.vendors++;
  }
  for (const x of m.labelTemplates ?? []) {
    if (x.isDefault) await c.query('UPDATE label_template SET is_default = false WHERE tenant_id = $1 AND template_code <> $2', [tenantId, x.code]);
    await c.query(`INSERT INTO label_template (id, tenant_id, template_code, name, layout, zpl, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, template_code) DO UPDATE SET name = EXCLUDED.name, layout = EXCLUDED.layout, zpl = EXCLUDED.zpl,
        is_default = EXCLUDED.is_default, is_active = true, updated_at = now(), version = label_template.version + 1`,
    [randomUUID(), tenantId, x.code, x.name, x.layout ?? 'QR_CODE128', x.zpl, x.isDefault ?? false]);
    n.labelTemplates++;
  }
  return n;
}
