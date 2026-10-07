import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';
import { cx } from './cx';

export type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** 2.6초 후 사라짐. 오류는 닫을 때까지 유지 */
export function ToastProvider({ children, durationMs = 2600 }: { children: ReactNode; durationMs?: number }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { id, kind, message }]);
      if (kind !== 'error') setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss, durationMs],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className={s.toastHost} aria-live="polite">
        {items.map((it) => (
          <div key={it.id} className={cx(s.toast, it.kind === 'error' && s.toastError)} role={it.kind === 'error' ? 'alert' : 'status'}>
            <span>{it.message}</span>
            {it.kind === 'error' && (
              <button type="button" className={s.toastClose} onClick={() => dismiss(it.id)} aria-label={t('common.close')}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
