// ADM-050 자산 카테고리 관리(2026-10-18 결정): 카테고리는 ALM에서 정의하고, 기본 자산클래스는 SAP에서 받은 클래스만 고른다.
//   카테고리 = 운영 분류(메뉴의 카테고리별 조회·등록, 모델, CMDB CI, 교체 내용연수, 재산세 구분 예외). 코드는 만든 뒤 바꾸지 않는다
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FormGrid, Panel, SelectField, StatusPill, TextField, useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Lookups } from '../assets/types';
import { PROPERTY_TYPES } from '../tax/types';
import s from '../assets/assets.module.css';

export interface CategoryRow {
  id: string; version: number; categoryCode: string; name: string; parentId?: string; parentName?: string; defaultAssetClassId?: string;
  assetClassCode?: string; assetClassName?: string; usefulLifeYears?: number; isCi: boolean; taxPropertyType?: string; isActive: boolean;
  assetCount: number; modelCount: number;
}

export function AssetCategories() {
  const { t } = useTranslation();
  const { can } = useSession();
  const write = can('master.write');
  const list = useAsync((sig) => api.get<{ items: CategoryRow[] }>('/admin/categories', sig), []);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<CategoryRow | 'new'>();
  const rows = (list.data?.items ?? []).filter((x) => !q.trim() || `${x.categoryCode} ${x.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  const columns = useMemo<Column<CategoryRow>[]>(() => [
    { key: 'categoryCode', label: t('cat.code'), render: (x) => <span className="mono">{x.categoryCode}</span> },
    { key: 'name', label: t('cat.name') },
    { key: 'parentName', label: t('cat.parent'), render: (x) => x.parentName ?? '—' },
    { key: 'assetClassCode', label: t('cat.assetClass'), render: (x) => (x.assetClassCode ? <span><span className="mono">{x.assetClassCode}</span> {x.assetClassName}</span> : '—') },
    { key: 'usefulLifeYears', label: t('cat.life'), align: 'right', render: (x) => x.usefulLifeYears ?? '—' },
    { key: 'isCi', label: t('cat.isCi'), render: (x) => t(x.isCi ? 'common.yes' : 'common.no') },
    { key: 'taxPropertyType', label: t('cat.taxType'), render: (x) => (x.taxPropertyType ? t(`tax.ptype.${x.taxPropertyType}`) : <span className="faint">{t('cat.fromClass')}</span>) },
    { key: 'assetCount', label: t('cat.assets'), align: 'right' },
    { key: 'isActive', label: t('cat.status'), render: (x) => <StatusPill tone={x.isActive ? 'ok' : 'neutral'}>{t(x.isActive ? 'cat.active' : 'cat.inactive')}</StatusPill> },
  ], [t]);
  return (
    <>
      <ViewHeader crumb="ADM-050" title={t('nav.categories')} description={t('cat.description')}
        actions={write ? <Button variant="primary" onClick={() => setEditing('new')}>{t('cat.add')}</Button> : undefined} />
      <Panel padded={false}>
        <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('cat.search')} />
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={rows} columns={columns} rowId={(x) => x.id} loading={list.loading} onRowClick={write ? (x) => setEditing(x) : undefined}
            empty={<EmptyState message={t('common.noResults')} />} />
        )}
      </Panel>
      {editing && <CategoryDrawer row={editing === 'new' ? undefined : editing} all={list.data?.items ?? []}
        onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); list.reload(); }} />}
    </>
  );
}

function CategoryDrawer({ row, all, onClose, onSaved }: { row?: CategoryRow; all: CategoryRow[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [delError, setDelError] = useState<string>();
  // 자산클래스는 /lookups(SAP에서 받은 활성 클래스만)
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=assetClasses', sig), []);
  const [f, setF] = useState({ code: row?.categoryCode ?? '', name: row?.name ?? '', parentId: row?.parentId ?? '', classId: row?.defaultAssetClassId ?? '',
    life: row?.usefulLifeYears ? String(row.usefulLifeYears) : '', isCi: row?.isCi ?? false, taxType: row?.taxPropertyType ?? '', isActive: row?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const title = row ? `${t('cat.edit')} · ${row.categoryCode}` : t('cat.add');
  const parents = all.filter((x) => x.isActive && x.id !== row?.id);
  const classes = lk.data?.assetClasses ?? [];
  const save = async () => {
    const e: Record<string, string> = {};
    if (!row && !/^[A-Za-z0-9_.-]{1,20}$/.test(f.code)) e.categoryCode = t('cat.codeHint');
    if (!f.name.trim()) e.name = t('common.required');
    if (f.life && !(Number.isInteger(Number(f.life)) && Number(f.life) >= 1 && Number(f.life) <= 50)) e.usefulLifeYears = t('cat.lifeHint');
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = { name: f.name.trim(), parentId: f.parentId || null, defaultAssetClassId: f.classId || null, usefulLifeYears: f.life ? Number(f.life) : null,
      isCi: f.isCi, taxPropertyType: f.taxType || null };
    setSaving(true);
    try {
      if (row) await api.patch(`/admin/categories/${row.id}`, { ...body, isActive: f.isActive });
      else await api.post('/admin/categories', { categoryCode: f.code.trim().toUpperCase(), ...body });
      toast.show(t('common.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  // 삭제: 이 카테고리로 등록된 자산이 있으면 서버가 409(ALM-E318)와 이유를 돌려준다 → 창 안에 그대로 보여 준다
  const remove = async () => {
    if (!row) return;
    if (!(await confirm({ title: t('cat.delete'), message: t('cat.deleteMsg', { name: `${row.categoryCode} · ${row.name}` }), danger: true, confirmLabel: t('cat.delete') }))) return;
    setDelError(undefined);
    setSaving(true);
    try {
      await api.del(`/admin/categories/${row.id}`);
      toast.show(t('cat.deleted', { code: row.categoryCode }), 'success');
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDelError(msg);
      toast.show(msg, 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      {delError && <div className={s.notice} role="alert" style={{ color: 'var(--bad)' }}>{delError}</div>}
      <FormGrid onSubmit={() => void save()}>
        {!row && <TextField label={t('cat.code')} required maxLength={20} value={f.code} error={errors.categoryCode} hint={t('cat.codeHint')} onChange={set('code')} />}
        <TextField label={t('cat.name')} required maxLength={60} value={f.name} error={errors.name} onChange={set('name')} />
        <SelectField label={t('cat.parent')} value={f.parentId} error={errors.parentId} onChange={set('parentId')}
          options={[{ value: '', label: '—' }, ...parents.map((x) => ({ value: x.id, label: `${x.categoryCode} · ${x.name}` }))]} />
        <SelectField label={t('cat.assetClass')} value={f.classId} error={errors.defaultAssetClassId} onChange={set('classId')} hint={t('cat.classHint')}
          options={[{ value: '', label: '—' }, ...classes.map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` })),
            ...(row?.defaultAssetClassId && !classes.some((x) => x.id === row.defaultAssetClassId) ? [{ value: row.defaultAssetClassId, label: `${row.assetClassCode ?? '?'} (${t('cat.classUnavailable')})` }] : [])]} />
        <TextField label={t('cat.life')} type="number" min={1} max={50} value={f.life} error={errors.usefulLifeYears} hint={t('cat.lifeHint')} onChange={set('life')} />
        <SelectField label={t('cat.taxType')} value={f.taxType} error={errors.taxPropertyType} onChange={set('taxType')}
          options={[{ value: '', label: t('cat.fromClass') }, ...PROPERTY_TYPES.map((x) => ({ value: x, label: t(`tax.ptype.${x}`) }))]} />
        <CheckboxField label={t('cat.isCi')} checked={f.isCi} onChange={(e) => setF((v) => ({ ...v, isCi: e.target.checked }))} />
        {row && <CheckboxField label={t('cat.active')} checked={f.isActive} onChange={(e) => setF((v) => ({ ...v, isActive: e.target.checked }))} />}
        {row && <p className="small faint" style={{ gridColumn: '1 / -1' }}>{t('cat.usage', { assets: row.assetCount, models: row.modelCount })}</p>}
        <div className={s.formActions}>
          {row && <Button disabled={saving} onClick={() => void remove()} style={{ marginRight: 'auto' }}>{t('cat.delete')}</Button>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
