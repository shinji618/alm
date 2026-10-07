import type { ReactNode } from 'react';
import s from './ui.module.css';

export interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** false면 본문 여백 없이(테이블 등) */
  padded?: boolean;
}

export function Panel({ title, subtitle, actions, children, padded = true }: PanelProps) {
  return (
    <section className={s.panel}>
      {(title || actions) && (
        <header className={s.panelHead}>
          <div>
            {title && <h2 className={s.panelTitle}>{title}</h2>}
            {subtitle && <div className={s.panelSub}>{subtitle}</div>}
          </div>
          {actions}
        </header>
      )}
      {padded ? <div className={s.panelBody}>{children}</div> : children}
    </section>
  );
}
