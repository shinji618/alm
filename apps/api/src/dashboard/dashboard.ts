// 대시보드(ALM-010, WBS 4.1). 위젯 전체를 한 번에 돌려준다: KPI 6종 · 라이프사이클 단계 · 카테고리별 · 120일 이내 갱신 · 조치 필요 · 최근 활동.
//   범위: dashboard.read의 역할 범위(부서 관리자는 코스트센터)로 자산을 거른다. 금액(NBV·APC·계약 금액)은 amount.read가 없으면 null.
//   모듈 권한이 없는 KPI·조치(라이선스·실사·SAP·라벨·Discovery)는 빼고 보낸다. 결과는 사용자·사이트별 5분 캐시(refresh=true면 다시 계산)
import type { PoolClient } from 'pg';
import { Check } from '../common/validate';
import type { Principal } from '../auth/principal';
import { assetScope, can, Params } from '../auth/scope';
import { inboxCount } from '../requests/requests';

const STAGES = ['PLAN', 'PROCURE', 'DEPLOY', 'OPERATE', 'MAINTAIN', 'RETIRE'] as const;
const CACHE_MS = 5 * 60_000;
const RENEWAL_DAYS = 120;
const WARRANTY_DAYS = 90;
const ACTIVE = `a.status NOT IN ('RETIRED', 'DISPOSED', 'ON_ORDER')`;

type Kpi = { key: string; value: number | null; unit: 'count' | 'usd' | 'percent'; secondary?: number | null; link: string };
type Out = Record<string, unknown> & { asOf: string };
const cache = new Map<string, { at: number; out: Out }>();
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);

export async function getDashboard(c: PoolClient, p: Principal, q: Record<string, string | undefined>): Promise<Out> {
  const k = new Check(q);
  const siteId = k.uuid(q as Record<string, unknown>, 'siteId');
  k.done();
  const key = `${p.tenantId}:${p.userId}:${siteId ?? ''}:${[...p.permissions.keys()].sort().join(',')}`;
  const hit = cache.get(key);
  if (q.refresh !== 'true' && hit && Date.now() - hit.at < CACHE_MS) return hit.out;
  const out = await compute(c, p, siteId);
  if (cache.size > 1000) cache.clear();
  cache.set(key, { at: Date.now(), out });
  return out;
}

/** 시험용: 캐시 비우기 */
export function clearDashboardCache() { cache.clear(); }

async function compute(c: PoolClient, p: Principal, siteId: string | undefined): Promise<Out> {
  const amount = can(p, 'amount.read');
  // 범위 조건(자산 a). 매번 새 Params로 만든다($n 번호가 쿼리마다 다름)
  const scoped = (extra = 'true') => {
    const ps = new Params();
    const w = [assetScope(p, 'dashboard.read', ps)];
    if (siteId) w.push(`a.site_id = ${ps.add(siteId)}`);
    w.push(extra);
    return { where: w.join(' AND '), ps };
  };

  // ---- KPI ----
  const s1 = scoped();
  const base = (await c.query(`SELECT
        count(*) FILTER (WHERE ${ACTIVE})::int AS active,
        coalesce(sum(vl.net_book_value) FILTER (WHERE ${ACTIVE}), 0) AS nbv,
        coalesce(sum(vl.acquisition_value) FILTER (WHERE ${ACTIVE}), 0) AS apc,
        count(*) FILTER (WHERE ${ACTIVE} AND a.warranty_end_date BETWEEN current_date AND current_date + ${WARRANTY_DAYS})::int AS warranty
      FROM asset a LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id WHERE ${s1.where}`, s1.ps.values)).rows[0];
  const kpis: Kpi[] = [
    { key: 'activeAssets', value: base.active, unit: 'count', link: '/assets' },
    { key: 'nbv', value: amount ? num(base.nbv) : null, secondary: amount ? num(base.apc) : null, unit: 'usd', link: '/assets?sort=-nbv' },
    { key: 'warrantyExpiring', value: base.warranty, unit: 'count', link: '/assets?quick=WARRANTY_90' },
  ];
  if (can(p, 'license.read')) {
    const l = (await c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE compliance <> 'UNDER')::int AS ok FROM v_license_compliance`)).rows[0];
    kpis.push({ key: 'licenseCompliance', value: l.n ? Math.round((l.ok / l.n) * 1000) / 10 : null, unit: 'percent', link: '/software' });
  }
  if (can(p, 'count.read')) {
    const s = scoped(`ci.result IN ('MISPLACED', 'NOT_FOUND') AND ci.variance_action IS NULL`);
    const v = (await c.query(`SELECT count(*)::int AS n FROM count_item ci JOIN count_campaign cc ON cc.id = ci.campaign_id AND cc.status IN ('COUNTING', 'REVIEW', 'POSTING')
        JOIN asset a ON a.id = ci.asset_id WHERE ${s.where}`, s.ps.values)).rows[0];
    kpis.push({ key: 'countVariance', value: v.n, unit: 'count', link: '/counts' });
  }
  const sapErrors = can(p, 'sap.status')
    ? (await c.query(`SELECT count(*)::int AS n FROM sap_posting WHERE status = 'FAILED'`)).rows[0].n as number : undefined;
  if (sapErrors !== undefined) kpis.push({ key: 'sapErrors', value: sapErrors, unit: 'count', link: '/sap' });

  // ---- 라이프사이클 단계 ----
  const s2 = scoped();
  const stageRows = (await c.query(`SELECT st.stage, count(*)::int AS n FROM asset a JOIN v_asset_stage st ON st.asset_id = a.id WHERE ${s2.where} GROUP BY st.stage`, s2.ps.values)).rows;
  const stages = STAGES.map((stage) => ({ stage, count: stageRows.find((r) => r.stage === stage)?.n ?? 0 }));

  // ---- 카테고리별(운영 중 자산) ----
  const s3 = scoped(ACTIVE);
  const categories = (await c.query(`SELECT cat.id, cat.name, count(*)::int AS total,
        count(*) FILTER (WHERE a.status = 'IN_USE')::int AS in_use, count(*) FILTER (WHERE a.status = 'IN_STOCK')::int AS in_stock,
        count(*) FILTER (WHERE st.useful_life_end < current_date)::int AS past_life, coalesce(sum(vl.net_book_value), 0) AS nbv
      FROM asset a JOIN category cat ON cat.id = a.category_id LEFT JOIN v_asset_stage st ON st.asset_id = a.id LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id
     WHERE ${s3.where} GROUP BY cat.id, cat.name ORDER BY count(*) DESC, cat.name LIMIT 12`, s3.ps.values)).rows
    .map((r) => ({ categoryId: r.id, name: r.name, total: r.total, inUse: r.in_use, inStock: r.in_stock, pastUsefulLife: r.past_life, nbv: amount ? num(r.nbv) : null }));

  // ---- 갱신 예정(120일 이내, 남은 일수 순 7건) ----
  const renewals: { kind: string; id: string; name: string; endDate: string; daysLeft: number; amount?: number | null; link: string }[] = [];
  const s4 = scoped(`${ACTIVE} AND a.warranty_end_date BETWEEN current_date AND current_date + ${RENEWAL_DAYS}`);
  for (const r of (await c.query(`SELECT a.id, a.asset_tag, a.description, a.warranty_end_date, (a.warranty_end_date - current_date) AS left
      FROM asset a WHERE ${s4.where} ORDER BY a.warranty_end_date, a.asset_tag LIMIT 7`, s4.ps.values)).rows) {
    renewals.push({ kind: 'WARRANTY', id: r.id, name: `${r.asset_tag} · ${r.description}`, endDate: day(r.warranty_end_date)!, daysLeft: r.left, link: `/assets/${r.id}` });
  }
  if (can(p, 'contract.read')) {
    for (const r of (await c.query(`SELECT id, contract_no, title, end_date, amount, (end_date - current_date) AS left FROM contract
        WHERE end_date BETWEEN current_date AND current_date + ${RENEWAL_DAYS} ORDER BY end_date, contract_no LIMIT 7`)).rows) {
      renewals.push({ kind: 'CONTRACT', id: r.id, name: `${r.contract_no} · ${r.title}`, endDate: day(r.end_date)!, daysLeft: r.left, amount: amount ? num(r.amount) : null, link: '/contracts' });
    }
  }
  if (can(p, 'license.read')) {
    for (const r of (await c.query(`SELECT l.id, sp.publisher, sp.name, l.renewal_date, (l.renewal_date - current_date) AS left, l.owned_quantity * l.unit_cost AS amount
        FROM license l JOIN software_product sp ON sp.id = l.product_id WHERE l.renewal_date BETWEEN current_date AND current_date + ${RENEWAL_DAYS}
       ORDER BY l.renewal_date LIMIT 7`)).rows) {
      renewals.push({ kind: 'LICENSE', id: r.id, name: `${r.publisher} ${r.name}`, endDate: day(r.renewal_date)!, daysLeft: r.left, amount: amount ? num(r.amount) : null, link: '/software' });
    }
  }
  renewals.sort((x, y) => x.daysLeft - y.daysLeft || x.name.localeCompare(y.name));

  // ---- 조치 필요(0건은 빼고) ----
  const actions: { kind: string; count: number; link: string }[] = [];
  const push = (kind: string, count: number, link: string) => { if (count > 0) actions.push({ kind, count, link }); };
  push('APPROVAL_PENDING', await inboxCount(c, p), '/requests?tab=inbox');
  if (sapErrors !== undefined) push('POSTING_ERROR', sapErrors, '/sap');
  if (can(p, 'count.read')) {
    push('COUNT_REVIEW', (await c.query(`SELECT count(*)::int AS n FROM count_campaign WHERE status = 'REVIEW'`)).rows[0].n, '/counts?status=REVIEW');
  }
  if (can(p, 'label.read')) {
    const s5 = scoped(`j.status IN ('QUEUED', 'FAILED')`);
    push('LABEL_QUEUED', (await c.query(`SELECT count(*)::int AS n FROM label_print_job j JOIN asset a ON a.id = j.asset_id WHERE ${s5.where}`, s5.ps.values)).rows[0].n, '/labels');
  }
  if (can(p, 'license.read')) push('LICENSE_SHORTAGE', (await c.query(`SELECT count(*)::int AS n FROM v_license_compliance WHERE compliance = 'UNDER'`)).rows[0].n, '/software');
  if (can(p, 'discovery.read')) {
    push('SCAN_FAILED', (await c.query(`SELECT count(*)::int AS n FROM discovery_run WHERE status = 'FAILED' AND coalesce(finished_at, created_at) > now() - interval '7 days'`)).rows[0].n, '/discovery');
    push('UNMANAGED_DEVICE', (await c.query(`SELECT count(*)::int AS n FROM discovery_item WHERE match_status IN ('UNMANAGED', 'NEW') AND resolution IS NULL`)).rows[0].n, '/discovery');
  }

  // ---- 최근 활동(자산 이력 7건) ----
  const s6 = scoped();
  const activity = (await c.query(`SELECT e.id, e.event_type, e.occurred_at, e.channel, a.id AS asset_id, a.asset_tag, a.description, u.display_name
      FROM asset_event e JOIN asset a ON a.id = e.asset_id LEFT JOIN app_user u ON u.id = e.actor_id WHERE ${s6.where}
     ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 7`, s6.ps.values)).rows
    .map((r) => ({ id: r.id, eventType: r.event_type, occurredAt: (r.occurred_at as Date).toISOString(), channel: r.channel, assetId: r.asset_id, assetTag: r.asset_tag,
      description: r.description, actorName: r.display_name ?? undefined }));

  // 기준 기간 = SAP 최신 금액 수신 기간(예: 009/2026)
  const vp = (await c.query(`SELECT fiscal_year, period FROM asset_value ORDER BY fiscal_year DESC, period DESC LIMIT 1`)).rows[0];
  return { asOf: new Date().toISOString(), valuePeriod: vp ? `${String(vp.period).padStart(3, '0')}/${vp.fiscal_year}` : undefined, kpis, stages, categories,
    renewals: renewals.slice(0, 7), actions, activity };
}
