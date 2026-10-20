// ADM-055 자산태그 번호 범위(2026-10-19): 태그 앞 2자리(Prefix)와 번호 구간을 정의하고, 카테고리 화면(ADM-050)에서 카테고리에 지정한다.
//   태그 = Prefix-nnnnnn. 카테고리 → 상위 카테고리 → 기본 범위 순으로 자동 채번. 남은 번호가 적으면 경고, 다 쓰면 그 카테고리는 자동 채번 등록이 막힌다
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FormGrid, Panel, StatusPill, TextField, useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import { notifyCategoriesChanged } from '@/lib/events';
import s from '../assets/assets.module.css';

export interface NumberRange {
  id: string; version: number; prefix: string; name: string; fromNo: number; toNo: number; nextNo: number; nextTag?: string; sample: string;
  used: number; remaining: number; nearlyFull: boolean; exhausted: boolean; isDefault: boolean; isActive: boolean;
  categories: { id: string; code: string; name: string }[];
}
const MAX = 999999;

export function NumberRanges() {
  const { t } = useTranslation();
  const { can } = useSession();
  const write = can('master.write');
  const list = useAsync((sig) => api.get<{ items: NumberRange[] }>('/admin/number-ranges', sig), []);
  const [editing, setEditing] = useState<NumberRange | 'new'>();
  const rows = list.data?.items ?? [];
  const warn = rows.filter((x) => x.isActive && (x.exhausted || x.nearlyFull));
  const columns = useMemo<Column<NumberRange>[]>(() => [
    { key: 'prefix', label: t('nr.prefix'), render: (x) => <span className="mono" style={{ fontWeight: 600 }}>{x.prefix}</span> },
    { key: 'name', label: t('nr.name'), render: (x) => <span>{x.name}{x.isDefault && <> <StatusPill tone="info">{t('nr.default')}</StatusPill></>}</span> },
    { key: 'sample', label: t('nr.range'), render: (x) => <span className="mono small">{x.sample}</span> },
    { key: 'nextTag', label: t('nr.nextTag'), render: (x) => <span className="mono">{x.nextTag ?? '—'}</span> },
    { key: 'used', label: t('nr.used'), align: 'right', render: (x) => x.used.toLocaleString() },
    { key: 'remaining', label: t('nr.remaining'), align: 'right', render: (x) => (
      <span>{x.remaining.toLocaleString()}{' '}
        {x.exhausted ? <StatusPill tone="bad">{t('nr.exhausted')}</StatusPill> : x.nearlyFull && x.isActive ? <StatusPill tone="warn">{t('nr.nearlyFull')}</StatusPill> : null}</span>) },
    { key: 'categories', label: t('nr.categories'), render: (x) => (x.categories.length ? x.categories.map((c) => c.code).join(', ')
      : <span className="faint">{x.isDefault ? t('nr.allOthers') : '—'}</span>) },
    { key: 'isActive', label: t('cat.status'), render: (x) => <StatusPill tone={x.isActive ? 'ok' : 'neutral'}>{t(x.isActive ? 'cat.active' : 'cat.inactive')}</StatusPill> },
  ], [t]);
  return (
    <>
      <ViewHeader crumb="ADM-055" title={t('nav.numberRanges')} description={t('nr.description')}
        actions={write ? <Button variant="primary" onClick={() => setEditing('new')}>{t('nr.add')}</Button> : undefined} />
      {warn.length > 0 && (
        <div className={s.notice} role="status">{t('nr.warn', { prefixes: warn.map((x) => `${x.prefix} (${x.remaining.toLocaleString()})`).join(', ') })}</div>
      )}
      <Panel padded={false}>
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={rows} columns={columns} rowId={(x) => x.id} loading={list.loading} onRowClick={write ? (x) => setEditing(x) : undefined}
            empty={<EmptyState message={t('common.noResults')} />} />
        )}
      </Panel>
      <p className="small faint" style={{ marginTop: 8 }}>{t('nr.howTo')} <Link to="/admin/categories">{t('nav.categories')}</Link></p>
      {editing && <RangeDrawer row={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)}
        onSaved={() => { setEditing(undefined); list.reload(); notifyCategoriesChanged(); }} />}
    </>
  );
}

function RangeDrawer({ row, onClose, onSaved }: { row?: NumberRange; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setF] = useState({ prefix: row?.prefix ?? '', name: row?.name ?? '', fromNo: String(row?.fromNo ?? 1), toNo: String(row?.toNo ?? MAX),
    nextNo: String(row?.nextNo ?? 1), isDefault: row?.isDefault ?? false, isActive: row?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: 'prefix' | 'name' | 'fromNo' | 'toNo' | 'nextNo') => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const title = row ? `${t('nr.edit')} · ${row.prefix}` : t('nr.add');
  const started = !!row && (row.used > 0 || row.nextNo !== row.fromNo);
  const pad = (n: string) => String(Math.max(0, Math.min(MAX, Number(n) || 0))).padStart(6, '0');
  const prefix = f.prefix.toUpperCase();
  const save = async () => {
    const e: Record<string, string> = {};
    const num = (v: string, max = MAX) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max;
    if (!row && !/^[A-Z0-9]{2}$/.test(prefix)) e.prefix = t('nr.prefixHint');
    if (!f.name.trim()) e.name = t('common.required');
    if (!num(f.fromNo)) e.fromNo = t('nr.numHint');
    if (!num(f.toNo)) e.toNo = t('nr.numHint');
    else if (Number(f.toNo) < Number(f.fromNo)) e.toNo = t('nr.toHint');
    if (!num(f.nextNo, MAX + 1) || Number(f.nextNo) < Number(f.fromNo) || Number(f.nextNo) > Number(f.toNo) + 1) e.nextNo = t('nr.nextHint');
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      if (row) {
        const body: Record<string, unknown> = { name: f.name.trim(), toNo: Number(f.toNo) };
        if (Number(f.fromNo) !== row.fromNo) body.fromNo = Number(f.fromNo);
        if (Number(f.nextNo) !== row.nextNo || body.fromNo !== undefined) body.nextNo = Number(f.nextNo);
        if (f.isDefault && !row.isDefault) body.isDefault = true;
        if (f.isActive !== row.isActive) body.isActive = f.isActive;
        await api.patch(`/admin/number-ranges/${row.id}`, body);
      } else {
        await api.post('/admin/number-ranges', { prefix, name: f.name.trim(), fromNo: Number(f.fromNo), toNo: Number(f.toNo), nextNo: Number(f.nextNo), isDefault: f.isDefault });
      }
      toast.show(t('common.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!row) return;
    if (!(await confirm({ title: t('nr.delete'), message: t('nr.deleteMsg', { prefix: row.prefix }), danger: true, confirmLabel: t('nr.delete') }))) return;
    setSaving(true);
    try {
      await api.del(`/admin/number-ranges/${row.id}`);
      toast.show(t('nr.deleted', { prefix: row.prefix }), 'success');
      onSaved();
    } catch (err) { toast.show(err instanceof Error ? err.message : String(err), 'error'); } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void save()}>
        {!row && <TextField label={t('nr.prefix')} required maxLength={2} value={f.prefix} error={errors.prefix} hint={t('nr.prefixHint')}
          onChange={(e) => setF((v) => ({ ...v, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))} />}
        <TextField label={t('nr.name')} required maxLength={60} value={f.name} error={errors.name} onChange={set('name')} />
        <TextField label={t('nr.fromNo')} type="number" min={1} max={MAX} value={f.fromNo} error={errors.fromNo} disabled={started}
          hint={started ? t('nr.fromLocked') : undefined} onChange={(e) => { set('fromNo')(e); if (!row) setF((v) => ({ ...v, nextNo: e.target.value })); }} />
        <TextField label={t('nr.toNo')} type="number" min={1} max={MAX} value={f.toNo} error={errors.toNo} onChange={set('toNo')} />
        <TextField label={t('nr.nextNo')} type="number" min={1} max={MAX + 1} value={f.nextNo} error={errors.nextNo} hint={t('nr.nextNoHint')} onChange={set('nextNo')} />
        <p className="small" style={{ gridColumn: '1 / -1' }}>{t('nr.preview')}: <span className="mono">{(prefix || '??')}-{pad(f.fromNo)} ~ {(prefix || '??')}-{pad(f.toNo)}</span></p>
        <CheckboxField label={t('nr.setDefault')} checked={f.isDefault} disabled={row?.isDefault} onChange={(e) => setF((v) => ({ ...v, isDefault: e.target.checked }))} />
        {row && <CheckboxField label={t('cat.active')} checked={f.isActive} disabled={row.isDefault} onChange={(e) => setF((v) => ({ ...v, isActive: e.target.checked }))} />}
        {row && <p className="small faint" style={{ gridColumn: '1 / -1' }}>{t('nr.usage', { used: row.used, categories: row.categories.map((c) => c.code).join(', ') || '—' })}</p>}
        <div className={s.formActions}>
          {row && !row.isDefault && <Button disabled={saving} onClick={() => void remove()} style={{ marginRight: 'auto' }}>{t('nr.delete')}</Button>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
