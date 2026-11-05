// Portal 일정 피드(09 §4): 보증 만료·계약 만료·실사 마감을 사용자 권한 범위 안에서 날짜 이벤트로 돌려준다. 금액은 담지 않는다.
import type { PoolClient } from 'pg';
import { E } from '../common/errors';
import type { Principal } from '../platform/identity/principal';
import { assetScope, can, Params } from '../auth/scope';

export const MAX_EVENTS = 500;
const MAX_SPAN_MS = 100 * 86_400_000;
export interface CalendarEvent { id: string; title: string; startsAt: string; endsAt: string; allDay: true; kind: string; deepLink: string }

/** from·to(ISO 8601) 검사: 형식, from<to, 최대 100일 */
export function parseRange(from: unknown, to: unknown): { from: Date; to: Date } {
  const f = typeof from === 'string' ? new Date(from) : new Date(NaN), t = typeof to === 'string' ? new Date(to) : new Date(NaN);
  if (isNaN(+f) || isNaN(+t)) throw E.badRequest('from과 to(ISO 8601 날짜·시각)가 필요합니다');
  if (+t <= +f) throw E.badRequest('to는 from보다 뒤여야 합니다');
  if (+t - +f > MAX_SPAN_MS) throw E.badRequest('기간은 최대 100일입니다');
  return { from: f, to: t };
}

/** 날짜(YYYY-MM-DD) → 그날 종일 이벤트(UTC 00:00 ~ 다음날 00:00) */
export function allDay(id: string, title: string, kind: string, date: string, deepLink: string): CalendarEvent {
  const s = new Date(`${date}T00:00:00.000Z`);
  return { id, title: title.slice(0, 200), startsAt: s.toISOString(), endsAt: new Date(+s + 86_400_000).toISOString(), allDay: true, kind, deepLink };
}
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export async function calendarFeed(c: PoolClient, p: Principal, range: { from: Date; to: Date }): Promise<{ items: CalendarEvent[]; partial?: true }> {
  const lo = range.from.toISOString().slice(0, 10), hi = range.to.toISOString().slice(0, 10);   // 날짜 비교는 UTC 날짜 기준(끝 날짜 포함)
  const out: CalendarEvent[] = [];
  if (can(p, 'dashboard.read')) {
    const ps = new Params();
    const w = [assetScope(p, 'dashboard.read', ps), `a.status NOT IN ('RETIRED', 'DISPOSED', 'ON_ORDER')`, `a.warranty_end_date >= ${ps.add(lo)}::date`, `a.warranty_end_date < ${ps.add(hi)}::date + 1`];
    for (const r of (await c.query(`SELECT a.id, a.asset_tag, a.description, a.warranty_end_date FROM asset a WHERE ${w.join(' AND ')} ORDER BY a.warranty_end_date, a.asset_tag LIMIT ${MAX_EVENTS + 1}`, ps.values)).rows)
      out.push(allDay(`warranty:${r.id}`, `보증 만료 · ${r.asset_tag} ${r.description ?? ''}`.trim(), 'WARRANTY_END', day(r.warranty_end_date), `/assets/${r.id}`));
  }
  if (can(p, 'contract.read')) {
    for (const r of (await c.query(`SELECT id, contract_no, title, end_date FROM contract WHERE end_date >= $1::date AND end_date < $2::date + 1 ORDER BY end_date, contract_no LIMIT ${MAX_EVENTS + 1}`, [lo, hi])).rows)
      out.push(allDay(`contract:${r.id}`, `계약 만료 · ${r.contract_no} ${r.title ?? ''}`.trim(), 'CONTRACT_END', day(r.end_date), '/contracts'));
  }
  if (can(p, 'count.read')) {
    for (const r of (await c.query(`SELECT id, campaign_code, name, due_date FROM count_campaign WHERE status NOT IN ('CLOSED', 'CANCELLED') AND due_date >= $1::date AND due_date < $2::date + 1 ORDER BY due_date, campaign_code LIMIT ${MAX_EVENTS + 1}`, [lo, hi])).rows)
      out.push(allDay(`count:${r.id}`, `실사 마감 · ${r.campaign_code} ${r.name}`, 'COUNT_DUE', day(r.due_date), `/counts/${r.id}`));
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  return out.length > MAX_EVENTS ? { items: out.slice(0, MAX_EVENTS), partial: true } : { items: out };
}
