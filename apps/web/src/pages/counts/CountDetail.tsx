// ALM-240 실사 캠페인 상세(WBS 4.4): 단계 진행·룸 담당 배정·진행 현황·실사 대상·차이 처리·미등록 처리·결과 전기·종료
//   SCOPING(룸 담당 배정) → COUNTING(PDA 스캔) → REVIEW(차이 처리) → POSTING(SAP 실사일 전기) → CLOSED
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, DataTable, Drawer, EmptyState, FilterBar, FilterSelect, FormGrid, KeyValue, KpiTile, Panel, ProgressBar, SelectField, StatusPill, Steps, Tabs, TextField,
  useConfirm, useToast, type Column } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Lookups, Page } from '../assets/types';
import { allowedActions, campaignTone, FLOW, resultTone, type BulkResult, type CampaignDetail, type CountItemRow, type RoomProgress, type UnregisteredRow,
  type VarianceAction } from './types';
import s from '../assets/assets.module.css';
import c from './counts.module.css';

type Tab = 'rooms' | 'items' | 'variances' | 'unregistered';
const PAGE = 100;
const taskTone = { NOT_STARTED: 'neutral', IN_PROGRESS: 'accent', COMPLETED: 'ok' } as const;

export function CountDetail() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  const manage = can('count.manage');
  const d = useAsync((sig) => api.get<CampaignDetail>(`/count-campaigns/${id}`, sig), [id]);
  const [tab, setTab] = useState<Tab>();
  const [busy, setBusy] = useState(false);
  const x = d.data;
  if (d.error) return <div className={s.notice} role="alert">{t('common.error', { message: d.error.message })}</div>;
  if (!x) return <EmptyState message={t('common.loading')} />;
  const review = ['REVIEW', 'POSTING', 'CLOSED'].includes(x.status);
  const current: Tab = tab ?? (x.status === 'REVIEW' ? 'variances' : 'rooms');
  const p = x.progress;

  const run = async (op: string, opts: { title: string; message: string; done: string; danger?: boolean }) => {
    if (!(await confirm({ title: opts.title, message: opts.message, danger: opts.danger, confirmLabel: opts.title }))) return;
    setBusy(true);
    try {
      await api.post(`/count-campaigns/${id}:${op}`);
      toast.show(opts.done, 'success');
      d.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const unassigned = p.rooms.filter((r) => !r.assigneeName).length;
  const actions = (
    <div className={c.actions}>
      {manage && x.status === 'SCOPING' && (
        <Button variant="primary" disabled={busy} onClick={() => void run('start', { title: t('count.act.start'), message: t('count.act.startMsg'), done: t('count.act.started') })}>
          {t('count.act.start')}</Button>
      )}
      {manage && x.status === 'COUNTING' && (
        <Button variant="primary" disabled={busy} onClick={() => void run('close-counting', { title: t('count.act.closeCounting'), message: t('count.act.closeCountingMsg', { pending: p.pending }),
          done: t('count.act.countingClosed') })}>{t('count.act.closeCounting')}</Button>
      )}
      {can('count.post') && x.status === 'REVIEW' && (
        <Button variant="primary" disabled={busy} onClick={() => void run('post-results', { title: t('count.act.post'), message: t(x.sapEnabled ? 'count.act.postMsgSap' : 'count.act.postMsg'),
          done: t('count.act.posted') })}>{t('count.act.post')}</Button>
      )}
      {manage && x.status === 'POSTING' && (
        <Button variant="primary" disabled={busy} onClick={() => void run('close', { title: t('count.act.close'), message: t('count.act.closeMsg'), done: t('count.act.closed') })}>
          {t('count.act.close')}</Button>
      )}
      {manage && ['SCOPING', 'COUNTING'].includes(x.status) && (
        <Button disabled={busy} onClick={() => void run('cancel', { title: t('count.act.cancel'), message: t('count.act.cancelMsg'), done: t('count.act.cancelled'), danger: true })}>
          {t('count.act.cancel')}</Button>
      )}
    </div>
  );
  const postings = Object.entries(x.postings);
  return (
    <>
      <ViewHeader crumb="ALM-240" title={`${x.campaign.campaignCode} · ${x.campaign.name}`} actions={actions}
        description={<span>
          <StatusPill tone={campaignTone[x.status]}>{t(`count.status.${x.status}`)}</StatusPill>{' '}
          {t('count.detail.dates', { company: x.companyCode, key: formatDate(x.campaign.keyDate), due: formatDate(x.campaign.dueDate) })}
          {' · '}<button type="button" className="link" onClick={() => nav('/counts')}>{t('count.detail.back')}</button>
        </span>} />
      {x.status !== 'CANCELLED' && <Panel><Steps label={t('count.detail.steps')} steps={FLOW.map((f) => t(`count.status.${f}`))} current={FLOW.indexOf(x.status)} /></Panel>}
      {x.status === 'SCOPING' && unassigned > 0 && <div className={s.notice} role="status">{t('count.detail.unassigned', { n: unassigned })}</div>}
      {x.status === 'POSTING' && postings.length > 0 && (
        <div className={s.notice} role="status">{t('count.detail.postings')} {postings.map(([k, n]) => `${k} ${n}`).join(' · ')}</div>
      )}
      <div className={c.kpis}>
        <KpiTile label={t('count.kpi.total')} value={p.total} />
        <KpiTile label={t('count.kpi.found')} value={p.found} hint={p.total ? <ProgressBar label={t('count.kpi.found')} value={p.found + p.misplaced} max={p.total} /> : undefined} />
        <KpiTile label={t('count.kpi.misplaced')} value={p.misplaced} tone={p.misplaced ? 'warn' : 'default'} />
        <KpiTile label={t(review ? 'count.kpi.notFound' : 'count.kpi.pending')} value={review ? p.notFound : p.pending} tone={review && p.notFound ? 'bad' : 'default'} />
        <KpiTile label={t('count.kpi.unregistered')} value={p.unregistered} tone={p.unregistered ? 'warn' : 'default'} />
      </div>
      <Panel padded={false}>
        <Tabs<Tab> label={t('nav.inventoryCount')} value={current} onChange={setTab} items={[
          { value: 'rooms', label: t('count.tab.rooms') }, { value: 'items', label: t('count.tab.items') },
          ...(review ? [{ value: 'variances' as const, label: t('count.tab.variances') }] : []),
          { value: 'unregistered', label: t('count.tab.unregistered', { n: p.unregistered }) },
        ]} />
        {current === 'rooms' && <Rooms campaign={x} canAssign={manage && ['SCOPING', 'COUNTING', 'REVIEW'].includes(x.status)} onChanged={d.reload} />}
        {current === 'items' && <Items id={id} />}
        {current === 'variances' && <Variances id={id} editable={manage && x.status === 'REVIEW'} onChanged={d.reload} />}
        {current === 'unregistered' && <Unregistered campaign={x} editable={manage && ['COUNTING', 'REVIEW'].includes(x.status)} onChanged={d.reload} />}
      </Panel>
    </>
  );
}

// 룸 작업: SCOPING이면 범위 룸을 맞춰 보여 준다(서버). 담당자는 COUNTER 역할 사용자만
function Rooms({ campaign, canAssign, onChanged }: { campaign: CampaignDetail; canAssign: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const r = useAsync((sig) => api.get<CampaignDetail['progress']>(`/count-campaigns/${campaign.id}/tasks`, sig), [campaign.id, campaign.version]);
  const users = useAsync((sig) => (canAssign ? api.get<Lookups>('/lookups?types=users&role=COUNTER', sig) : Promise.resolve({} as Lookups)), [canAssign]);
  const [rooms, setRooms] = useState<RoomProgress[]>();
  const rows = rooms ?? r.data?.rooms ?? [];
  const counters = users.data?.users ?? [];
  const assign = async (x: RoomProgress, assigneeId: string) => {
    if (!assigneeId) return;
    try {
      const u = await api.patch<RoomProgress>(`/count-tasks/${x.taskId}`, { assigneeId });
      setRooms(rows.map((y) => (y.taskId === x.taskId ? u : y)));
      toast.show(t('count.rooms.assigned', { room: x.roomCode, name: u.assigneeName ?? '' }), 'success');
      onChanged();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const columns: Column<RoomProgress>[] = [
    { key: 'roomCode', label: t('count.rooms.room'), render: (x) => <span className="mono">{x.roomCode}</span> },
    { key: 'assigneeName', label: t('count.rooms.assignee'), render: (x) => (canAssign ? (
      <select className={c.assign} aria-label={t('count.rooms.assignFor', { room: x.roomCode })} value={counters.find((u) => u.label === x.assigneeName)?.id ?? ''}
        onChange={(e) => void assign(x, e.target.value)}>
        <option value="">{x.assigneeName ?? t('count.rooms.unassigned')}</option>
        {counters.map((u) => <option key={u.id} value={u.id}>{u.label} · {u.code}</option>)}
      </select>
    ) : x.assigneeName ?? <StatusPill tone="warn">{t('count.rooms.unassigned')}</StatusPill>) },
    { key: 'status', label: t('count.col.status'), render: (x) => <StatusPill tone={taskTone[x.status]}>{t(`count.task.${x.status}`)}</StatusPill> },
    { key: 'expected', label: t('count.rooms.expected'), align: 'right' },
    { key: 'found', label: t('count.rooms.counted'), render: (x) => <ProgressBar label={x.roomCode} value={x.found} max={x.expected || 1} /> },
    { key: 'pending', label: t('count.rooms.pending'), align: 'right' },
  ];
  if (r.error) return <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div>;
  return (
    <>
      {canAssign && !r.loading && !counters.length && <div className={s.notice}>{t('count.rooms.noCounters')}</div>}
      <DataTable rows={rows} columns={columns} rowId={(x) => x.taskId} loading={r.loading} empty={<EmptyState message={t('count.rooms.empty')} />} />
    </>
  );
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / PAGE));
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

function useItemColumns(): Column<CountItemRow>[] {
  const { t } = useTranslation();
  const nav = useNavigate();
  return useMemo(() => [
    { key: 'assetTag', label: t('count.items.tag'), render: (x) => <button type="button" className="link mono" onClick={(e) => { e.stopPropagation(); nav(`/assets/${x.assetId}`); }}>{x.assetTag}</button> },
    { key: 'description', label: t('count.items.description') },
    { key: 'expectedRoomCode', label: t('count.items.expected'), render: (x) => <span className="mono">{x.expectedRoomCode}</span> },
    { key: 'foundRoomCode', label: t('count.items.found'), render: (x) => (x.foundRoomCode ? <span className="mono">{x.foundRoomCode}</span> : '—') },
    { key: 'result', label: t('count.items.result'), render: (x) => (
      <>
        <StatusPill tone={resultTone[x.result]}>{t(`count.result.${x.result}`)}</StatusPill>
        {x.condition === 'DAMAGED' && <> <StatusPill tone="bad">{t('count.condition.DAMAGED')}</StatusPill></>}
        {x.needsRelabel && <> <StatusPill tone="info">{t('count.items.relabel')}</StatusPill></>}
      </>) },
    { key: 'countedAt', label: t('count.items.counted'), render: (x) => (x.countedAt ? `${formatDateTime(x.countedAt)}${x.countedByName ? ` · ${x.countedByName}` : ''}` : '—') },
    { key: 'photoCount', label: t('count.items.photos'), align: 'right' },
    { key: 'varianceAction', label: t('count.items.action'), render: (x) => (x.varianceAction
      ? <>{t(`count.action.${x.varianceAction}`)}{x.requestNo ? <span className="mono faint"> · {x.requestNo}</span> : null}</> : '—') },
  ], [t, nav]);
}

function Items({ id }: { id: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [result, setResult] = useState('');
  const [page, setPage] = useState(1);
  const r = useAsync((sig) => api.get<Page<CountItemRow>>(`/count-campaigns/${id}/items${qs({ q, result, page, pageSize: PAGE })}`, sig), [id, q, result, page]);
  const columns = useItemColumns();
  return (
    <>
      <FilterBar search={q} onSearch={(v) => { setQ(v); setPage(1); }} searchPlaceholder={t('count.items.search')}
        onClear={q || result ? () => { setQ(''); setResult(''); setPage(1); } : undefined}>
        <FilterSelect label={t('count.items.result')} allLabel={t('count.items.allResults')} value={result} onChange={(v) => { setResult(v); setPage(1); }}
          options={(['PENDING', 'FOUND', 'MISPLACED', 'NOT_FOUND'] as const).map((v) => ({ value: v, label: t(`count.result.${v}`) }))} />
      </FilterBar>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={r.loading}
          empty={<EmptyState message={t('common.noResults')} />} footer={<Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />} />
      )}
    </>
  );
}

// 차이 처리: 고른 행에 같은 동작. 행마다 쓸 수 있는 동작이 다르면 서버가 그 행만 오류로 돌려준다(207)
function Variances({ id, editable, onChanged }: { id: string; editable: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [unresolved, setUnresolved] = useState('true');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string[]>([]);
  const [action, setAction] = useState<VarianceAction | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const r = useAsync((sig) => api.get<Page<CountItemRow>>(`/count-campaigns/${id}/items${qs({ variance: 'true', unresolved, q, page, pageSize: PAGE })}`, sig), [id, unresolved, q, page]);
  const rows = r.data?.items ?? [];
  const columns = useItemColumns();
  const chosen = rows.filter((x) => sel.includes(x.id));
  // 고른 행 모두에 쓸 수 있는 동작만
  const common = chosen.length ? allowedActions(chosen[0]).filter((a) => chosen.every((x) => allowedActions(x).includes(a))) : [];
  const apply = async () => {
    if (!action || !chosen.length) return;
    setBusy(true);
    try {
      const res = await api.post<BulkResult>('/count-items:resolve', { items: chosen.map((x) => ({ id: x.id, action, note: note.trim() || undefined })) });
      const bad = res.results.filter((x) => x.status === 'ERROR');
      if (bad.length) toast.show(t('count.var.partial', { ok: res.results.length - bad.length, bad: bad.length, message: bad[0].message ?? '' }), 'error');
      else toast.show(t('count.var.done', { n: res.results.length }), 'success');
      setSel([]); setAction(''); setNote('');
      r.reload(); onChanged();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <FilterBar search={q} onSearch={(v) => { setQ(v); setPage(1); setSel([]); }} searchPlaceholder={t('count.items.search')}>
        <FilterSelect label={t('count.var.show')} allLabel={t('count.var.all')} value={unresolved} onChange={(v) => { setUnresolved(v); setPage(1); setSel([]); }}
          options={[{ value: 'true', label: t('count.var.unresolved') }]} />
      </FilterBar>
      {editable && (
        <div className={c.bulk} aria-label={t('count.var.bulk')}>
          <span className="small">{t('count.var.selected', { n: chosen.length })}</span>
          <SelectField label={t('count.items.action')} full={false} value={action} disabled={!chosen.length} onChange={(e) => setAction(e.target.value as VarianceAction)}
            options={[{ value: '', label: '—' }, ...common.map((a) => ({ value: a, label: t(`count.action.${a}`) }))]} />
          <TextField label={t('count.var.note')} full={false} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" disabled={busy || !action || !chosen.length} onClick={() => void apply()}>{t('count.var.apply')}</Button>
        </div>
      )}
      {editable && <p className="small faint" style={{ padding: '0 12px' }}>{t('count.var.help')}</p>}
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={rows} columns={columns} rowId={(x) => x.id} loading={r.loading} selected={editable ? sel : undefined}
          onSelectedChange={editable ? (ids) => setSel(ids.filter((i) => rows.some((x) => x.id === i && !x.varianceAction))) : undefined}
          empty={<EmptyState message={t('count.var.empty')} />} footer={<Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />} />
      )}
    </>
  );
}

function Unregistered({ campaign, editable, onChanged }: { campaign: CampaignDetail; editable: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<UnregisteredRow>();
  const r = useAsync((sig) => api.get<Page<UnregisteredRow>>(`/count-campaigns/${campaign.id}/unregistered${qs({ page, pageSize: PAGE })}`, sig), [campaign.id, page, campaign.version]);
  const columns: Column<UnregisteredRow>[] = [
    { key: 'tempNo', label: t('count.unreg.tempNo'), render: (x) => <span className="mono">{x.tempNo}</span> },
    { key: 'description', label: t('count.items.description') },
    { key: 'categoryName', label: t('count.unreg.category'), render: (x) => x.categoryName ?? '—' },
    { key: 'serialNo', label: t('count.unreg.serial'), render: (x) => (x.serialNo ? <span className="mono">{x.serialNo}</span> : '—') },
    { key: 'roomCode', label: t('count.rooms.room'), render: (x) => <span className="mono">{x.roomCode}</span> },
    { key: 'reportedByName', label: t('count.unreg.reportedBy'), render: (x) => `${x.reportedByName} · ${formatDateTime(x.reportedAt)}` },
    { key: 'photoCount', label: t('count.items.photos'), align: 'right' },
    { key: 'resolution', label: t('count.items.action'), render: (x) => (x.resolution
      ? <>{t(`count.unreg.${x.resolution}`)}{x.createdAssetTag ? <span className="mono faint"> · {x.createdAssetTag}</span> : null}</>
      : <StatusPill tone="warn">{t('count.unreg.open')}</StatusPill>) },
  ];
  return (
    <>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={r.loading}
          onRowClick={editable ? (x) => { if (!x.resolution) setOpen(x); } : undefined}
          empty={<EmptyState message={t('count.unreg.empty')} />} footer={<Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />} />
      )}
      {open && <ResolveUnregistered row={open} companyCode={campaign.companyCode} onClose={() => setOpen(undefined)} onDone={() => { setOpen(undefined); r.reload(); onChanged(); }} />}
    </>
  );
}

// 미등록 처리: 자산으로 등록(모델·코스트센터 필요 — POST /assets 규칙) 또는 자산 아님
function ResolveUnregistered({ row, companyCode, onClose, onDone }: { row: UnregisteredRow; companyCode: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=categories,models,costCenters', sig), []);
  const [f, setF] = useState({ categoryId: row.categoryId ?? '', modelId: '', costCenterId: '', description: row.description.slice(0, 50), note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const models = (lk.data?.models ?? []).filter((m) => !f.categoryId || m.parentId === f.categoryId);
  const ccs = (lk.data?.costCenters ?? []).filter((x) => x.extra?.companyCode === undefined || x.extra.companyCode === companyCode);
  const send = async (action: 'REGISTER' | 'NON_ASSET') => {
    if (action === 'REGISTER') {
      const e: Record<string, string> = {};
      for (const k of ['categoryId', 'modelId', 'costCenterId', 'description'] as const) if (!f[k]) e[k] = t('common.required');
      setErrors(e);
      if (Object.keys(e).length) return;
    }
    setBusy(true);
    try {
      await api.post(`/count-unregistered/${row.id}:resolve`, { action, note: f.note.trim() || undefined,
        ...(action === 'REGISTER' ? { asset: { categoryId: f.categoryId, modelId: f.modelId, costCenterId: f.costCenterId, description: f.description.trim() } } : {}) });
      toast.show(t(action === 'REGISTER' ? 'count.unreg.registered' : 'count.unreg.dismissed', { no: row.tempNo }), 'success');
      onDone();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const title = `${row.tempNo} · ${row.description}`;
  return (
    <Drawer open onClose={onClose} label={title} title={title}>
      <KeyValue items={[
        { label: t('count.rooms.room'), value: row.roomCode },
        { label: t('count.unreg.serial'), value: row.serialNo },
        { label: t('count.unreg.barcode'), value: row.scannedBarcode },
        { label: t('count.unreg.reportedBy'), value: `${row.reportedByName} · ${formatDateTime(row.reportedAt)}` },
        { label: t('count.items.photos'), value: String(row.photoCount) },
      ]} />
      <h3>{t('count.unreg.registerTitle')}</h3>
      <FormGrid onSubmit={() => void send('REGISTER')}>
        <TextField label={t('count.items.description')} required maxLength={50} value={f.description} error={errors.description} onChange={set('description')} />
        <SelectField label={t('count.unreg.category')} required value={f.categoryId} error={errors.categoryId} onChange={(e) => setF((v) => ({ ...v, categoryId: e.target.value, modelId: '' }))}
          options={[{ value: '', label: '—' }, ...(lk.data?.categories ?? []).map((x) => ({ value: x.id, label: x.label }))]} />
        <SelectField label={t('count.unreg.model')} required value={f.modelId} error={errors.modelId} onChange={set('modelId')}
          options={[{ value: '', label: '—' }, ...models.map((x) => ({ value: x.id, label: x.label }))]} />
        <SelectField label={t('count.unreg.costCenter')} required value={f.costCenterId} error={errors.costCenterId} onChange={set('costCenterId')}
          options={[{ value: '', label: '—' }, ...ccs.map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))]} />
        <TextField label={t('count.var.note')} maxLength={200} value={f.note} onChange={set('note')} />
        <div className={s.formActions}>
          <Button disabled={busy} onClick={() => void send('NON_ASSET')}>{t('count.unreg.NON_ASSET')}</Button>
          <Button variant="primary" type="submit" disabled={busy}>{t('count.unreg.REGISTER')}</Button>
        </div>
      </FormGrid>
    </Drawer>
  );
}
