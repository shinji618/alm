// ALM-010 대시보드(WBS 4.1). 화면설계서 ALM-010: .1 헤더 · .2 KPI 6개 · .3 라이프사이클 · .4 카테고리별 · .5 갱신 예정 · .6 최근 활동 · .7 조치 필요
//   GET /dashboard 한 번으로 그린다(서버 5분 캐시, [Refresh]는 refresh=true). KPI·단계·카테고리 클릭 시 필터를 건 목록으로 이동
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, EmptyState, KpiTile, Panel, SelectField } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { formatDate, formatDateTime, formatUsd, type Lang } from '@/lib/format';
import { stageCodeColorVar, type StageCode } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Lookups } from '../assets/types';
import s from '../assets/assets.module.css';
import c from './dashboard.module.css';

interface Kpi { key: 'activeAssets' | 'nbv' | 'warrantyExpiring' | 'licenseCompliance' | 'countVariance' | 'sapErrors'; value: number | null; unit: 'count' | 'usd' | 'percent'; secondary?: number | null; link: string }
interface DashboardData {
  asOf: string; valuePeriod?: string; kpis: Kpi[]; stages: { stage: StageCode; count: number }[];
  categories: { categoryId: string; name: string; total: number; inUse: number; inStock: number; pastUsefulLife: number; nbv: number | null }[];
  renewals: { kind: 'CONTRACT' | 'WARRANTY' | 'LICENSE'; id: string; name: string; endDate: string; daysLeft: number; amount?: number | null; link: string }[];
  actions: { kind: string; count: number; link: string }[];
  activity: { id: string; eventType: string; occurredAt: string; channel: string; assetId: string; assetTag: string; description: string; actorName?: string }[];
}

/** 0보다 크면 주의·경고 타일(화면설계서 .2) */
const KPI_TONE: Partial<Record<Kpi['key'], 'warn' | 'bad'>> = { warrantyExpiring: 'warn', countVariance: 'warn', sapErrors: 'bad' };
const EVENT_DOT: Record<string, string> = { CREATED: 'info', ASSIGNED: 'ok', RETURNED: 'info', TRANSFERRED: 'accent', REPAIR_IN: 'warn', REPAIR_OUT: 'ok', COUNTED: 'ok',
  LABEL_PRINTED: 'info', SAP_POSTED: 'accent', SAP_SYNCED: 'accent', RETIRED: 'bad', DISPOSED: 'bad', STATUS_CHANGED: 'warn', UPDATED: 'neutral' };

export function Dashboard() {
  const { t } = useTranslation();
  const { can } = useSession();
  // 대시보드 권한이 없는 역할(직원 등)은 바로 갈 곳만 안내한다
  if (!can('dashboard.read')) {
    return (
      <>
        <ViewHeader crumb="ALM-010" title={t('dash.title')} description={t('dash.description')} />
        <Panel><EmptyState message={t('dash.noAccess')} /></Panel>
      </>
    );
  }
  return <DashboardView />;
}

function DashboardView() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const nav = useNavigate();
  const { can } = useSession();
  const [siteId, setSiteId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=sites', sig), []);
  const r = useAsync((sig) => api.get<DashboardData>(`/dashboard${qs({ siteId, refresh: refresh ? 'true' : undefined })}`, sig), [siteId, refresh]);
  const d = r.data;
  const value = (k: Kpi) => (k.value === null ? '—' : k.unit === 'usd' ? formatUsd(k.value) : k.unit === 'percent' ? `${k.value}%` : k.value.toLocaleString('en-US'));
  const total = d ? d.stages.reduce((n, x) => n + x.count, 0) : 0;
  const maxNbv = d ? Math.max(0, ...d.categories.map((x) => x.nbv ?? 0)) : 0;
  return (
    <>
      <ViewHeader crumb="ALM-010" title={t('dash.title')}
        description={d ? t('dash.basis', { period: d.valuePeriod ?? t('dash.noPeriod'), asOf: formatDateTime(d.asOf) }) : t('dash.description')}
        actions={
          <div className={c.bar}>
            <SelectField label={t('asset.col.site')} value={siteId} onChange={(e) => setSiteId(e.target.value)}
              options={[{ value: '', label: t('asset.list.allSites') }, ...(lk.data?.sites ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))]} />
            <Button onClick={() => setRefresh((n) => n + 1)} disabled={r.loading}>{t('dash.refresh')}</Button>
            {can('count.read') && <Button onClick={() => nav('/counts')}>{t('dash.openCount')}</Button>}
            {can('asset.write') && <Button variant="primary" onClick={() => nav('/assets/new')}>{t('dash.newAsset')}</Button>}
          </div>
        } />
      {r.error && <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })} <Button size="sm" onClick={r.reload}>{t('common.retry')}</Button></div>}
      {!d ? (!r.error && <div className={s.notice}>{t('common.loading')}</div>) : (
        <>
          <section className={c.kpis} aria-label={t('dash.kpis')}>
            {d.kpis.map((k) => (
              <KpiTile key={k.key} label={t(`dash.kpi.${k.key}`)} value={value(k)}
                hint={k.key === 'nbv' && k.secondary !== undefined ? t('dash.apc', { value: k.secondary === null ? '—' : formatUsd(k.secondary) }) : undefined}
                tone={k.value && KPI_TONE[k.key] ? KPI_TONE[k.key] : 'default'} onClick={() => nav(k.link)} />
            ))}
          </section>

          <Panel title={t('dash.lifecycle')} subtitle={t('dash.lifecycleHint', { total })}>
            <div className={c.stageBar} role="img" aria-label={d.stages.map((x) => `${t(`asset.stage.${x.stage}`)} ${x.count}`).join(', ')}>
              {total > 0 && d.stages.filter((x) => x.count > 0).map((x) => {
                const pct = (x.count / total) * 100;
                return <span key={x.stage} style={{ width: `${pct}%`, background: stageCodeColorVar[x.stage] }}>{pct >= 6 ? `${Math.round(pct)}%` : ''}</span>;
              })}
            </div>
            <div className={c.stages}>
              {d.stages.map((x) => (
                <button key={x.stage} type="button" className={c.stage} onClick={() => nav(`/assets?stage=${x.stage}`)}>
                  <span className={c.stageName}><span className={s.stageDot} style={{ background: stageCodeColorVar[x.stage] }} />{t(`asset.stage.${x.stage}`)}</span>
                  <strong className={c.stageCount}>{x.count}</strong>
                  <span className="small muted">{t(`dash.stageHelp.${x.stage}`)}</span>
                </button>
              ))}
            </div>
          </Panel>

          <div className={c.cols}>
            <Panel title={t('dash.byCategory')} padded={false}>
              {d.categories.length === 0 ? <EmptyState message={t('dash.noAssets')} /> : (
                <table className={c.table}>
                  <thead><tr><th>{t('asset.col.category')}</th><th className={c.num}>{t('dash.col.total')}</th><th className={c.num}>{t('dash.col.inUse')}</th>
                    <th className={c.num}>{t('dash.col.inStock')}</th><th className={c.num}>{t('dash.col.pastLife')}</th><th>{t('dash.col.nbv')}</th></tr></thead>
                  <tbody>
                    {d.categories.map((x) => (
                      <tr key={x.categoryId}>
                        <td><button type="button" className="link" onClick={() => nav(`/assets?categoryId=${x.categoryId}`)}>{x.name}</button></td>
                        <td className={c.num}>{x.total}</td><td className={c.num}>{x.inUse}</td><td className={c.num}>{x.inStock}</td>
                        <td className={`${c.num} ${x.pastUsefulLife > 0 ? c.warnText : ''}`}>{x.pastUsefulLife}</td>
                        <td>{x.nbv === null ? '—' : (
                          <span className={c.nbv}><span className={c.nbvBar} style={{ width: `${maxNbv ? (x.nbv / maxNbv) * 100 : 0}%` }} /><span className="num small">{formatUsd(x.nbv)}</span></span>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title={t('dash.renewals')} subtitle={t('dash.renewalsHint')}>
              {d.renewals.length === 0 ? <EmptyState message={t('dash.noRenewals')} /> : (
                <ul className={c.list}>
                  {d.renewals.map((x) => (
                    <li key={`${x.kind}-${x.id}`}>
                      <span className={`${c.dot} ${x.daysLeft <= 30 ? c.bad : x.daysLeft <= 60 ? c.warn : c.info}`} aria-hidden="true" />
                      <div className={c.grow}>
                        <button type="button" className="link" onClick={() => nav(x.link)}>{x.name}</button>
                        <div className="small muted">{t(`dash.kind.${x.kind}`)} · {formatDate(x.endDate, lang)}{x.amount ? ` · ${formatUsd(x.amount)}` : ''}</div>
                      </div>
                      <span className={`small ${x.daysLeft <= 30 ? c.badText : x.daysLeft <= 60 ? c.warnText : ''}`}>{t('dash.daysLeft', { count: x.daysLeft })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className={c.cols}>
            <Panel title={t('dash.activity')}>
              {d.activity.length === 0 ? <EmptyState message={t('dash.noActivity')} /> : (
                <ul className={c.list}>
                  {d.activity.map((x) => (
                    <li key={x.id}>
                      <span className={`${c.dot} ${c[EVENT_DOT[x.eventType] ?? 'neutral'] ?? ''}`} aria-hidden="true" />
                      <div className={c.grow}>
                        <span>{t(`dash.event.${x.eventType}`, { defaultValue: x.eventType })} · <button type="button" className="link mono" onClick={() => nav(`/assets/${x.assetId}`)}>{x.assetTag}</button></span>
                        <div className="small muted">{x.description}{x.actorName ? ` · ${x.actorName}` : ''} · {x.channel}</div>
                      </div>
                      <span className="small muted">{formatDateTime(x.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={t('dash.actions')}>
              {d.actions.length === 0 ? <EmptyState message={t('dash.noActions')} /> : (
                <ul className={c.list}>
                  {d.actions.map((x) => (
                    <li key={x.kind}>
                      <strong className={c.actionCount}>{x.count}</strong>
                      <span className={c.grow}>{t(`dash.action.${x.kind}`, { count: x.count })}</span>
                      <Button size="sm" onClick={() => nav(x.link)}>{t('dash.review')}</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
