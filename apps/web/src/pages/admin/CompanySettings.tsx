// 관리 > 회사·SAP 연계: 회사코드별 SAP 연계 사용과 자산 요청 승인 단계(2026-10-13 결정). SYS_ADMIN(admin.config)
//   SAP 연계를 끄면 SAP 필드·기능을 숨기고 요청은 승인 후 ALM에만 반영. 승인 1·0단계는 SAP 연계를 끈 회사만
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, DataTable, Drawer, EmptyState, FormGrid, Panel, SelectField, StatusPill, TextField, useToast, type Column } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import s from '../assets/assets.module.css';

export interface CompanyConfig {
  id: string; companyCode: string; name: string; currency: string; sapEnabled: boolean; approvalSteps: 0 | 1 | 2; isActive: boolean;
  sapSyncedAt?: string; sapConnections: number; version: number;
}

export function CompanySettings() {
  const { t } = useTranslation();
  const { refresh } = useSession();
  const list = useAsync((sig) => api.get<{ items: CompanyConfig[] }>('/admin/companies', sig), []);
  const [editing, setEditing] = useState<CompanyConfig | 'new'>();
  const columns = useMemo<Column<CompanyConfig>[]>(() => [
    { key: 'companyCode', label: t('company.code'), render: (x) => <span className="mono">{x.companyCode}</span> },
    { key: 'name', label: t('company.name') },
    { key: 'currency', label: t('company.currency') },
    { key: 'sapEnabled', label: t('company.sap'), render: (x) => <StatusPill tone={x.sapEnabled ? 'ok' : 'neutral'}>{t(x.sapEnabled ? 'company.on' : 'company.off')}</StatusPill> },
    { key: 'approvalSteps', label: t('company.steps'), render: (x) => t(`company.stepsLabel.${x.approvalSteps}`) },
    { key: 'sapConnections', label: t('company.connections'), align: 'right' },
    { key: 'sapSyncedAt', label: t('company.synced'), render: (x) => formatDateTime(x.sapSyncedAt) },
  ], [t]);
  const saved = () => { setEditing(undefined); list.reload(); refresh(); };
  return (
    <>
      <ViewHeader crumb={t('company.crumb')} title={t('company.title')} description={t('company.description')}
        actions={<Button variant="primary" onClick={() => setEditing('new')}>{t('company.register')}</Button>} />
      <Panel padded={false}>
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={list.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={list.loading} onRowClick={(x) => setEditing(x)}
            empty={<EmptyState message={t('common.noResults')} />} />
        )}
      </Panel>
      {editing && <CompanyDrawer company={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={saved} />}
    </>
  );
}

function CompanyDrawer({ company, onClose, onSaved }: { company?: CompanyConfig; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ companyCode: '', name: company?.name ?? '', currency: company?.currency ?? 'USD', sapEnabled: company?.sapEnabled ?? false,
    approvalSteps: company?.approvalSteps ?? 2 });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const title = company ? `${t('company.edit')} · ${company.companyCode}` : t('company.register');
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!company && !/^[A-Z0-9]{1,4}$/.test(f.companyCode)) e.companyCode = t('company.codeHint');
    if (!f.name.trim()) e.name = t('common.required');
    if (f.sapEnabled && f.approvalSteps !== 2) e.approvalSteps = t('company.sapOnlyTwo');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      if (company) {
        await api.patch(`/admin/companies/${company.id}`, { name: f.name.trim(), sapEnabled: f.sapEnabled, approvalSteps: f.approvalSteps }, company.version);
        toast.show(t('company.saved'), 'success');
      } else {
        await api.post('/admin/companies', { companyCode: f.companyCode, name: f.name.trim(), currency: f.currency, sapEnabled: f.sapEnabled, approvalSteps: f.approvalSteps });
        toast.show(t('company.created', { code: f.companyCode }), 'success');
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void submit()}>
        {!company && (
          <>
            <TextField label={t('company.code')} required maxLength={4} value={f.companyCode} error={errors.companyCode}
              onChange={(x) => setF((v) => ({ ...v, companyCode: x.target.value.toUpperCase() }))} />
            <TextField label={t('company.currency')} maxLength={5} value={f.currency} onChange={(x) => setF((v) => ({ ...v, currency: x.target.value.toUpperCase() }))} />
            <div className="small muted" style={{ gridColumn: '1 / -1' }}>{t('company.registerHint')}</div>
          </>
        )}
        <TextField label={t('company.name')} required maxLength={25} value={f.name} error={errors.name} onChange={(x) => setF((v) => ({ ...v, name: x.target.value }))} />
        <SelectField label={t('company.sap')} value={f.sapEnabled ? 'on' : 'off'} options={[{ value: 'on', label: t('company.on') }, { value: 'off', label: t('company.off') }]}
          onChange={(x) => setF((v) => ({ ...v, sapEnabled: x.target.value === 'on', approvalSteps: x.target.value === 'on' ? 2 : v.approvalSteps }))} />
        <SelectField label={t('company.steps')} value={String(f.approvalSteps)} error={errors.approvalSteps}
          options={[2, 1, 0].map((n) => ({ value: String(n), label: t(`company.stepsLabel.${n}`), disabled: f.sapEnabled && n !== 2 }))}
          onChange={(x) => setF((v) => ({ ...v, approvalSteps: Number(x.target.value) as 0 | 1 | 2 }))} />
        <div className="small muted" style={{ gridColumn: '1 / -1' }}>{f.sapEnabled ? t('company.sapOnlyTwo') : t('company.offWarn')}</div>
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
