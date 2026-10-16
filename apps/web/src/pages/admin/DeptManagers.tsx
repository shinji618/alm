// 관리 > 부서 관리자(ADM-040, 2026-10-15 결정): 코스트센터별 부서 관리자(이름·전화·이메일·유효기간). admin.user
//   승인자는 이 지정으로 정한다(SAP 코스트센터 책임자 VERAK는 참고용). 이관은 보내는 부서 → 받는 부서 → 자산회계
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, KeyValue, Panel, StatusPill, TextField, useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import type { Lookups } from '../assets/types';
import s from '../assets/assets.module.css';

export interface DeptManager { id: string; userId: string; displayName: string; email: string; phone?: string; validFrom?: string; validUntil?: string; active: boolean; linked: boolean }
export interface CostCenterManagers { costCenterId: string; costCenterCode: string; name: string; companyCode: string; profitCenterCode?: string; sapResponsible?: string;
  isActive: boolean; managers: DeptManager[] }

const match = (q: string, x: CostCenterManagers) => !q.trim() || [x.costCenterCode, x.name, ...x.managers.flatMap((m) => [m.displayName, m.email])]
  .some((v) => v.toLowerCase().includes(q.trim().toLowerCase()));

export function DeptManagers() {
  const { t } = useTranslation();
  const [companyId, setCompanyId] = useState('');
  const [q, setQ] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [open, setOpen] = useState<string>();
  const companies = useAsync((sig) => api.get<Lookups>('/lookups?types=companies', sig), []);
  const list = useAsync((sig) => api.get<{ items: CostCenterManagers[] }>(`/admin/dept-managers${qs({ companyId })}`, sig), [companyId]);
  const rows = (list.data?.items ?? []).filter((x) => match(q, x) && (!missingOnly || !x.managers.some((m) => m.active)));
  const columns = useMemo<Column<CostCenterManagers>[]>(() => [
    { key: 'companyCode', label: t('company.code'), render: (x) => <span className="mono">{x.companyCode}</span> },
    { key: 'costCenterCode', label: t('fin.ccCode'), render: (x) => <span className="mono">{x.costCenterCode}</span> },
    { key: 'name', label: t('company.name') },
    { key: 'profitCenterCode', label: t('dm.profitCenter'), render: (x) => (x.profitCenterCode ? <span className="mono">{x.profitCenterCode}</span> : '') },
    { key: 'managers', label: t('dm.managers'), render: (x) => (x.managers.length ? (
      <div>{x.managers.map((m) => (
        <div key={m.id} className={m.active ? undefined : 'faint'}>
          {m.displayName} <span className="faint">· {m.email}{m.phone ? ` · ${m.phone}` : ''}</span>
        </div>
      ))}</div>
    ) : <StatusPill tone="warn">{t('dm.none')}</StatusPill>) },
    { key: 'sapResponsible', label: t('dm.sapResponsible') },
  ], [t]);
  const current = list.data?.items.find((x) => x.costCenterId === open);
  return (
    <>
      <ViewHeader crumb={t('company.crumb')} title={t('dm.title')} description={t('dm.description')} />
      <Panel padded={false}>
        <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('dm.search')}>
          <FilterSelect label={t('company.code')} allLabel={t('fin.allCompanies')} value={companyId} onChange={setCompanyId}
            options={(companies.data?.companies ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.label}` }))} />
          <CheckboxField label={t('dm.missingOnly')} full={false} checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
        </FilterBar>
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={rows} columns={columns} rowId={(x) => x.costCenterId} loading={list.loading} onRowClick={(x) => setOpen(x.costCenterId)}
            empty={<EmptyState message={t('common.noResults')} />} />
        )}
      </Panel>
      {current && <ManagersDrawer cc={current} onClose={() => setOpen(undefined)} onChanged={() => list.reload()} />}
    </>
  );
}

interface Form { email: string; displayName: string; phone: string; validFrom: string; validUntil: string }
const EMPTY: Form = { email: '', displayName: '', phone: '', validFrom: '', validUntil: '' };

function ManagersDrawer({ cc, onClose, onChanged }: { cc: CostCenterManagers; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<DeptManager | 'new'>();
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const title = `${t('dm.title')} · ${cc.costCenterCode} ${cc.name}`;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const start = (m?: DeptManager) => {
    setErrors({});
    setEditing(m ?? 'new');
    setF(m ? { email: m.email, displayName: m.displayName, phone: m.phone ?? '', validFrom: m.validFrom ?? '', validUntil: m.validUntil ?? '' } : EMPTY);
  };
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  };
  const save = async () => {
    const e: Record<string, string> = {};
    if (editing === 'new' && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.email.trim())) e.email = t('dm.emailHint');
    if (f.phone.trim() && !/^[0-9+()\-.\s]{3,30}$/.test(f.phone.trim())) e.phone = t('dm.phoneHint');
    if (f.validFrom && f.validUntil && f.validFrom > f.validUntil) e.validUntil = t('dm.dateOrder');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      if (editing === 'new') {
        await api.post('/admin/dept-managers', { costCenterId: cc.costCenterId, email: f.email.trim(), displayName: f.displayName.trim() || undefined,
          phone: f.phone.trim() || undefined, validFrom: f.validFrom || undefined, validUntil: f.validUntil || undefined });
      } else if (editing) {
        await api.patch(`/admin/dept-managers/${editing.id}`, { displayName: f.displayName.trim() || undefined, phone: f.phone.trim() || null,
          validFrom: f.validFrom || null, validUntil: f.validUntil || null });
      }
      toast.show(t('company.saved'), 'success');
      setEditing(undefined);
      onChanged();
    } catch (err) { fail(err); } finally { setSaving(false); }
  };
  const remove = async (m: DeptManager) => {
    if (!(await confirm({ title: t('dm.removeTitle', { name: m.displayName }), message: t('dm.removeMessage', { cc: cc.costCenterCode }), danger: true, confirmLabel: t('dm.remove') }))) return;
    try {
      await api.del(`/admin/dept-managers/${m.id}`);
      toast.show(t('dm.removed'), 'success');
      onChanged();
    } catch (err) { fail(err); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <KeyValue items={[
        { label: t('company.code'), value: cc.companyCode },
        { label: t('dm.profitCenter'), value: cc.profitCenterCode },
        { label: t('dm.sapResponsible'), value: cc.sapResponsible },
        { label: t('fin.active'), value: t(cc.isActive ? 'common.yes' : 'common.no') },
      ]} />
      <p className="faint">{t('dm.sapNote')}</p>
      <h3>{t('dm.managers')}</h3>
      {!cc.managers.length && <div className={s.notice}>{t('dm.noneNote')}</div>}
      {cc.managers.map((m) => (
        <div key={m.id} className={s.notice} data-testid="dm-row">
          <div className={s.headRow}>
            <strong>{m.displayName}</strong>
            <StatusPill tone={m.active ? 'ok' : 'neutral'}>{t(m.active ? 'dm.active' : 'dm.inactive')}</StatusPill>
            {!m.linked && <StatusPill tone="info">{t('dm.notLinked')}</StatusPill>}
          </div>
          <div>{m.email}{m.phone ? ` · ${m.phone}` : ''}</div>
          {(m.validFrom || m.validUntil) && <div className="faint">{t('dm.validity', { from: m.validFrom ?? '…', until: m.validUntil ?? '…' })}</div>}
          <div className={s.headRow} style={{ marginTop: 6 }}>
            <Button onClick={() => start(m)}>{t('dm.edit')}</Button>
            <Button onClick={() => void remove(m)}>{t('dm.remove')}</Button>
          </div>
        </div>
      ))}
      {!editing && cc.isActive && <Button variant="primary" onClick={() => start()}>{t('dm.add')}</Button>}
      {editing && (
        <FormGrid onSubmit={() => void save()}>
          <TextField label={t('dm.email')} required={editing === 'new'} disabled={editing !== 'new'} type="email" maxLength={254} value={f.email} error={errors.email}
            hint={editing === 'new' ? t('dm.emailNewHint') : undefined} onChange={set('email')} />
          <TextField label={t('dm.name')} maxLength={100} value={f.displayName} error={errors.displayName} onChange={set('displayName')} />
          <TextField label={t('dm.phone')} maxLength={30} value={f.phone} error={errors.phone} onChange={set('phone')} />
          <TextField label={t('dm.validFrom')} type="date" value={f.validFrom} error={errors.validFrom} onChange={set('validFrom')} />
          <TextField label={t('dm.validUntil')} type="date" value={f.validUntil} error={errors.validUntil} onChange={set('validUntil')} />
          <div className={s.formActions}>
            <Button onClick={() => setEditing(undefined)}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
          </div>
        </FormGrid>
      )}
    </Drawer>
  );
}
