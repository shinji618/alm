// ALM-260 재산세 신고 상세: 요약(원가 → 공정가치 → 평가액 → 예상 세액) · 취득연도별 표 · 자산 행 · 전년 대비 · 경고
//   DRAFT: 다시 계산·삭제·신고 완료 / FILED: 고지 기록·신고 취소 / ASSESSED: 고지 수정. 엑셀은 언제나
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, KeyValue, KpiTile, Panel, StatusPill, Tabs, TextareaField, TextField,
  useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError, download, qs } from '@/lib/api';
import { formatDate, formatDateTime, formatPercent, formatUsd } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import { changeTone, filingTone, type FilingDetail, type FilingLine, type LineChange } from './types';
import s from '../assets/assets.module.css';
import c from './tax.module.css';

type Tab = 'schedule' | 'lines' | 'changes';
const PAGE = 100;

export function TaxFilingDetail() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  const manage = can('tax.manage');
  const d = useAsync((sig) => api.get<FilingDetail>(`/tax/filings/${id}`, sig), [id]);
  const [tab, setTab] = useState<Tab>('schedule');
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<'file' | 'assess'>();
  const [rev, setRev] = useState(0);
  const x = d.data;
  if (d.error) return <div className={s.notice} role="alert">{t('common.error', { message: d.error.message })}</div>;
  if (!x) return <EmptyState message={t('common.loading')} />;
  const p = x.params;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast.show(done, 'success'); d.reload(); setRev((v) => v + 1); } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const regenerate = async () => {
    if (await confirm({ title: t('tax.act.regenerate'), message: t('tax.act.regenerateMsg'), confirmLabel: t('tax.act.regenerate') })) {
      await act(() => api.post(`/tax/filings/${id}:regenerate`), t('tax.act.regenerated'));
    }
  };
  const reopen = async () => {
    if (await confirm({ title: t('tax.act.reopen'), message: t('tax.act.reopenMsg'), confirmLabel: t('tax.act.reopen'), danger: true })) {
      await act(() => api.post(`/tax/filings/${id}:reopen`), t('tax.act.reopened'));
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: t('tax.act.delete'), message: t('tax.act.deleteMsg'), confirmLabel: t('tax.act.delete'), danger: true }))) return;
    setBusy(true);
    try { await api.del(`/tax/filings/${id}`); toast.show(t('tax.act.deleted'), 'success'); nav('/tax'); } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); setBusy(false); }
  };
  const exportXlsx = async () => {
    setBusy(true);
    try { const name = await download(`/tax/filings/${id}/export`, `BPP_${x.taxYear}.xlsx`); toast.show(t('tax.act.exported', { name }), 'success'); }
    catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const actions = (
    <div className={c.actions}>
      <Button variant={x.status === 'DRAFT' ? 'primary' : undefined} disabled={busy} onClick={() => void exportXlsx()}>{t('tax.act.export')}</Button>
      {manage && x.status === 'DRAFT' && <>
        <Button disabled={busy} onClick={() => void regenerate()}>{t('tax.act.regenerate')}</Button>
        <Button disabled={busy} onClick={() => setDrawer('file')}>{t('tax.act.file')}</Button>
        <Button disabled={busy} onClick={() => void remove()}>{t('tax.act.delete')}</Button>
      </>}
      {manage && x.status !== 'DRAFT' && <Button variant="primary" disabled={busy} onClick={() => setDrawer('assess')}>{t('tax.act.assess')}</Button>}
      {manage && x.status === 'FILED' && <Button disabled={busy} onClick={() => void reopen()}>{t('tax.act.reopen')}</Button>}
    </div>
  );
  const diff = x.actualTax !== undefined ? x.actualTax - x.estimatedTax : undefined;
  return (
    <>
      <ViewHeader crumb="ALM-260" title={`${x.taxYear} · ${x.jurisdictionName}`} actions={actions}
        description={<span>
          <StatusPill tone={filingTone[x.status]}>{t(`tax.status.${x.status}`)}</StatusPill>{' '}
          {t('tax.detail.line', { company: x.companyCode, form: x.formCode ?? t('tax.notTaxableShort'), lien: formatDate(x.lienDate), due: formatDate(x.dueDate) })}
          {' · '}<button type="button" className="link" onClick={() => nav('/tax')}>{t('tax.detail.back')}</button>
        </span>} />
      {x.warnings.length > 0 && (
        <ul className={c.warnings} aria-label={t('tax.detail.warnings')}>
          {x.warnings.map((w) => <li key={w.code} className="small"><strong className="mono">{w.code}</strong> {w.message}</li>)}
        </ul>
      )}
      <div className={c.kpis}>
        <KpiTile label={t('tax.col.assets')} value={x.assetCount} />
        <KpiTile label={t('tax.col.cost')} value={formatUsd(x.totalCost)} />
        <KpiTile label={t('tax.col.marketValue')} value={formatUsd(x.totalMarketValue)} />
        <KpiTile label={t('tax.col.exemption')} value={formatUsd(x.exemption)} />
        <KpiTile label={t('tax.col.assessed')} value={formatUsd(x.assessedValue)} hint={`× ${formatPercent(p.assessmentRatio, 1)}`} />
        <KpiTile label={t('tax.col.estimatedTax')} value={formatUsd(x.estimatedTax, 2)} hint={t('tax.detail.millage', { m: p.millage })} />
        <KpiTile label={t('tax.col.actualTax')} value={x.actualTax === undefined ? '—' : formatUsd(x.actualTax, 2)}
          tone={diff !== undefined && Math.abs(diff) > Math.max(1, x.estimatedTax * 0.1) ? 'warn' : 'default'}
          hint={diff !== undefined ? t('tax.detail.diff', { v: formatUsd(diff, 2) }) : undefined} />
      </div>
      <Panel title={t('tax.detail.basis')}>
        <KeyValue items={[
          { label: t('tax.col.factorSet'), value: `${p.factorSet}${p.factorTableYear ? ` · ${p.factorTableYear}` : ''}` },
          { label: t('tax.source'), value: p.factorSource ?? undefined },
          { label: t('tax.col.exemption'), value: p.exemptionMode === 'NONE' ? t('tax.exemption.NONE') : `${t(`tax.exemption.${p.exemptionMode}`)} ${formatUsd(p.exemptionAmount)}` },
          { label: t('tax.detail.prior'), value: x.prior ? (
            <button type="button" className="link" onClick={() => nav(`/tax/filings/${x.prior!.id}`)}>
              {t('tax.detail.priorLine', { year: x.prior.taxYear, mv: formatUsd(x.prior.totalMarketValue), tax: formatUsd(x.prior.actualTax ?? x.prior.estimatedTax, 2) })}
            </button>) : t('tax.detail.noPrior') },
          { label: t('tax.col.filedAt'), value: x.filedAt ? `${formatDate(x.filedAt)}${x.filingRef ? ` · ${x.filingRef}` : ''}` : undefined },
          { label: t('tax.detail.generatedAt'), value: formatDateTime(x.generatedAt) },
          { label: t('tax.notes'), value: x.notes },
        ]} />
        <p className="small faint">{t('tax.disclaimer')}</p>
      </Panel>
      <Panel padded={false}>
        <Tabs<Tab> label={t('tax.detail.tabs')} value={tab} onChange={setTab} items={[
          { value: 'schedule', label: t('tax.tab.schedule') }, { value: 'lines', label: t('tax.tab.lines', { n: x.assetCount }) },
          { value: 'changes', label: t('tax.tab.changes') },
        ]} />
        {tab === 'schedule' && <Schedule x={x} />}
        {tab === 'lines' && <Lines id={id} rev={rev} />}
        {tab === 'changes' && <Changes x={x} rev={rev} />}
      </Panel>
      {drawer && <StatusDrawer mode={drawer} x={x} onClose={() => setDrawer(undefined)} onSaved={() => { setDrawer(undefined); d.reload(); }} />}
    </>
  );
}

function Schedule({ x }: { x: FilingDetail }) {
  const { t } = useTranslation();
  const columns: Column<FilingDetail['schedule'][number]>[] = [
    { key: 'acquisitionYear', label: t('tax.col.acqYear'), render: (y) => <span className="mono">{y.acquisitionYear}</span> },
    { key: 'lifeClass', label: t('tax.col.class'), render: (y) => <span className="mono">{y.lifeClass}</span> },
    { key: 'count', label: t('tax.col.assets'), align: 'right' },
    { key: 'cost', label: t('tax.col.cost'), align: 'right', render: (y) => formatUsd(y.cost, 2) },
    { key: 'factor', label: t('tax.col.factor'), align: 'right', render: (y) => (y.factor === null ? '—' : y.factor.toFixed(4)) },
    { key: 'marketValue', label: t('tax.col.marketValue'), align: 'right', render: (y) => formatUsd(y.marketValue, 2) },
  ];
  return <DataTable rows={x.schedule} columns={columns} rowId={(y) => `${y.acquisitionYear}|${y.lifeClass}`} empty={<EmptyState message={t('tax.detail.noAssets')} />} />;
}

function Lines({ id, rev, change: fixed }: { id: string; rev: number; change?: LineChange }) {
  const { t } = useTranslation();
  const [change, setChange] = useState<string>(fixed ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const r = useAsync((sig) => api.get<{ items: FilingLine[]; total: number }>(`/tax/filings/${id}/lines${qs({ change, q, page, pageSize: PAGE })}`, sig), [id, change, q, page, rev]);
  const columns = useMemo<Column<FilingLine>[]>(() => [
    { key: 'assetTag', label: t('asset.col.tag'), render: (y) => <span className="mono">{y.assetTag}</span> },
    { key: 'description', label: t('asset.col.description') },
    { key: 'categoryName', label: t('tax.col.category'), render: (y) => y.categoryName ?? '—' },
    { key: 'lifeClass', label: t('tax.col.class'), render: (y) => <span className="mono">{y.lifeClass ?? '—'}</span> },
    { key: 'acquisitionDate', label: t('tax.col.acquired'), render: (y) => formatDate(y.acquisitionDate) },
    { key: 'originalCost', label: t('tax.col.cost'), align: 'right', render: (y) => (y.originalCost === undefined ? <StatusPill tone="warn">{t('tax.unknownCost')}</StatusPill> : formatUsd(y.originalCost, 2)) },
    { key: 'costSource', label: t('tax.col.costSource'), render: (y) => y.costSource ?? '—' },
    { key: 'age', label: t('tax.col.age'), align: 'right', render: (y) => y.age ?? '—' },
    { key: 'factor', label: t('tax.col.factor'), align: 'right', render: (y) => (y.factor === undefined ? '—' : y.factor.toFixed(4)) },
    { key: 'marketValue', label: t('tax.col.marketValue'), align: 'right', render: (y) => (y.marketValue === undefined ? '—' : formatUsd(y.marketValue, 2)) },
    { key: 'site', label: t('tax.col.site'), render: (y) => [y.siteCode, y.roomCode].filter(Boolean).join(' / ') || '—' },
    { key: 'change', label: t('tax.col.change'), render: (y) => <StatusPill tone={changeTone[y.change]}>{t(`tax.change.${y.change}`)}</StatusPill> },
    ...(change === 'DISPOSED' ? [{ key: 'disposalDate', label: t('tax.col.disposed'), render: (y: FilingLine) => formatDate(y.disposalDate) }] : []),
  ], [t, change]);
  const total = r.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <>
      {!fixed && (
        <FilterBar search={q} onSearch={(v) => { setQ(v); setPage(1); }} searchPlaceholder={t('tax.searchLines')}
          onClear={change || q ? () => { setChange(''); setQ(''); setPage(1); } : undefined}>
          <FilterSelect label={t('tax.col.change')} allLabel={t('tax.allChanges')} value={change} onChange={(v) => { setChange(v); setPage(1); }}
            options={(['NEW', 'CARRIED', 'DISPOSED'] as const).map((v) => ({ value: v, label: t(`tax.change.${v}`) }))} />
        </FilterBar>
      )}
      <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(y) => `${y.assetTag}|${y.change}`} loading={r.loading}
        empty={<EmptyState message={t('common.noResults')} />}
        footer={pages > 1 ? (
          <div className={s.pager}>
            <span className="small">{t('common.page', { page, pages })}</span>
            <div className={s.pagerBtns}>
              <Button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>{t('common.prev')}</Button>
              <Button disabled={page >= pages} onClick={() => setPage((v) => v + 1)}>{t('common.next')}</Button>
            </div>
          </div>
        ) : undefined} />
    </>
  );
}

function Changes({ x, rev }: { x: FilingDetail; rev: number }) {
  const { t } = useTranslation();
  const ch = (k: LineChange) => x.changes[k] ?? { count: 0, cost: 0 };
  const [view, setView] = useState<LineChange>('NEW');
  return (
    <div style={{ padding: 12 }}>
      {!x.prior && <p className="small faint">{t('tax.detail.firstYear')}</p>}
      <div className={c.kpis}>
        {(['NEW', 'CARRIED', 'DISPOSED'] as const).map((k) => (
          <KpiTile key={k} label={t(`tax.change.${k}`)} value={ch(k).count} hint={formatUsd(ch(k).cost)} onClick={() => setView(k)} tone={k === 'DISPOSED' && ch(k).count ? 'warn' : 'default'} />
        ))}
      </div>
      <h3 className="small">{t(`tax.change.${view}`)}</h3>
      <Lines key={view} id={x.id} rev={rev} change={view} />
    </div>
  );
}

function StatusDrawer({ mode, x, onClose, onSaved }: { mode: 'file' | 'assess'; x: FilingDetail; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ filedAt: x.filedAt ?? new Date().toISOString().slice(0, 10), filingRef: x.filingRef ?? '', notes: x.notes ?? '',
    actualAssessed: x.actualAssessed === undefined ? '' : String(x.actualAssessed), actualTax: x.actualTax === undefined ? '' : String(x.actualTax) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    if (mode === 'file' && !f.filedAt) { setErrors({ filedAt: t('common.required') }); return; }
    setSaving(true);
    try {
      if (mode === 'file') await api.post(`/tax/filings/${x.id}:file`, { filedAt: f.filedAt, filingRef: f.filingRef.trim() || undefined, notes: f.notes.trim() || undefined });
      else {
        const n = (v: string) => (v.trim() === '' ? null : Number(v));
        await api.patch(`/tax/filings/${x.id}`, { actualAssessed: n(f.actualAssessed), actualTax: n(f.actualTax), filingRef: f.filingRef.trim() || null, notes: f.notes.trim() || null });
      }
      toast.show(t(mode === 'file' ? 'tax.act.filed' : 'common.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  const title = t(mode === 'file' ? 'tax.act.file' : 'tax.act.assess');
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <p className="faint">{t(mode === 'file' ? 'tax.act.fileNote' : 'tax.act.assessNote')}</p>
      <FormGrid onSubmit={() => void save()}>
        {mode === 'file' && <TextField label={t('tax.col.filedAt')} required type="date" value={f.filedAt} error={errors.filedAt} onChange={set('filedAt')} />}
        {mode === 'assess' && <>
          <TextField label={t('tax.actualAssessed')} type="number" step="0.01" min={0} value={f.actualAssessed} error={errors.actualAssessed} onChange={set('actualAssessed')}
            hint={t('tax.estimateWas', { v: formatUsd(x.assessedValue) })} />
          <TextField label={t('tax.col.actualTax')} type="number" step="0.01" min={0} value={f.actualTax} error={errors.actualTax} onChange={set('actualTax')}
            hint={t('tax.estimateWas', { v: formatUsd(x.estimatedTax, 2) })} />
        </>}
        <TextField label={t('tax.filingRef')} maxLength={60} value={f.filingRef} onChange={set('filingRef')} />
        <TextareaField label={t('tax.notes')} maxLength={2000} value={f.notes} onChange={set('notes')} />
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{title}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
