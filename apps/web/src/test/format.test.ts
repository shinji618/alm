import { daysUntil, formatDate, formatPercent, formatUsd, formatUsdCompact } from '@/lib/format';
import { expiryTone } from '@/lib/status';

describe('format (UI spec 5.2)', () => {
  it('formats dates per language', () => {
    expect(formatDate('2026-10-04', 'en')).toBe('Oct 04, 2026');
    expect(formatDate('2026-10-04', 'ko')).toBe('2026-10-04');
    expect(formatDate(null)).toBe('—');
  });
  it('formats money', () => {
    expect(formatUsd(1840)).toBe('$1,840');
    expect(formatUsd(1840, 2)).toBe('$1,840.00');
    expect(formatUsd(-85)).toBe('-$85');
    expect(formatUsdCompact(204000)).toBe('$204.0K');
    expect(formatUsdCompact(1250000)).toBe('$1.25M');
    expect(formatPercent(0.875)).toBe('88%');
  });
  it('computes days and expiry tone', () => {
    expect(daysUntil('2026-10-14', new Date(2026, 9, 4))).toBe(10);
    expect(expiryTone(-1)).toBe('bad');
    expect(expiryTone(30)).toBe('bad');
    expect(expiryTone(60)).toBe('warn');
    expect(expiryTone(120)).toBe('ok');
  });
});
