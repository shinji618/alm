import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import s from './layout.module.css';
import { NAV } from './nav';

export interface NavCounts {
  [path: string]: { count: number; alert?: boolean } | undefined;
}

/** ① Nav rail. counts는 서버 요약 API에서 받아 넘긴다 */
export function NavRail({ open, counts = {}, onNavigate }: { open: boolean; counts?: NavCounts; onNavigate?: () => void }) {
  const { t } = useTranslation();
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
        {NAV.map((g) => (
          <div key={g.labelKey}>
            <div className={s.group}>{t(g.labelKey)}</div>
            {g.items.map((it) => {
              const c = counts[it.path];
              return (
                <NavLink key={it.path} to={it.path} end={it.path === '/'} className={({ isActive }) => `${s.link} ${isActive ? s.active : ''}`} onClick={onNavigate}>
                  {t(it.labelKey)}
                  {c && c.count > 0 && <span className={`${s.count} ${c.alert ? s.countAlert : ''}`}>{c.count}</span>}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={s.railFoot}>v0.1 · WBS 3.5</div>
    </aside>
  );
}
