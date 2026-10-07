import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import s from './layout.module.css';
import { Button } from '../ui';
import { applyTheme, getThemePref, type ThemePref } from '@/lib/theme';
import { setLanguage } from '@/i18n';

export interface TopBarProps {
  userName: string;
  userRole: string;
  onMenu: () => void;
  /** Enter 시 호출. 정확 일치면 상세, 아니면 목록 검색(화면설계서 5.3) */
  onSearch: (q: string) => void;
}

/** ② Top bar: 전역 검색 · 사용자 메뉴(언어·테마) */
export function TopBar({ userName, userRole, onMenu, onSearch }: TopBarProps) {
  const { t, i18n } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const ref = useRef<HTMLDivElement>(null);
  const initials = userName
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <div className={s.top}>
      <Button size="sm" className={s.menuBtn} onClick={onMenu} aria-label={t('app.openMenu')}>
        ☰
      </Button>
      <div className={s.search}>
        <input
          type="search"
          placeholder={t('app.searchPlaceholder')}
          aria-label={t('app.searchPlaceholder')}
          onKeyDown={(e) => {
            const q = e.currentTarget.value.trim();
            if (e.key === 'Enter' && q) onSearch(q);
          }}
        />
      </div>
      <div className={s.user} ref={ref}>
        <button type="button" className={s.userBtn} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <span className={s.userName}>
            {userName} · {userRole}
          </span>
          <span className={s.avatar}>{initials}</span>
        </button>
        {menu && (
          <div className={s.menu} role="menu">
            <label className={s.menuRow}>
              {t('app.language')}
              <select value={i18n.language} onChange={(e) => setLanguage(e.target.value as 'en' | 'ko')}>
                <option value="en">English</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            <label className={s.menuRow}>
              {t('app.theme')}
              <select
                value={theme}
                onChange={(e) => {
                  const v = e.target.value as ThemePref;
                  setTheme(v);
                  applyTheme(v);
                }}
              >
                <option value="system">{t('app.themeSystem')}</option>
                <option value="light">{t('app.themeLight')}</option>
                <option value="dark">{t('app.themeDark')}</option>
              </select>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
