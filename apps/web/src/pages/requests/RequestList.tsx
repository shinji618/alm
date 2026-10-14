// ALM-230 자산 요청·승인 목록. 탭: 내 승인함(승인 권한이 있을 때) · 요청 목록(범위). 필터는 주소(쿼리 문자열)에 둔다
import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ViewHeader } from '@/components/layout';
import { Button, DataTable, EmptyState, FilterBar, FilterSelect, Panel, StatusPill, Tabs, type Column } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { formatDateTime, formatUsd } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { Page } from '../assets/types';
import { REQUEST_STATUSES, REQUEST_TYPES, statusTone, type InboxRow, type RequestSummary } from './types';
import s from '../assets/assets.module.css';

const PAGE_SIZE = 50;
type Tab = 'inbox' | 'all';

export function RequestList() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const approver = can('approval.decide') || can('asset.write');   // 자산 관리자: 1단계 회사의 대리 승인
  const tab: Tab = (sp.get('tab') as Tab) ?? (approver ? 'inbox' : 'all');
  const get = (k: string) => sp.get(k) ?? '';
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const set = useCallback((patch: Record<string, string>) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
      if (!('page' in patch)) n.delete('page');
      return n;
    }, { replace: true });
  }, [setSp]);

  return (
    <>
      <ViewHeader crumb="ALM-230" title={t('nav.requests')} description={t('request.list.description')} />
      <Panel padded={false}>
        <Tabs<Tab> label={t('nav.requests')} value={approver ? tab : 'all'} onChange={(v) => setSp(new URLSearchParams({ tab: v }), { replace: true })}
          items={[...(approver ? [{ value: 'inbox' as const, label: t('request.list.inbox') }] : []), { value: 'all', label: t('request.list.all') }]} />
        {approver && tab === 'inbox' ? <Inbox page={page} set={set} onOpen={(id) => nav(`/requests/${id}`)} />
          : <All page={page} get={get} set={set} onOpen={(id) => nav(`/requests/${id}`)} onClear={() => setSp(new URLSearchParams({ tab: 'all' }), { replace: true })} />}
      </Panel>
    </>
  );
}

function Pager({ page, total, set }: { page: number; total: number; set: (p: Record<string, string>) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className={s.pager}>
      <span className="small muted">{t('asset.list.total', { total })}</span>
      <div className={s.pagerBtns}>
        <Button size="sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>{t('common.prev')}</Button>
        <span className="small">{t('common.page', { page, pages })}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>{t('common.next')}</Button>
      </div>
    </div>
  );
}

// 승인함 요약(화면 언어로): 자산태그 + 유형별 핵심 값
function summaryOf(t: (k: string, o?: Record<string, unknown>) => string, x: InboxRow): string {
  const tag = x.assetTag ?? '';
  switch (x.requestType) {
    case 'NEW_ASSET': return t('request.summary.NEW_ASSET', { tag, cc: x.targetCostCenterCode ?? '' });
    case 'TRANSFER': return t(x.isProfitCenterChange ? 'request.summary.TRANSFER_PC' : 'request.summary.TRANSFER', { tag, cc: x.targetCostCenterCode ?? '' });
    case 'CHANGE': return t('request.summary.CHANGE', { tag });
    case 'RETIRE': return t('request.summary.RETIRE', { tag, type: x.retireType ? t(`request.retireType.${x.retireType}`) : '' });
    case 'SALE': return t('request.summary.SALE', { tag, buyer: x.buyer ?? '' });
    default: return x.summary;
  }
}

function Inbox({ page, set, onOpen }: { page: number; set: (p: Record<string, string>) => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const r = useAsync((sig) => api.get<Page<InboxRow>>(`/approvals/inbox${qs({ page, pageSize: PAGE_SIZE })}`, sig), [page]);
  const columns = useMemo<Column<InboxRow>[]>(() => [
    { key: 'targetNo', label: t('request.col.no'), render: (x) => <span className="mono">{x.targetNo}</span> },
    { key: 'requestType', label: t('request.col.type'), render: (x) => t(`request.type.${x.requestType}`) },
    { key: 'summary', label: t('request.col.summary'), render: (x) => summaryOf(t, x) },
    { key: 'requesterName', label: t('request.col.requester') },
    { key: 'stepNo', label: t('request.col.step'), render: (x) => `${x.stepNo} · ${t(`role.${x.approverRole}`)}${x.proxy ? ` (${t('request.list.proxy')})` : ''}` },
    { key: 'amount', label: t('request.col.amount'), align: 'right', render: (x) => <span className="num">{formatUsd(x.amount ?? null)}</span> },
    { key: 'waitingSince', label: t('request.col.waiting'), render: (x) => formatDateTime(x.waitingSince) },
  ], [t]);
  if (r.error) return <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div>;
  return (
    <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(x) => x.approvalId} loading={r.loading} onRowClick={(x) => onOpen(x.targetId)}
      empty={<EmptyState message={t('request.list.inboxEmpty')} />} footer={<Pager page={page} total={r.data?.total ?? 0} set={set} />} />
  );
}

function All({ page, get, set, onOpen, onClear }: { page: number; get: (k: string) => string; set: (p: Record<string, string>) => void;
  onOpen: (id: string) => void; onClear: () => void }) {
  const { t } = useTranslation();
  const query = qs({ q: get('q'), type: get('type'), status: get('status'), mine: get('mine'), page, pageSize: PAGE_SIZE });
  const r = useAsync((sig) => api.get<Page<RequestSummary>>(`/asset-requests${query}`, sig), [query]);
  const columns = useMemo<Column<RequestSummary>[]>(() => [
    { key: 'requestNo', label: t('request.col.no'), render: (x) => <span className="mono">{x.requestNo}</span> },
    { key: 'requestType', label: t('request.col.type'), render: (x) => t(`request.type.${x.requestType}`) },
    { key: 'status', label: t('request.col.status'), render: (x) => <StatusPill tone={statusTone[x.status]}>{t(`request.status.${x.status}`)}</StatusPill> },
    { key: 'assetTag', label: t('request.col.asset'), render: (x) => <span className="mono">{x.assetTag ?? '—'}</span> },
    { key: 'requesterName', label: t('request.col.requester') },
    { key: 'awaitingRole', label: t('request.col.awaiting'), render: (x) => (x.awaitingRole ? `${x.currentStep} · ${t(`role.${x.awaitingRole}`)}` : '—') },
    { key: 'submittedAt', label: t('request.col.submitted'), render: (x) => formatDateTime(x.submittedAt ?? x.createdAt) },
  ], [t]);
  const hasFilter = ['q', 'type', 'status', 'mine'].some((k) => get(k));
  return (
    <>
      <FilterBar search={get('q')} onSearch={(q) => set({ q })} searchPlaceholder={t('request.list.search')} onClear={hasFilter ? onClear : undefined}>
        <FilterSelect label={t('request.col.type')} allLabel={t('request.list.allTypes')} value={get('type')} onChange={(v) => set({ type: v })}
          options={REQUEST_TYPES.map((c) => ({ value: c, label: t(`request.type.${c}`) }))} />
        <FilterSelect label={t('request.col.status')} allLabel={t('request.list.allStatus')} value={get('status')} onChange={(v) => set({ status: v })}
          options={REQUEST_STATUSES.map((c) => ({ value: c, label: t(`request.status.${c}`) }))} />
        <FilterSelect label={t('request.list.mine')} allLabel={t('request.list.everyone')} value={get('mine')} onChange={(v) => set({ mine: v })}
          options={[{ value: 'true', label: t('request.list.mineOnly') }]} />
      </FilterBar>
      {r.error ? <div className={s.notice} role="alert">{t('common.error', { message: r.error.message })}</div> : (
        <DataTable rows={r.data?.items ?? []} columns={columns} rowId={(x) => x.id} loading={r.loading} onRowClick={(x) => onOpen(x.id)}
          empty={<EmptyState message={t('common.noResults')} />} footer={<Pager page={page} total={r.data?.total ?? 0} set={set} />} />
      )}
    </>
  );
}
