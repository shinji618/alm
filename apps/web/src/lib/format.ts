/** 화면설계서 5.2 포맷 규칙 */
export type Lang = 'en' | 'ko';

const EMPTY = '—';

export function formatDate(value: string | Date | null | undefined, lang: Lang = 'en'): string {
  if (!value) return EMPTY;
  const d = typeof value === 'string' ? new Date(value.length === 10 ? `${value}T00:00:00` : value) : value;
  if (Number.isNaN(d.getTime())) return EMPTY;
  if (lang === 'ko') {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return EMPTY;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return EMPTY;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** $1,840 · $1,840.00 */
export function formatUsd(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  const abs = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${value < 0 ? '-' : ''}$${abs}`;
}

/** $204.0K · $1.25M — KPI 등 큰 금액 */
export function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  const a = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return formatUsd(value);
}

export function formatPercent(ratio: number | null | undefined, decimals = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return EMPTY;
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** 오늘 기준 남은 일수(음수 = 지남) */
export function daysUntil(value: string | Date, today: Date = new Date()): number {
  const d = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00`) : value;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d.getTime() - t.getTime()) / 86_400_000);
}

export { EMPTY };
