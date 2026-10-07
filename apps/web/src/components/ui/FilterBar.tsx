import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';
import { cx } from './cx';

export interface FilterBarProps {
  search: string;
  /** 입력 300ms 후 호출(디바운스) */
  onSearch: (q: string) => void;
  searchPlaceholder?: string;
  /** 선택 상자, ChipGroup 등 */
  children?: ReactNode;
  /** 값이 있으면 초기화 버튼 표시 */
  onClear?: () => void;
  debounceMs?: number;
}

export function FilterBar({ search, onSearch, searchPlaceholder, children, onClear, debounceMs = 300 }: FilterBarProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(search);
  const first = useRef(true);
  useEffect(() => setDraft(search), [search]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (draft === search) return;
    const id = setTimeout(() => onSearch(draft), debounceMs);
    return () => clearTimeout(id);
  }, [draft, search, onSearch, debounceMs]);

  return (
    <div className={s.filterBar}>
      <input
        type="search"
        className={cx(s.control, s.search)}
        value={draft}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder ?? 'Search'}
        onChange={(e) => setDraft(e.target.value)}
      />
      {children}
      {onClear && (
        <button type="button" className={cx(s.btn, s.btnSmall)} onClick={onClear}>
          {t('common.clear')}
        </button>
      )}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** 필터 바용 선택 상자. 빈 값 = 전체 */
export function FilterSelect({ value, onChange, options, allLabel, label }: { value: string; onChange: (v: string) => void; options: SelectOption[]; allLabel: string; label: string }) {
  return (
    <select className={s.control} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
