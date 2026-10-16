// ALM-240 실물 실사 캠페인 목록·만들기(WBS 4.4). 만들기는 SCOPING으로 시작 → 상세에서 룸 담당 배정 후 실사 시작
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, Panel, ProgressBar, SelectField, StatusPill, TextField, useToast, type Column } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Lookups, Page } from '../assets/types';
import { CAMPAIGN_STATUSES, campaignTone, type CampaignDetail, type CampaignSummary } from './types';
import s from '../assets/assets.module.css';
import c from './counts.module.css';

export function CountList() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const r = useAsync((sig) => api.get<Page<CampaignSummary>>(`/count-campaigns${qs({ status, pageSize: 200 })}`, sig), [status]);
  const columns = useMemo<Column<CampaignSummary>[]>(() => [
    { key: 'campaignCode', label: t('count.col.code'), render: (x) => <span className="mono">{x.campaignCode}</span> },
    { key: 'name', label: t('count.col.name') },
    { key: 'companyCode', label: t('company.code'), render: (x) => <span className="mono">{x.companyCode}</span> },
    { key: 'status', label: t('count.col.status'), render: (x) => <StatusPill tone={campaignTone[x.status]}>{t(`count.status.${x.status}`)}</StatusPill> },
    { key: 'keyDate', label: t('count.col.keyDate'), render: (x) => formatDate(x.keyDate) },
    { key: 'dueDate', label: t('count.col.dueDate'), render: (x) => formatDate(x.dueDate) },
    { key: 'countedItems', label: t('count.col.progress'), render: (x) => (x.totalItems
      ? <ProgressBar label={t('count.col.progress')} value={x.countedItems} max={x.totalItems} /> : <span className="faint">—</span>) },
    { key: 'varianceItems', label: t('count.col.variances'), align: 'right', render: (x) => (x.varianceItems ? <StatusPill tone="warn">{x.varianceItems}</StatusPill> : '0') },
  ], [t]);
  return (
    <>
      <ViewHeader crumb="ALM-240" title={t('nav.inventoryCount')} description={t('count.list.description')}
        actions={can('count.manage') ? <Button variant="primary" onClick={() => setCreating(true)}>{t('count.list.new')}</Button> : undefined} />
      <Panel padded={false}>
        <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('count.list.search')}
          onClear={status || q ? () => { setQ(''); setSp(new URLSearchParams(), { replace: true }); } : undefined}>
          <FilterSelect label={t('count.col.status')} allLabel={t('count.list.allStatus')} value={status}
            onChange={(v) => setSp(v ? new URLSearchParams({ status: v }) : new URLSearchParams(), { replace: true })}
            options={CAMPAIGN_STATUSES.map((x) => ({ value: x, label: t(`count.status.${x}`) }))} />
        </FilterBar>
        {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
          <DataTable rows={(r.data?.items ?? []).filter((x) => !q.trim() || `${x.campaignCode} ${x.name}`.toLowerCase().includes(q.trim().toLowerCase()))}
            columns={columns} rowId={(x) => x.id} loading={r.loading} onRowClick={(x) => nav(`/counts/${x.id}`)}
            empty={<EmptyState message={t('count.list.empty')} />} />
        )}
      </Panel>
      {creating && <CreateDrawer onClose={() => setCreating(false)} onCreated={(id) => nav(`/counts/${id}`)} />}
    </>
  );
}

interface Form { campaignCode: string; name: string; companyId: string; keyDate: string; dueDate: string; siteIds: string[]; capitalizedOnly: boolean }

function CreateDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=companies,sites', sig), []);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState<Form>({ campaignCode: '', name: '', companyId: '', keyDate: today, dueDate: today, siteIds: [], capitalizedOnly: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const companies = lk.data?.companies ?? [];
  const companyId = f.companyId || (companies.length === 1 ? companies[0].id : '');
  const toggleSite = (id: string) => setF((v) => ({ ...v, siteIds: v.siteIds.includes(id) ? v.siteIds.filter((x) => x !== id) : [...v.siteIds, id] }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (!/^[A-Za-z0-9]{2,6}$/.test(f.campaignCode.trim())) e.campaignCode = t('count.create.codeHint');
    if (!f.name.trim()) e.name = t('common.required');
    if (!companyId) e.companyId = t('common.required');
    if (!f.keyDate) e.keyDate = t('common.required');
    if (!f.dueDate) e.dueDate = t('common.required');
    else if (f.dueDate < f.keyDate) e.dueDate = t('count.create.dueHint');
    if (!f.siteIds.length) e.siteIds = t('count.create.siteHint');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const r = await api.post<CampaignDetail>('/count-campaigns', { campaignCode: f.campaignCode.trim().toUpperCase(), name: f.name.trim(), companyId,
        keyDate: f.keyDate, dueDate: f.dueDate, scope: { siteIds: f.siteIds, ...(f.capitalizedOnly ? { includeNonCapitalized: false } : {}) } });
      toast.show(t('count.create.created', { code: r.campaign.campaignCode }), 'success');
      onCreated(r.id);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={t('count.list.new')} title={t('count.list.new')}>
      <p className="faint">{t('count.create.note')}</p>
      <FormGrid onSubmit={() => void save()}>
        <TextField label={t('count.col.code')} required maxLength={6} value={f.campaignCode} error={errors.campaignCode} hint={t('count.create.codeHint')} onChange={set('campaignCode')} />
        <TextField label={t('count.col.name')} required maxLength={100} value={f.name} error={errors.name} onChange={set('name')} />
        <SelectField label={t('company.code')} required value={companyId} error={errors.companyId} onChange={set('companyId')}
          options={[{ value: '', label: '—' }, ...companies.map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))]} />
        <TextField label={t('count.col.keyDate')} required type="date" value={f.keyDate} error={errors.keyDate} hint={t('count.create.keyDateHint')} onChange={set('keyDate')} />
        <TextField label={t('count.col.dueDate')} required type="date" value={f.dueDate} error={errors.dueDate} onChange={set('dueDate')} />
        <fieldset className={c.sites} aria-label={t('count.create.sites')}>
          <legend className="small">{t('count.create.sites')} *</legend>
          {(lk.data?.sites ?? []).map((x) => (
            <CheckboxField key={x.id} full={false} label={`${x.code} · ${x.label}`} checked={f.siteIds.includes(x.id)} onChange={() => toggleSite(x.id)} />
          ))}
          {errors.siteIds && <span className="small" role="alert" style={{ color: 'var(--bad)' }}>{errors.siteIds}</span>}
        </fieldset>
        <CheckboxField label={t('count.create.capitalizedOnly')} checked={f.capitalizedOnly} onChange={(e) => setF((v) => ({ ...v, capitalizedOnly: e.target.checked }))} />
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('count.create.submit')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
