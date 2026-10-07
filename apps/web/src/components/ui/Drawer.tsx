import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** 접근성 이름 */
  label: string;
  /** 제목 위 배지 줄(태그·상태 등) */
  badges?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 헤더 아래 탭 등 */
  toolbar?: ReactNode;
  children: ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/** 화면설계서 4장 · Drawer — Esc·배경 클릭으로 닫고, 포커스를 안에 가둔다 */
export function Drawer({ open, onClose, label, badges, title, subtitle, toolbar, children }: DrawerProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <>
      <div className={s.scrim} onClick={onClose} data-testid="drawer-scrim" />
      <aside ref={ref} className={s.drawer} role="dialog" aria-modal="true" aria-label={label}>
        <header className={s.drawerHead}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {badges && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{badges}</div>}
            <h2 className={s.drawerTitle}>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <button type="button" className={`${s.btn} ${s.btnSmall}`} onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </header>
        {toolbar}
        <div className={s.drawerBody}>{children}</div>
      </aside>
    </>,
    document.body,
  );
}
