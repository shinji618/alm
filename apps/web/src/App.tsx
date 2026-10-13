import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell, NAV_ITEMS } from '@/components/layout';
import { Button, ConfirmProvider, EmptyState, ToastProvider } from '@/components/ui';
import { SessionProvider, useSession, type Me } from '@/lib/session';
import { DesignGallery } from '@/pages/DesignGallery';
import { Placeholder } from '@/pages/Placeholder';
import { Login } from '@/pages/Login';
import { AssetList } from '@/pages/assets/AssetList';
import { AssetDetail } from '@/pages/assets/AssetDetail';
import { AssetCreate } from '@/pages/assets/AssetCreate';
import { RequestList } from '@/pages/requests/RequestList';
import { RequestDetail } from '@/pages/requests/RequestDetail';

// 만든 화면(그 외 메뉴는 아직 자리 화면)
const BUILT = new Set(['/assets', '/requests', '/design']);

function Routed() {
  const { t } = useTranslation();
  const { state, reload } = useSession();
  if (state.status === 'loading') return <EmptyState message={t('app.loadingSession')} />;
  if (state.status === 'anonymous') return <Login />;
  if (state.status === 'error') {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message={t('app.sessionError', { message: state.message })} />
        <Button onClick={reload}>{t('common.retry')}</Button>
      </div>
    );
  }
  const counts = state.me.navCounts ?? {};
  return (
    <Routes>
      <Route element={<AppShell counts={Object.fromEntries(Object.entries(counts).map(([k, v]) => [`/${k}`, { count: v }]))} />}>
        <Route path="/design" element={<DesignGallery />} />
        <Route path="/assets" element={<AssetList />} />
        <Route path="/assets/new" element={<AssetCreate />} />
        <Route path="/assets/:id" element={<AssetDetail />} />
        <Route path="/requests" element={<RequestList />} />
        <Route path="/requests/:id" element={<RequestDetail />} />
        {NAV_ITEMS.filter((i) => !BUILT.has(i.path)).map((i) => (
          <Route key={i.path} path={i.path} element={<Placeholder />} />
        ))}
        <Route path="*" element={<Placeholder />} />
      </Route>
    </Routes>
  );
}

/** initialMe: 시험·Storybook에서 로그인 없이 그릴 때 */
export function App({ initialMe }: { initialMe?: Me } = {}) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider initial={initialMe}>
          <BrowserRouter>
            <Routed />
          </BrowserRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
