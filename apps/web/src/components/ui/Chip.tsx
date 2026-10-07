import type { ReactNode } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

export function Chip({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" className={cx(s.chip, on && s.chipOn)} aria-pressed={!!on} onClick={onClick}>
      {children}
    </button>
  );
}

export interface ChipOption<V extends string> {
  value: V;
  label: ReactNode;
}

/** 하나만 선택되는 칩 묶음 */
export function ChipGroup<V extends string>({ options, value, onChange, label }: { options: ChipOption<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className={s.chips} role="group" aria-label={label}>
      {options.map((o) => (
        <Chip key={o.value} on={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </Chip>
      ))}
    </div>
  );
}
