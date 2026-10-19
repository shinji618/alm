// Bundle 자산의 구성품(ALM-111 일반 탭). 구성품은 SAP에 없는 ALM 자산이고, SAP에는 Bundle 1건만 등록된다
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AssetTag, Button, DataTable, StatusPill, TextField, useToast, type Column } from '@/components/ui';
import { api } from '@/lib/api';
import { formatUsd } from '@/lib/format';
import { statusCodeTone } from '@/lib/status';
import { useSession } from '@/lib/session';
import type { AssetDetail, BundleComponent, BundleComponents } from './types';
import s from './assets.module.css';

export function BundlePanel({ d, canWrite, onChange }: { d: AssetDetail; canWrite: boolean; onChange: (x: BundleComponents) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useSession();
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = d.components ?? [];
  const run = async (fn: () => Promise<BundleComponents>, msg: (x: BundleComponents) => string) => {
    setBusy(true);
    try { const x = await fn(); onChange(x); toast.show(msg(x), 'success'); return true; } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error'); return false;
    } finally { setBusy(false); }
  };
  const add = async () => {
    const list = tags.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) return;
    if (await run(() => api.post<BundleComponents>(`/assets/${d.id}/components`, { assetTags: list }), (x) => t('asset.bundle.added', { count: x.added?.length ?? 0 }))) setTags('');
  };
  const remove = (r: BundleComponent) => run(() => api.delJson<BundleComponents>(`/assets/${d.id}/components/${r.id}`), () => t('asset.bundle.removed', { tag: r.assetTag }));

  const columns: Column<BundleComponent>[] = [
    { key: 'assetTag', label: t('asset.col.tag'), render: (r) => <Link to={`/assets/${r.id}`}><AssetTag tag={r.assetTag} /></Link> },
    { key: 'description', label: t('asset.col.description'), render: (r) => <div><div>{r.description}</div><div className="small muted">{[r.categoryName, r.serialNo].filter(Boolean).join(' · ')}</div></div> },
    { key: 'status', label: t('asset.col.status'), render: (r) => <StatusPill tone={statusCodeTone[r.status]}>{t(`asset.status.${r.status}`)}</StatusPill> },
    { key: 'roomCode', label: t('asset.col.room'), render: (r) => r.roomCode ?? '—' },
    { key: 'assignedUserName', label: t('asset.col.user'), render: (r) => r.assignedUserName ?? '—' },
    ...(can('amount.read') ? [{ key: 'purchaseCost', label: t('asset.field.purchaseCost'), align: 'right' as const,
      render: (r: BundleComponent) => <span className="num">{formatUsd(r.purchaseCost, 2)}</span> }] : []),
    ...(canWrite ? [{ key: 'actions', label: '', render: (r: BundleComponent) => (
      <Button size="sm" disabled={busy} aria-label={`${t('asset.bundle.remove')} ${r.assetTag}`} onClick={() => void remove(r)}>{t('asset.bundle.remove')}</Button>) }] : []),
  ];
  return (
    <section aria-label={t('asset.bundle.components')} style={{ marginTop: 16 }}>
      <h3>{t('asset.bundle.components')} ({rows.length})</h3>
      <div className={s.notice}>{t('asset.bundle.notice', { count: rows.length })} {t('asset.bundle.rules')}</div>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', margin: '8px 0' }}>
          <TextField label={t('asset.bundle.addTags')} hint={t('asset.bundle.addTagsHint')} value={tags} onChange={(e) => setTags(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
          <Button variant="primary" disabled={busy || !tags.trim()} onClick={() => void add()}>{t('asset.bundle.add')}</Button>
        </div>
      )}
      {rows.length ? <DataTable rows={rows} columns={columns} rowId={(r) => r.id} /> : <div className="muted">{t('asset.bundle.noComponents')}</div>}
      {d.componentCostTotal !== undefined && d.componentCostTotal !== null && (
        <div className="small" style={{ marginTop: 8 }}>{t('asset.bundle.costTotal')}: <span className="num">{formatUsd(d.componentCostTotal, 2)}</span></div>
      )}
    </section>
  );
}
