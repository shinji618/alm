// 관리 > 사용자·역할(ADM-010): 사용자 등록·활성/비활성, 역할·범위 지정. admin.user(SYS_ADMIN)
//   API는 기존 /admin/users(중앙 ID 전환 뒤에는 서버가 중앙에 먼저 반영하고 미러). 자기 자신의 역할은 바꿀 수 없다(H-03, ST07)
//   AUDITOR는 다른 역할과 함께 줄 수 없고 유효 종료일(최대 1년)이 필수, DEPT_MANAGER는 코스트센터가 필수. 직무 충돌은 막지 않고 알린다(09 5.2)
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, KeyValue, Panel, SelectField, StatusPill, TextField, useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError, qs, request } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';
import s from '../assets/assets.module.css';

export const ROLE_CODES = ['SYS_ADMIN', 'ASSET_MANAGER', 'DEPT_MANAGER', 'ASSET_ACCOUNTANT', 'COUNTER', 'EMPLOYEE', 'AUDITOR'] as const;
export interface RoleScope { role: string; companyCode?: string; siteCode?: string; costCenterCode?: string; validFrom?: string; validUntil?: string }
export interface UserRow { id: string; email: string; displayName: string; department?: string; costCenterCode?: string; roles: RoleScope[]; isActive: boolean; lastLoginAt?: string }

const roleText = (r: RoleScope) => r.role + (r.costCenterCode ? `(${r.costCenterCode})` : '');
// EMPLOYEE는 활성 사용자에게 자동으로 붙는다(감사인 제외). 지정 대상에서 뺀다
const ASSIGNABLE = ROLE_CODES.filter((r) => r !== 'EMPLOYEE');

export function UserAdmin() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [open, setOpen] = useState<string | 'new'>();
  const list = useAsync((sig) => api.get<{ items: UserRow[] }>(`/admin/users${qs({ q: q.trim() || undefined, role: role || undefined, pageSize: 200 })}`, sig), [q, role]);
  const columns = useMemo<Column<UserRow>[]>(() => [
    { key: 'displayName', label: t('users.name') },
    { key: 'email', label: t('users.email') },
    { key: 'roles', label: t('users.roles'), render: (u) => (u.roles.length ? u.roles.map(roleText).join(', ') : <span className="faint">{t('users.noRoles')}</span>) },
    { key: 'isActive', label: t('users.status'), render: (u) => <StatusPill tone={u.isActive ? 'ok' : 'neutral'}>{t(u.isActive ? 'users.active' : 'users.inactive')}</StatusPill> },
    { key: 'lastLoginAt', label: t('users.lastLogin'), render: (u) => (u.lastLoginAt ? u.lastLoginAt.slice(0, 16).replace('T', ' ') : <span className="faint">{t('users.never')}</span>) },
  ], [t]);
  const current = list.data?.items.find((u) => u.id === open);
  return (
    <>
      <ViewHeader crumb={t('company.crumb')} title={t('users.title')} description={t('users.description')}
        actions={<Button variant="primary" onClick={() => setOpen('new')}>{t('users.add')}</Button>} />
      <Panel padded={false}>
        <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('users.search')}>
          <FilterSelect label={t('users.roles')} allLabel={t('users.allRoles')} value={role} onChange={setRole} options={ROLE_CODES.map((r) => ({ value: r, label: r }))} />
        </FilterBar>
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={list.data?.items ?? []} columns={columns} rowId={(u) => u.id} loading={list.loading} onRowClick={(u) => setOpen(u.id)}
            empty={<EmptyState message={t('common.noResults')} />} />
        )}
      </Panel>
      {open === 'new' && <NewUserDrawer onClose={() => setOpen(undefined)} onCreated={(id) => { list.reload(); setOpen(id); }} />}
      {current && <UserDrawer user={current} onClose={() => setOpen(undefined)} onChanged={() => list.reload()} />}
    </>
  );
}

function NewUserDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const e: Record<string, string> = {};
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.trim())) e.email = t('users.emailHint');
    if (!displayName.trim()) e.displayName = t('users.nameRequired');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const u = await api.post<UserRow>('/admin/users', { email: email.trim(), displayName: displayName.trim() });
      toast.show(t('users.created'), 'success');
      onCreated(u.id);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={t('users.add')} title={t('users.add')}>
      <p className="faint">{t('users.newNote')}</p>
      <FormGrid onSubmit={() => void save()}>
        <TextField label={t('users.email')} required type="email" maxLength={254} value={email} error={errors.email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label={t('users.name')} required maxLength={100} value={displayName} error={errors.displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}

function UserDrawer({ user, onClose, onChanged }: { user: UserRow; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useSession();
  const self = me?.userId === user.id;
  const [rows, setRows] = useState<RoleScope[]>(() => user.roles.filter((r) => r.role !== 'EMPLOYEE').map((r) => ({ ...r })));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const auditor = rows.some((r) => r.role === 'AUDITOR');
  const set = (i: number, patch: Partial<RoleScope>) => setRows((v) => v.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  };
  const save = async () => {
    const e: Record<string, string> = {};
    if (auditor && rows.length > 1) e.roles = t('users.auditorAlone');
    rows.forEach((r, i) => {
      if (r.role === 'DEPT_MANAGER' && !r.costCenterCode?.trim()) e[`roles[${i}].costCenterCode`] = t('users.ccRequired');
      if (r.role === 'AUDITOR' && !r.validUntil) e[`roles[${i}].validUntil`] = t('users.untilRequired');
      if (r.validFrom && r.validUntil && r.validFrom > r.validUntil) e[`roles[${i}].validUntil`] = t('dm.dateOrder');
    });
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = { roles: rows.map((r) => ({ role: r.role, costCenterCode: r.costCenterCode?.trim() || undefined, validFrom: r.validFrom || undefined, validUntil: r.validUntil || undefined })) };
      const res = await request<UserRow>(`/admin/users/${user.id}/roles`, { method: 'PUT', body });
      const sod = res.headers.get('X-SoD-Warning');
      toast.show(sod ? t('users.savedSod', { rules: sod }) : t('company.saved'), sod ? 'info' : 'success');
      onChanged();
    } catch (err) { fail(err); } finally { setSaving(false); }
  };
  const toggleActive = async () => {
    const next = !user.isActive;
    if (!next && !(await confirm({ title: t('users.deactivateTitle', { name: user.displayName }), message: t('users.deactivateMessage'), danger: true, confirmLabel: t('users.deactivate') }))) return;
    try {
      await api.patch(`/admin/users/${user.id}`, { isActive: next });
      toast.show(t('company.saved'), 'success');
      onChanged();
    } catch (err) { fail(err); }
  };
  const title = `${t('users.title')} · ${user.displayName}`;
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <KeyValue items={[
        { label: t('users.email'), value: user.email },
        { label: t('users.status'), value: t(user.isActive ? 'users.active' : 'users.inactive') },
        { label: t('users.lastLogin'), value: user.lastLoginAt ? user.lastLoginAt.slice(0, 16).replace('T', ' ') : t('users.never') },
      ]} />
      <h3>{t('users.roles')}</h3>
      <p className="faint">{t('users.rolesNote')}</p>
      {self && <div className={s.notice} role="status">{t('users.selfNote')}</div>}
      {errors.roles && <div className={s.notice} role="alert">{errors.roles}</div>}
      {rows.map((r, i) => (
        <div key={i} className={s.notice} data-testid="role-row">
          <FormGrid onSubmit={() => undefined}>
            <SelectField label={t('users.role')} value={r.role} disabled={self} error={errors[`roles[${i}].role`]} onChange={(e) => set(i, { role: e.target.value })}
              options={ASSIGNABLE.map((c) => ({ value: c, label: c }))} />
            {r.role === 'DEPT_MANAGER' && (
              <TextField label={t('users.costCenter')} required maxLength={10} disabled={self} value={r.costCenterCode ?? ''} error={errors[`roles[${i}].costCenterCode`]}
                onChange={(e) => set(i, { costCenterCode: e.target.value })} />
            )}
            <TextField label={t('dm.validFrom')} type="date" disabled={self} value={r.validFrom ?? ''} error={errors[`roles[${i}].validFrom`]} onChange={(e) => set(i, { validFrom: e.target.value })} />
            <TextField label={t('dm.validUntil')} type="date" required={r.role === 'AUDITOR'} disabled={self} value={r.validUntil ?? ''} error={errors[`roles[${i}].validUntil`]}
              onChange={(e) => set(i, { validUntil: e.target.value })} />
          </FormGrid>
          {!self && <Button onClick={() => setRows((v) => v.filter((_, j) => j !== i))}>{t('users.removeRole')}</Button>}
        </div>
      ))}
      <div className={s.headRow}>
        {!self && <Button onClick={() => setRows((v) => [...v, { role: ASSIGNABLE.find((c) => !v.some((x) => x.role === c)) ?? 'ASSET_MANAGER' }])}>{t('users.addRole')}</Button>}
        {!self && <Button variant="primary" disabled={saving} onClick={() => void save()}>{t('common.save')}</Button>}
      </div>
      <h3>{t('users.account')}</h3>
      {!self && <Button onClick={() => void toggleActive()}>{t(user.isActive ? 'users.deactivate' : 'users.activate')}</Button>}
    </Drawer>
  );
}
