import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';
import { Button } from './Button';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 위험 작업이면 danger 버튼 */
  danger?: boolean;
}

type Ask = (opts: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<Ask | null>(null);

/** 화면설계서 5.5 — 반려·폐기·최종 승인·실사 종료 등은 반드시 확인을 받는다 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  const ask = useCallback<Ask>((opts) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })), []);
  const close = useCallback(
    (v: boolean) => {
      state?.resolve(v);
      setState(null);
    },
    [state],
  );

  useEffect(() => {
    if (!state) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, close]);

  return (
    <Ctx.Provider value={ask}>
      {children}
      {state &&
        createPortal(
          <>
            <div className={`${s.scrim} ${s.dialogScrim}`} onClick={() => close(false)} />
            <div className={s.dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
              <h2 id="confirm-title" className={s.dialogTitle}>
                {state.title}
              </h2>
              {state.message && <div className="muted">{state.message}</div>}
              <div className={s.actions}>
                <Button onClick={() => close(false)}>{state.cancelLabel ?? t('common.cancel')}</Button>
                <Button ref={okRef} variant={state.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                  {state.confirmLabel ?? t('common.confirm')}
                </Button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  if (!ask) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ask;
}
