// ALM-250 라벨 출력(WBS 4.5). 대기열 → [Print](프린터 선택) → ZPL 받기 → Zebra Browser Print로 전송 → 결과 회신(결정 A-08).
//   서버는 프린터에 연결하지 않는다. Browser Print가 없으면 [Print]를 끄고 설치 안내를 보여 준다. [Copy ZPL]은 보조 기능
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, Panel, SelectField, StatusPill, Tabs, TextareaField, TextField,
  useConfirm, useToast, type Column } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import { detect, pickDevice, write, type BpStatus } from '@/lib/browserPrint';
import type { Lookups } from '../assets/types';
import { LabelCard } from './LabelCard';
import { JOB_SOURCES, JOB_STATUSES, LAYOUTS, jobTone, type BulkResult, type JobPage, type LabelJob, type LabelTemplate, type Printer, type ZplBundle } from './types';
import s from '../assets/assets.module.css';
import c from './labels.module.css';

type Tab = 'queue' | 'history' | 'settings';
const PREVIEW_MAX = 24;
const INSTALL_URL = 'https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html';
const PRINTER_KEY = 'alm.labels.printerId';

const load = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가(사생활 보호 모드) */ } };

export function Labels() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  const canPrint = can('label.print');
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'queue';
  const setTab = (v: Tab) => setSp(v === 'queue' ? new URLSearchParams() : new URLSearchParams({ tab: v }), { replace: true });

  // Browser Print 상태(화면 상단 칩) — 열 때 한 번, [Check again]으로 다시
  const [bp, setBp] = useState<BpStatus>({ state: 'checking' });
  const recheck = useCallback(() => { setBp({ state: 'checking' }); void detect().then(setBp); }, []);
  useEffect(() => { if (canPrint) recheck(); }, [canPrint, recheck]);

  const printers = useAsync((sig) => api.get<{ items: Printer[] }>('/printers', sig), []);
  const templates = useAsync((sig) => api.get<{ items: LabelTemplate[] }>('/label-templates', sig), []);
  const active = (printers.data?.items ?? []).filter((x) => x.isActive);
  const [printerId, setPrinterIdRaw] = useState(() => load(PRINTER_KEY));
  const setPrinterId = (v: string) => { setPrinterIdRaw(v); save(PRINTER_KEY, v); };
  const printer = active.find((x) => x.id === printerId) ?? (active.length === 1 ? active[0] : undefined);

  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = () => setReloadKey((n) => n + 1);

  /** 고른 작업 출력: ZPL 받기 → Browser Print로 한 건씩 → 결과 회신 */
  const print = async (ids: string[]) => {
    if (!ids.length || !printer || bp.state !== 'ready') return;
    setBusy(true);
    try {
      const b = await api.post<ZplBundle>('/label-jobs:render', { jobIds: ids, printerId: printer.id });
      const device = pickDevice(bp, b.deviceName);
      const results: { jobId: string; status: 'PRINTED' | 'FAILED'; error?: string }[] = [];
      for (const it of b.items) {
        try { await write(bp.base, device, it.zpl); results.push({ jobId: it.jobId, status: 'PRINTED' }); }
        catch (e) { results.push({ jobId: it.jobId, status: 'FAILED', error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }); }
      }
      await api.post<BulkResult>('/label-jobs:report', { renderId: b.renderId, results, clientInfo: `Browser Print · ${device.name}`.slice(0, 200) });
      const failed = results.filter((x) => x.status === 'FAILED').length;
      toast.show(failed ? t('label.printPartial', { ok: results.length - failed, failed }) : t('label.printed', { count: results.length }), failed ? 'error' : 'success');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); refresh(); }
  };

  const copyZpl = async (ids: string[]) => {
    try {
      const parts = await Promise.all(ids.map((id) => api.get<{ zpl: string }>(`/label-jobs/${id}/zpl`)));
      await navigator.clipboard.writeText(parts.map((x) => x.zpl).join('\n'));
      toast.show(t('label.zplCopied', { count: ids.length }), 'success');
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const remove = async (ids: string[]) => {
    if (!ids.length || !(await confirm({ title: t('label.remove'), message: t('label.removeMsg', { count: ids.length }), confirmLabel: t('label.remove') }))) return;
    try { await api.post('/label-jobs:cancel', { jobIds: ids }); toast.show(t('label.removed', { count: ids.length }), 'success'); } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    }
    refresh();
  };

  const printReady = canPrint && bp.state === 'ready' && !!printer;
  return (
    <>
      <ViewHeader crumb="ALM-250" title={t('nav.labels')} description={t('label.description')}
        actions={canPrint ? (
          <div className={c.bar}>
            <BpChip st={bp} onRecheck={recheck} />
            <SelectField label={t('label.printer')} value={printer?.id ?? ''} onChange={(e) => setPrinterId(e.target.value)}
              options={[{ value: '', label: active.length ? t('label.choosePrinter') : t('label.noPrinters') },
                ...active.map((x) => ({ value: x.id, label: `${x.name}${x.siteCode ? ` · ${x.siteCode}` : ''} · ${x.dpi} dpi` }))]} />
          </div>
        ) : undefined} />
      {canPrint && bp.state === 'notInstalled' && (
        <div className={s.notice} role="status">
          {t('label.bp.installHelp')} <a href={INSTALL_URL} target="_blank" rel="noreferrer">{t('label.bp.download')}</a>
        </div>
      )}
      <Tabs label={t('nav.labels')} value={tab} onChange={setTab}
        items={[{ value: 'queue', label: t('label.tab.queue') }, { value: 'history', label: t('label.tab.history') }, { value: 'settings', label: t('label.tab.settings') }]} />
      {tab === 'queue' && <QueueTab key={reloadKey} templates={templates.data?.items ?? []} canPrint={canPrint} printReady={printReady} busy={busy}
        onPrint={print} onCopy={copyZpl} onRemove={remove} onChanged={refresh} />}
      {tab === 'history' && <HistoryTab key={reloadKey} canPrint={canPrint} printReady={printReady} busy={busy} onPrint={print} />}
      {tab === 'settings' && <SettingsTab printers={printers.data?.items ?? []} templates={templates.data?.items ?? []} bp={bp} printReady={canPrint && bp.state === 'ready'}
        onChanged={() => { printers.reload(); templates.reload(); }} />}
    </>
  );
}

function BpChip({ st, onRecheck }: { st: BpStatus; onRecheck: () => void }) {
  const { t } = useTranslation();
  const dot = st.state === 'ready' ? c.dotOk : st.state === 'noPrinter' ? c.dotWarn : st.state === 'notInstalled' ? c.dotBad : '';
  return (
    <span className={c.status} role="status" aria-live="polite">
      <span className={`${c.dot} ${dot}`} aria-hidden="true" />
      <span className="small">{t(`label.bp.${st.state}`, { count: st.state === 'ready' ? st.devices.length : 0 })}</span>
      {st.state !== 'checking' && <Button size="sm" onClick={onRecheck}>{t('label.bp.recheck')}</Button>}
    </span>
  );
}

// ---------------- 대기열 ----------------
function QueueTab({ templates, canPrint, printReady, busy, onPrint, onCopy, onRemove, onChanged }: {
  templates: LabelTemplate[]; canPrint: boolean; printReady: boolean; busy: boolean;
  onPrint: (ids: string[]) => void; onCopy: (ids: string[]) => void; onRemove: (ids: string[]) => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const list = useAsync((sig) => api.get<JobPage>(`/label-jobs${qs({ q, source, pageSize: 500 })}`, sig), [q, source]);
  const rows = list.data?.items ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const sel = selected.filter((id) => rows.some((r) => r.id === id));
  // 도구 바: 태그로 추가 · 템플릿 · 매수
  const activeTpl = templates.filter((x) => x.isActive !== false);
  const [tags, setTags] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [copies, setCopies] = useState('1');
  const [adding, setAdding] = useState(false);
  const add = async () => {
    const list0 = tags.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!list0.length) return;
    setAdding(true);
    try {
      const r = await api.post<{ items: LabelJob[] }>('/label-jobs', { assetTags: list0, templateId: templateId || undefined, copies: Number(copies) || 1 });
      toast.show(t('label.added', { count: r.items.length }), 'success');
      setTags('');
      setSelected(r.items.map((x) => x.id));
      onChanged();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally { setAdding(false); }
  };
  const columns = useMemo<Column<LabelJob>[]>(() => [
    { key: 'assetTag', label: t('label.col.asset'), render: (x) => <div><div className="mono">{x.assetTag}</div><div className="small muted">{x.description}</div></div> },
    { key: 'templateName', label: t('label.col.template') },
    { key: 'copies', label: t('label.col.copies'), align: 'right' },
    { key: 'source', label: t('label.col.source'), render: (x) => t(`label.source.${x.source}`) },
    { key: 'status', label: t('label.col.status'), render: (x) => <span><StatusPill tone={jobTone[x.status]}>{t(`label.status.${x.status}`)}</StatusPill>
      {x.needsCheck && <> <StatusPill tone="warn">{t('label.needsCheck')}</StatusPill></>}{x.error && <div className="small" style={{ color: 'var(--bad)' }}>{x.error}</div>}</span> },
    { key: 'requestedAt', label: t('label.col.requested'), render: (x) => <span className="small">{formatDateTime(x.requestedAt)}{x.requestedByName ? ` · ${x.requestedByName}` : ''}</span> },
    { key: 'attemptCount', label: t('label.col.attempts'), align: 'right' },
  ], [t]);
  const preview = (sel.length ? rows.filter((r) => sel.includes(r.id)) : rows).slice(0, PREVIEW_MAX);
  const tpl = activeTpl.find((x) => x.id === templateId) ?? activeTpl.find((x) => x.isDefault);
  return (
    <>
      <Panel padded={false} title={t('label.queueTitle', { count: list.data?.total ?? 0 })}
        actions={canPrint ? (
          <div className={c.bar}>
            <Button variant="primary" disabled={!printReady || busy || !sel.length} onClick={() => onPrint(sel)}>{t('label.print', { count: sel.length })}</Button>
            <Button disabled={!sel.length} onClick={() => onCopy(sel)}>{t('label.copyZpl')}</Button>
            <Button disabled={!sel.length || busy} onClick={() => onRemove(sel)}>{t('label.remove')}</Button>
          </div>
        ) : undefined}>
        {canPrint && (
          <div className={c.toolbar}>
            <TextField label={t('label.addTags')} placeholder="AT-000123, AT-000124" value={tags} onChange={(e) => setTags(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
            <SelectField label={t('label.template')} value={templateId} onChange={(e) => setTemplateId(e.target.value)}
              options={[{ value: '', label: t('label.defaultTemplate') }, ...activeTpl.map((x) => ({ value: x.id, label: x.name }))]} />
            <TextField label={t('label.col.copies')} type="number" min={1} max={20} value={copies} onChange={(e) => setCopies(e.target.value)} style={{ width: 80 }} />
            <Button disabled={adding || !tags.trim()} onClick={() => void add()}>{t('label.add')}</Button>
            <span className={`small muted ${c.paper}`}>{tpl ? t('label.paper', { w: tpl.widthIn, h: tpl.heightIn, dpi: tpl.dpi }) : ''}</span>
          </div>
        )}
        <FilterBar search={q} onSearch={setQ} searchPlaceholder={t('label.search')} onClear={q || source ? () => { setQ(''); setSource(''); } : undefined}>
          <FilterSelect label={t('label.col.source')} allLabel={t('label.allSources')} value={source} onChange={setSource}
            options={JOB_SOURCES.map((x) => ({ value: x, label: t(`label.source.${x}`) }))} />
        </FilterBar>
        {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
          <DataTable rows={rows} columns={columns} rowId={(x) => x.id} loading={list.loading}
            selected={canPrint ? sel : undefined} onSelectedChange={canPrint ? setSelected : undefined}
            empty={<EmptyState message={t('label.emptyQueue')} />} />
        )}
      </Panel>
      {preview.length > 0 && (
        <Panel title={t('label.preview')} subtitle={sel.length ? t('label.previewSelected', { count: sel.length }) : t('label.previewQueue')} padded={false}>
          <div className={c.grid}>
            {preview.map((x) => <LabelCard key={x.id} layout={x.layout} data={x} />)}
          </div>
        </Panel>
      )}
    </>
  );
}

// ---------------- 이력 ----------------
function HistoryTab({ canPrint, printReady, busy, onPrint }: { canPrint: boolean; printReady: boolean; busy: boolean; onPrint: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useAsync((sig) => api.get<JobPage>(`/label-jobs${qs({ status: status || 'ALL', q, page, pageSize: 50 })}`, sig), [status, q, page]);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const counts = list.data?.counts ?? {};
  const columns = useMemo<Column<LabelJob>[]>(() => [
    { key: 'assetTag', label: t('label.col.asset'), render: (x) => <div><div className="mono">{x.assetTag}</div><div className="small muted">{x.description}</div></div> },
    { key: 'status', label: t('label.col.status'), render: (x) => <span><StatusPill tone={jobTone[x.status]}>{t(`label.status.${x.status}`)}</StatusPill>
      {x.needsCheck && <> <StatusPill tone="warn">{t('label.needsCheck')}</StatusPill></>}{x.error && <div className="small" style={{ color: 'var(--bad)' }}>{x.error}</div>}</span> },
    { key: 'source', label: t('label.col.source'), render: (x) => t(`label.source.${x.source}`) },
    { key: 'templateName', label: t('label.col.template') },
    { key: 'printerName', label: t('label.printer'), render: (x) => x.printerName ?? '—' },
    { key: 'renderedByName', label: t('label.col.printedBy'), render: (x) => x.renderedByName ?? '—' },
    { key: 'printedAt', label: t('label.col.when'), render: (x) => <span className="small">{formatDateTime(x.printedAt ?? x.renderedAt ?? x.requestedAt)}</span> },
    { key: 'attemptCount', label: t('label.col.attempts'), align: 'right' },
    ...(canPrint ? [{ key: 'retry', label: '', render: (x: LabelJob) => (['FAILED', 'RENDERED'].includes(x.status)
      ? <Button size="sm" disabled={!printReady || busy} onClick={(e) => { e.stopPropagation(); onPrint([x.id]); }}>{t('label.retry')}</Button> : null) } as Column<LabelJob>] : []),
  ], [t, canPrint, printReady, busy, onPrint]);
  return (
    <Panel padded={false} title={t('label.historyTitle')} subtitle={JOB_STATUSES.map((x) => `${t(`label.status.${x}`)} ${counts[x] ?? 0}`).join(' · ')}>
      <FilterBar search={q} onSearch={(v) => { setQ(v); setPage(1); }} searchPlaceholder={t('label.search')} onClear={q || status ? () => { setQ(''); setStatus(''); setPage(1); } : undefined}>
        <FilterSelect label={t('label.col.status')} allLabel={t('label.allStatus')} value={status} onChange={(v) => { setStatus(v); setPage(1); }}
          options={JOB_STATUSES.map((x) => ({ value: x, label: t(`label.status.${x}`) }))} />
      </FilterBar>
      {list.error ? <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })}</div> : (
        <DataTable rows={list.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={list.loading} empty={<EmptyState message={t('common.noResults')} />}
          footer={
            <div className={s.pager}>
              <span className="small muted">{t('asset.list.total', { total })}</span>
              <div className={s.pagerBtns}>
                <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.prev')}</Button>
                <span className="small">{t('common.page', { page, pages })}</span>
                <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
              </div>
            </div>
          } />
      )}
    </Panel>
  );
}

// ---------------- 설정: 프린터·템플릿 ----------------
function SettingsTab({ printers, templates, bp, printReady, onChanged }: { printers: Printer[]; templates: LabelTemplate[]; bp: BpStatus; printReady: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useSession();
  const config = can('label.config');
  const [editPrinter, setEditPrinter] = useState<Printer | 'new'>();
  const [editTpl, setEditTpl] = useState<LabelTemplate | 'new'>();
  const testPrint = async (p: Printer) => {
    if (bp.state !== 'ready') return;
    try {
      const { zpl } = await api.get<{ zpl: string }>(`/printers/${p.id}/test-label`);
      const device = pickDevice(bp, p.deviceName);
      await write(bp.base, device, zpl);
      toast.show(t('label.testSent', { device: device.name }), 'success');
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const pCols = useMemo<Column<Printer>[]>(() => [
    { key: 'name', label: t('label.printer') },
    { key: 'siteCode', label: t('asset.col.site'), render: (x) => x.siteCode ?? t('label.allSites') },
    { key: 'deviceName', label: t('label.deviceName'), render: (x) => <span className="mono">{x.deviceName ?? '—'}</span> },
    { key: 'connection', label: t('label.connection'), render: (x) => `${x.connection}${x.host ? ` · ${x.host}` : ''}` },
    { key: 'dpi', label: 'DPI', align: 'right' },
    { key: 'isActive', label: t('cat.status'), render: (x) => <StatusPill tone={x.isActive ? 'ok' : 'neutral'}>{t(x.isActive ? 'cat.active' : 'cat.inactive')}</StatusPill> },
    ...(can('label.print') ? [{ key: 'test', label: '', render: (x: Printer) => <Button size="sm" disabled={!printReady || !x.isActive}
      onClick={(e) => { e.stopPropagation(); void testPrint(x); }}>{t('label.testLabel')}</Button> } as Column<Printer>] : []),
  ], [t, can, printReady]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tCols = useMemo<Column<LabelTemplate>[]>(() => [
    { key: 'templateCode', label: t('cat.code'), render: (x) => <span className="mono">{x.templateCode}</span> },
    { key: 'name', label: t('cat.name') },
    { key: 'layout', label: t('label.layout'), render: (x) => t(`label.layouts.${x.layout}`) },
    { key: 'size', label: t('label.size'), render: (x) => `${x.widthIn}" × ${x.heightIn}" · ${x.dpi} dpi` },
    { key: 'isDefault', label: t('label.default'), render: (x) => (x.isDefault ? <StatusPill tone="accent">{t('label.default')}</StatusPill> : '') },
    { key: 'isActive', label: t('cat.status'), render: (x) => <StatusPill tone={x.isActive !== false ? 'ok' : 'neutral'}>{t(x.isActive !== false ? 'cat.active' : 'cat.inactive')}</StatusPill> },
  ], [t]);
  return (
    <>
      <Panel padded={false} title={t('label.printers')} actions={config ? <Button onClick={() => setEditPrinter('new')}>{t('label.addPrinter')}</Button> : undefined}>
        <DataTable rows={printers} columns={pCols} rowId={(x) => x.id} onRowClick={config ? (x) => setEditPrinter(x) : undefined}
          empty={<EmptyState message={t('label.noPrinters')} />} />
      </Panel>
      <Panel padded={false} title={t('label.templates')} actions={config ? <Button onClick={() => setEditTpl('new')}>{t('label.addTemplate')}</Button> : undefined}>
        <DataTable rows={templates} columns={tCols} rowId={(x) => x.id} onRowClick={config ? (x) => setEditTpl(x) : undefined} empty={<EmptyState message={t('common.noResults')} />} />
      </Panel>
      {editPrinter && <PrinterDrawer row={editPrinter === 'new' ? undefined : editPrinter} bp={bp} onClose={() => setEditPrinter(undefined)}
        onSaved={() => { setEditPrinter(undefined); onChanged(); }} />}
      {editTpl && <TemplateDrawer row={editTpl === 'new' ? undefined : editTpl} onClose={() => setEditTpl(undefined)} onSaved={() => { setEditTpl(undefined); onChanged(); }} />}
    </>
  );
}

function PrinterDrawer({ row, bp, onClose, onSaved }: { row?: Printer; bp: BpStatus; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=sites', sig), []);
  const [f, setF] = useState({ name: row?.name ?? '', siteId: row?.siteId ?? '', deviceName: row?.deviceName ?? '', connection: row?.connection ?? 'USB',
    host: row?.host ?? '', dpi: String(row?.dpi ?? 203), isActive: row?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const devices = bp.state === 'ready' ? bp.devices.map((d) => d.name) : [];
  const title = row ? `${t('label.editPrinter')} · ${row.name}` : t('label.addPrinter');
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = t('common.required');
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = { name: f.name.trim(), siteId: f.siteId || null, deviceName: f.deviceName.trim() || null, connection: f.connection, host: f.host.trim() || null, dpi: Number(f.dpi) };
    setSaving(true);
    try {
      if (row) await api.patch(`/printers/${row.id}`, { ...body, isActive: f.isActive }); else await api.post('/printers', body);
      toast.show(t('common.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void submit()}>
        <TextField label={t('label.printer')} required maxLength={60} value={f.name} error={errors.name} onChange={set('name')} />
        <SelectField label={t('asset.col.site')} value={f.siteId} error={errors.siteId} onChange={set('siteId')}
          options={[{ value: '', label: t('label.allSites') }, ...(lk.data?.sites ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))]} />
        <TextField label={t('label.deviceName')} maxLength={100} value={f.deviceName} error={errors.deviceName} onChange={set('deviceName')} hint={t('label.deviceHint')}
          list="bp-devices" />
        <datalist id="bp-devices">{devices.map((d) => <option key={d} value={d} />)}</datalist>
        <SelectField label={t('label.connection')} value={f.connection} onChange={set('connection')} options={[{ value: 'USB', label: 'USB' }, { value: 'NETWORK', label: t('label.network') }]} />
        {f.connection === 'NETWORK' && <TextField label={t('label.host')} maxLength={100} value={f.host} onChange={set('host')} />}
        <SelectField label="DPI" value={f.dpi} onChange={set('dpi')} options={['203', '300', '600'].map((x) => ({ value: x, label: `${x} dpi` }))} />
        {row && <CheckboxField label={t('cat.active')} checked={f.isActive} onChange={(e) => setF((v) => ({ ...v, isActive: e.target.checked }))} />}
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}

function TemplateDrawer({ row, onClose, onSaved }: { row?: LabelTemplate; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ code: row?.templateCode ?? '', name: row?.name ?? '', layout: row?.layout ?? 'QR_CODE128', widthIn: String(row?.widthIn ?? 2),
    heightIn: String(row?.heightIn ?? 1), dpi: String(row?.dpi ?? 203), zpl: row?.zpl ?? '^XA\n^CI28^PW406^LL203\n^FO10,10^BQN,2,3^FDMA,{assetTag}^FS\n^XZ',
    isDefault: row?.isDefault ?? false, isActive: row?.isActive ?? true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const title = row ? `${t('label.editTemplate')} · ${row.templateCode}` : t('label.addTemplate');
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!row && !/^[A-Za-z0-9_.-]{1,20}$/.test(f.code)) e.templateCode = t('cat.codeHint');
    if (!f.name.trim()) e.name = t('common.required');
    if (!/^\s*\^XA[\s\S]*\^XZ\s*$/.test(f.zpl)) e.zpl = t('label.zplHint');
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = { name: f.name.trim(), layout: f.layout, widthIn: Number(f.widthIn), heightIn: Number(f.heightIn), dpi: Number(f.dpi), zpl: f.zpl, isDefault: f.isDefault };
    setSaving(true);
    try {
      if (row) await api.patch(`/label-templates/${row.id}`, { ...body, isActive: f.isActive }); else await api.post('/label-templates', { templateCode: f.code.trim().toUpperCase(), ...body });
      toast.show(t('common.saved'), 'success');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally { setSaving(false); }
  };
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <FormGrid onSubmit={() => void submit()}>
        {!row && <TextField label={t('cat.code')} required maxLength={20} value={f.code} error={errors.templateCode} onChange={set('code')} />}
        <TextField label={t('cat.name')} required maxLength={60} value={f.name} error={errors.name} onChange={set('name')} />
        <SelectField label={t('label.layout')} value={f.layout} onChange={set('layout')} options={LAYOUTS.map((x) => ({ value: x, label: t(`label.layouts.${x}`) }))} />
        <TextField label={t('label.widthIn')} type="number" step="0.25" min={0.5} max={8} value={f.widthIn} onChange={set('widthIn')} />
        <TextField label={t('label.heightIn')} type="number" step="0.25" min={0.25} max={8} value={f.heightIn} onChange={set('heightIn')} />
        <SelectField label="DPI" value={f.dpi} onChange={set('dpi')} options={['203', '300', '600'].map((x) => ({ value: x, label: `${x} dpi` }))} />
        <TextareaField label="ZPL" required rows={12} value={f.zpl} error={errors.zpl} onChange={set('zpl')} hint={t('label.zplVars')} className={c.zpl} />
        <CheckboxField label={t('label.default')} checked={f.isDefault} onChange={(e) => setF((v) => ({ ...v, isDefault: e.target.checked }))} />
        {row && !row.isDefault && <CheckboxField label={t('cat.active')} checked={f.isActive} onChange={(e) => setF((v) => ({ ...v, isActive: e.target.checked }))} />}
        <div className={s.formActions}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{t('common.save')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
