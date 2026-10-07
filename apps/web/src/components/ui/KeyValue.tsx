import type { ReactNode } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

export interface KeyValueItem {
  label: string;
  value: ReactNode;
}

/** 값이 비면 '—' */
export function KeyValue({ items, columns = 2 }: { items: KeyValueItem[]; columns?: 1 | 2 }) {
  return (
    <dl className={cx(s.kv, columns === 1 && s.kvOne)}>
      {items.map((it) => (
        <div key={it.label} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <dt>{it.label}</dt>
          <dd>{it.value === null || it.value === undefined || it.value === '' ? <span className="faint">—</span> : it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
