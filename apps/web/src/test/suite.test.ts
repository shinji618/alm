// 공유 플랫폼(suite) 모드(VITE_SUITE=1): API 호출은 공통 틀(window.suite.fetch)로, 자체 토큰 갱신·로그인 호출은 하지 않는다
const load = async (suiteMode: boolean) => {
  vi.resetModules();
  vi.stubEnv('VITE_SUITE', suiteMode ? '1' : '');
  return import('@/lib/api');
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('suite mode api', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); delete window.suite; });

  it('공통 틀의 fetch로 부른다: 토큰 없음, /auth/refresh 호출 없음', async () => {
    const suiteFetch = vi.fn(async () => json(200, { userId: 'u1' }));
    const plain = vi.fn(async () => json(500, {}));
    vi.stubGlobal('fetch', plain);
    window.suite = { ready: Promise.resolve(), fetch: suiteFetch, logout: vi.fn(async () => undefined) };
    const { api } = await load(true);
    expect(await api.get('/me')).toEqual({ userId: 'u1' });
    await api.post('/assets', { name: 'x' });
    expect(plain).not.toHaveBeenCalled();
    expect(suiteFetch).toHaveBeenCalledTimes(2);
    const [url, init] = suiteFetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/assets');   // 시험의 기준 경로는 '/' — 빌드에서는 '/alm/api/v1'
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });   // authorization 없음(통행증 쿠키), CSRF 헤더는 공통 틀이 붙인다
  });

  it('401이면(공통 틀이 갱신·재시도한 뒤에도) 로그인 필요 상태로 알리고, 다시 갱신을 시도하지 않는다', async () => {
    const suiteFetch = vi.fn(async () => json(401, { code: 'ALM-E402', message: '통행증이 없거나 만료되었습니다' }));
    window.suite = { ready: Promise.resolve(), fetch: suiteFetch, logout: vi.fn(async () => undefined) };
    const { api, setUnauthenticatedHandler } = await load(true);
    const onAnon = vi.fn();
    setUnauthenticatedHandler(onAnon);
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401, code: 'ALM-E402' });
    expect(suiteFetch).toHaveBeenCalledTimes(1);
    expect(onAnon).toHaveBeenCalledTimes(1);
  });

  it('로그아웃은 플랫폼 세션을 끝낸다', async () => {
    const out = vi.fn(async () => undefined);
    window.suite = { ready: Promise.resolve(), fetch: vi.fn(), logout: out };
    const { logout } = await load(true);
    await logout();
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('공통 틀 스크립트가 없으면 알린다(배포 오류를 조용히 넘기지 않는다)', async () => {
    const { api } = await load(true);
    await expect(api.get('/me')).rejects.toThrow(/공통 틀/);
  });

  it('기본 모드는 그대로: /auth/refresh로 토큰을 받고 Bearer로 부른다', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]);
      return url.endsWith('/auth/refresh') ? json(200, { accessToken: 'tok' }) : json(200, { ok: true }); }));
    const { api } = await load(false);
    await api.get('/me');
    expect(calls.map((c) => c[0])).toEqual(['/api/v1/auth/refresh', '/api/v1/me']);
    expect(calls[1][1].headers).toEqual({ authorization: 'Bearer tok' });
  });
});
