import type { ReactNode } from 'react';
import type { Tone } from '@/lib/status';
import s from './ui.module.css';
import { cx } from './cx';

const toneClass: Record<Tone, string | undefined> = {
  ok: s.toneOk,
  warn: s.toneWarn,
  bad: s.toneBad,
  info: s.toneInfo,
  accent: s.toneAccent,
  neutral: undefined,
};

/** 상태 배지 — 색만으로 구분하지 않도록 항상 글자를 넣는다 */
export function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx(s.pill, toneClass[tone])}>{children}</span>;
}
