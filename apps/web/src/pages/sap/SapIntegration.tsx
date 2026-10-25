// ALM-310 SAP 연계: 상태(IF별 마지막 실행·지연·수동 실행 요청) · 실행 로그 · 전기 큐(재전기·취소) · 대사 차이 처리 · 매핑·연결. WBS 4.6
//   자산 관리자는 상태만(sap.status), 자산회계·시스템 관리자는 전체(sap.monitor). 처리 버튼은 권한 키로 숨긴다(서버가 다시 확인)
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import {
  Button, CheckboxField, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, KeyValue, KpiTile, Panel, StatusPill, Tabs, useConfirm, useToast, type Column,
} from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Tone } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Page } from '../assets/types';
import s from '../assets/assets.module.css';

type Tab = 'status' | 'runs' | 'postings' | 'recon' | 'config';
interface IfStatus { interfaceId: string; name: string; direction: string; everyMinutes: number; lastRunAt?: string; lastStatus?: string; lastRecordCount?: number;
  isOverdue: boolean; runnable?: boolean; runPending?: boolean }
interface SapStatus { systemId: string; companyCodes: string[]; lastCallAt?: string; interfaces: IfStatus[]; postingQueue: { READY: number; CLAIMED: number; FAILED: number } }
interface RunRow { id: string; interfaceId: string; direction: string; batchId: string; status: string; recordCount: number; errorCount: number; startedAt: string;
  finishedAt?: string; httpStatus?: number }
interface MsgRow { recordKey: string; result: string; errorCode?: string; message?: string; payload?: unknown }
interface PostingRow { id: string; postingId: string; postingType: string; status: string; companyCode: string; assetTag?: string; attemptCount: number;
  approvedAt?: string; leaseUntil?: string; sapDocumentNo?: string; lastMessage?: string; exhausted?: boolean; updatedAt: string }
interface PostingDetail { summary: PostingRow & { messages: { type: string; id: string; number: string; text: string }[]; sapAssetNo?: string; resultAt?: string };
  payload: unknown; postingDate?: string; valueDate?: string; requestNo?: string; requestId?: string; requestStatus?: string; assetId?: string }
interface ReconRun { id: string; runType: string; batchId: string; snapshotAt: string; status: string; sapCount: number; almCount: number; diffCount: number; openDiffs: number }
interface ReconDiff { id: string; diffType: string; assetId?: string; assetTag?: string; sapAssetNo?: string; almValue?: string; sapValue?: string; suggestedAction: string;
  status: string; allowedActions: string[]; resolvedBy?: string; resolvedAt?: string }

const runTone: Record<string, Tone> = { SUCCESS: 'ok', PARTIAL: 'warn', FAILED: 'bad' };
const postTone: Record<string, Tone> = { READY: 'info', CLAIMED: 'accent', POSTED: 'ok', FAILED: 'bad', CANCELLED: 'neutral' };

export function SapIntegration() {
  const { t } = useTranslation();
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const full = can('sap.monitor');
  const tabs: Tab[] = full ? ['status', 'runs', 'postings', 'recon', 'config'] : ['status'];
  const tab = (tabs as string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as Tab) : 'status';
  const go = (v: Tab, extra: Record<string, string> = {}) => setSp(new URLSearchParams({ tab: v, ...extra }), { replace: true });
  return (
    <>
      <ViewHeader crumb="ALM-310" title={t('nav.sap')} description={t('sap.description')} />
      <Panel padded={false}>
        <Tabs<Tab> label={t('nav.sap')} value={tab} onChange={(v) => go(v)} items={tabs.map((v) => ({ value: v, label: t(`sap.tabs.${v}`) }))} />
        <div style={{ padding: 16 }}>
          {tab === 'status' ? <Status onRuns={(iface) => go('runs', { interfaceId: iface })} onQueue={() => go('postings')} />
            : tab === 'runs' ? <Runs initialIface={sp.get('interfaceId') ?? ''} />
            : tab === 'postings' ? <Postings />
            : tab === 'recon' ? <Recon />
            : <Config />}
        </div>
      </Panel>
    </>
  );
}

// ---------------- 상태 ----------------
function Status({ onRuns, onQueue }: { onRuns: (iface: string) => void; onQueue: () => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const toast = useToast();
  const st = useAsync((sig) => api.get<SapStatus>('/integration/sap/status', sig), []);
  const reqs = useAsync((sig) => (can('sap.monitor') ? api.get<{ items: { id: string; interfaceId: string; status: string; requestedAt: string; requestedBy?: string;
    pickedAt?: string; doneAt?: string; isClosing?: boolean }[] }>('/integration/sap/run-requests', sig) : Promise.resolve({ items: [] })), []);
  const [busy, setBusy] = useState<string>();
  const run = async (iface: string, isClosing = false) => {
    setBusy(iface);
    try {
      await api.post('/integration/sap/run-requests', { interfaceId: iface, ...(isClosing ? { isClosing: true } : {}) });
      toast.show(t('sap.runRequested', { iface }), 'success');
      st.reload(); reqs.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(undefined); }
  };
  if (st.error) return <div className={s.notice} role="alert">{t('common.error', { message: st.error.message })}</div>;
  const d = st.data;
  if (!d) return <span className="muted">{t('common.loading')}</span>;
  const columns: Column<IfStatus>[] = [
    { key: 'interfaceId', label: 'IF', render: (x) => <span className="mono">{x.interfaceId}</span> },
    { key: 'name', label: t('sap.col.name') },
    { key: 'direction', label: t('sap.col.direction'), render: (x) => t(`sap.direction.${x.direction}`) },
    { key: 'everyMinutes', label: t('sap.col.every'), render: (x) => every(t, x.everyMinutes) },
    { key: 'lastRunAt', label: t('sap.col.lastRun'), render: (x) => formatDateTime(x.lastRunAt) },
    { key: 'lastStatus', label: t('sap.col.result'), render: (x) => (x.lastStatus ? <StatusPill tone={runTone[x.lastStatus]}>{t(`sap.runStatus.${x.lastStatus}`)}</StatusPill> : '—') },
    { key: 'lastRecordCount', label: t('sap.col.records'), align: 'right' },
    { key: 'isOverdue', label: t('sap.col.overdue'), render: (x) => (x.isOverdue ? <StatusPill tone="bad">{t('sap.overdue')}</StatusPill> : '') },
    { key: 'runnable', label: '', render: (x) => (
      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {can('sap.monitor') && x.direction === 'SAP_TO_ALM' && <Button size="sm" onClick={(e) => { e.stopPropagation(); onRuns(x.interfaceId); }}>{t('sap.viewRuns')}</Button>}
        {x.runnable && can('sap.operate') && (x.runPending ? <StatusPill tone="info">{t('sap.pending')}</StatusPill>
          : <Button size="sm" disabled={!!busy} onClick={(e) => { e.stopPropagation(); void run(x.interfaceId); }}>{t('sap.runNow')}</Button>)}
        {x.interfaceId === 'IF-AA-02' && can('sap.finance') && !x.runPending && (
          <Button size="sm" disabled={!!busy} onClick={(e) => { e.stopPropagation(); void run(x.interfaceId, true); }}>{t('sap.runClosing')}</Button>)}
      </span>
    ) },
  ];
  return (
    <>
      {!d.companyCodes.length && <div className={s.notice}>{t('sap.noConnection')}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <KpiTile label={t('sap.kpi.system')} value={d.systemId || '—'} hint={d.companyCodes.join(', ')} />
        <KpiTile label={t('sap.kpi.lastCall')} value={d.lastCallAt ? formatDateTime(d.lastCallAt) : '—'} />
        <KpiTile label={t('sap.kpi.ready')} value={String(d.postingQueue.READY + d.postingQueue.CLAIMED)} onClick={can('sap.monitor') ? onQueue : undefined} />
        <KpiTile label={t('sap.kpi.failed')} value={String(d.postingQueue.FAILED)} tone={d.postingQueue.FAILED ? 'bad' : undefined} onClick={can('sap.monitor') ? onQueue : undefined} />
      </div>
      <DataTable rows={d.interfaces} columns={columns} rowId={(x) => x.interfaceId} />
      {can('sap.monitor') && (reqs.data?.items.length ?? 0) > 0 && (
        <>
          <h3>{t('sap.runRequests')}</h3>
          <DataTable rows={reqs.data!.items} rowId={(x) => x.id} columns={[
            { key: 'interfaceId', label: 'IF', render: (x) => <span className="mono">{x.interfaceId}{x.isClosing ? ` (${t('sap.closing')})` : ''}</span> },
            { key: 'status', label: t('sap.col.status'), render: (x) => t(`sap.reqStatus.${x.status}`) },
            { key: 'requestedBy', label: t('sap.col.requestedBy') },
            { key: 'requestedAt', label: t('sap.col.requestedAt'), render: (x) => formatDateTime(x.requestedAt) },
            { key: 'pickedAt', label: t('sap.col.pickedAt'), render: (x) => formatDateTime(x.pickedAt) },
            { key: 'doneAt', label: t('sap.col.doneAt'), render: (x) => formatDateTime(x.doneAt) },
          ]} />
        </>
      )}
    </>
  );
}

const every = (t: (k: string, o?: Record<string, unknown>) => string, m: number) => (m >= 10080 ? t('sap.weekly') : m >= 1440 ? t('sap.daily') : t('sap.minutes', { m }));

// ---------------- 실행 로그 ----------------
function Runs({ initialIface }: { initialIface: string }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ interfaceId: initialIface, status: '', page: 1 });
  const r = useAsync((sig) => api.get<Page<RunRow>>(`/integration/sap/runs${qs({ ...f, pageSize: 50 })}`, sig), [f.interfaceId, f.status, f.page]);
  const [open, setOpen] = useState<RunRow>();
  const ifs = ['IF-MD-01', 'IF-AA-01', 'IF-AA-02', 'IF-MM-01', 'IF-MM-03', 'IF-RC-01', 'IF-AA-03', 'IF-AA-04', 'IF-AA-05', 'IF-AA-06', 'IF-AA-07', 'IF-MM-02'];
  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <FilterSelect label="IF" allLabel={t('sap.allIfs')} value={f.interfaceId} onChange={(v) => setF({ ...f, interfaceId: v, page: 1 })} options={ifs.map((x) => ({ value: x, label: x }))} />
        <FilterSelect label={t('sap.col.result')} allLabel={t('sap.allResults')} value={f.status} onChange={(v) => setF({ ...f, status: v, page: 1 })}
          options={['SUCCESS', 'PARTIAL', 'FAILED'].map((x) => ({ value: x, label: t(`sap.runStatus.${x}`) }))} />
        <span className="small muted" style={{ alignSelf: 'center' }}>{t('sap.last30')}</span>
      </div>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={r.data?.items ?? []} rowId={(x) => x.id} loading={r.loading} onRowClick={setOpen} empty={<EmptyState message={t('common.noResults')} />}
          columns={[
            { key: 'startedAt', label: t('sap.col.started'), render: (x) => formatDateTime(x.startedAt) },
            { key: 'interfaceId', label: 'IF', render: (x) => <span className="mono">{x.interfaceId}</span> },
            { key: 'batchId', label: t('sap.col.batch'), render: (x) => <span className="mono small">{x.batchId}</span> },
            { key: 'status', label: t('sap.col.result'), render: (x) => <StatusPill tone={runTone[x.status]}>{t(`sap.runStatus.${x.status}`)}</StatusPill> },
            { key: 'recordCount', label: t('sap.col.records'), align: 'right' },
            { key: 'errorCount', label: t('sap.col.errors'), align: 'right' },
            { key: 'httpStatus', label: 'HTTP', align: 'right' },
          ]}
          footer={<Pager page={f.page} total={r.data?.total ?? 0} onPage={(p) => setF({ ...f, page: p })} />} />
      )}
      {open && <RunDrawer run={open} onClose={() => setOpen(undefined)} />}
    </>
  );
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / 50));
  return (
    <div className={s.pager}>
      <span className="small muted">{t('asset.list.total', { total })}</span>
      <div className={s.pagerBtns}>
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t('common.prev')}</Button>
        <span className="small">{t('common.page', { page, pages })}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>{t('common.next')}</Button>
      </div>
    </div>
  );
}

function RunDrawer({ run, onClose }: { run: RunRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [errorsOnly, setErrorsOnly] = useState(run.errorCount > 0);
  const m = useAsync((sig) => api.get<Page<MsgRow>>(`/integration/sap/runs/${run.id}/messages${qs({ result: errorsOnly ? 'ERROR' : undefined, pageSize: 200 })}`, sig), [run.id, errorsOnly]);
  return (
    <Drawer open onClose={onClose} label={t('sap.runDetail')} title={`${run.interfaceId} · ${run.batchId}`}>
      <KeyValue items={[
        { label: t('sap.col.started'), value: formatDateTime(run.startedAt) }, { label: t('sap.col.finished'), value: formatDateTime(run.finishedAt) },
        { label: t('sap.col.records'), value: run.recordCount }, { label: t('sap.col.errors'), value: run.errorCount },
      ]} />
      <CheckboxField label={t('sap.errorsOnly')} checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
      <DataTable rows={m.data?.items ?? []} rowId={(x) => `${x.recordKey}-${x.result}`} loading={m.loading} empty={<EmptyState message={t('common.noResults')} />} columns={[
        { key: 'recordKey', label: t('sap.col.key'), render: (x) => <span className="mono small">{x.recordKey}</span> },
        { key: 'result', label: t('sap.col.result') },
        { key: 'errorCode', label: t('sap.col.code'), render: (x) => <span className="mono">{x.errorCode ?? ''}</span> },
        { key: 'message', label: t('sap.col.message'), render: (x) => <span className="small">{x.message}</span> },
      ]} />
    </Drawer>
  );
}

// ---------------- 전기 큐 ----------------
function Postings() {
  const { t } = useTranslation();
  const [f, setF] = useState({ status: 'FAILED,READY,CLAIMED', q: '', page: 1 });
  const r = useAsync((sig) => api.get<Page<PostingRow>>(`/integration/sap/postings${qs({ ...f, pageSize: 50 })}`, sig), [f.status, f.q, f.page]);
  const [open, setOpen] = useState<string>();
  const columns = useMemo<Column<PostingRow>[]>(() => [
    { key: 'postingId', label: t('sap.col.postingId'), render: (x) => <span className="mono">{x.postingId}</span> },
    { key: 'postingType', label: t('sap.col.type'), render: (x) => t(`sap.postingType.${x.postingType}`) },
    { key: 'status', label: t('sap.col.status'), render: (x) => <StatusPill tone={postTone[x.status]}>{t(`request.posting.statuses.${x.status}`)}</StatusPill> },
    { key: 'assetTag', label: t('request.col.asset'), render: (x) => <span className="mono">{x.assetTag ?? '—'}</span> },
    { key: 'attemptCount', label: t('sap.col.attempts'), align: 'right' },
    { key: 'lastMessage', label: t('sap.col.message'), render: (x) => <span className="small">{x.lastMessage}</span> },
    { key: 'updatedAt', label: t('sap.col.updated'), render: (x) => formatDateTime(x.updatedAt) },
  ], [t]);
  return (
    <>
      <FilterBar search={f.q} onSearch={(q) => setF({ ...f, q, page: 1 })} searchPlaceholder={t('sap.searchPosting')}>
        <FilterSelect label={t('sap.col.status')} allLabel={t('sap.openPostings')} value={f.status === 'FAILED,READY,CLAIMED' ? '' : f.status}
          onChange={(v) => setF({ ...f, status: v || 'FAILED,READY,CLAIMED', page: 1 })}
          options={['FAILED', 'READY', 'CLAIMED', 'POSTED', 'CANCELLED'].map((x) => ({ value: x, label: t(`request.posting.statuses.${x}`) }))} />
      </FilterBar>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={r.loading} onRowClick={(x) => setOpen(x.id)}
          empty={<EmptyState message={t('sap.queueEmpty')} />} footer={<Pager page={f.page} total={r.data?.total ?? 0} onPage={(p) => setF({ ...f, page: p })} />} />
      )}
      {open && <PostingDrawer id={open} onClose={() => setOpen(undefined)} onChanged={() => r.reload()} />}
    </>
  );
}

function PostingDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const d = useAsync((sig) => api.get<PostingDetail>(`/integration/sap/postings/${id}`, sig), [id]);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (kind: 'retry' | 'cancel' | 'release') => {
    const p = d.data!.summary;
    if (kind === 'cancel' && !(await confirm({ title: t('sap.cancelTitle', { no: p.postingId }), message: t('sap.cancelMessage'), danger: true, confirmLabel: t('sap.cancelPosting') }))) return;
    if (kind === 'release' && !(await confirm({ title: t('sap.releaseTitle', { no: p.postingId }), message: t('sap.releaseMessage'), confirmLabel: t('sap.release') }))) return;
    setBusy(true);
    try {
      const body = kind === 'release' ? { confirmed: true } : (kind === 'retry' && p.exhausted) || (kind === 'cancel' && stale) ? { confirmSapChecked: checked } : {};
      await api.post(`/integration/sap/postings/${id}:${kind}`, body);
      toast.show(t(kind === 'retry' ? 'sap.retried' : kind === 'release' ? 'sap.released' : 'sap.cancelled', { no: p.postingId }), 'success');
      d.reload(); onChanged();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const x = d.data;
  // SAP 잡이 가져갔지만 잠금이 끝나도록 회신이 없는 건: 확인 체크 후 취소 가능
  const stale = !!x && x.summary.status === 'CLAIMED' && !!x.summary.leaseUntil && Date.parse(x.summary.leaseUntil) < Date.now();
  return (
    <Drawer open onClose={onClose} label={t('sap.postingDetail')} title={x ? `${x.summary.postingId} · ${t(`sap.postingType.${x.summary.postingType}`)}` : t('common.loading')}>
      {x && (
        <>
          <KeyValue items={[
            { label: t('sap.col.status'), value: <StatusPill tone={postTone[x.summary.status]}>{t(`request.posting.statuses.${x.summary.status}`)}</StatusPill> },
            { label: t('sap.col.attempts'), value: x.summary.attemptCount },
            { label: t('request.col.asset'), value: x.assetId ? <Link to={`/assets/${x.assetId}`} className="mono">{x.summary.assetTag}</Link> : undefined },
            { label: t('sap.col.request'), value: x.requestId ? <Link to={`/requests/${x.requestId}`} className="mono">{x.requestNo}</Link> : undefined },
            { label: t('sap.col.postingDate'), value: x.postingDate }, { label: t('sap.col.valueDate'), value: x.valueDate },
            { label: t('request.posting.document'), value: x.summary.sapDocumentNo }, { label: t('request.posting.assetNo'), value: x.summary.sapAssetNo },
            { label: t('request.posting.resultAt'), value: formatDateTime(x.summary.resultAt) },
          ]} />
          {x.summary.messages.length > 0 && (
            <ul className="small" style={{ paddingLeft: 16 }}>{x.summary.messages.map((m, i) => <li key={i}><span className="mono">{m.type} {m.id} {m.number}</span> {m.text}</li>)}</ul>
          )}
          <details><summary className="small">{t('sap.payload')}</summary><pre className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(x.payload, null, 2)}</pre></details>
          {x.summary.status === 'CLAIMED' && (
            <p className="small muted">{stale ? t('sap.staleClaim', { at: formatDateTime(x.summary.leaseUntil) }) : t('sap.claimedUntil', { at: formatDateTime(x.summary.leaseUntil) })}</p>
          )}
          {((x.summary.status === 'FAILED' && x.summary.exhausted && can('sap.operate')) || (stale && can('sap.finance'))) && (
            <div className={s.notice}><CheckboxField label={t('sap.confirmChecked')} checked={checked} onChange={(e) => setChecked(e.target.checked)} /></div>
          )}
          <div className={s.formActions}>
            {(['READY', 'FAILED'].includes(x.summary.status) || stale) && can('sap.finance') && (
              <Button disabled={busy || (stale && !checked)} onClick={() => void act('cancel')}>{t('sap.cancelPosting')}</Button>)}
            {x.summary.status === 'CLAIMED' && can('sap.operate') && (
              <Button variant="primary" disabled={busy} onClick={() => void act('release')}>{t('sap.release')}</Button>)}
            {x.summary.status === 'FAILED' && can('sap.operate') && (
              <Button variant="primary" disabled={busy || (!!x.summary.exhausted && !checked)} onClick={() => void act('retry')}>{t('sap.retry')}</Button>)}
          </div>
          {x.summary.status === 'FAILED' && x.requestId && can('sap.finance') && <p className="small muted">{t('sap.fixHint')}</p>}
        </>
      )}
    </Drawer>
  );
}

// ---------------- 대사 ----------------
function Recon() {
  const { t } = useTranslation();
  const runs = useAsync((sig) => api.get<Page<ReconRun>>('/integration/sap/reconciliation/runs?pageSize=20', sig), []);
  const [runId, setRunId] = useState<string>();
  const current = runId ?? runs.data?.items[0]?.id;
  if (runs.error) return <div className={s.notice} role="alert">{t('common.error', { message: runs.error.message })}</div>;
  if (!runs.loading && !runs.data?.items.length) return <EmptyState message={t('sap.noRecon')} />;
  return (
    <>
      <DataTable rows={runs.data?.items ?? []} rowId={(x) => x.id} loading={runs.loading} onRowClick={(x) => setRunId(x.id)} columns={[
        { key: 'snapshotAt', label: t('sap.col.snapshot'), render: (x) => <span>{x.id === current ? '▶ ' : ''}{formatDateTime(x.snapshotAt)}</span> },
        { key: 'runType', label: t('sap.col.runType') },
        { key: 'sapCount', label: t('sap.col.sapCount'), align: 'right' },
        { key: 'almCount', label: t('sap.col.almCount'), align: 'right' },
        { key: 'diffCount', label: t('sap.col.diffs'), align: 'right' },
        { key: 'openDiffs', label: t('sap.col.open'), align: 'right' },
      ]} />
      {current && <Diffs key={current} runId={current} onChanged={() => runs.reload()} />}
    </>
  );
}

function Diffs({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const toast = useToast();
  const [f, setF] = useState({ diffType: '', status: 'OPEN', page: 1 });
  const r = useAsync((sig) => api.get<Page<ReconDiff>>(`/integration/sap/reconciliation/runs/${runId}/diffs${qs({ ...f, pageSize: 100 })}`, sig), [runId, f.diffType, f.status, f.page]);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pick = useCallback((id: string, action: string) => setSel((x) => ({ ...x, [id]: action })), []);
  const resolve = async () => {
    const items = Object.entries(sel).filter(([, a]) => a).map(([id, action]) => ({ id, action }));
    if (!items.length) return;
    setBusy(true);
    try {
      const res = await api.post<{ results: { id: string; status: string; message?: string }[] }>('/integration/sap/reconciliation/diffs:resolve', { items });
      const bad = res.results.filter((x) => x.status === 'ERROR');
      toast.show(t('sap.resolved', { ok: res.results.length - bad.length, bad: bad.length }), bad.length ? 'error' : 'success');
      for (const b of bad.slice(0, 3)) toast.show(b.message ?? '', 'error');
      setSel({}); r.reload(); onChanged();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };
  const finance = can('sap.finance');
  const chosen = Object.values(sel).filter(Boolean).length;
  return (
    <>
      <h3>{t('sap.diffs')}</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <FilterSelect label={t('sap.col.diffType')} allLabel={t('sap.allDiffTypes')} value={f.diffType} onChange={(v) => setF({ ...f, diffType: v, page: 1 })}
          options={['SAP_ONLY', 'ALM_ONLY', 'COST_CENTER', 'LOCATION', 'SERIAL', 'TAG', 'RETIRED'].map((x) => ({ value: x, label: t(`sap.diffType.${x}`) }))} />
        <FilterSelect label={t('sap.col.status')} allLabel={t('sap.allStatus')} value={f.status === 'ALL' ? '' : f.status} onChange={(v) => setF({ ...f, status: v || 'ALL', page: 1 })}
          options={['OPEN', 'RESOLVED', 'IGNORED'].map((x) => ({ value: x, label: t(`sap.diffStatus.${x}`) }))} />
        {finance && <Button variant="primary" disabled={busy || !chosen} onClick={() => void resolve()}>{t('sap.applyActions', { n: chosen })}</Button>}
      </div>
      <DataTable rows={r.data?.items ?? []} rowId={(x) => x.id} loading={r.loading} empty={<EmptyState message={t('sap.noDiffs')} />} columns={[
        { key: 'diffType', label: t('sap.col.diffType'), render: (x) => t(`sap.diffType.${x.diffType}`) },
        { key: 'assetTag', label: t('request.col.asset'), render: (x) => (x.assetId ? <Link to={`/assets/${x.assetId}`} className="mono">{x.assetTag}</Link> : '—') },
        { key: 'sapAssetNo', label: t('sap.col.sapAsset'), render: (x) => <span className="mono">{x.sapAssetNo?.replace(/^0+/, '') ?? '—'}</span> },
        { key: 'almValue', label: t('sap.col.almValue'), render: (x) => <span className="mono">{x.almValue ?? '—'}</span> },
        { key: 'sapValue', label: t('sap.col.sapValue'), render: (x) => <span className="mono">{x.sapValue ?? '—'}</span> },
        { key: 'suggestedAction', label: t('sap.col.action'), render: (x) => (x.status === 'OPEN' && finance ? (
          <select aria-label={`${t('sap.col.action')} ${x.assetTag ?? x.sapAssetNo ?? ''}`} value={sel[x.id] ?? ''} onChange={(e) => pick(x.id, e.target.value)}>
            <option value="">{t('sap.suggested', { action: t(`sap.action.${x.suggestedAction}`) })}</option>
            {x.allowedActions.map((a) => <option key={a} value={a}>{t(`sap.action.${a}`)}</option>)}
          </select>
        ) : `${t(`sap.diffStatus.${x.status}`)}${x.status !== 'OPEN' ? ` · ${t(`sap.action.${x.suggestedAction}`)}` : ` · ${t(`sap.action.${x.suggestedAction}`)}`}`) },
      ]} footer={<Pager page={f.page} total={r.data?.total ?? 0} onPage={(p) => setF({ ...f, page: p })} />} />
    </>
  );
}

// ---------------- 매핑·연결 ----------------
function Config() {
  const { t } = useTranslation();
  const { can } = useSession();
  const m = useAsync((sig) => api.get<{ items: { id: string; almField: string; sapTable?: string; sapField?: string; masterSystem: string; interfaceIds?: string; description?: string }[] }>(
    '/integration/sap/field-mappings', sig), []);
  const cn = useAsync((sig) => (can('sap.config') ? api.get<{ items: { id: string; systemId: string; companyCode: string; oauthClientId: string; lastCallAt?: string;
    isActive: boolean; companySapEnabled: boolean; allowedCidrs: string[] }[] }>('/integration/sap/connections', sig) : Promise.resolve({ items: [] })), []);
  return (
    <>
      {can('sap.config') && (
        <>
          <h3 style={{ marginTop: 0 }}>{t('sap.connections')}</h3>
          <DataTable rows={cn.data?.items ?? []} rowId={(x) => x.id} loading={cn.loading} empty={<EmptyState message={t('sap.noConnection')} />} columns={[
            { key: 'systemId', label: t('sap.col.system'), render: (x) => <span className="mono">{x.systemId}</span> },
            { key: 'companyCode', label: t('company.code') },
            { key: 'oauthClientId', label: t('sap.col.clientId'), render: (x) => <span className="mono small">{x.oauthClientId}</span> },
            { key: 'allowedCidrs', label: t('sap.col.cidrs'), render: (x) => <span className="mono small">{x.allowedCidrs.join(', ') || '—'}</span> },
            { key: 'lastCallAt', label: t('sap.kpi.lastCall'), render: (x) => formatDateTime(x.lastCallAt) },
            { key: 'isActive', label: t('fin.active'), render: (x) => (x.isActive && x.companySapEnabled ? t('common.yes') : t('sap.inactiveConn')) },
          ]} />
          <p className="small muted">{t('sap.connectionHint')}</p>
        </>
      )}
      <h3>{t('sap.mappings')}</h3>
      <DataTable rows={m.data?.items ?? []} rowId={(x) => x.id} loading={m.loading} empty={<EmptyState message={t('common.noResults')} />} columns={[
        { key: 'almField', label: t('sap.col.almField'), render: (x) => <span className="mono small">{x.almField}</span> },
        { key: 'sapField', label: t('sap.col.sapField'), render: (x) => <span className="mono small">{[x.sapTable, x.sapField].filter(Boolean).join('-')}</span> },
        { key: 'masterSystem', label: t('sap.col.master'), render: (x) => <StatusPill tone={x.masterSystem === 'SAP' ? 'info' : 'accent'}>{x.masterSystem}</StatusPill> },
        { key: 'interfaceIds', label: 'IF', render: (x) => <span className="mono small">{x.interfaceIds}</span> },
        { key: 'description', label: t('sap.col.description') },
      ]} />
    </>
  );
}
