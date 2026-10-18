import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import s from './layout.module.css';
import { NAV } from './nav';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';

interface CategoryItem { id: string; code: string; label: string }

export interface NavCounts {
  [path: string]: { count: number; alert?: boolean } | undefined;
}

/** ① Nav rail. counts는 서버 요약 API에서 받아 넘긴다 */
export function NavRail({ open, counts = {}, onNavigate }: { open: boolean; counts?: NavCounts; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { can, me } = useSession();
  // 권한 키·꺼진 기능(SAP 연계를 쓰는 회사 없음)으로 메뉴를 거른다. 세션이 없으면(Storybook) 권한 메뉴만 숨김
  const loc = useLocation();
  const showCats = !!me && can('asset.read');
  // 자산 카테고리별 하위 메뉴(조회·등록). 세션이 없으면(Storybook) 부르지 않는다
  const cats = useAsync((sig) => (showCats ? api.get<{ categories?: CategoryItem[] }>('/lookups?types=categories', sig) : Promise.resolve({ categories: [] })), [showCats]);
  const curCat = loc.pathname === '/assets' ? new URLSearchParams(loc.search).get('categoryId') ?? '' : '';
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((it) => (!it.perm || can(it.perm)) && (!it.feature || me?.features?.[it.feature] !== false)) }))
    .filter((g) => g.items.length);
  return (
    <aside className={`${s.rail} ${open ? s.railOpen : ''}`} aria-label="Main navigation">
      <div className={s.brand}>
        <div className={s.mark}>ALM</div>
        <div>
          {t('app.name')}
          <small className={s.tenant}>{t('app.tenant')}</small>
        </div>
      </div>
      <nav>
        {groups.map((g) => (
          <div key={g.labelKey}>
            <div className={s.group}>{t(g.labelKey)}</div>
            {g.items.map((it) => {
              const c = counts[it.path];
              return (
                <div key={it.path}>
                  <NavLink to={it.path} end={it.path === '/'} onClick={onNavigate}
                    className={({ isActive }) => `${s.link} ${isActive && !(it.children && curCat) ? s.active : ''}`}>
                    {t(it.labelKey)}
                    {c && c.count > 0 && <span className={`${s.count} ${c.alert ? s.countAlert : ''}`}>{c.count}</span>}
                  </NavLink>
                  {it.children === 'categories' && (cats.data?.categories ?? []).length > 0 && (
                    <div role="group" aria-label={t('nav.byCategory')}>
                      {(cats.data?.categories ?? []).map((k) => (
                        <NavLink key={k.id} to={`/assets?categoryId=${k.id}`} onClick={onNavigate}
                          className={() => `${s.link} ${s.sub} ${curCat === k.id ? s.active : ''}`}>{k.label}</NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={s.railFoot}>v0.1 · WBS 3.5</div>
    </aside>
  );
}
