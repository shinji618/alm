import type { ReactNode } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'warn' | 'bad';
  /** 클릭 시 해당 목록(필터 적용)으로 이동 */
  onClick?: () => void;
}

export function KpiTile({ label, value, hint, tone = 'default', onClick }: KpiTileProps) {
  const cls = cx(s.kpi, tone === 'warn' && s.kpiWarn, tone === 'bad' && s.kpiBad);
  const body = (
    <>
      <span className={s.kpiLabel}>{label}</span>
      <span className={s.kpiValue}>{value}</span>
      {hint && <span className={s.kpiHint}>{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
