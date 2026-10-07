import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import s from './layout.module.css';
import { NavRail, type NavCounts } from './NavRail';
import { TopBar } from './TopBar';

/** 앱 셸: Nav rail + Top bar + 작업 영역(Outlet) */
export function AppShell({ counts }: { counts?: NavCounts }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div className={s.app}>
      <NavRail open={open} counts={counts} onNavigate={() => setOpen(false)} />
      {open && <div className={s.backdrop} onClick={() => setOpen(false)} />}
      <div className={s.main}>
        <TopBar userName="Jiseung Shin" userRole="Asset Manager" onMenu={() => setOpen((o) => !o)} onSearch={(q) => navigate(`/assets?q=${encodeURIComponent(q)}`)} />
        <main className={s.view}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
