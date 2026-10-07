import s from './ui.module.css';
import { cx } from './cx';

export interface TabItem<V extends string> {
  value: V;
  label: string;
}

export function Tabs<V extends string>({ items, value, onChange, label }: { items: TabItem<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className={s.tabs} role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          className={cx(s.tab, it.value === value && s.tabOn)}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
