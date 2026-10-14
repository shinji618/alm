// ALM-111 자산 상세: 일반(수정) · 금액·SAP · 이력 · 할당 · 첨부, 할당·반납·수리
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import {
  AssetTag, Button, DataTable, Drawer, EmptyState, FormGrid, KeyValue, Panel, SelectField, StatusPill, Tabs, TextField, TextareaField, Timeline, useToast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatDateTime, formatUsd, type Lang } from '@/lib/format';
import { stageCodeColorVar, statusCodeTone } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { AssetDetail as Detail, ChangeResult, Lookups, LookupItem } from './types';
import { RequestDrawer } from '../requests/RequestDrawer';
import s from './assets.module.css';

type Tab = 'general' | 'financial' | 'history' | 'assignments' | 'attachments';
type Action = 'edit' | 'checkOut' | 'checkIn' | 'repairIn' | 'repairOut' | 'request' | undefined;

export function AssetDetail() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('general');
  const [action, setAction] = useState<Action>();
  const a = useAsync((sig) => api.get<Detail>(`/assets/${id}`, sig), [id]);
  const lk = useAsync((sig) => api.get<Lookups>('/lookups?types=sites,rooms,costCenters,assetClasses,categories,models,users,vendors', sig), []);
  const L = lk.data ?? {};
  const name = (xs: LookupItem[] | undefined, v?: string) => { const x = xs?.find((i) => i.id === v); return x ? `${x.code} · ${x.label}` : v ? '…' : undefined; };

  const done = (r: ChangeResult, msg: string) => {
    a.setData(r.asset);
    setAction(undefined);
    toast.show(msg, 'success');
    for (const q of r.createdRequests) toast.show(t('asset.detail.createdRequests', { no: q.requestNo }), 'info');
  };

  if (a.error) {
    const notFound = a.error instanceof ApiError && a.error.status === 404;
    return (
      <>
        <ViewHeader crumb={t('asset.detail.crumb')} title={t('nav.assets')} />
        <Panel><EmptyState message={notFound ? t('asset.detail.notFound') : t('common.error', { message: a.error.message })} /></Panel>
      </>
    );
  }
  const d = a.data;
  const assign = can('asset.assign');
  const editable = (d?.editableFields.length ?? 0) > 0;
  const requestable = !!d && can('request.create') && !['RETIRED', 'DISPOSED'].includes(d.status) && d.openRequests.length === 0;

  return (
    <>
      <ViewHeader crumb={`${t('asset.detail.crumb')} · ${t('nav.assets')}`} title={d ? d.description : t('common.loading')}
        description={d && (
          <span className={s.headRow}>
            <AssetTag tag={d.assetTag} />
            <StatusPill tone={statusCodeTone[d.status]}>{t(`asset.status.${d.status}`)}</StatusPill>
            <span><span className={s.stageDot} style={{ background: stageCodeColorVar[d.stage] }} />{t(`asset.stage.${d.stage}`)}</span>
            {d.financial.sapEnabled !== false && d.financial.sapAssetNo && <span className="mono small">SAP {d.financial.companyCode}/{d.financial.sapAssetNo.replace(/^0+/, '')}-{d.financial.sapSubNo}</span>}
          </span>
        )}
        actions={d && (
          <>
            <Button onClick={() => nav('/assets')}>{t('nav.assets')}</Button>
            {editable && <Button onClick={() => setAction('edit')}>{t('common.edit')}</Button>}
            {assign && ['IN_STOCK', 'IN_USE'].includes(d.status) && <Button variant="primary" onClick={() => setAction('checkOut')}>{t('asset.detail.checkOut')}</Button>}
            {assign && d.status === 'IN_USE' && <Button onClick={() => setAction('checkIn')}>{t('asset.detail.checkIn')}</Button>}
            {assign && ['IN_STOCK', 'IN_USE'].includes(d.status) && <Button onClick={() => setAction('repairIn')}>{t('asset.detail.repairIn')}</Button>}
            {assign && d.status === 'IN_REPAIR' && <Button onClick={() => setAction('repairOut')}>{t('asset.detail.repairOut')}</Button>}
            {requestable && <Button onClick={() => setAction('request')}>{t('asset.detail.newRequest')}</Button>}
          </>
        )} />
      {d && d.openRequests.length > 0 && (
        <div className={s.notice}>
          {t('asset.detail.openRequests')}: {d.openRequests.map((r, i) => (
            <span key={r.id}>{i > 0 && ', '}<Link to={`/requests/${r.id}`} className="mono">{r.requestNo}</Link> ({t(`request.type.${r.requestType}`)} · {t(`request.status.${r.status}`)})</span>
          ))}
        </div>
      )}
      <Panel padded={false}>
        <Tabs<Tab> label={t('asset.detail.crumb')} value={tab} onChange={setTab} items={(['general', 'financial', 'history', 'assignments', 'attachments'] as const)
          .map((v) => ({ value: v, label: t(`asset.detail.tabs.${v}`) }))} />
        <div style={{ padding: 16 }}>
          {!d ? <span className="muted">{t('common.loading')}</span>
            : tab === 'general' ? <General d={d} L={L} lang={lang} name={name} />
            : tab === 'financial' ? <><Financial d={d} lang={lang} /><h3>{t('asset.po.title')}</h3><Purchase d={d} lang={lang} /></>
            : tab === 'history' ? <History id={id} lang={lang} />
            : tab === 'assignments' ? <Assignments id={id} lang={lang} />
            : <Attachments id={id} />}
        </div>
      </Panel>

      {d && action === 'edit' && <EditDrawer d={d} L={L} onClose={() => setAction(undefined)} onDone={(r) => done(r, t('asset.detail.saved'))}
        onConflict={() => { setAction(undefined); a.reload(); toast.show(t('asset.detail.conflict'), 'error'); }} />}
      {d && action === 'request' && <RequestDrawer d={d} L={L} onClose={() => setAction(undefined)} onDone={(id) => nav(`/requests/${id}`)} />}
      {d && action === 'checkOut' && <CheckOutDrawer d={d} L={L} onClose={() => setAction(undefined)} onDone={(r) => done(r, t('asset.detail.checkOut'))} />}
      {d && action === 'checkIn' && <CheckInDrawer d={d} L={L} onClose={() => setAction(undefined)} onDone={(r) => done(r, t('asset.detail.checkIn'))} />}
      {d && (action === 'repairIn' || action === 'repairOut') && <RepairDrawer d={d} L={L} dir={action === 'repairIn' ? 'IN' : 'OUT'}
        onClose={() => setAction(undefined)} onDone={(r) => done(r, t(action === 'repairIn' ? 'asset.detail.repairIn' : 'asset.detail.repairOut'))} />}
    </>
  );
}

function General({ d, L, lang, name }: { d: Detail; L: Lookups; lang: Lang; name: (xs: LookupItem[] | undefined, v?: string) => string | undefined }) {
  const { t } = useTranslation();
  const user = L.users?.find((u) => u.id === d.assignedUserId);
  return (
    <KeyValue items={[
      { label: t('asset.field.category'), value: name(L.categories, d.categoryId) },
      { label: t('asset.field.model'), value: name(L.models, d.modelId)?.replace(/^[^·]*· /, '') },
      { label: t('asset.field.serialNo'), value: d.serialNo && <span className="mono">{d.serialNo}</span> },
      { label: t('asset.field.source'), value: d.source },
      { label: t('asset.field.site'), value: name(L.sites, d.siteId) },
      { label: t('asset.field.room'), value: name(L.rooms, d.roomId) },
      { label: t('asset.field.costCenter'), value: name(L.costCenters, d.costCenterId) },
      { label: t('asset.field.assignedUser'), value: user ? user.label : d.assignedUserId ? '…' : undefined },
      { label: t('asset.field.assignedAt'), value: d.assignedAt && formatDateTime(d.assignedAt) },
      { label: t('asset.field.dueBackDate'), value: d.dueBackDate && formatDate(d.dueBackDate, lang) },
      { label: t('asset.field.hostname'), value: d.hostname },
      { label: t('asset.field.ipAddress'), value: d.ipAddress && <span className="mono">{d.ipAddress}</span> },
      { label: t('asset.field.macAddress'), value: d.macAddress && <span className="mono">{d.macAddress}</span> },
      { label: t('asset.field.osName'), value: d.osName },
      { label: t('asset.field.warrantyEndDate'), value: d.warrantyEndDate && formatDate(d.warrantyEndDate, lang) },
      { label: t('asset.field.lastCount'), value: d.lastCountDate && formatDate(d.lastCountDate, lang) },
      { label: t('asset.field.lastSeen'), value: d.lastSeenAt && formatDateTime(d.lastSeenAt) },
      { label: t('asset.field.notes'), value: d.notes },
    ]} />
  );
}

function Financial({ d, lang }: { d: Detail; lang: Lang }) {
  const { t } = useTranslation();
  const f = d.financial;
  if (f.sapEnabled === false) {
    // SAP 연계를 끈 회사: SAP 값(자산번호·장부가액 등)은 숨기고 구매가 기준
    return (
      <>
        <div className={s.notice}>{t('asset.fin.noSapNote')}</div>
        <KeyValue items={[
          { label: t('asset.fin.companyCode'), value: f.companyCode },
          { label: t('asset.fin.assetClass'), value: f.assetClass },
          { label: t('asset.fin.usefulLife'), value: f.usefulLifeYears },
          { label: t('asset.fin.tco'), value: <span className="num">{formatUsd(f.tcoEstimate, 2)}</span> },
        ]} />
      </>
    );
  }
  return (
    <KeyValue items={[
      { label: t('asset.fin.companyCode'), value: f.companyCode },
      { label: t('asset.fin.sapAssetNo'), value: f.sapAssetNo ? <span className="mono">{f.sapAssetNo}-{f.sapSubNo}</span> : t('asset.fin.notInSap') },
      { label: t('asset.fin.isCapitalized'), value: f.isCapitalized ? t('common.yes') : t('common.no') },
      { label: t('asset.fin.assetClass'), value: f.assetClass },
      { label: t('asset.fin.capDate'), value: f.capDate && formatDate(f.capDate, lang) },
      { label: t('asset.fin.usefulLife'), value: f.usefulLifeYears },
      { label: t('asset.fin.apc'), value: <span className="num">{formatUsd(f.acquisitionValue, 2)}</span> },
      { label: t('asset.fin.accum'), value: <span className="num">{formatUsd(f.accumDepreciation, 2)}</span> },
      { label: t('asset.fin.nbv'), value: <span className="num">{formatUsd(f.netBookValue, 2)}</span> },
      { label: t('asset.fin.valueAsOf'), value: f.valueAsOf },
      { label: t('asset.fin.tco'), value: <span className="num">{formatUsd(f.tcoEstimate, 2)}</span> },
      { label: t('asset.fin.sapSyncedAt'), value: f.sapSyncedAt && formatDateTime(f.sapSyncedAt) },
    ]} />
  );
}

// 구매·입고(IF-MM-01·03): PO 항목과 이 자산의 입고 행
function Purchase({ d, lang }: { d: Detail; lang: Lang }) {
  const { t } = useTranslation();
  const p = d.purchase;
  if (!p) return <span className="muted">{t('asset.po.none')}</span>;
  const g = p.goodsReceipt;
  return (
    <KeyValue items={[
      { label: t('asset.po.po'), value: <span className="mono">{p.poNo}/{p.poItem}</span> },
      { label: t('asset.po.vendor'), value: p.vendorName },
      { label: t('asset.po.text'), value: p.description },
      { label: t('asset.po.qty'), value: `${p.grQuantity} / ${p.quantity}` },
      { label: t('asset.po.unitPrice'), value: <span className="num">{formatUsd(p.unitPrice, 2)}</span> },
      { label: t('asset.po.gr'), value: g ? <span className="mono">{g.materialDoc}/{g.docYear}/{g.docItem} · {g.movementType}</span> : t('asset.po.notReceived') },
      { label: t('asset.po.grDate'), value: g && formatDate(g.postingDate, lang) },
      { label: t('asset.po.flags'), value: [p.isDeleted && t('asset.po.deleted'), p.isGrCancelled && t('asset.po.grCancelled')].filter(Boolean).join(', ') || undefined },
    ]} />
  );
}

interface EventItem { id: string; eventType: string; occurredAt: string; actorName?: string; channel: string; changes?: Record<string, unknown>; reason?: string; requestNo?: string; sapDocumentNo?: string }
function History({ id }: { id: string; lang: Lang }) {
  const { t } = useTranslation();
  const h = useAsync((sig) => api.get<{ items: EventItem[] }>(`/assets/${id}/history?pageSize=100`, sig), [id]);
  if (h.loading) return <span className="muted">{t('common.loading')}</span>;
  if (h.error) return <span role="alert">{t('common.error', { message: h.error.message })}</span>;
  if (!h.data?.items.length) return <EmptyState message={t('asset.detail.noHistory')} />;
  const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <Timeline label={t('asset.detail.tabs.history')} events={h.data.items.map((e) => ({
      id: e.id,
      meta: <>{formatDateTime(e.occurredAt)} · {e.actorName ?? t('asset.detail.system')} · {e.channel}</>,
      body: (
        <div>
          <strong>{e.eventType}</strong>{e.requestNo && <span className="small muted"> · {e.requestNo}</span>}{e.sapDocumentNo && <span className="small muted"> · SAP {e.sapDocumentNo}</span>}
          {e.reason && <div className="small">{e.reason}</div>}
          {e.changes && (
            <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {Object.entries(e.changes).map(([k, v]) => (
                <li key={k}>{k}: {v && typeof v === 'object' && 'after' in (v as object) ? `${fmt((v as { before: unknown }).before)} → ${fmt((v as { after: unknown }).after)}` : fmt(v)}</li>
              ))}
            </ul>
          )}
        </div>
      ),
    }))} />
  );
}

interface AssignmentRow { userName?: string; costCenterCode?: string; roomCode?: string; checkedOutAt: string; dueBackDate?: string; returnedAt?: string }
function Assignments({ id, lang }: { id: string; lang: Lang }) {
  const { t } = useTranslation();
  const r = useAsync((sig) => api.get<{ items: AssignmentRow[] }>(`/assets/${id}/assignments`, sig), [id]);
  return (
    <DataTable rows={r.data?.items ?? []} loading={r.loading} rowId={(x) => x.checkedOutAt} empty={<EmptyState message={t('asset.detail.noAssignments')} />}
      columns={[
        { key: 'userName', label: t('asset.assignmentCol.user') },
        { key: 'costCenterCode', label: t('asset.assignmentCol.costCenter') },
        { key: 'roomCode', label: t('asset.assignmentCol.room') },
        { key: 'checkedOutAt', label: t('asset.assignmentCol.out'), render: (x) => formatDateTime(x.checkedOutAt) },
        { key: 'dueBackDate', label: t('asset.assignmentCol.due'), render: (x) => formatDate(x.dueBackDate, lang) },
        { key: 'returnedAt', label: t('asset.assignmentCol.returned'), render: (x) => formatDateTime(x.returnedAt) },
      ]} />
  );
}

interface Attachment { id: string; fileName: string; contentType: string; sizeBytes: number; kind: string; uploadedBy: string; createdAt: string }
function Attachments({ id }: { id: string }) {
  const { t } = useTranslation();
  const r = useAsync((sig) => api.get<{ items: Attachment[] }>(`/assets/${id}/attachments`, sig), [id]);
  return (
    <DataTable rows={r.data?.items ?? []} loading={r.loading} rowId={(x) => x.id} empty={<EmptyState message={t('asset.detail.noAttachments')} />}
      columns={[
        { key: 'fileName', label: t('asset.attachmentCol.name') },
        { key: 'kind', label: t('asset.attachmentCol.kind') },
        { key: 'sizeBytes', label: t('asset.attachmentCol.size'), align: 'right', render: (x) => `${Math.max(1, Math.round(x.sizeBytes / 1024))} KB` },
        { key: 'uploadedBy', label: t('asset.attachmentCol.by') },
        { key: 'createdAt', label: t('asset.attachmentCol.at'), render: (x) => formatDateTime(x.createdAt) },
      ]} />
  );
}

// ---------------- 작업 패널(Drawer) ----------------
const opts = (xs: LookupItem[] | undefined, blank = true) => [...(blank ? [{ value: '', label: '—' }] : []), ...(xs ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }))];

function useSubmit(onDone: (r: ChangeResult) => void, onConflict?: () => void) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<ChangeResult>) => {
    setSaving(true);
    try { onDone(await fn()); } catch (e) {
      if (e instanceof ApiError && e.code === 'ALM-E310' && onConflict) return onConflict();
      if (e instanceof ApiError && e.errors.length) setErrors(e.fieldErrors());
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally { setSaving(false); }
  };
  return { saving, errors, setErrors, run };
}

function Actions({ onClose, saving, label }: { onClose: () => void; saving: boolean; label: string }) {
  const { t } = useTranslation();
  return (
    <div className={s.formActions}>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" type="submit" disabled={saving}>{label}</Button>
    </div>
  );
}

function EditDrawer({ d, L, onClose, onDone, onConflict }: { d: Detail; L: Lookups; onClose: () => void; onDone: (r: ChangeResult) => void; onConflict: () => void }) {
  const { t } = useTranslation();
  const can = new Set(d.editableFields);
  const [f, setF] = useState({ description: d.description, modelId: d.modelId ?? '', serialNo: d.serialNo ?? '', roomId: d.roomId ?? '', hostname: d.hostname ?? '',
    ipAddress: d.ipAddress ?? '', macAddress: d.macAddress ?? '', warrantyEndDate: d.warrantyEndDate ?? '', dueBackDate: d.dueBackDate ?? '', notes: d.notes ?? '' });
  const sub = useSubmit(onDone, onConflict);
  const models = useMemo(() => (L.models ?? []).filter((m) => m.parentId === d.categoryId), [L.models, d.categoryId]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = () => {
    // 바뀐 필드만 보낸다(빈 문자열은 지우기 = null)
    const orig: Record<string, string> = { description: d.description, modelId: d.modelId ?? '', serialNo: d.serialNo ?? '', roomId: d.roomId ?? '', hostname: d.hostname ?? '',
      ipAddress: d.ipAddress ?? '', macAddress: d.macAddress ?? '', warrantyEndDate: d.warrantyEndDate ?? '', dueBackDate: d.dueBackDate ?? '', notes: d.notes ?? '' };
    const body = Object.fromEntries(Object.entries(f).filter(([k, v]) => can.has(k) && v !== orig[k]).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()]));
    if (!Object.keys(body).length) return onClose();
    void sub.run(() => api.patch<ChangeResult>(`/assets/${d.id}`, body, d.version));
  };
  const e = sub.errors;
  return (
    <Drawer open onClose={onClose} label={t('common.edit')} title={`${t('common.edit')} · ${d.assetTag}`}>
      <FormGrid onSubmit={submit}>
        <TextField label={t('asset.field.description')} required maxLength={50} value={f.description} error={e.description} disabled={!can.has('description')} onChange={(x) => set('description', x.target.value)} />
        <SelectField label={t('asset.field.model')} value={f.modelId} error={e.modelId} options={opts(models, false)} disabled={!can.has('modelId')} onChange={(x) => set('modelId', x.target.value)} />
        <TextField label={t('asset.field.serialNo')} maxLength={40} value={f.serialNo} error={e.serialNo} disabled={!can.has('serialNo')} onChange={(x) => set('serialNo', x.target.value)} />
        <SelectField label={t('asset.field.room')} value={f.roomId} error={e.roomId} options={opts(L.rooms, false)} disabled={!can.has('roomId')} onChange={(x) => set('roomId', x.target.value)} />
        <TextField label={t('asset.field.hostname')} maxLength={63} value={f.hostname} disabled={!can.has('hostname')} onChange={(x) => set('hostname', x.target.value)} />
        <TextField label={t('asset.field.ipAddress')} value={f.ipAddress} error={e.ipAddress} disabled={!can.has('ipAddress')} onChange={(x) => set('ipAddress', x.target.value)} />
        <TextField label={t('asset.field.macAddress')} value={f.macAddress} error={e.macAddress} disabled={!can.has('macAddress')} onChange={(x) => set('macAddress', x.target.value)} />
        <TextField label={t('asset.field.warrantyEndDate')} type="date" value={f.warrantyEndDate} disabled={!can.has('warrantyEndDate')} onChange={(x) => set('warrantyEndDate', x.target.value)} />
        {can.has('dueBackDate') && <TextField label={t('asset.field.dueBackDate')} type="date" value={f.dueBackDate} onChange={(x) => set('dueBackDate', x.target.value)} />}
        <TextareaField label={t('asset.field.notes')} value={f.notes} disabled={!can.has('notes')} onChange={(x) => set('notes', x.target.value)} />
        <Actions onClose={onClose} saving={sub.saving} label={t('common.save')} />
      </FormGrid>
    </Drawer>
  );
}

function CheckOutDrawer({ d, L, onClose, onDone }: { d: Detail; L: Lookups; onClose: () => void; onDone: (r: ChangeResult) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ userId: '', roomId: d.roomId ?? '', costCenterId: '', dueBackDate: '', note: '' });
  const sub = useSubmit(onDone);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.userId) e.userId = t('common.required');
    if (!f.roomId) e.roomId = t('common.required');
    sub.setErrors(e);
    if (Object.keys(e).length) return;
    void sub.run(() => api.post<ChangeResult>(`/assets/${d.id}:check-out`, { userId: f.userId, roomId: f.roomId, costCenterId: f.costCenterId || undefined,
      dueBackDate: f.dueBackDate || undefined, note: f.note.trim() || undefined }));
  };
  return (
    <Drawer open onClose={onClose} label={t('asset.assign.title')} title={`${t('asset.assign.title')} · ${d.assetTag}`}>
      <FormGrid onSubmit={submit}>
        <SelectField label={t('asset.assign.user')} required value={f.userId} error={sub.errors.userId} options={opts(L.users)} onChange={(x) => set('userId', x.target.value)} />
        <SelectField label={t('asset.assign.room')} required value={f.roomId} error={sub.errors.roomId} options={opts(L.rooms)} onChange={(x) => set('roomId', x.target.value)} />
        <SelectField label={t('asset.assign.costCenter')} value={f.costCenterId} error={sub.errors.costCenterId} options={opts(L.costCenters)} onChange={(x) => set('costCenterId', x.target.value)} />
        <TextField label={t('asset.assign.dueBack')} type="date" value={f.dueBackDate} onChange={(x) => set('dueBackDate', x.target.value)} />
        <TextareaField label={t('asset.assign.note')} maxLength={200} value={f.note} onChange={(x) => set('note', x.target.value)} />
        <Actions onClose={onClose} saving={sub.saving} label={t('asset.detail.checkOut')} />
      </FormGrid>
    </Drawer>
  );
}

function CheckInDrawer({ d, L, onClose, onDone }: { d: Detail; L: Lookups; onClose: () => void; onDone: (r: ChangeResult) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ roomId: '', condition: 'GOOD', note: '' });
  const sub = useSubmit(onDone);
  const rooms = (L.rooms ?? []).filter((r) => !d.siteId || r.parentId === d.siteId);
  const submit = () => void sub.run(() => api.post<ChangeResult>(`/assets/${d.id}:check-in`, { roomId: f.roomId || undefined, condition: f.condition, note: f.note.trim() || undefined }));
  return (
    <Drawer open onClose={onClose} label={t('asset.checkin.title')} title={`${t('asset.checkin.title')} · ${d.assetTag}`}>
      <FormGrid onSubmit={submit}>
        <SelectField label={t('asset.checkin.room')} value={f.roomId} options={opts(rooms)} onChange={(x) => setF((v) => ({ ...v, roomId: x.target.value }))} />
        <SelectField label={t('asset.checkin.condition')} value={f.condition} options={['GOOD', 'DAMAGED', 'UNUSED'].map((c) => ({ value: c, label: t(`asset.checkin.${c}`) }))}
          onChange={(x) => setF((v) => ({ ...v, condition: x.target.value }))} />
        <TextareaField label={t('asset.assign.note')} maxLength={200} value={f.note} onChange={(x) => setF((v) => ({ ...v, note: x.target.value }))} />
        <Actions onClose={onClose} saving={sub.saving} label={t('asset.detail.checkIn')} />
      </FormGrid>
    </Drawer>
  );
}

function RepairDrawer({ d, L, dir, onClose, onDone }: { d: Detail; L: Lookups; dir: 'IN' | 'OUT'; onClose: () => void; onDone: (r: ChangeResult) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ vendorId: '', ticketNo: '', note: '' });
  const sub = useSubmit(onDone);
  const title = t(dir === 'IN' ? 'asset.repair.titleIn' : 'asset.repair.titleOut');
  const submit = () => void sub.run(() => api.post<ChangeResult>(`/assets/${d.id}:repair`, { direction: dir, vendorId: f.vendorId || undefined,
    ticketNo: f.ticketNo.trim() || undefined, note: f.note.trim() || undefined }));
  return (
    <Drawer open onClose={onClose} label={title} title={`${title} · ${d.assetTag}`}>
      <FormGrid onSubmit={submit}>
        <SelectField label={t('asset.repair.vendor')} value={f.vendorId} options={opts(L.vendors)} onChange={(x) => setF((v) => ({ ...v, vendorId: x.target.value }))} />
        <TextField label={t('asset.repair.ticket')} maxLength={30} value={f.ticketNo} onChange={(x) => setF((v) => ({ ...v, ticketNo: x.target.value }))} />
        <TextareaField label={t('asset.assign.note')} maxLength={200} value={f.note} onChange={(x) => setF((v) => ({ ...v, note: x.target.value }))} />
        <Actions onClose={onClose} saving={sub.saving} label={title} />
      </FormGrid>
    </Drawer>
  );
}
