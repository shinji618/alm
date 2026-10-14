// 로그인 사용자(GET /me). 권한 키로 메뉴·버튼을 숨긴다(서버가 다시 확인 — 09 1장 "권한은 서버가 결정")
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthenticatedHandler } from './api';
import { setLanguage } from '@/i18n';

export interface RoleScope { role: string; companyCode?: string; siteCode?: string; costCenterCode?: string }
export interface Me {
  userId: string; displayName: string; email: string; locale: 'en' | 'ko'; tenantCode: string;
  roles: RoleScope[]; permissions: string[]; navCounts: Record<string, number>;
  /** sap: SAP 연계를 쓰는 회사가 하나라도 있음(없으면 SAP 메뉴·필드를 숨긴다) */
  features?: { sap?: boolean };
}
type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'error'; message: string } | { status: 'ready'; me: Me };
interface SessionApi { state: State; me?: Me; can: (perm: string) => boolean; reload: () => void; /** 화면을 가리지 않고 /me만 다시(메뉴 배지 수 등) */ refresh: () => void }

const Ctx = createContext<SessionApi | null>(null);

export function SessionProvider({ children, initial }: { children: ReactNode; initial?: Me }) {
  const [state, setState] = useState<State>(initial ? { status: 'ready', me: initial } : { status: 'loading' });
  const load = useCallback(() => {
    setState({ status: 'loading' });
    api.get<Me>('/me').then(
      (me) => {
        setState({ status: 'ready', me });
        try { if (!localStorage.getItem('alm.lang')) setLanguage(me.locale); } catch { /* ignore */ }
      },
      (e) => setState(e instanceof ApiError && (e.status === 401 || e.code === 'ALM-E402') ? { status: 'anonymous' } : { status: 'error', message: String(e.message ?? e) }),
    );
  }, []);
  const refresh = useCallback(() => {
    api.get<Me>('/me').then((me) => setState({ status: 'ready', me }), () => undefined);
  }, []);
  useEffect(() => {
    setUnauthenticatedHandler(() => setState({ status: 'anonymous' }));
    if (!initial) load();
  }, [initial, load]);
  const value = useMemo<SessionApi>(() => {
    const me = state.status === 'ready' ? state.me : undefined;
    const perms = new Set(me?.permissions ?? []);
    return { state, me, can: (p) => perms.has(p), reload: load, refresh };
  }, [state, load, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// 공급자 밖(Storybook의 셸 등)에서는 비로그인·권한 없음으로 본다
const NONE: SessionApi = { state: { status: 'loading' }, can: () => false, reload: () => undefined, refresh: () => undefined };
export function useSession(): SessionApi {
  return useContext(Ctx) ?? NONE;
}
