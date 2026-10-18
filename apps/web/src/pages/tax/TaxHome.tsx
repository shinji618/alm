// ALM-260 재산세(사업용 동산) — 신고 목록(과거 기록) · 관할 · 계수표(WBS 4.x, 2026-10 요청)
//   신고 1건 = 회사 × 관할(주·카운티) × 과세 연도. 계산 시점 자산을 복사해 두므로 신고(FILED) 뒤에는 그대로 과거 기록이 된다
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, Panel, SelectField, StatusPill, Tabs, TextareaField, TextField,
  useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { formatDate, formatUsd } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Lookups } from '../assets/types';
import { FACTOR_SETS, FILING_STATUSES, filingTone, PROPERTY_TYPES, type ClassMapItem, type ExemptionMode, type FactorSet, type FactorTable, type FilingDetail,
  type FilingSummary, type Jurisdiction, type PropertyType, type PropertyTypes, type TaxReference } from './types';
import s from '../assets/assets.module.css';
import c from './tax.module.css';

type Tab = 'filings' | 'jurisdictions' | 'types' | 'factors';
const pad2 = (n: number) => String(n).padStart(2, '0');
const lienOf = (j: Jurisdiction, year: string) => `${year}-${pad2(j.lienMonth)}-${pad2(j.lienDay)}`;
/** 다음에 낼 신고의 과세 연도: 올해 기한이 지났으면 내년(예: GA 10월이면 2027년 신고 = 2027-01-01 기준 보유 자산) */
export function nextTaxYear(j: Pick<Jurisdiction, 'lienMonth' | 'lienDay' | 'dueMonth' | 'dueDay'>, today = new Date()): number {
  const y = today.getFullYear();
  const md = today.toISOString().slice(5, 10);
  const end = j.dueMonth ? `${pad2(j.dueMonth)}-${pad2(j.dueDay ?? 1)}` : `${pad2(j.lienMonth)}-${pad2(j.lienDay)}`;
  return md > end ? y + 1 : y;
}
const md = (m?: number, d?: number) => (m ? `${String(m).padStart(2, '0')}/${String(d ?? 1).padStart(2, '0')}` : '—');

export function TaxHome() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'filings';
  return (
    <>
      <ViewHeader crumb="ALM-260" title={t('nav.propertyTax')} description={t('tax.description')} />
      <Panel padded={false}>
        <Tabs<Tab> label={t('nav.propertyTax')} value={tab} onChange={(v) => setSp(v === 'filings' ? new URLSearchParams() : new URLSearchParams({ tab: v }), { replace: true })}
          items={[{ value: 'filings', label: t('tax.tab.filings') }, { value: 'jurisdictions', label: t('tax.tab.jurisdictions') },
            { value: 'types', label: t('tax.tab.types') }, { value: 'factors', label: t('tax.tab.factors') }]} />
        {tab === 'filings' && <Filings />}
        {tab === 'jurisdictions' && <Jurisdictions />}
        {tab === 'types' && <PropertyTypesTab />}
        {tab === 'factors' && <Factors />}
      </Panel>
    </>
  );
}

// ---------------- 신고 목록(과거 기록) ----------------
function Filings() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useSession();
  const [f, setF] = useState({ taxYear: '', state: '', status: '' });
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const r = useAsync((sig) => api.get<{ items: FilingSummary[]; years: number[] }>(`/tax/filings${qs(f)}`, sig), [f.taxYear, f.state, f.status]);
  const all = r.data?.items ?? [];
  const items = all.filter((x) => !q.trim() || `${x.companyCode} ${x.county} ${x.jurisdictionName} ${x.filingRef ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const states = useMemo(() => [...new Set(all.map((x) => x.state))].sort(), [all]);
  const totals = items.reduce((a, x) => ({ est: a.est + x.estimatedTax, act: a.act + (x.actualTax ?? 0) }), { est: 0, act: 0 });
  const columns = useMemo<Column<FilingSummary>[]>(() => [
    { key: 'taxYear', label: t('tax.col.year'), render: (x) => <span className="mono">{x.taxYear}</span> },
    { key: 'companyCode', label: t('company.code'), render: (x) => <span className="mono">{x.companyCode}</span> },
    { key: 'jurisdiction', label: t('tax.col.jurisdiction'), render: (x) => `${x.state} · ${x.county}`, sortValue: (x) => `${x.state}${x.county}` },
    { key: 'formCode', label: t('tax.col.form'), render: (x) => x.formCode ?? '—' },
    { key: 'status', label: t('tax.col.status'), render: (x) => <StatusPill tone={filingTone[x.status]}>{t(`tax.status.${x.status}`)}</StatusPill> },
    { key: 'assetCount', label: t('tax.col.assets'), align: 'right' },
    { key: 'totalCost', label: t('tax.col.cost'), align: 'right', render: (x) => formatUsd(x.totalCost) },
    { key: 'totalMarketValue', label: t('tax.col.marketValue'), align: 'right', render: (x) => formatUsd(x.totalMarketValue) },
    { key: 'estimatedTax', label: t('tax.col.estimatedTax'), align: 'right', render: (x) => formatUsd(x.estimatedTax, 2) },
    { key: 'actualTax', label: t('tax.col.actualTax'), align: 'right', render: (x) => (x.actualTax === undefined ? '—' : formatUsd(x.actualTax, 2)) },
    { key: 'dueDate', label: t('tax.col.due'), render: (x) => formatDate(x.dueDate) },
    { key: 'filedAt', label: t('tax.col.filedAt'), render: (x) => formatDate(x.filedAt) },
  ], [t]);
  const set = (k: keyof typeof f) => (v: string) => setF((o) => ({ ...o, [k]: v }));
  return (
    <>
      <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('tax.searchFilings')}
        onClear={f.taxYear || f.state || f.status || q ? () => { setF({ taxYear: '', state: '', status: '' }); setQ(''); } : undefined}>
        <FilterSelect label={t('tax.col.year')} allLabel={t('tax.allYears')} value={f.taxYear} onChange={set('taxYear')}
          options={(r.data?.years ?? []).map((y) => ({ value: String(y), label: String(y) }))} />
        <FilterSelect label={t('tax.col.state')} allLabel={t('tax.allStates')} value={f.state} onChange={set('state')}
          options={(f.state && !states.includes(f.state) ? [...states, f.state] : states).map((x) => ({ value: x, label: x }))} />
        <FilterSelect label={t('tax.col.status')} allLabel={t('tax.allStatus')} value={f.status} onChange={set('status')}
          options={FILING_STATUSES.map((x) => ({ value: x, label: t(`tax.status.${x}`) }))} />
        {can('tax.manage') && <Button variant="primary" onClick={() => setCreating(true)}>{t('tax.new')}</Button>}
      </FilterBar>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={items} columns={columns} rowId={(x) => x.id} loading={r.loading} onRowClick={(x) => nav(`/tax/filings/${x.id}`)}
          empty={<EmptyState message={t('tax.empty')} />}
          footer={items.length ? <span className="small">{t('tax.totals', { n: items.length, est: formatUsd(totals.est, 2), act: formatUsd(totals.act, 2) })}</span> : undefined} />
      )}
      {creating && <CreateFiling onClose={() => setCreating(false)} onCreated={(id) => nav(`/tax/filings/${id}`)} />}
    </>
  );
}

function CreateFiling({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=companies', sig), []);
  const jr = useAsync((sig) => api.get<{ items: Jurisdiction[] }>('/tax/jurisdictions', sig), []);
  const [f, setF] = useState({ companyId: '', jurisdictionId: '', taxYear: String(new Date().getFullYear()) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const companies = lk.data?.companies ?? [];
  const jurs = (jr.data?.items ?? []).filter((x) => x.isActive);
  const companyId = f.companyId || (companies.length === 1 ? companies[0].id : '');
  const jur = jurs.find((x) => x.id === f.jurisdictionId);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (!companyId) e.companyId = t('common.required');
    if (!f.jurisdictionId) e.jurisdictionId = t('common.required');
    if (!/^\d{4}$/.test(f.taxYear)) e.taxYear = t('common.required');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const r = await api.post<FilingDetail>('/tax/filings', { companyId, jurisdictionId: f.jurisdictionId, taxYear: Number(f.taxYear) });
      toast.show(t('tax.created', { year: r.taxYear, state: r.state, county: r.county }), 'success');
      onCreated(r.id);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={t('tax.new')} title={t('tax.new')}>
      <p className="faint">{t('tax.createNote')}</p>
      <FormGrid onSubmit={() => void save()}>
        <SelectField label={t('company.code')} required value={companyId} error={errors.companyId} onChange={set('companyId')}
          options={[{ value: '', label: '—' }, ...companies.map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))]} />
        <SelectField label={t('tax.col.jurisdiction')} required value={f.jurisdictionId} error={errors.jurisdictionId}
          onChange={(e) => { const j = jurs.find((x) => x.id === e.target.value); setF((v) => ({ ...v, jurisdictionId: e.target.value, ...(j ? { taxYear: String(nextTaxYear(j)) } : {}) })); }}
          hint={jurs.length ? undefined : t('tax.noJurisdictions')}
          options={[{ value: '', label: '—' }, ...jurs.map((x) => ({ value: x.id, label: `${x.state} · ${x.county} (${x.sites?.length ?? 0} ${t('tax.sitesShort')})` }))]} />
        <TextField label={t('tax.col.year')} required inputMode="numeric" maxLength={4} value={f.taxYear} error={errors.taxYear} onChange={set('taxYear')}
          hint={jur ? <>{t('tax.lienHint', { date: lienOf(jur, f.taxYear) })}
            {lienOf(jur, f.taxYear) > new Date().toISOString().slice(0, 10) ? <> · {t('tax.futureLien')}</> : null}</> : undefined} />
        {jur && !jur.taxable && <p className={c.note} role="status">{t('tax.notTaxable', { state: jur.state })}</p>}
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('tax.generate')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}

// ---------------- 관할 ----------------
function Jurisdictions() {
  const { t } = useTranslation();
  const { can } = useSession();
  const r = useAsync((sig) => api.get<{ items: Jurisdiction[] }>('/tax/jurisdictions', sig), []);
  const ref = useAsync((sig) => api.get<TaxReference>('/tax/reference', sig), []);
  const [editing, setEditing] = useState<Jurisdiction | 'new'>();
  const columns = useMemo<Column<Jurisdiction>[]>(() => [
    { key: 'state', label: t('tax.col.state'), render: (x) => <span className="mono">{x.state}</span> },
    { key: 'county', label: t('tax.col.county') },
    { key: 'formCode', label: t('tax.col.form'), render: (x) => (x.taxable ? x.formCode ?? '—' : <StatusPill>{t('tax.notTaxableShort')}</StatusPill>) },
    { key: 'lien', label: t('tax.col.lien'), render: (x) => md(x.lienMonth, x.lienDay) },
    { key: 'due', label: t('tax.col.due'), render: (x) => md(x.dueMonth, x.dueDay) },
    { key: 'assessmentRatio', label: t('tax.col.ratio'), align: 'right', render: (x) => `${Math.round(x.assessmentRatio * 1000) / 10}%` },
    { key: 'millage', label: t('tax.col.millage'), align: 'right' },
    { key: 'exemption', label: t('tax.col.exemption'), render: (x) => (x.exemptionMode === 'NONE' ? '—' : `${t(`tax.exemption.${x.exemptionMode}`)} ${formatUsd(x.exemptionAmount)}`) },
    { key: 'factorSet', label: t('tax.col.factorSet'), render: (x) => <span className="mono">{x.factorSet}</span> },
    { key: 'sites', label: t('tax.col.sites'), render: (x) => (x.sites?.length ? x.sites.map((y) => y.siteCode).join(', ') : <span className="faint">{t('tax.noSites')}</span>) },
  ], [t]);
  return (
    <>
      <div className={c.toolbar}>
        <span className="faint small">{t('tax.jurisdictionNote')}</span>
        {can('tax.manage') && <Button variant="primary" onClick={() => setEditing('new')}>{t('tax.addJurisdiction')}</Button>}
      </div>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={r.loading}
          onRowClick={can('tax.manage') ? (x) => setEditing(x) : undefined} empty={<EmptyState message={t('tax.noJurisdictions')} />} />
      )}
      {editing && ref.data && <JurisdictionDrawer value={editing === 'new' ? undefined : editing} reference={ref.data} onClose={() => setEditing(undefined)}
        onSaved={() => { setEditing(undefined); r.reload(); }} />}
    </>
  );
}

interface JForm { state: string; county: string; name: string; taxable: boolean; formCode: string; lienMonth: string; lienDay: string; dueMonth: string; dueDay: string;
  assessmentRatio: string; millage: string; exemptionMode: ExemptionMode; exemptionAmount: string; factorSet: FactorSet; notes: string; isActive: boolean; siteIds: string[];
  includeVehicles: boolean; includeCip: boolean }

function JurisdictionDrawer({ value, reference, onClose, onSaved }: { value?: Jurisdiction; reference: TaxReference; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=sites', sig), []);
  const str = (n?: number) => (n === undefined || n === null ? '' : String(n));
  const [f, setF] = useState<JForm>(() => ({ state: value?.state ?? '', county: value?.county ?? '', name: value?.name ?? '', taxable: value?.taxable ?? true,
    formCode: value?.formCode ?? '', lienMonth: str(value?.lienMonth ?? 1), lienDay: str(value?.lienDay ?? 1), dueMonth: str(value?.dueMonth), dueDay: str(value?.dueDay),
    assessmentRatio: str(value?.assessmentRatio ?? 1), millage: str(value?.millage ?? 0), exemptionMode: value?.exemptionMode ?? 'NONE',
    exemptionAmount: str(value?.exemptionAmount ?? 0), factorSet: value?.factorSet ?? 'GENERIC_SL', notes: value?.notes ?? '', isActive: value?.isActive ?? true,
    siteIds: value?.sites?.map((x) => x.id) ?? [], includeVehicles: value?.includeVehicles ?? false, includeCip: value?.includeCip ?? true }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const preset = reference.presets.find((p) => p.state === f.state.toUpperCase());
  const set = (k: keyof JForm) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const applyPreset = (st: string) => {
    const p = reference.presets.find((x) => x.state === st);
    setF((v) => (p ? { ...v, state: st, taxable: p.taxable, formCode: p.formCode ?? '', lienMonth: str(p.lienMonth), lienDay: str(p.lienDay), dueMonth: str(p.dueMonth),
      dueDay: str(p.dueDay), assessmentRatio: str(p.assessmentRatio), millage: str(p.typicalMillage ?? 0), exemptionMode: p.exemptionMode,
      exemptionAmount: str(p.exemptionAmount), factorSet: p.factorSet, includeVehicles: p.includeVehicles, includeCip: p.includeCip, name: v.name || (v.county ? `${v.county} County, ${st}` : '') } : { ...v, state: st }));
  };
  const toggleSite = (id: string) => setF((v) => ({ ...v, siteIds: v.siteIds.includes(id) ? v.siteIds.filter((x) => x !== id) : [...v.siteIds, id] }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (!/^[A-Za-z]{2}$/.test(f.state)) e.state = t('common.required');
    if (!f.county.trim()) e.county = t('common.required');
    if (!f.name.trim()) e.name = t('common.required');
    setErrors(e);
    if (Object.keys(e).length) return;
    const num = (x: string) => (x.trim() === '' ? undefined : Number(x));
    const body = { state: f.state.toUpperCase(), county: f.county.trim(), name: f.name.trim(), taxable: f.taxable, formCode: f.formCode.trim() || undefined,
      lienMonth: num(f.lienMonth), lienDay: num(f.lienDay), dueMonth: num(f.dueMonth), dueDay: num(f.dueDay), assessmentRatio: num(f.assessmentRatio),
      millage: num(f.millage), exemptionMode: f.exemptionMode, exemptionAmount: num(f.exemptionAmount), factorSet: f.factorSet, notes: f.notes.trim() || undefined, isActive: f.isActive,
      includeVehicles: f.includeVehicles, includeCip: f.includeCip };
    setSaving(true);
    try {
      const j = value ? await api.patch<Jurisdiction>(`/tax/jurisdictions/${value.id}`, body) : await api.post<Jurisdiction>('/tax/jurisdictions', body);
      const before = (value?.sites ?? []).map((x) => x.id).sort().join();
      if ([...f.siteIds].sort().join() !== before) await api.put(`/tax/jurisdictions/${j.id}/sites`, { siteIds: f.siteIds });
      toast.show(t('common.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  const title = value ? `${value.state} · ${value.county}` : t('tax.addJurisdiction');
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void save()}>
        <SelectField label={t('tax.col.state')} required value={f.state} error={errors.state} onChange={(e) => applyPreset(e.target.value)}
          options={[{ value: '', label: '—' }, ...reference.presets.map((p) => ({ value: p.state, label: `${p.state} · ${p.name}` })),
            ...(f.state && !preset ? [{ value: f.state, label: f.state }] : [])]} />
        <TextField label={t('tax.col.county')} required maxLength={60} value={f.county} error={errors.county} onChange={set('county')} hint={t('tax.countyHint')} />
        <TextField label={t('tax.col.name')} required maxLength={100} value={f.name} error={errors.name} onChange={set('name')} />
        <TextField label={t('tax.col.form')} maxLength={20} value={f.formCode} onChange={set('formCode')} />
        {preset && <p className={`${c.note} small faint`}>{preset.note}</p>}
        <TextField label={t('tax.lienMonth')} type="number" min={1} max={12} value={f.lienMonth} onChange={set('lienMonth')} />
        <TextField label={t('tax.lienDay')} type="number" min={1} max={31} value={f.lienDay} onChange={set('lienDay')} />
        <TextField label={t('tax.dueMonth')} type="number" min={1} max={12} value={f.dueMonth} onChange={set('dueMonth')} />
        <TextField label={t('tax.dueDay')} type="number" min={1} max={31} value={f.dueDay} onChange={set('dueDay')} />
        <TextField label={t('tax.col.ratio')} type="number" step="0.0001" min={0} max={1} value={f.assessmentRatio} onChange={set('assessmentRatio')} hint={t('tax.ratioHint')} />
        <TextField label={t('tax.col.millage')} type="number" step="0.0001" min={0} value={f.millage} onChange={set('millage')} hint={t('tax.millageHint')} />
        <SelectField label={t('tax.col.exemption')} value={f.exemptionMode} onChange={set('exemptionMode')}
          options={(['NONE', 'THRESHOLD', 'DEDUCT'] as const).map((x) => ({ value: x, label: t(`tax.exemption.${x}`) }))} />
        <TextField label={t('tax.exemptionAmount')} type="number" min={0} value={f.exemptionAmount} onChange={set('exemptionAmount')} disabled={f.exemptionMode === 'NONE'} />
        <SelectField label={t('tax.col.factorSet')} value={f.factorSet} onChange={set('factorSet')} options={FACTOR_SETS.map((x) => ({ value: x, label: t(`tax.factorSet.${x}`) }))} />
        <CheckboxField label={t('tax.taxable')} checked={f.taxable} onChange={(e) => setF((v) => ({ ...v, taxable: e.target.checked }))} />
        <CheckboxField label={t('tax.includeVehicles')} checked={f.includeVehicles} onChange={(e) => setF((v) => ({ ...v, includeVehicles: e.target.checked }))} />
        <CheckboxField label={t('tax.includeCip')} checked={f.includeCip} onChange={(e) => setF((v) => ({ ...v, includeCip: e.target.checked }))} />
        <CheckboxField label={t('tax.active')} checked={f.isActive} onChange={(e) => setF((v) => ({ ...v, isActive: e.target.checked }))} />
        <fieldset className={c.sites} aria-label={t('tax.col.sites')}>
          <legend className="small">{t('tax.col.sites')}</legend>
          {(lk.data?.sites ?? []).map((x) => (
            <CheckboxField key={x.id} full={false} label={`${x.code} · ${x.label}`} checked={f.siteIds.includes(x.id)} onChange={() => toggleSite(x.id)} />
          ))}
        </fieldset>
        <TextareaField label={t('tax.notes')} maxLength={2000} value={f.notes} onChange={set('notes')} />
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}

// ---------------- 계수표·구분 매핑 ----------------
function Factors() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  const manage = can('tax.manage');
  const [set, setSet] = useState<FactorSet>('GA_DOR');
  const [year, setYear] = useState('');
  const r = useAsync((sig) => api.get<FactorTable>(`/tax/factors${qs({ factorSet: set, tableYear: year })}`, sig), [set, year]);
  const cm = useAsync((sig) => api.get<{ items: ClassMapItem[] }>(`/tax/class-map?factorSet=${set}`, sig), [set]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setEdit({}), [set, year, r.data]);
  const x = r.data;
  const classes = useMemo(() => [...new Set((x?.rows ?? []).map((y) => y.lifeClass))], [x]);
  const ages = useMemo(() => [...new Set((x?.rows ?? []).map((y) => y.age))].sort((a, b) => a - b), [x]);
  const cell = (cls: string, age: number) => edit[`${cls}|${age}`] ?? String(x?.rows.find((y) => y.lifeClass === cls && y.age === age)?.factor ?? '');
  const dirty = Object.keys(edit).length > 0;

  const load = async () => {
    if (!(await confirm({ title: t('tax.loadReference'), message: t('tax.loadReferenceMsg', { set }), confirmLabel: t('tax.loadReference') }))) return;
    setBusy(true);
    try {
      await api.post(`/tax/factors:load-reference`, { factorSet: set });
      toast.show(t('tax.loaded'), 'success');
      setYear(''); r.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!x?.tableYear) return;
    const rows = classes.flatMap((cls) => ages.map((age) => ({ lifeClass: cls, age, factor: Number(cell(cls, age)) }))
      .filter((y) => cell(y.lifeClass, y.age) !== '' && Number.isFinite(y.factor)));
    setBusy(true);
    try {
      await api.put('/tax/factors', { factorSet: set, tableYear: x.tableYear, source: x.source, rows });
      toast.show(t('common.saved'), 'success');
      r.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const setClass = async (it: ClassMapItem, lifeClass: string) => {
    try {
      await api.put('/tax/class-map', { factorSet: set, items: [{ categoryId: it.categoryId, lifeClass: lifeClass || undefined }] });
      cm.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const classOptions = set === 'GENERIC_SL' || set === 'CA_BOE581' ? [] : classes;
  const cmColumns: Column<ClassMapItem>[] = [
    { key: 'name', label: t('tax.col.category') },
    { key: 'usefulLifeYears', label: t('tax.col.life'), align: 'right', render: (y) => y.usefulLifeYears ?? '—' },
    { key: 'defaultClass', label: t('tax.col.defaultClass'), render: (y) => <span className="mono">{y.defaultClass}</span> },
    { key: 'lifeClass', label: t('tax.col.class'), render: (y) => (manage ? (
      classOptions.length ? (
        <select aria-label={`${t('tax.col.class')} ${y.name}`} value={y.lifeClass ?? ''} onChange={(e) => void setClass(y, e.target.value)}>
          <option value="">{t('tax.useDefault')}</option>
          {classOptions.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : <input aria-label={`${t('tax.col.class')} ${y.name}`} defaultValue={y.lifeClass ?? ''} maxLength={10} size={6}
        onBlur={(e) => { if (e.target.value !== (y.lifeClass ?? '')) void setClass(y, e.target.value.trim()); }} />
    ) : <span className="mono">{y.lifeClass ?? '—'}</span>) },
  ];
  return (
    <>
      <div className={c.toolbar}>
        <SelectField label={t('tax.col.factorSet')} full={false} value={set} onChange={(e) => { setSet(e.target.value as FactorSet); setYear(''); }}
          options={FACTOR_SETS.map((y) => ({ value: y, label: t(`tax.factorSet.${y}`) }))} />
        <SelectField label={t('tax.tableYear')} full={false} value={year || String(x?.tableYear ?? '')} onChange={(e) => setYear(e.target.value)}
          options={(x?.tableYears.length ? x.tableYears : ['']).map((y) => ({ value: String(y), label: y ? String(y) : '—' }))} />
        {manage && set !== 'GENERIC_SL' && <Button disabled={busy} onClick={() => void load()}>{t('tax.loadReference')}</Button>}
        {manage && dirty && <Button variant="primary" disabled={busy} onClick={() => void save()}>{t('common.save')}</Button>}
      </div>
      {x?.source && <p className={`${s.notice} small`} style={{ margin: '0 12px 12px' }}>{t('tax.source')}: {x.source}</p>}
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div>
        : !x?.rows.length ? <EmptyState message={t(set === 'GENERIC_SL' ? 'tax.genericNote' : 'tax.noTable')} /> : (
          <div className={c.grid}>
            <table aria-label={t('tax.tab.factors')}>
              <thead><tr><th>{t('tax.col.age')}</th>{classes.map((cls) => <th key={cls} scope="col">{cls}</th>)}</tr></thead>
              <tbody>
                {ages.map((age) => (
                  <tr key={age}>
                    <th scope="row">{age}</th>
                    {classes.map((cls) => (
                      <td key={cls}>{manage ? (
                        <input aria-label={`${cls} ${age}`} inputMode="decimal" value={cell(cls, age)} onChange={(e) => setEdit((v) => ({ ...v, [`${cls}|${age}`]: e.target.value }))} />
                      ) : cell(cls, age) || '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small faint">{t('tax.ageNote', { start: x.ageStart })}</p>
          </div>
        )}
      <Panel title={t('tax.classMap')} subtitle={t('tax.classMapNote')} padded={false}>
        <DataTable rows={cm.data?.items ?? []} columns={cmColumns} rowId={(y) => y.categoryId} loading={cm.loading} empty={<EmptyState message={t('common.noResults')} />} />
      </Panel>
    </>
  );
}

// ---------------- 재산세 구분(자산클래스·카테고리) ----------------
//   구분: 카테고리 지정 → 자산클래스 지정 → 클래스 이름 추정. 임차 자산·부동산·무형·제외는 신고에서 빠지고, 차량·건설중은 관할 설정을 따른다
function PropertyTypesTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useSession();
  const manage = can('tax.manage');
  const r = useAsync((sig) => api.get<PropertyTypes>('/tax/property-types', sig), []);
  const save = async (kind: 'assetClasses' | 'categories', id: string, v: string) => {
    try {
      await api.put('/tax/property-types', { [kind]: [{ id, propertyType: v || null }] });
      toast.show(t('common.saved'), 'success');
      r.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const label = (x?: PropertyType) => (x ? t(`tax.ptype.${x}`) : '—');
  const pick = (kind: 'assetClasses' | 'categories', id: string, value: PropertyType | undefined, fallback: string, name: string) => (manage ? (
    <select aria-label={`${t('tax.col.propertyType')} ${name}`} value={value ?? ''} onChange={(e) => void save(kind, id, e.target.value)}>
      <option value="">{fallback}</option>
      {PROPERTY_TYPES.map((o) => <option key={o} value={o}>{t(`tax.ptype.${o}`)}</option>)}
    </select>
  ) : <span>{value ? label(value) : fallback}</span>);
  const classCols: Column<PropertyTypes['assetClasses'][number]>[] = [
    { key: 'classCode', label: t('tax.col.assetClass'), render: (x) => <span className="mono">{x.classCode}</span> },
    { key: 'name', label: t('tax.col.name') },
    { key: 'propertyType', label: t('tax.col.propertyType'),
      render: (x) => pick('assetClasses', x.id, x.propertyType, t('tax.ptypeGuess', { type: label(x.suggested) }), x.classCode) },
    { key: 'status', label: '', render: (x) => (x.propertyType ? null : <StatusPill tone="warn">{t('tax.ptypeUnset')}</StatusPill>) },
  ];
  const catCols: Column<PropertyTypes['categories'][number]>[] = [
    { key: 'name', label: t('tax.col.category') },
    { key: 'classCode', label: t('tax.col.assetClass'), render: (x) => <span className="mono">{x.classCode ?? '—'}</span> },
    { key: 'propertyType', label: t('tax.col.propertyType'),
      render: (x) => pick('categories', x.id, x.propertyType, x.inherited ? t('tax.ptypeInherit', { type: label(x.inherited) }) : t('tax.ptypeNone'), x.name) },
  ];
  return (
    <>
      <p className="small faint" style={{ padding: '10px 12px 0' }}>{t('tax.ptypeNote')}</p>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <>
          <Panel title={t('tax.ptypeClasses')} padded={false}>
            <DataTable rows={r.data?.assetClasses ?? []} columns={classCols} rowId={(x) => x.id} loading={r.loading} empty={<EmptyState message={t('common.noResults')} />} />
          </Panel>
          <Panel title={t('tax.ptypeCategories')} subtitle={t('tax.ptypeCategoriesNote')} padded={false}>
            <DataTable rows={r.data?.categories ?? []} columns={catCols} rowId={(x) => x.id} loading={r.loading} empty={<EmptyState message={t('common.noResults')} />} />
          </Panel>
        </>
      )}
    </>
  );
}
