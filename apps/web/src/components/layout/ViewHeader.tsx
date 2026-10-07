import type { ReactNode } from 'react';
import s from './layout.module.css';

/** ③ View header: 경로 · H1 · 설명 · 우측 액션 */
export function ViewHeader({ crumb, title, description, actions }: { crumb: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={s.vh}>
      <div>
        <div className={s.crumb}>{crumb}</div>
        <h1 className={s.h1}>{title}</h1>
        {description && <p className={s.desc}>{description}</p>}
      </div>
      {actions && <div className={s.vhActions}>{actions}</div>}
    </div>
  );
}
