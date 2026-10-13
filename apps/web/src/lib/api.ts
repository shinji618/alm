// API 호출(BFF, 09 6.2). 리프레시 토큰은 HttpOnly 쿠키(서버만 앎), 액세스 토큰은 메모리에만 둔다.
//   - 첫 호출 전·401이면 POST /auth/refresh(x-alm-csrf + 같은 출처)로 액세스 토큰을 받아 한 번 다시 시도
//   - 그래도 401이면 로그인 필요(onUnauthenticated)
//   - 오류 응답 { code, message, errors[] } → ApiError
export const BASE = '/api/v1';

export interface FieldError { field: string; code: string; message: string }
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors: FieldError[] = [], readonly detail?: unknown) { super(message); }
  fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.errors.map((e) => [e.field, e.message]));
  }
}

let token: string | undefined;
let refreshing: Promise<string | undefined> | undefined;
let onUnauthenticated: () => void = () => undefined;
export function setUnauthenticatedHandler(fn: () => void) { onUnauthenticated = fn; }
export function clearToken() { token = undefined; }

async function refresh(): Promise<string | undefined> {
  // 동시에 여러 호출이 401을 받아도 갱신은 한 번. 끝나면 바로 비워 다음 401은 새로 갱신한다
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin', headers: { 'x-alm-csrf': '1' } });
      if (!r.ok) return undefined;
      const b = (await r.json()) as { accessToken: string };
      return b.accessToken;
    } catch {
      return undefined;
    }
  })().finally(() => { refreshing = undefined; });
  token = await refreshing;
  return token;
}

export interface RequestOptions { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }
export interface ApiResponse<T> { data: T; headers: Headers; status: number }

export async function request<T>(path: string, o: RequestOptions = {}): Promise<ApiResponse<T>> {
  if (!token) await refresh();
  const send = () => fetch(`${BASE}${path}`, {
    method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    signal: o.signal,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  let r = await send();
  if (r.status === 401) {
    await refresh();
    if (token) r = await send();
  }
  const text = await r.text();
  let b: Record<string, unknown> | undefined;
  try { b = text ? JSON.parse(text) : undefined; } catch { b = undefined; }
  if (r.status === 401) { onUnauthenticated(); }
  if (!r.ok) {
    throw new ApiError(r.status, String(b?.code ?? `HTTP${r.status}`), String(b?.message ?? b?.detail ?? r.statusText), (b?.errors as FieldError[] | undefined) ?? [], b);
  }
  return { data: b as T, headers: r.headers, status: r.status };
}

export const api = {
  get: async <T>(path: string, signal?: AbortSignal) => (await request<T>(path, { signal })).data,
  post: async <T>(path: string, body: unknown = {}) => (await request<T>(path, { method: 'POST', body })).data,
  patch: async <T>(path: string, body: unknown, ifMatch: number | string) => (await request<T>(path, { method: 'PATCH', body, headers: { 'if-match': `"${ifMatch}"` } })).data,
};

// 쿼리 문자열(빈 값 제외)
export function qs(p: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export async function logout(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'same-origin', headers: { 'x-alm-csrf': '1' } });
    const b = r.ok ? ((await r.json()) as { logoutUrl?: string }) : undefined;
    clearToken();
    window.location.assign(b?.logoutUrl ?? '/');
  } catch {
    clearToken();
    window.location.assign('/');
  }
}

export function loginUrl(email: string, returnTo: string): string {
  return `${BASE}/auth/login${qs({ email, returnTo })}`;
}
