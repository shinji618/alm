// ALM-110 자산 목록(카테고리별 하위 메뉴). 검색·필터·정렬·페이지는 주소(쿼리 문자열)에 둬서 새로 고침·뒤로 가기·링크 공유가 된다
import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SortingState } from '@tanstack/react-table';
import { ViewHeader } from '@/components/layout';
import { AssetTag, Button, DataTable, FilterBar, FilterSelect, Panel, StatusPill, type Column } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { formatDate, formatUsd, type Lang } from '@/lib/format';
import { STAGE_CODES, STATUS_CODES, stageCodeColorVar, statusCodeTone } from '@/lib/status';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import type { AssetSummary, Lookups, Page } from './types';
import s from './assets.module.css';

const PAGE_SIZE = 50;
const QUICK = ['WARRANTY_90', 'PAST_USEFUL_LIFE', 'NON_SAP', 'UNCOUNTED_1Y'] as const;

export function AssetList() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const nav = useNavigate();
  const { can, me } = useSession();
  const sap = me?.features?.sap !== false;   // SAP 연계를 쓰는 회사가 없으면 SAP 열·필터를 숨긴다
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const sort = get('sort') || '-updatedAt';

  const set = useCallback((patch: Record<string, string>) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
      if (!('page' in patch)) n.delete('page');
      return n;
    }, { replace: true });
  }, [setSp]);

  const lookups = useAsync((sig) => api.get<Lookups>('/lookups?types=sites,categories', sig), []);
  const query = qs({ q: get('q'), status: get('status'), stage: get('stage'), siteId: get('siteId'), categoryId: get('categoryId'),
    quick: get('quick'), page, pageSize: PAGE_SIZE, sort });
  const list = useAsync((sig) => api.get<Page<AssetSummary>>(`/assets${query}`, sig), [query]);

  const amount = can('amount.read');
  const columns = useMemo<Column<AssetSummary>[]>(() => [
    { key: 'assetTag', label: t('asset.col.tag'), sortValue: (r) => r.assetTag, render: (r) => <AssetTag tag={r.assetTag} /> },
    { key: 'description', label: t('asset.col.description'), sortValue: (r) => r.description,
      render: (r) => <div><div>{r.description}</div><div className="small muted">{[r.categoryName, r.modelName].filter(Boolean).join(' · ')}</div></div> },
    { key: 'serialNo', label: t('asset.col.serial'), sortValue: (r) => r.serialNo ?? '', render: (r) => <span className="mono">{r.serialNo ?? '—'}</span> },
    { key: 'status', label: t('asset.col.status'), sortValue: (r) => r.status, render: (r) => <StatusPill tone={statusCodeTone[r.status]}>{t(`asset.status.${r.status}`)}</StatusPill> },
    { key: 'stage', label: t('asset.col.stage'), render: (r) => <span><span className={s.stageDot} style={{ background: stageCodeColorVar[r.stage] }} />{t(`asset.stage.${r.stage}`)}</span> },
    { key: 'roomCode', label: t('asset.col.room'), sortValue: (r) => r.roomCode ?? '', render: (r) => [r.siteCode, r.roomCode].filter(Boolean).join(' / ') || '—' },
    { key: 'assignedUserName', label: t('asset.col.user'), sortValue: (r) => r.assignedUserName ?? '' },
    { key: 'costCenterCode', label: t('asset.col.costCenter'), sortValue: (r) => r.costCenterCode ?? '', render: (r) => <span className="mono">{r.costCenterCode ?? '—'}</span> },
    ...(sap ? [{ key: 'sapAssetNo', label: t('asset.col.sapNo'), sortValue: (r: AssetSummary) => r.sapAssetNo ?? '', render: (r: AssetSummary) => <span className="mono">{r.sapAssetNo?.replace(/^0+/, '') ?? '—'}</span> } as Column<AssetSummary>] : []),
    ...(amount && sap ? [{ key: 'nbv', label: t('asset.col.nbv'), align: 'right' as const, sortValue: (r: AssetSummary) => r.nbv ?? 0, render: (r: AssetSummary) => <span className="num">{formatUsd(r.nbv)}</span> }] : []),
    { key: 'updatedAt', label: t('asset.col.updated'), sortValue: (r) => r.updatedAt, render: (r) => formatDate(r.updatedAt, lang) },
  ], [t, lang, amount, sap]);

  // 서버 정렬: 표 머리글 → sort 파라미터
  const sorting: SortingState = sort.split(',')[0] ? [{ id: sort.replace(/^-/, '').split(',')[0], desc: sort.startsWith('-') }] : [];
  const onSorting = (st: SortingState) => set({ sort: st[0] ? `${st[0].desc ? '-' : ''}${st[0].id}` : '' });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const opts = (xs?: { id: string; code: string; label: string }[]) => (xs ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.label}` }));
  // 메뉴의 카테고리 하위 항목으로 들어오면 제목·등록 버튼에 카테고리를 보여 준다
  const catLabel = lookups.data?.categories?.find((x) => x.id === get('categoryId'))?.label;
  const hasFilter = ['q', 'status', 'stage', 'siteId', 'categoryId', 'quick'].some((k) => sp.get(k));

  return (
    <>
      <ViewHeader crumb="ALM-110" title={catLabel ? `${t('nav.assets')} · ${catLabel}` : t('nav.assets')} description={t('asset.list.description')}
        actions={can('asset.write') ? (
          <Button variant="primary" onClick={() => nav(`/assets/new${get('categoryId') ? `?categoryId=${get('categoryId')}` : ''}`)}>
            {catLabel ? t('asset.list.registerIn', { category: catLabel }) : t('asset.list.register')}</Button>) : undefined} />
      <Panel padded={false}>
        <FilterBar search={get('q')} onSearch={(q) => set({ q })} searchPlaceholder={t('asset.list.search')}
          onClear={hasFilter ? () => setSp(new URLSearchParams(), { replace: true }) : undefined}>
          <FilterSelect label={t('asset.col.status')} allLabel={t('asset.list.allStatus')} value={get('status')} onChange={(v) => set({ status: v })}
            options={STATUS_CODES.map((c) => ({ value: c, label: t(`asset.status.${c}`) }))} />
          <FilterSelect label={t('asset.col.stage')} allLabel={t('asset.list.allStages')} value={get('stage')} onChange={(v) => set({ stage: v })}
            options={STAGE_CODES.map((c) => ({ value: c, label: t(`asset.stage.${c}`) }))} />
          <FilterSelect label={t('asset.col.site')} allLabel={t('asset.list.allSites')} value={get('siteId')} onChange={(v) => set({ siteId: v })} options={opts(lookups.data?.sites)} />
          <FilterSelect label={t('asset.col.category')} allLabel={t('asset.list.allCategories')} value={get('categoryId')} onChange={(v) => set({ categoryId: v })} options={opts(lookups.data?.categories)} />
          <FilterSelect label={t('asset.list.quick')} allLabel={t('asset.list.quick')} value={get('quick')} onChange={(v) => set({ quick: v })}
            options={QUICK.filter((c) => sap || c !== 'NON_SAP').map((c) => ({ value: c, label: t(`asset.quick.${c}`) }))} />
        </FilterBar>
        {list.error ? (
          <div className={s.notice} role="alert">{t('common.error', { message: list.error.message })} <Button size="sm" onClick={list.reload}>{t('common.retry')}</Button></div>
        ) : (
          <DataTable rows={list.data?.items ?? []} columns={columns} rowId={(r) => r.id} loading={list.loading} sorting={sorting} onSortingChange={onSorting}
            onRowClick={(r) => nav(`/assets/${r.id}`)}
            footer={
              <div className={s.pager}>
                <span className="small muted">{t('asset.list.total', { total })}</span>
                <div className={s.pagerBtns}>
                  <Button size="sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>{t('common.prev')}</Button>
                  <span className="small">{t('common.page', { page, pages })}</span>
                  <Button size="sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>{t('common.next')}</Button>
                </div>
              </div>
            } />
        )}
      </Panel>
    </>
  );
}
