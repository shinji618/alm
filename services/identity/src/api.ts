// HTTP API 라우터(17 문서 6.4). 호출자 = Cognito 액세스 토큰(client_credentials)의 앱 클라이언트.
//   admin 범위(플랫폼 관리 클라이언트): 테넌트·제품·SSO 관리, 모든 테넌트
//   제품 백엔드(product_client MACHINE): 자기 제품만, 그 제품을 쓰는 테넌트만. read = 조회, write = 변경·로그인 완료
// 처리자: 헤더 X-Actor-Id(제품에서 로그인한 관리자의 중앙 사용자 ID) → 자기 변경 금지(H-03)·변경 감사
import { Db } from './db';
import { E, IdError } from './errors';
import { UUID } from './validate';
import { Events, Publisher } from './events';
import { getProduct, listProducts, productOfClient, registerProduct, RESOURCE_SERVER } from './products';
import { createTenant, getTenant, listTenants, patchTenant, tenantByDomain } from './tenants';
import { createUser, getUser, listUsers, patchUser } from './users';
import { listSodConflicts, loadRoles, putAssignments } from './roles';
import { completeLogin, loginError } from './login';
import { CognitoEnv, deleteSso, getSso, putSso, syncIdps } from './sso';
import { importUsers } from './importer';

export interface Caller { clientId: string; scopes: string[]; admin: boolean; product?: string }
export interface Verifier { verify(token: string): Promise<{ client_id: string; scope?: string }> }
export interface Deps { db: Db; cognito: CognitoEnv; publisher: Publisher; verifier: Verifier; log?: Pick<Console, 'error' | 'info'> }
export interface HttpReq { method: string; path: string; query: Record<string, string | undefined>; headers: Record<string, string | undefined>; body?: unknown }
export interface HttpRes { status: number; body?: unknown; headers?: Record<string, string> }

const scope = (s: string) => `${RESOURCE_SERVER}/${s}`;

export async function authenticate(d: Deps, headers: HttpReq['headers']): Promise<Caller> {
  const h = headers.authorization ?? headers.Authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  if (!token) throw E.unauthenticated();
  let p: { client_id: string; scope?: string };
  try { p = await d.verifier.verify(token); } catch { throw E.unauthenticated('토큰이 올바르지 않거나 만료되었습니다'); }
  const scopes = (p.scope ?? '').split(' ').filter(Boolean);
  const caller: Caller = { clientId: p.client_id, scopes, admin: scopes.includes(scope('admin')) };
  if (!caller.admin) {
    const pc = await d.db.withTx({}, (c) => productOfClient(c, p.client_id));
    if (!pc || pc.kind !== 'MACHINE') throw E.forbidden('등록된 제품 백엔드 클라이언트가 아닙니다');
    caller.product = pc.product;
  }
  return caller;
}

type Handler = (d: Deps, caller: Caller, req: HttpReq, p: Record<string, string>, ev: Events) => Promise<HttpRes>;
const ok = (body: unknown, status = 200): HttpRes => ({ status, body });
const need = (c: Caller, s: 'read' | 'write' | 'admin') => {
  if (c.admin) return;
  if (s === 'admin' || !(c.scopes.includes(scope(s)) || (s === 'read' && c.scopes.includes(scope('write'))))) throw E.forbidden(`${scope(s)} 범위가 필요합니다`);
};
const actorOf = (req: HttpReq) => {
  const a = req.headers['x-actor-id'];
  if (a !== undefined && !UUID.test(a)) throw E.bad('X-Actor-Id: 사용자 ID(UUID)');
  return a;
};
// 이 호출이 다룰 제품: 제품 클라이언트는 자기 제품, 플랫폼 관리자는 ?product=
async function productFor(d: Deps, c: Caller, req: HttpReq) {
  const code = c.product ?? req.query.product;
  if (!code) throw E.bad('product 쿼리가 필요합니다(플랫폼 관리자 호출)');
  return d.db.withTx({}, (tx) => getProduct(tx, code));
}
// 테넌트 접근: 제품 클라이언트는 그 제품을 쓰는 테넌트만(아니면 존재를 알리지 않고 404)
async function tenantFor(d: Deps, c: Caller, code: string) {
  const t = await d.db.withTx({}, (tx) => getTenant(tx, code));
  if (c.product && !t.products.includes(c.product)) throw E.notFound('테넌트를 찾을 수 없습니다');
  return t;
}
const actorTag = (c: Caller, actor?: string) => `${c.product ?? 'platform'}:${actor ?? c.clientId}`;

const routes: [string, RegExp, Handler][] = [
  // ---- 제품(플랫폼) ----
  ['GET', /^\/v1\/products$/, async (d, c) => { need(c, 'admin'); return ok({ items: await d.db.withTx({}, listProducts) }); }],
  ['POST', /^\/v1\/products$/, async (d, c, req) => {
    need(c, 'admin');
    return ok(await d.db.withTx({ actor: actorTag(c) }, (tx) => registerProduct(tx, d.cognito.cip, d.cognito.poolId, req.body)), 201);
  }],
  ['GET', /^\/v1\/products\/(?<code>[^/]+)$/, async (d, c, _r, p) => {
    if (!c.admin && c.product !== p.code) throw E.notFound('제품을 찾을 수 없습니다');
    need(c, 'read');
    return ok(await d.db.withTx({}, (tx) => getProduct(tx, p.code)));
  }],
  // ---- 테넌트(플랫폼) ----
  ['GET', /^\/v1\/tenants$/, async (d, c) => { need(c, 'admin'); return ok({ items: await d.db.withTx({}, listTenants) }); }],
  ['POST', /^\/v1\/tenants$/, async (d, c, req, _p, ev) => {
    need(c, 'admin');
    const t = await d.db.withTx({ actor: actorTag(c) }, (tx) => createTenant(tx, req.body));
    ev.add({ type: 'tenant.updated', tenantId: t.id, tenantCode: t.code });
    return ok(t, 201);
  }],
  // 로그인 화면: 이메일 → 테넌트(IdP 이름). 제품 백엔드(read)도 호출
  ['GET', /^\/v1\/tenants\/lookup$/, async (d, c, req) => { need(c, 'read'); return ok(await d.db.withTx({}, (tx) => tenantByDomain(tx, req.query.email))); }],
  ['GET', /^\/v1\/tenants\/(?<t>[^/]+)$/, async (d, c, _r, p) => { need(c, 'read'); return ok(await tenantFor(d, c, p.t)); }],
  ['PATCH', /^\/v1\/tenants\/(?<t>[^/]+)$/, async (d, c, req, p, ev) => {
    need(c, 'admin');
    const r = await d.db.withTx({ actor: actorTag(c) }, async (tx) => {
      const out = await patchTenant(tx, p.t, req.body);
      if (out.productsChanged) await syncIdps(tx, d.cognito);
      return out;
    });
    ev.add({ type: 'tenant.updated', tenantId: r.tenant.id, tenantCode: r.tenant.code });
    return ok(r.tenant);
  }],
  // ---- SSO 연결(플랫폼) ----
  ['GET', /^\/v1\/tenants\/(?<t>[^/]+)\/sso$/, async (d, c, _r, p) => { need(c, 'admin'); await tenantFor(d, c, p.t); return ok(await getSso(d.cognito, p.t)); }],
  ['PUT', /^\/v1\/tenants\/(?<t>[^/]+)\/sso$/, async (d, c, req, p) => {
    need(c, 'admin'); await tenantFor(d, c, p.t);
    return ok(await d.db.withTx({}, (tx) => putSso(tx, d.cognito, p.t, req.body)));
  }],
  ['DELETE', /^\/v1\/tenants\/(?<t>[^/]+)\/sso$/, async (d, c, _r, p) => {
    need(c, 'admin'); await tenantFor(d, c, p.t);
    return ok(await d.db.withTx({}, (tx) => deleteSso(tx, d.cognito, p.t)));
  }],
  ['POST', /^\/v1\/sso\/sync$/, async (d, c) => { need(c, 'admin'); return ok(await d.db.withTx({}, (tx) => syncIdps(tx, d.cognito))); }],
  // ---- 로그인 완료(제품) ----
  ['POST', /^\/v1\/login\/complete$/, async (d, c, req, _p, ev) => {
    need(c, 'write');
    const prod = await productFor(d, c, req);
    const r = await completeLogin(d.db, prod.code, prod.catalog, c.clientId, req.body, ev);
    if (!r.ok) throw loginError(r);
    return ok(r);
  }],
  // ---- 사용자·역할(제품, 테넌트 범위) ----
  ['GET', /^\/v1\/tenants\/(?<t>[^/]+)\/users$/, async (d, c, req, p) => {
    need(c, 'read');
    const [t, prod] = [await tenantFor(d, c, p.t), await productFor(d, c, req)];
    return ok(await d.db.withTx({ tenantId: t.id }, (tx) => listUsers(tx, prod.code, prod.catalog, req.query)));
  }],
  ['POST', /^\/v1\/tenants\/(?<t>[^/]+)\/users$/, async (d, c, req, p, ev) => {
    need(c, 'write');
    const [t, prod, actor] = [await tenantFor(d, c, p.t), await productFor(d, c, req), actorOf(req)];
    const u = await d.db.withTx({ tenantId: t.id, actor: actorTag(c, actor) }, (tx) => createUser(tx, t.id, actor, prod.code, prod.catalog, req.body));
    ev.add({ type: 'user.created', tenantId: t.id, tenantCode: t.code, userId: u.id });
    return ok(u, 201);
  }],
  ['GET', /^\/v1\/tenants\/(?<t>[^/]+)\/users\/(?<id>[^/]+)$/, async (d, c, req, p) => {
    need(c, 'read');
    const [t, prod] = [await tenantFor(d, c, p.t), await productFor(d, c, req)];
    return ok(await d.db.withTx({ tenantId: t.id }, (tx) => getUser(tx, p.id, prod.code, prod.catalog)));
  }],
  ['PATCH', /^\/v1\/tenants\/(?<t>[^/]+)\/users\/(?<id>[^/]+)$/, async (d, c, req, p, ev) => {
    need(c, 'write');
    const [t, prod, actor] = [await tenantFor(d, c, p.t), await productFor(d, c, req), actorOf(req)];
    const r = await d.db.withTx({ tenantId: t.id, actor: actorTag(c, actor) }, (tx) => patchUser(tx, p.id, actor, prod.code, prod.catalog, req.body));
    ev.add({ type: r.deactivated ? 'user.deactivated' : 'user.updated', tenantId: t.id, tenantCode: t.code, userId: p.id });
    if (r.rolesCleared) ev.add({ type: 'assignment.changed', tenantId: t.id, tenantCode: t.code, userId: p.id });
    return ok({ ...r.user, rolesCleared: r.rolesCleared });
  }],
  // 제품이 principal을 만들 때: 지금 유효한 역할만(valid=now), 기본은 전체
  ['GET', /^\/v1\/tenants\/(?<t>[^/]+)\/users\/(?<id>[^/]+)\/roles$/, async (d, c, req, p) => {
    need(c, 'read');
    if (!UUID.test(p.id)) throw E.notFound('사용자를 찾을 수 없습니다');
    const [t, prod] = [await tenantFor(d, c, p.t), await productFor(d, c, req)];
    return ok(await d.db.withTx({ tenantId: t.id }, async (tx) => {
      const u = (await tx.query(`SELECT is_active FROM app_user WHERE id = $1::uuid`, [p.id])).rows[0];
      if (!u) throw E.notFound('사용자를 찾을 수 없습니다');
      return { userId: p.id, isActive: u.is_active, product: prod.code,
        roles: (await loadRoles(tx, [p.id], prod.code, prod.catalog, req.query.valid === 'now')).get(p.id) };
    }));
  }],
  ['PUT', /^\/v1\/tenants\/(?<t>[^/]+)\/users\/(?<id>[^/]+)\/roles$/, async (d, c, req, p, ev) => {
    need(c, 'write');
    const [t, prod, actor] = [await tenantFor(d, c, p.t), await productFor(d, c, req), actorOf(req)];
    const r = await d.db.withTx({ tenantId: t.id, actor: actorTag(c, actor) }, (tx) => putAssignments(tx, t.id, p.id, prod.code, prod.catalog, actor, req.body));
    ev.add({ type: 'assignment.changed', tenantId: t.id, tenantCode: t.code, userId: p.id, product: prod.code });
    return { status: 200, body: { userId: p.id, product: prod.code, roles: r.roles, sod: r.sod },
      headers: r.sod.length ? { 'x-sod-warning': r.sod.map((h) => h.rule).join(', ') } : undefined };
  }],
  // 제품 사용자 이관(3.13): 같은 ID로 올린다
  ['POST', /^\/v1\/tenants\/(?<t>[^/]+)\/import$/, async (d, c, req, p) => {
    need(c, 'write');
    const [t, prod] = [await tenantFor(d, c, p.t), await productFor(d, c, req)];
    return ok(await d.db.withTx({ tenantId: t.id, actor: actorTag(c, 'import') }, (tx) => importUsers(tx, t.id, prod.code, prod.catalog, req.body)));
  }],
  ['GET', /^\/v1\/tenants\/(?<t>[^/]+)\/sod-conflicts$/, async (d, c, req, p) => {
    need(c, 'read');
    const [t, prod] = [await tenantFor(d, c, p.t), await productFor(d, c, req)];
    return ok(await d.db.withTx({ tenantId: t.id }, (tx) => listSodConflicts(tx, prod.code, prod.catalog)));
  }],
];

// caller를 주면 인증을 건너뛴다(Lambda 직접 호출 = IAM으로 허가된 운영 작업, 플랫폼 관리자로 처리)
export async function route(d: Deps, req: HttpReq, asCaller?: Caller): Promise<HttpRes> {
  const log = d.log ?? console;
  if (req.method === 'GET' && req.path === '/health') return ok({ status: 'UP' });
  const ev = new Events();
  try {
    const caller = asCaller ?? await authenticate(d, req.headers);
    for (const [m, re, h] of routes) {
      const match = re.exec(req.path);
      if (!match) continue;
      if (m !== req.method) continue;
      const res = await h(d, caller, req, { ...(match.groups ?? {}) }, ev);
      await d.publisher.publish(ev.list);
      return res;
    }
    if (routes.some(([, re]) => re.test(req.path))) throw new IdError(405, 'ID-E405', '허용되지 않은 메서드입니다');
    throw E.notFound('없는 경로입니다');
  } catch (e: any) {
    if (e?.name === 'DatabaseResumingException') throw e;   // 진입점이 재시도
    if (e instanceof IdError) {
      return { status: e.status, body: { code: e.code, message: e.message, ...(e.errors ? { errors: e.errors } : {}), ...((e as any).reason ? { reason: (e as any).reason } : {}) } };
    }
    if (e?.code === '23505' || /duplicate key/.test(String(e?.message))) return { status: 409, body: { code: 'ID-E409', message: '이미 있는 값입니다' } };
    log.error(JSON.stringify({ msg: 'unhandled', error: e?.name, detail: String(e?.message ?? e).slice(0, 500) }));
    return { status: 500, body: { code: 'ID-E500', message: '처리하지 못했습니다' } };
  }
}
