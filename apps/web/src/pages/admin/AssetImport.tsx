// ADM-060 자산 일괄 업로드(2026-10-19). 템플릿 내려받기 → 파일 올리기(xlsx·CSV) → 미리보기(행별 검사, 아무것도 바뀌지 않음) → 적용(오류 없는 행만) → 결과 내려받기.
//   신규는 ALM에만 등록(SAP 요청 없음). 기존 태그면 적힌 칸만 수정. 권한 asset.write
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, ChipGroup, DataTable, EmptyState, KpiTile, Panel, StatusPill, useConfirm, useToast, type Column } from '@/components/ui';
import { api, download } from '@/lib/api';
import s from '../assets/assets.module.css';
import c from './assetImport.module.css';

interface Msg { field?: string; code: string; message: string }
export interface ImportRow {
  rowNo: number; action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP'; status: 'OK' | 'WARN' | 'ERROR'; assetTag?: string; description?: string;
  changes?: string[]; errors: Msg[]; warnings: Msg[]; assetId?: string;
}
export interface ImportResult {
  fileName: string; applied: boolean; unknownColumns: string[];
  summary: { rows: number; create: number; update: number; unchanged: number; errors: number; warnings: number }; rows: ImportRow[];
}
type Filter = 'all' | 'errors' | 'warnings' | 'create' | 'update';
const MAX_BYTES = 700 * 1024;
const actionTone = { CREATE: 'accent', UPDATE: 'info', UNCHANGED: 'neutral', SKIP: 'neutral' } as const;
const statusTone = { OK: 'ok', WARN: 'warn', ERROR: 'bad' } as const;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

export function AssetImport() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; base64: string }>();
  const [result, setResult] = useState<ImportResult>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const msgText = (m: Msg) => t(`imp.code.${m.code}`, { defaultValue: m.message, field: m.field ?? '', message: m.message });
  const getTemplate = async (withAssets: boolean) => {
    try { const name = await download(`/admin/asset-import/template${withAssets ? '?withAssets=true' : ''}`, 'ALM_asset_import_template.xlsx'); toast.show(t('imp.downloaded', { name }), 'success'); }
    catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const pick = async (f?: File) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { toast.show(t('imp.tooLarge'), 'error'); return; }
    setBusy(true); setResult(undefined); setFilter('all');
    try {
      const base64 = await toBase64(f);
      setFile({ name: f.name, base64 });
      setResult(await api.post<ImportResult>('/admin/asset-import:preview', { fileName: f.name, contentBase64: base64 }));
    } catch (e) { setFile(undefined); toast.show(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const ready = result && !result.applied ? result.summary.create + result.summary.update : 0;
  const apply = async () => {
    if (!file || !result) return;
    if (!(await confirm({ title: t('imp.apply'), message: t('imp.applyMsg', { create: result.summary.create, update: result.summary.update, errors: result.summary.errors }), confirmLabel: t('imp.apply') }))) return;
    setBusy(true);
    try {
      const r = await api.post<ImportResult>('/admin/asset-import:apply', { fileName: file.name, contentBase64: file.base64 });
      setResult(r); setFilter('all');
      toast.show(t('imp.applied', { create: r.summary.create, update: r.summary.update }), r.summary.errors ? 'error' : 'success');
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
  };
  const downloadResults = () => {
    if (!result) return;
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['row', 'action', 'status', 'assetTag', 'description', 'changes', 'errors', 'warnings'].join(','),
      ...result.rows.map((r) => [r.rowNo, r.action, r.status, r.assetTag, r.description, (r.changes ?? []).join(' '),
        r.errors.map((m) => `${m.field ? `${m.field}: ` : ''}${msgText(m)}`).join(' | '), r.warnings.map((m) => msgText(m)).join(' | ')].map(q).join(','))];
    const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${file?.name.replace(/\.[^.]+$/, '') ?? 'import'}_${result.applied ? 'result' : 'preview'}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const rows = (result?.rows ?? []).filter((r) => filter === 'all' || (filter === 'errors' && r.status === 'ERROR') || (filter === 'warnings' && r.status === 'WARN')
    || (filter === 'create' && r.action === 'CREATE') || (filter === 'update' && r.action === 'UPDATE'));
  const columns = useMemo<Column<ImportRow>[]>(() => [
    { key: 'rowNo', label: t('imp.col.row'), align: 'right' },
    { key: 'action', label: t('imp.col.action'), render: (r) => <StatusPill tone={actionTone[r.action]}>{t(`imp.action.${r.action}`)}</StatusPill> },
    { key: 'status', label: t('imp.col.status'), render: (r) => <StatusPill tone={statusTone[r.status]}>{t(`imp.status.${r.status}`)}</StatusPill> },
    { key: 'assetTag', label: t('imp.col.tag'), render: (r) => <span className="mono">{r.assetTag ?? (r.action === 'CREATE' ? t('imp.autoTag') : '—')}</span> },
    { key: 'description', label: t('imp.col.description'), render: (r) => r.description ?? '—' },
    { key: 'details', label: t('imp.col.details'), render: (r) => (
      <div className={c.msgs}>
        {r.changes && r.changes.length > 0 && <div className="small muted">{t('imp.changes', { cols: r.changes.join(', ') })}</div>}
        {r.errors.map((m, i) => <div key={`e${i}`} className={c.err}>{m.field && <span className="mono">{m.field}: </span>}{msgText(m)}</div>)}
        {r.warnings.map((m, i) => <div key={`w${i}`} className={c.warn}>{m.field && <span className="mono">{m.field}: </span>}{msgText(m)}</div>)}
      </div>) },
  ], [t]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ViewHeader crumb="ADM-060" title={t('nav.assetImport')} description={t('imp.description')} />
      <Panel title={t('imp.step1')} subtitle={t('imp.step1Hint')}>
        <div className={c.bar}>
          <Button onClick={() => void getTemplate(false)}>{t('imp.template')}</Button>
          <Button onClick={() => void getTemplate(true)}>{t('imp.templateWithAssets')}</Button>
        </div>
      </Panel>
      <Panel title={t('imp.step2')} subtitle={t('imp.step2Hint')}>
        <div className={c.bar}>
          <input ref={input} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" className={c.file}
            aria-label={t('imp.chooseFile')} onChange={(e) => void pick(e.target.files?.[0])} disabled={busy} />
          <Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>{busy && !result ? t('imp.checking') : t('imp.chooseFile')}</Button>
          {file && <span className="small muted">{file.name}</span>}
        </div>
      </Panel>
      {result && (
        <Panel padded={false} title={result.applied ? t('imp.resultTitle') : t('imp.previewTitle')}
          subtitle={result.applied ? t('imp.resultHint') : t('imp.previewHint')}
          actions={<div className={c.bar}>
            <Button onClick={downloadResults}>{t('imp.downloadResults')}</Button>
            {!result.applied && <Button variant="primary" disabled={busy || ready === 0} onClick={() => void apply()}>{t('imp.applyN', { count: ready })}</Button>}
          </div>}>
          <div className={c.kpis}>
            <KpiTile label={t('imp.sum.rows')} value={result.summary.rows} />
            <KpiTile label={t('imp.sum.create')} value={result.summary.create} />
            <KpiTile label={t('imp.sum.update')} value={result.summary.update} />
            <KpiTile label={t('imp.sum.unchanged')} value={result.summary.unchanged} />
            <KpiTile label={t('imp.sum.warnings')} value={result.summary.warnings} tone={result.summary.warnings ? 'warn' : 'default'} />
            <KpiTile label={t('imp.sum.errors')} value={result.summary.errors} tone={result.summary.errors ? 'bad' : 'default'} />
          </div>
          {result.unknownColumns.length > 0 && <div className={s.notice} role="status">{t('imp.unknownColumns', { cols: result.unknownColumns.join(', ') })}</div>}
          <div className={c.filters}>
            <ChipGroup label={t('imp.filter')} value={filter} onChange={setFilter}
              options={(['all', 'errors', 'warnings', 'create', 'update'] as Filter[]).map((v) => ({ value: v, label: t(`imp.filters.${v}`) }))} />
          </div>
          <DataTable rows={rows} columns={columns} rowId={(r) => String(r.rowNo)} empty={<EmptyState message={t('common.noResults')} />} />
        </Panel>
      )}
    </>
  );
}
