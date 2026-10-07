import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader, NAV_ITEMS } from '@/components/layout';
import { EmptyState, Panel } from '@/components/ui';

/** 아직 만들지 않은 화면 자리 — 4.x·5.x에서 교체 */
export function Placeholder() {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const item = NAV_ITEMS.find((i) => i.path === pathname) ?? NAV_ITEMS[0];
  return (
    <>
      <ViewHeader crumb={item.screenId} title={t(item.labelKey)} />
      <Panel>
        <EmptyState message={t('common.comingSoon', { wbs: item.wbs })} />
      </Panel>
    </>
  );
}
