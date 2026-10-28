// 테넌트·도메인·테넌트 제품(플랫폼 관리, admin 범위)
import { Tx } from './db';
import { E } from './errors';
import { Check, TENANT_CODE, PRODUCT_CODE } from './validate';

export interface Tenant { id: string; code: string; name: string; jitProvision: boolean; isActive: boolean; domains: string[]; products: string[]; version: number }

const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

async function rows(c: Tx, where = '', args: unknown[] = []): Promise<Tenant[]> {
  const r = await c.query(`
    SELECT t.id::text, t.code, t.name, t.jit_provision, t.is_active, t.version,
           coalesce((SELECT json_agg(d.domain ORDER BY d.domain) FROM tenant_domain d WHERE d.tenant_id = t.id), '[]')::text AS domains,
           coalesce((SELECT json_agg(p.product_code ORDER BY p.product_code) FROM tenant_product p WHERE p.tenant_id = t.id), '[]')::text AS products
      FROM tenant t ${where} ORDER BY t.code`, args);
  return r.rows.map((x) => ({ id: x.id, code: x.code, name: x.name, jitProvision: x.jit_provision, isActive: x.is_active,
    version: Number(x.version), domains: JSON.parse(x.domains), products: JSON.parse(x.products) }));
}
export const listTenants = (c: Tx) => rows(c);
export async function getTenant(c: Tx, code: string): Promise<Tenant> {
  if (!TENANT_CODE.test(code)) throw E.notFound('테넌트를 찾을 수 없습니다');
  const t = (await rows(c, 'WHERE t.code = $1', [code]))[0];
  if (!t) throw E.notFound('테넌트를 찾을 수 없습니다');
  return t;
}

interface TenantIn { code?: string; name?: string; jitProvision?: boolean; isActive?: boolean; domains?: string[]; products?: string[] }
function parse(body: unknown, partial: boolean): TenantIn {
  const k = new Check(body), o = k.obj();
  const v: TenantIn = {
    code: partial ? undefined : k.str(o, 'code', { required: true, pattern: TENANT_CODE }),
    name: k.str(o, 'name', { required: !partial, max: 100 }),
    jitProvision: k.bool(o, 'jitProvision'), isActive: partial ? k.bool(o, 'isActive') : undefined,
  };
  if (o.domains !== undefined) v.domains = k.arr(o, 'domains', { max: 20 }).map((d, i) => {
    const s = typeof d === 'string' ? d.trim().toLowerCase() : '';
    if (!DOMAIN.test(s)) k.fail(`domains[${i}]`, '도메인 형식이 아닙니다');
    return s;
  });
  if (o.products !== undefined) v.products = k.arr(o, 'products', { max: 20 }).map((p, i) => {
    if (typeof p !== 'string' || !PRODUCT_CODE.test(p)) k.fail(`products[${i}]`, '제품 코드 형식이 아닙니다');
    return String(p);
  });
  k.done();
  return v;
}

async function setDomains(c: Tx, tenantId: string, domains: string[]) {
  const taken = (await c.query(`SELECT d.domain, t.code FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id
    WHERE d.domain IN (SELECT jsonb_array_elements_text($1::jsonb)) AND d.tenant_id <> $2::uuid`, [JSON.stringify(domains), tenantId])).rows;
  if (taken.length) throw E.conflict(`다른 테넌트가 쓰는 도메인입니다: ${taken.map((x) => `${x.domain}(${x.code})`).join(', ')}`);
  await c.query(`DELETE FROM tenant_domain WHERE tenant_id = $1::uuid AND domain NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`, [tenantId, JSON.stringify(domains)]);
  await c.query(`INSERT INTO tenant_domain (domain, tenant_id) SELECT d, $1::uuid FROM jsonb_array_elements_text($2::jsonb) d ON CONFLICT (domain) DO NOTHING`,
    [tenantId, JSON.stringify(domains)]);
}
async function setProducts(c: Tx, tenantId: string, products: string[]) {
  const known = (await c.query(`SELECT code FROM product WHERE code IN (SELECT jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(products)])).rows.map((r) => r.code);
  const missing = products.filter((p) => !known.includes(p));
  if (missing.length) throw E.bad(`등록되지 않은 제품: ${missing.join(', ')}`, [{ field: 'products', message: '등록되지 않은 제품' }]);
  await c.query(`DELETE FROM tenant_product WHERE tenant_id = $1::uuid AND product_code NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`, [tenantId, JSON.stringify(products)]);
  await c.query(`INSERT INTO tenant_product (tenant_id, product_code) SELECT $1::uuid, p FROM jsonb_array_elements_text($2::jsonb) p ON CONFLICT DO NOTHING`,
    [tenantId, JSON.stringify(products)]);
}

export async function createTenant(c: Tx, body: unknown): Promise<Tenant> {
  const v = parse(body, false);
  if ((await c.query('SELECT 1 FROM tenant WHERE code = $1', [v.code])).rowCount) throw E.conflict(`이미 있는 테넌트 코드입니다: ${v.code}`);
  const id = (await c.query(`INSERT INTO tenant (code, name, jit_provision) VALUES ($1, $2, $3) RETURNING id::text`,
    [v.code, v.name, v.jitProvision ?? false])).rows[0].id as string;
  if (v.domains) await setDomains(c, id, v.domains);
  if (v.products) await setProducts(c, id, v.products);
  return getTenant(c, v.code!);
}

export async function patchTenant(c: Tx, code: string, body: unknown): Promise<{ tenant: Tenant; productsChanged: boolean }> {
  const cur = await getTenant(c, code);
  const v = parse(body, true);
  await c.query(`UPDATE tenant SET name = coalesce($2, name), jit_provision = coalesce($3, jit_provision), is_active = coalesce($4, is_active),
    updated_at = now(), version = version + 1 WHERE id = $1::uuid`, [cur.id, v.name ?? null, v.jitProvision ?? null, v.isActive ?? null]);
  if (v.domains) await setDomains(c, cur.id, v.domains);
  if (v.products) await setProducts(c, cur.id, v.products);
  const tenant = await getTenant(c, code);
  return { tenant, productsChanged: JSON.stringify(tenant.products) !== JSON.stringify(cur.products) };
}

// 로그인 화면: 이메일 도메인 → 테넌트 코드(IdP 이름 T-<code>)
export async function tenantByDomain(c: Tx, email: unknown): Promise<{ tenantCode: string; idpName: string }> {
  const domain = typeof email === 'string' && email.includes('@') ? email.split('@').pop()!.trim().toLowerCase() : '';
  const t = (await c.query(`SELECT t.code FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id WHERE d.domain = $1 AND t.is_active`, [domain])).rows[0];
  if (!t) throw E.notFound('등록된 회사 도메인이 아닙니다');
  return { tenantCode: t.code, idpName: `T-${t.code}` };
}
