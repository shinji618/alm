import s from './ui.module.css';
import { cx } from './cx';

export interface ProgressSegment {
  value: number;
  color: string;
  label?: string;
}

/** 단일(value/max) 또는 누적(segments) 막대 */
export function ProgressBar({ value, max = 100, color = 'var(--accent)', segments, showLabel = true, large, label }: { value?: number; max?: number; color?: string; segments?: ProgressSegment[]; showLabel?: boolean; large?: boolean; label: string }) {
  const total = max > 0 ? max : 1;
  const segs = segments ?? [{ value: value ?? 0, color }];
  const pct = Math.round(((segments ? segs.reduce((a, b) => a + b.value, 0) : value ?? 0) / total) * 100);
  return (
    <div className={s.progress}>
      <div className={cx(s.bar, large && s.barLarge)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={segments ? undefined : value}>
        {segs.map((sg, i) => (
          <span key={i} title={sg.label} style={{ width: `${Math.min(100, (sg.value / total) * 100)}%`, background: sg.color }} />
        ))}
      </div>
      {showLabel && <span className={s.progressLabel}>{pct}%</span>}
    </div>
  );
}
