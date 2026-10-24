// 관리 > SAP 마스터(ADM-035, 읽기 전용): IF-MD-01로 받은 회사·플랜트·프로핏센터·코스트센터·자산클래스. master.read
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { DataTable, EmptyState, FilterBar, FilterSelect, Panel, StatusPill, Tabs, type Column } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import s from '../assets/assets.module.css';

const TYPES = ['COMPANY', 'PLANT', 'PROFIT_CENTER', 'COST_CENTER', 'ASSET_CLASS'] as const;
type MType = (typeof TYPES)[number];
interface SummaryItem { type: MType; total: number; active: number; inactive: number; updatedAt?: string }
interface Summary { items: SummaryItem[]; lastRun?: { batchId: string; status: 'SUCCESS' | 'PARTIAL' | 'FAILED'; recordCount: number; successCount: number; errorCount: number; startedAt: string } }
interface Row { id: string; code: string; name: string; companyCode?: string; controllingArea?: string; detail?: string; isActive: boolean; updatedAt?: string; usage?: number }

const fmt = (v?: string) => (v ? v.slice(0, 16).replace('T', ' ') : '');
const match = (q: string, ...vals: (string | undefined)[]) => !q.trim() || vals.some((v) => (v ?? '').toLowerCase().includes(q.trim().toLowerCase()));

export function SapMasters() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab: MType = (TYPES as readonly string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as MType) : 'COMPANY';
  const summary = useAsync((sig) => api.get<Summary>('/admin/sap-masters/summary', sig), []);
  const run = summary.data?.lastRun;
  const count = (type: MType) => summary.data?.items.find((i) => i.type === type);
  return (
    <>
      <ViewHeader crumb={t('company.crumb')} title={t('sapm.title')} description={t('sapm.description')} />
      <div className={s.notice} style={{ marginBottom: 12 }}>
        {run ? (
          <span>{t('sapm.lastRun')}: {fmt(run.startedAt)} · <StatusPill tone={run.status === 'SUCCESS' ? 'ok' : run.status === 'PARTIAL' ? 'warn' : 'bad'}>{run.status}</StatusPill>
            {' '}· {t('sapm.runCounts', { total: run.recordCount, ok: run.successCount, err: run.errorCount })}</span>
        ) : <span>{summary.loading ? t('common.loading') : t('sapm.noRun')}</span>}
      </div>
      <Panel padded={false}>
        <Tabs<MType> label={t('sapm.title')} value={tab} onChange={(v) => setSp(new URLSearchParams({ tab: v }), { replace: true })}
          items={TYPES.map((v) => ({ value: v, label: `${t(`sapm.type.${v}`)}${count(v) ? ` (${count(v)!.active}/${count(v)!.total})` : ''}` }))} />
        <MasterList key={tab} type={tab} />
      </Panel>
    </>
  );
}

function MasterList({ type }: { type: MType }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const list = useAsync((sig) => api.get<{ items: Row[] }>(`/admin/sap-masters/${type}${qs({ active })}`, sig), [type, active]);
  const columns = useMemo<Column<Row>[]>(() => {
    const cols: Column<Row>[] = [{ key: 'code', label: t(`sapm.code.${type}`), render: (x) => <span className="mono">{x.code}</span> }, { key: 'name', label: t('company.name') }];
    if (type === 'PLANT' || type === 'COST_CENTER') cols.push({ key: 'companyCode', label: t('company.code'), render: (x) => <span className="mono">{x.companyCode}</span> });
    if (type === 'PROFIT_CENTER' || type === 'COST_CENTER') cols.push({ key: 'controllingArea', label: t('sapm.area') });
    cols.push({ key: 'detail', label: t(`sapm.detail.${type}`), render: (x) => (type === 'ASSET_CLASS' && x.detail ? t(`sapm.flag.${x.detail}`) : x.detail ?? '') });
    if (type !== 'PROFIT_CENTER') cols.push({ key: 'usage', label: t(`sapm.usage.${type}`), align: 'right' });
    cols.push({ key: 'isActive', label: t('fin.active'), render: (x) => (x.isActive ? t('common.yes') : <StatusPill tone="neutral">{t('sapm.inactive')}</StatusPill>) });
    cols.push({ key: 'updatedAt', label: t('sapm.updated'), render: (x) => fmt(x.updatedAt) });
    return cols;
  }, [t, type]);
  return (
    <>
      <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('sapm.search')}>
        <FilterSelect label={t('fin.active')} allLabel={t('sapm.all')} value={active} onChange={setActive}
          options={[{ value: 'true', label: t('sapm.onlyActive') }, { value: 'false', label: t('sapm.onlyInactive') }]} />
      </FilterBar>
      {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
        <DataTable rows={(list.data?.items ?? []).filter((x) => match(q, x.code, x.name, x.companyCode, x.detail))} columns={columns} rowId={(x) => x.id} loading={list.loading}
          empty={<EmptyState message={t('common.noResults')} />} />
      )}
      <div className={s.notice} style={{ margin: 12 }}>{t('sapm.readOnly')}</div>
    </>
  );
}
