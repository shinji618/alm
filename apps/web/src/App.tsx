import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell, NAV_ITEMS } from '@/components/layout';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { DesignGallery } from '@/pages/DesignGallery';
import { Placeholder } from '@/pages/Placeholder';

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell counts={{ '/requests': { count: 3 }, '/counts': { count: 10, alert: true }, '/sap': { count: 5, alert: true } }} />}>
              <Route path="/design" element={<DesignGallery />} />
              {NAV_ITEMS.filter((i) => i.path !== '/design').map((i) => (
                <Route key={i.path} path={i.path} element={<Placeholder />} />
              ))}
              <Route path="*" element={<Placeholder />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </ToastProvider>
  );
}
