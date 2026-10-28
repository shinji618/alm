// 제품 등록(6.2): 카탈로그 저장, Cognito 클라이언트(사용자 로그인용 USER, 백엔드용 MACHINE) 준비. 플랫폼 관리(admin 범위)
import { Tx } from './db';
import { E } from './errors';
import { Check, PRODUCT_CODE } from './validate';
import { Catalog, parseCatalog } from './catalog';
import { Cip, createMachineClient, createUserClient, idpName, UserClientIn } from './cognito';

export interface Product { code: string; name: string; catalog: Catalog; clients: { clientId: string; kind: string; name: string }[]; version: number }
export const RESOURCE_SERVER = 'id-api';

export async function getProduct(c: Tx, code: string): Promise<Product> {
  if (!PRODUCT_CODE.test(code)) throw E.notFound('제품을 찾을 수 없습니다');
  const p = (await c.query(`SELECT code, name, catalog::text AS catalog, version FROM product WHERE code = $1`, [code])).rows[0];
  if (!p) throw E.notFound('제품을 찾을 수 없습니다');
  const clients = (await c.query(`SELECT client_id, kind, name FROM product_client WHERE product_code = $1 ORDER BY kind, name`, [code])).rows
    .map((x) => ({ clientId: x.client_id, kind: x.kind, name: x.name }));
  return { code: p.code, name: p.name, catalog: JSON.parse(p.catalog), clients, version: Number(p.version) };
}
export async function listProducts(c: Tx): Promise<Product[]> {
  const codes = (await c.query(`SELECT code FROM product ORDER BY code`)).rows.map((r) => r.code as string);
  return Promise.all(codes.map((x) => getProduct(c, x)));
}
// 호출한 앱 클라이언트 → 제품(토큰 검증 뒤)
export async function productOfClient(c: Tx, clientId: string): Promise<{ product: string; kind: string } | undefined> {
  const r = (await c.query(`SELECT product_code, kind FROM product_client WHERE client_id = $1`, [clientId])).rows[0];
  return r ? { product: r.product_code, kind: r.kind } : undefined;
}

interface RegisterIn { code: string; name: string; catalog: Catalog; userClients: UserClientIn[]; machineClient: boolean }
function parse(body: unknown): RegisterIn {
  const k = new Check(body), o = k.obj();
  const code = k.str(o, 'code', { required: true, pattern: PRODUCT_CODE }) ?? '';
  const name = k.str(o, 'name', { required: true, max: 100 }) ?? '';
  const catalog = parseCatalog(o.catalog, k);
  const urls = (x: Record<string, unknown>, key: string, f: string) => k.arr(x, key, { required: true, max: 10, field: `${f}.${key}` }).map((u, j) => {
    if (typeof u !== 'string' || !/^(https:\/\/|[a-z][a-z0-9.+-]*:\/\/)\S+$/.test(u) || u.startsWith('http://')) k.fail(`${f}.${key}[${j}]`, 'https URL 또는 앱 스킴');
    return String(u);
  });
  const userClients = k.arr(o, 'userClients', { max: 5 }).map((x, i) => {
    const f = `userClients[${i}]`, uc = k.obj(x, f);
    const n = k.str(uc, 'name', { required: true, pattern: /^[a-z][a-z0-9-]{1,40}$/, field: `${f}.name` }) ?? '';
    if (n && !n.startsWith(`${code}-`)) k.fail(`${f}.name`, `제품 코드로 시작(${code}-…)`);
    return { name: n, callbackUrls: urls(uc, 'callbackUrls', f), logoutUrls: urls(uc, 'logoutUrls', f),
      generateSecret: k.bool(uc, 'generateSecret', `${f}.generateSecret`) ?? false,
      accessMinutes: k.int(uc, 'accessMinutes', { min: 5, max: 1440, field: `${f}.accessMinutes` }) ?? 15,
      refreshHours: k.int(uc, 'refreshHours', { min: 1, max: 720, field: `${f}.refreshHours` }) ?? 8 };
  });
  const machineClient = k.bool(o, 'machineClient') ?? true;
  k.done();
  return { code, name, catalog, userClients, machineClient };
}

// 다시 불러도 된다: 카탈로그는 갱신, 클라이언트는 이름으로 없을 때만 만든다(설정 변경은 Cognito 콘솔·후속 작업)
export async function registerProduct(c: Tx, cip: Cip, poolId: string, body: unknown) {
  const v = parse(body);
  const cur = (await c.query(`SELECT catalog::text AS catalog FROM product WHERE code = $1`, [v.code])).rows[0];
  if (cur) {
    // 이미 부여된 역할이 카탈로그에서 빠지면 거부(부여를 먼저 정리)
    const used = (await c.query(`SELECT DISTINCT role FROM role_assignment WHERE product_code = $1`, [v.code])).rows.map((r) => r.role as string);
    const gone = used.filter((r) => !v.catalog.roles.some((d) => d.code === r));
    if (gone.length) throw E.conflict(`부여된 역할을 카탈로그에서 뺄 수 없습니다: ${gone.join(', ')}`);
    await c.query(`UPDATE product SET name = $2, catalog = $3::jsonb, updated_at = now(), version = version + 1 WHERE code = $1`, [v.code, v.name, v.catalog]);
  } else {
    await c.query(`INSERT INTO product (code, name, catalog) VALUES ($1, $2, $3::jsonb)`, [v.code, v.name, v.catalog]);
  }
  const existing = (await c.query(`SELECT name FROM product_client WHERE product_code = $1`, [v.code])).rows.map((r) => r.name as string);
  // 이 제품을 쓰는 테넌트의 IdP를 새 USER 클라이언트에 붙인다
  const idps = (await c.query(`SELECT t.code FROM tenant_product tp JOIN tenant t ON t.id = tp.tenant_id WHERE tp.product_code = $1 ORDER BY t.code`, [v.code]))
    .rows.map((r) => idpName(r.code));
  const created: { name: string; kind: string; clientId: string; clientSecret?: string }[] = [];
  for (const uc of v.userClients) {
    if (existing.includes(uc.name)) continue;
    const r = await createUserClient(cip, poolId, uc, idps);
    await c.query(`INSERT INTO product_client (client_id, product_code, kind, name) VALUES ($1, $2, 'USER', $3)`, [r.clientId, v.code, uc.name]);
    created.push({ name: uc.name, kind: 'USER', ...r });
  }
  const machineName = `${v.code}-backend`;
  if (v.machineClient && !existing.includes(machineName)) {
    const r = await createMachineClient(cip, poolId, machineName, [`${RESOURCE_SERVER}/read`, `${RESOURCE_SERVER}/write`]);
    await c.query(`INSERT INTO product_client (client_id, product_code, kind, name) VALUES ($1, $2, 'MACHINE', $3)`, [r.clientId, v.code, machineName]);
    created.push({ name: machineName, kind: 'MACHINE', ...r });
  }
  return { product: await getProduct(c, v.code), createdClients: created };
}
