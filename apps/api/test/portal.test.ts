// Portal 연동 API(09 앱 연동 계약 v1): 매니페스트·피드 모양과 가드의 PORTAL 채널 판정. DB 없이 돌아간다(주체 조회는 가짜 캐시로 대신한다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { catalog, permissionFor } from '../src/platform/identity/permissions';
import { AuthGuard, channelOfPath } from '../src/http/auth.guard';
import { OPERATION } from '../src/http/context';
import { PrincipalCache } from '../src/platform/identity/principal';
import type { Principal } from '../src/platform/identity/principal';
import { AlmError } from '../src/common/errors';
import { SharedLimiter, MemoryCounterStore } from '../src/common/shared';
import { buildManifest, parseLimit, toPortalItem } from '../src/portal/feed';
import type { Config } from '../src/config';

catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));
const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';

test('채널·권한 카탈로그: /api/v1/portal/* 는 PORTAL, 작업은 portal.feed', () => {
  assert.equal(channelOfPath('/api/v1/portal/inbox'), 'PORTAL');
  assert.equal(channelOfPath('/api/v1/requests'), 'WEB');
  for (const op of ['portalGetManifest', 'portalGetInbox', 'portalGetBadges']) assert.equal(permissionFor(op), 'portal.feed');
});

test('매니페스트: 계약 v1, 주소는 APP_ORIGIN에서, 선언하지 않은 기능은 비워 둔다', () => {
  const m = buildManifest({ appOrigin: 'https://alm.example.test/' });
  assert.equal(m.contractVersion, 1);
  assert.equal(m.appId, 'alm');
  assert.equal(m.launchUrl, 'https://alm.example.test/');
  assert.equal(m.apiBase, 'https://alm.example.test/api/v1/portal');
  assert.deepEqual(m.feeds, { approvalInbox: '/inbox', calendar: '/calendar-feed', badges: '/badges' });
  assert.deepEqual(m.menu.map((x) => x.key), ['requests']);
  assert.equal(m.notifications.sends, false);
  assert.deepEqual(m.lifecycle, { tenantExport: '/tenant-export', tenantImport: '/tenant-import', erasureHook: '/erase' });   // R1은 선언만 하고 호출하면 501(ALM-E501)
});

test('결재 대기 건 변환: 제목·단계·딥링크, 금액은 보내지 않는다', () => {
  const it = toPortalItem({ approvalId: 'a1', targetId: 'r1', targetNo: 'REQ-0007', summary: 'AT-1 SAP 등록 → CC100', requesterName: '김요청', approverRole: 'DEPT_MANAGER', waitingSince: '2026-11-04T10:00:00.000Z' });
  assert.deepEqual(it, { id: 'a1', title: '[REQ-0007] AT-1 SAP 등록 → CC100', kind: 'ASSET_REQUEST', requesterName: '김요청', stepLabel: '부서 관리자', arrivedAt: '2026-11-04T10:00:00.000Z', deepLink: '/requests/r1' });
  const long = toPortalItem({ approvalId: 'a2', targetId: 'r2', targetNo: 'N', summary: 'x'.repeat(500) });
  assert.equal(long.title.length, 200);
  assert.equal(toPortalItem({ approvalId: 'a3', targetId: 'r3', approverRole: 'CUSTOM' }).stepLabel, 'CUSTOM');
});

test('limit: 기본 50, 1~200으로 맞춘다', () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('abc'), 50);
  assert.equal(parseLimit('0'), 1);
  assert.equal(parseLimit('9999'), 200);
  assert.equal(parseLimit('25'), 25);
});

// ---- 가드(PORTAL 채널) ----
const principal = { tenantId: T, userId: U, permissions: new Map() } as unknown as Principal;
function guard(portal: Config['portal'], found: Principal | undefined, central: Record<string, string> = {}) {
  const cfg = { portal } as Config;
  const cache = new PrincipalCache();
  const origGet = cache.get.bind(cache);
  cache.get = (async (key: string) => { seen.push(key); return found; }) as typeof origGet;
  const seen: string[] = [];
  const cognito = { verifyAccess: async (t: string) => { const [, client, scope] = t.split('|'); return { sub: 's', username: 'm', client_id: client, token_use: 'access', scope, exp: 0 }; } };
  const reflector = { get: (key: string) => (key === OPERATION ? op.current : false) };
  const db = { query: async (_sql: string, p: string[]) => [{ id: central[p[0]] ?? null }] };
  const g = new AuthGuard(reflector as never, cfg, db as never, cognito as never, cache, {} as never, new SharedLimiter(new MemoryCounterStore()), null);
  return { g, seen };
}
const op = { current: 'portalGetInbox' };
function ctx(auth: string | undefined, query: Record<string, string> = { tenantId: T, userSub: U }, path = '/api/v1/portal/inbox') {
  const req = { path, query, alm: { correlationId: 'c' }, header: (n: string) => (n.toLowerCase() === 'authorization' ? auth : undefined) };
  const res = { setHeader: () => undefined };
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }), getHandler: () => () => undefined, req };
}
const rejects = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof AlmError && e.code === code);

test('가드: 설정이 없거나 다른 클라이언트면 ALM-E407', async () => {
  op.current = 'portalGetInbox';
  await rejects(guard(undefined, principal).g.canActivate(ctx('Bearer at|portal-backend|') as never), 'ALM-E407');
  await rejects(guard({ clientIds: ['portal-backend'] }, principal).g.canActivate(ctx('Bearer at|alm-web|') as never), 'ALM-E407');
});

test('가드: 범위를 정했으면 토큰에 있어야 한다', async () => {
  const p = { clientIds: ['portal-backend'], scope: 'id-api/portal.feed' };
  await rejects(guard(p, principal).g.canActivate(ctx('Bearer at|portal-backend|openid') as never), 'ALM-E407');
  assert.equal(await guard(p, principal).g.canActivate(ctx('Bearer at|portal-backend|openid id-api/portal.feed') as never), true);
});

test('가드: tenantId·userSub 형식 검사, 활성 사용자가 아니면 403, 통과하면 주체를 채운다', async () => {
  const p = { clientIds: ['portal-backend'] };
  await rejects(guard(p, principal).g.canActivate(ctx('Bearer at|portal-backend|', { tenantId: 'x', userSub: U }) as never), 'ALM-E100');
  await rejects(guard(p, principal).g.canActivate(ctx('Bearer at|portal-backend|', {}) as never), 'ALM-E100');
  await rejects(guard(p, undefined).g.canActivate(ctx('Bearer at|portal-backend|') as never), 'ALM-E401');
  const { g, seen } = guard(p, principal);
  const c = ctx('Bearer at|portal-backend|');
  assert.equal(await g.canActivate(c as never), true);
  assert.equal((c.req.alm as { principal?: Principal }).principal, principal);
  assert.deepEqual(seen, [`portal:${T}:${U}`]);
});

test('가드: Portal이 보내는 중앙 테넌트 ID를 ALM 테넌트 ID로 바꿔 쓴다(0021)', async () => {
  const p = { clientIds: ['portal-backend'] };
  const CENTRAL = '9b713b63-5074-4c82-9a91-58aab684d859';
  const { g, seen } = guard(p, principal, { [CENTRAL]: T });
  assert.equal(await g.canActivate(ctx('Bearer at|portal-backend|', { tenantId: CENTRAL, userSub: U }) as never), true);
  assert.deepEqual(seen, [`portal:${T}:${U}`], '캐시·DB 문맥은 ALM 테넌트 ID');
});

test('가드: 매니페스트는 사용자 문맥 없이 클라이언트만 확인한다', async () => {
  op.current = 'portalGetManifest';
  const { g, seen } = guard({ clientIds: ['portal-backend'] }, undefined);
  assert.equal(await g.canActivate(ctx('Bearer at|portal-backend|', {}, '/api/v1/portal/manifest') as never), true);
  assert.deepEqual(seen, []);
  op.current = 'portalGetInbox';
});

test('가드: 토큰이 없으면 401', async () => {
  await assert.rejects(guard({ clientIds: ['portal-backend'] }, principal).g.canActivate(ctx(undefined) as never), (e: unknown) => e instanceof AlmError && e.status === 401);
});

// ---- ALM → Portal 알림(09 §6) ----
import { PortalNotifier, toPortalJob, PORTAL_EVENTS } from '../src/notify/portal';

test('알림 변환: 승인 요청·결과만, 딥링크는 앱 안 경로, dedupeKey는 메일 알림 id', () => {
  const j = toPortalJob(T, { recipientId: U, template: 'APPROVAL_REQUESTED', params: { requestNo: 'REQ-1', requester: '김요청', secret: 'x' }, subjectType: 'ASSET_REQUEST', subjectId: 'r1' }, 'n1');
  assert.deepEqual(j, { type: 'portal-notify', tenantId: T, userSub: U, eventCode: 'approval.requested', titleKey: 'alm.notify.approvalRequested', params: { requestNo: 'REQ-1', requester: '김요청' }, linkUrl: '/requests/r1', dedupeKey: 'alm:n1' });
  assert.equal(toPortalJob(T, { recipientId: U, template: 'EXPIRY', params: {} }, 'n2'), undefined);
  assert.equal(toPortalJob(T, { email: 'a@b.c', template: 'APPROVAL_DECIDED', params: {} }, 'n3'), undefined);
  assert.ok((PORTAL_EVENTS as readonly string[]).includes(toPortalJob(T, { recipientId: U, template: 'APPROVAL_DECIDED', params: {} }, 'n4')!.eventCode));
});

test('매니페스트: 알림 송신 설정이 있을 때만 sends=true', () => {
  const cfg = { appOrigin: 'https://a.test', portalNotify: { url: 'u', tokenUrl: 't', clientId: 'c', clientSecret: 's' } };
  assert.deepEqual(buildManifest(cfg).notifications, { sends: true, events: ['approval.requested', 'approval.decided'] });
});

test('PortalNotifier: 토큰을 한 번만 받고, 영구 거절은 버리고 일시 오류는 던진다', async () => {
  const calls: { url: string; auth?: string; body?: string }[] = [];
  let status = 204;
  const http = (async (url: string, init: { headers?: Record<string, string>; body?: unknown }) => {
    calls.push({ url, auth: init.headers?.authorization, body: String(init.body) });
    if (url === 'https://tok.test/oauth2/token') return new Response(JSON.stringify({ access_token: 'tk', expires_in: 3600 }), { status: 200 });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const n = new PortalNotifier({ url: 'https://portal.test/', tokenUrl: 'https://tok.test/oauth2/token', clientId: 'c', clientSecret: 's' }, http);
  const job = toPortalJob(T, { recipientId: U, template: 'APPROVAL_DECIDED', params: { requestNo: 'R', decision: 'APPROVED' } }, 'n1')!;
  await n.send(job); await n.send(job);
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 1);
  const post = calls.find((c) => c.url === 'https://portal.test/v1/notifications')!;
  assert.equal(post.auth, 'Bearer tk');
  assert.equal(JSON.parse(post.body!).appCode, 'alm');
  status = 403; await n.send(job);
  status = 503; await assert.rejects(n.send(job));
});

// ---- 수명주기 훅(09 §9): R1은 501 ----
test('수명주기 훅: 선언만 하고 501 ALM-E501, 가드는 사용자 문맥을 요구하지 않는다', async () => {
  const m = buildManifest({ appOrigin: 'https://a.test' });
  assert.deepEqual(m.lifecycle, { tenantExport: '/tenant-export', tenantImport: '/tenant-import', erasureHook: '/erase' });
  for (const o of ['portalTenantExport', 'portalTenantImport', 'portalErase', 'portalGetJob']) assert.equal(permissionFor(o), 'portal.feed');
  const { PortalController } = await import('../src/http/portal.controller');
  const c = new PortalController({} as never, {} as never);
  for (const f of [c.tenantExport, c.tenantImport, c.erase, c.job]) assert.throws(() => f.call(c), (e: unknown) => e instanceof AlmError && e.status === 501 && e.code === 'ALM-E501');
  for (const o of ['portalTenantExport', 'portalGetJob']) {
    op.current = o;
    const { g, seen } = guard({ clientIds: ['portal-backend'] }, undefined);
    assert.equal(await g.canActivate(ctx('Bearer at|portal-backend|', {}, '/api/v1/portal/erase') as never), true);
    assert.deepEqual(seen, []);
  }
  op.current = 'portalGetInbox';
});

// ---- 일정 피드 ----
import { allDay, parseRange } from '../src/portal/calendar';
test('일정 피드: 기간 검사와 종일 이벤트 변환', () => {
  assert.throws(() => parseRange('x', '2026-11-10T00:00:00Z'), (e: unknown) => e instanceof AlmError && e.status === 400);
  assert.throws(() => parseRange('2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'), AlmError);
  assert.throws(() => parseRange('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'), AlmError);
  const r = parseRange('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
  assert.equal(r.to > r.from, true);
  assert.deepEqual(allDay('warranty:a', '보증 만료 · T1', 'WARRANTY_END', '2026-11-20', '/assets/a'),
    { id: 'warranty:a', title: '보증 만료 · T1', startsAt: '2026-11-20T00:00:00.000Z', endsAt: '2026-11-21T00:00:00.000Z', allDay: true, kind: 'WARRANTY_END', deepLink: '/assets/a' });
  assert.equal(permissionFor('portalGetCalendarFeed'), 'portal.feed');
});
