import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import s from './layout.module.css';
import { NavRail, type NavCounts } from './NavRail';
import { TopBar } from './TopBar';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/lib/session';
import { logout } from '@/lib/api';

/** 앱 셸: Nav rail + Top bar + 작업 영역(Outlet) */
export function AppShell({ counts }: { counts?: NavCounts }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { me } = useSession();
  // 대표 역할(일반 사용자는 다른 역할이 없을 때만)
  const role = me?.roles.find((r) => r.role !== 'EMPLOYEE')?.role ?? (me ? 'EMPLOYEE' : '');
  return (
    <div className={s.app}>
      <NavRail open={open} counts={counts} onNavigate={() => setOpen(false)} />
      {open && <div className={s.backdrop} onClick={() => setOpen(false)} />}
      <div className={s.main}>
        <TopBar userName={me?.displayName ?? ''} userRole={role ? t(`role.${role}`) : ''} onSignOut={me ? () => void logout() : undefined} onMenu={() => setOpen((o) => !o)} onSearch={(q) => navigate(`/assets?q=${encodeURIComponent(q)}`)} />
        <main className={s.view}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
