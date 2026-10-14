// 관리 > 코스트센터·자산클래스: SAP 연계를 쓰지 않는 회사용 직접 관리(2026-10-13 결정). master.read·master.write
//   SAP 회사의 코스트센터와 SAP 자산클래스는 읽기 전용(SAP 마스터 수신이 관리)
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, Panel, SelectField, StatusPill, Tabs, TextField, useToast, type Column } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Lookups } from '../assets/types';
import s from '../assets/assets.module.css';

interface CostCenterRow { id: string; companyId: string; companyCode: string; costCenterCode: string; name: string; responsible?: string; controllingArea: string;
  isActive: boolean; editable: boolean; assetCount: number; version: number }
interface AssetClassRow { id: string; classCode: string; name: string; isLowValue: boolean; isCapitalized: boolean; defaultUsefulLifeYears?: number; isManual: boolean;
  isActive: boolean; assetCount: number; version: number }
type Tab = 'costCenters' | 'assetClasses';

export function FinMasters() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get('tab') === 'assetClasses' ? 'assetClasses' : 'costCenters';
  return (
    <>
      <ViewHeader crumb={t('company.crumb')} title={t('fin.title')} description={t('fin.description')} />
      <Panel padded={false}>
        <Tabs<Tab> label={t('fin.title')} value={tab} onChange={(v) => setSp(new URLSearchParams({ tab: v }), { replace: true })}
          items={[{ value: 'costCenters', label: t('fin.costCenters') }, { value: 'assetClasses', label: t('fin.assetClasses') }]} />
        {tab === 'costCenters' ? <CostCenters /> : <AssetClasses />}
      </Panel>
    </>
  );
}

const match = (q: string, ...vals: string[]) => !q.trim() || vals.some((v) => v.toLowerCase().includes(q.trim().toLowerCase()));
const yesNo = (t: (k: string) => string, v: boolean) => t(v ? 'common.yes' : 'common.no');
const sourcePill = (t: (k: string) => string, manual: boolean) => <StatusPill tone={manual ? 'accent' : 'neutral'}>{t(manual ? 'fin.manual' : 'fin.sap')}</StatusPill>;

// ---------------- 코스트센터 ----------------
function CostCenters() {
  const { t } = useTranslation();
  const { can } = useSession();
  const write = can('master.write');
  const [companyId, setCompanyId] = useState('');
  const [q, setQ] = useState('');
  const companies = useAsync((sig) => api.get<Lookups>('/lookups?types=companies', sig)
    .then((r) => ({ items: (r.companies ?? []).map((c) => ({ id: c.id, companyCode: c.code, name: c.label, sapEnabled: c.extra?.sapEnabled !== false })) })), []);
  const list = useAsync((sig) => api.get<{ items: CostCenterRow[] }>(`/admin/cost-centers${qs({ companyId })}`, sig), [companyId]);
  const [editing, setEditing] = useState<CostCenterRow | 'new'>();
  const noSap = (companies.data?.items ?? []).filter((c) => !c.sapEnabled);
  const columns = useMemo<Column<CostCenterRow>[]>(() => [
    { key: 'companyCode', label: t('company.code'), render: (x) => <span className="mono">{x.companyCode}</span> },
    { key: 'costCenterCode', label: t('fin.ccCode'), render: (x) => <span className="mono">{x.costCenterCode}</span> },
    { key: 'name', label: t('company.name') },
    { key: 'responsible', label: t('fin.responsible') },
    { key: 'editable', label: t('fin.source'), render: (x) => sourcePill(t, x.editable) },
    { key: 'assetCount', label: t('fin.assets'), align: 'right' },
    { key: 'isActive', label: t('fin.active'), render: (x) => yesNo(t, x.isActive) },
  ], [t]);
  return (
    <>
      <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('fin.searchCc')}>
        <FilterSelect label={t('company.code')} allLabel={t('fin.allCompanies')} value={companyId} onChange={setCompanyId}
          options={(companies.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.companyCode} · ${c.name}${c.sapEnabled ? '' : ` (${t('fin.noSap')})`}` }))} />
        {write && <Button variant="primary" disabled={!noSap.length} onClick={() => setEditing('new')}>{t('fin.addCostCenter')}</Button>}
      </FilterBar>
      {write && !noSap.length && <div className={s.notice} style={{ margin: 12 }}>{t('fin.needNoSapCompany')}</div>}
      {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
        <DataTable rows={(list.data?.items ?? []).filter((x) => match(q, x.costCenterCode, x.name))} columns={columns} rowId={(x) => x.id} loading={list.loading}
          onRowClick={write ? (x) => (x.editable ? setEditing(x) : undefined) : undefined} empty={<EmptyState message={t('common.noResults')} />} />
      )}
      {editing && <CostCenterDrawer row={editing === 'new' ? undefined : editing} companies={noSap} defaultCompany={noSap.some((c) => c.id === companyId) ? companyId : noSap[0]?.id}
        onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); list.reload(); }} />}
    </>
  );
}

function CostCenterDrawer({ row, companies, defaultCompany, onClose, onSaved }: { row?: CostCenterRow; companies: { id: string; companyCode: string; name: string }[];
  defaultCompany?: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ companyId: row?.companyId ?? defaultCompany ?? '', code: row?.costCenterCode ?? '', name: row?.name ?? '', responsible: row?.responsible ?? '',
    isActive: row?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const title = row ? `${t('fin.editCostCenter')} · ${row.costCenterCode}` : t('fin.addCostCenter');
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!row && !/^[A-Za-z0-9_.-]{1,10}$/.test(f.code)) e.costCenterCode = t('fin.codeHint');
    if (!f.name.trim()) e.name = t('common.required');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      if (row) await api.patch(`/admin/cost-centers/${row.id}`, { name: f.name.trim(), responsible: f.responsible.trim() || null, isActive: f.isActive }, row.version);
      else await api.post('/admin/cost-centers', { companyId: f.companyId, costCenterCode: f.code, name: f.name.trim(), responsible: f.responsible.trim() || undefined });
      toast.show(t('company.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void submit()}>
        {!row && (
          <>
            <SelectField label={t('company.code')} required value={f.companyId} options={companies.map((c) => ({ value: c.id, label: `${c.companyCode} · ${c.name}` }))}
              onChange={(x) => setF((v) => ({ ...v, companyId: x.target.value }))} />
            <TextField label={t('fin.ccCode')} required maxLength={10} value={f.code} error={errors.costCenterCode} onChange={(x) => setF((v) => ({ ...v, code: x.target.value }))} />
          </>
        )}
        <TextField label={t('company.name')} required maxLength={20} value={f.name} error={errors.name} onChange={(x) => setF((v) => ({ ...v, name: x.target.value }))} />
        <TextField label={t('fin.responsible')} maxLength={20} value={f.responsible} onChange={(x) => setF((v) => ({ ...v, responsible: x.target.value }))} />
        {row && <CheckboxField label={t('fin.active')} checked={f.isActive} onChange={(x) => setF((v) => ({ ...v, isActive: x.target.checked }))} />}
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}

// ---------------- 자산클래스 ----------------
function AssetClasses() {
  const { t } = useTranslation();
  const { can } = useSession();
  const write = can('master.write');
  const list = useAsync((sig) => api.get<{ items: AssetClassRow[] }>('/admin/asset-classes', sig), []);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AssetClassRow | 'new'>();
  const columns = useMemo<Column<AssetClassRow>[]>(() => [
    { key: 'classCode', label: t('fin.classCode'), render: (x) => <span className="mono">{x.classCode}</span> },
    { key: 'name', label: t('company.name') },
    { key: 'defaultUsefulLifeYears', label: t('asset.fin.usefulLife'), align: 'right' },
    { key: 'isCapitalized', label: t('asset.fin.isCapitalized'), render: (x) => yesNo(t, x.isCapitalized) },
    { key: 'isLowValue', label: t('fin.lowValue'), render: (x) => yesNo(t, x.isLowValue) },
    { key: 'isManual', label: t('fin.source'), render: (x) => sourcePill(t, x.isManual) },
    { key: 'assetCount', label: t('fin.assets'), align: 'right' },
    { key: 'isActive', label: t('fin.active'), render: (x) => yesNo(t, x.isActive) },
  ], [t]);
  return (
    <>
      <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('fin.searchClass')}>
        <span className="small muted">{t('fin.classHint')}</span>
        {write && <Button variant="primary" onClick={() => setEditing('new')}>{t('fin.addAssetClass')}</Button>}
      </FilterBar>
      {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
        <DataTable rows={(list.data?.items ?? []).filter((x) => match(q, x.classCode, x.name))} columns={columns} rowId={(x) => x.id} loading={list.loading}
          onRowClick={write ? (x) => (x.isManual ? setEditing(x) : undefined) : undefined} empty={<EmptyState message={t('common.noResults')} />} />
      )}
      {editing && <AssetClassDrawer row={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); list.reload(); }} />}
    </>
  );
}

function AssetClassDrawer({ row, onClose, onSaved }: { row?: AssetClassRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ code: row?.classCode ?? '', name: row?.name ?? '', life: row?.defaultUsefulLifeYears ? String(row.defaultUsefulLifeYears) : '',
    cap: row?.isCapitalized ?? true, low: row?.isLowValue ?? false, isActive: row?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const title = row ? `${t('fin.editAssetClass')} · ${row.classCode}` : t('fin.addAssetClass');
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!row && !/^[A-Za-z0-9_.-]{1,8}$/.test(f.code)) e.classCode = t('fin.classCodeHint');
    if (!f.name.trim()) e.name = t('common.required');
    if (f.life && !(Number(f.life) >= 1 && Number(f.life) <= 50 && Number.isInteger(Number(f.life)))) e.defaultUsefulLifeYears = t('fin.lifeHint');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const body = { name: f.name.trim(), defaultUsefulLifeYears: f.life ? Number(f.life) : undefined, isCapitalized: f.cap, isLowValue: f.low };
    try {
      if (row) await api.patch(`/admin/asset-classes/${row.id}`, { ...body, isActive: f.isActive }, row.version);
      else await api.post('/admin/asset-classes', { classCode: f.code, ...body });
      toast.show(t('company.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void submit()}>
        {!row && <TextField label={t('fin.classCode')} required maxLength={8} value={f.code} error={errors.classCode} onChange={(x) => setF((v) => ({ ...v, code: x.target.value }))} />}
        <TextField label={t('company.name')} required maxLength={50} value={f.name} error={errors.name} onChange={(x) => setF((v) => ({ ...v, name: x.target.value }))} />
        <TextField label={t('asset.fin.usefulLife')} type="number" min="1" max="50" value={f.life} error={errors.defaultUsefulLifeYears} onChange={(x) => setF((v) => ({ ...v, life: x.target.value }))} />
        <CheckboxField label={t('asset.fin.isCapitalized')} checked={f.cap} onChange={(x) => setF((v) => ({ ...v, cap: x.target.checked }))} />
        <CheckboxField label={t('fin.lowValue')} checked={f.low} onChange={(x) => setF((v) => ({ ...v, low: x.target.checked }))} />
        {row && <CheckboxField label={t('fin.active')} checked={f.isActive} onChange={(x) => setF((v) => ({ ...v, isActive: x.target.checked }))} />}
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
