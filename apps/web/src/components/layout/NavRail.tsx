import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import s from './layout.module.css';
import { NAV } from './nav';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { CATEGORIES_CHANGED } from '@/lib/events';
import { Fragment, useEffect, useMemo } from 'react';

interface CategoryItem { id: string; code: string; label: string; parentId?: string; extra?: { assetCount?: number } }
interface CatNode { cat: CategoryItem; depth: number; total: number; children: CatNode[] }

/** 카테고리 계층(parentId). 상위가 비활성·없으면 맨 위로. 자산 수는 자기 + 하위 합계(목록 조회도 하위를 포함한다) */
export function categoryTree(cats: CategoryItem[]): CatNode[] {
  const ids = new Set(cats.map((c) => c.id));
  const kids = new Map<string, CategoryItem[]>();
  for (const c of cats) {
    const p = c.parentId && ids.has(c.parentId) && c.parentId !== c.id ? c.parentId : '';
    kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  const seen = new Set<string>();
  const build = (parent: string, depth: number): CatNode[] => (kids.get(parent) ?? [])
    .filter((c) => !seen.has(c.id) && (seen.add(c.id), true))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((c) => {
      const children = build(c.id, depth + 1);
      return { cat: c, depth, children, total: (c.extra?.assetCount ?? 0) + children.reduce((n, x) => n + x.total, 0) };
    });
  return build('', 0);
}

export interface NavCounts {
  [path: string]: { count: number; alert?: boolean } | undefined;
}

/** ① Nav rail. counts는 서버 요약 API에서 받아 넘긴다 */
export function NavRail({ open, counts = {}, onNavigate }: { open: boolean; counts?: NavCounts; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { can, me } = useSession();
  // 권한 키·꺼진 기능(SAP 연계를 쓰는 회사 없음)으로 메뉴를 거른다. 세션이 없으면(Storybook) 권한 메뉴만 숨김
  const loc = useLocation();
  const showCats = !!me && can('asset.read');
  // 자산 카테고리별 하위 메뉴(조회·등록). 세션이 없으면(Storybook) 부르지 않는다
  const cats = useAsync((sig) => (showCats ? api.get<{ categories?: CategoryItem[] }>('/lookups?types=categories&counts=true', sig) : Promise.resolve({ categories: [] })), [showCats]);
  // 관리 화면에서 카테고리를 바꾸면(사용 안 함·삭제·추가) 메뉴를 바로 다시 읽는다
  useEffect(() => {
    const on = () => cats.reload();
    window.addEventListener(CATEGORIES_CHANGED, on);
    return () => window.removeEventListener(CATEGORIES_CHANGED, on);
  }, [cats.reload]);
  // 자산을 등록·변경하고 메뉴로 돌아오면 수가 바뀌므로 화면을 옮길 때마다 다시 읽는다(가벼운 집계)
  useEffect(() => { if (showCats) cats.reload(); }, [loc.pathname]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tree = useMemo(() => categoryTree(cats.data?.categories ?? []), [cats.data]);
  const curCat = loc.pathname === '/assets' ? new URLSearchParams(loc.search).get('categoryId') ?? '' : '';
  const renderTree = (nodes: CatNode[]): React.ReactNode => nodes.map((n) => (
    <Fragment key={n.cat.id}>
      <NavLink to={`/assets?categoryId=${n.cat.id}`} onClick={onNavigate} title={n.cat.label}
        aria-label={n.cat.extra?.assetCount !== undefined ? t('nav.categoryCount', { name: n.cat.label, count: n.total }) : undefined}
        className={() => `${s.link} ${s.sub} ${curCat === n.cat.id ? s.active : ''}`} style={{ paddingLeft: 24 + n.depth * 14 }}>
        <span className={s.subLabel}>{n.cat.label}</span>
        {n.cat.extra?.assetCount !== undefined && <span className={s.count}>{n.total}</span>}
      </NavLink>
      {renderTree(n.children)}
    </Fragment>
  ));
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((it) => (!it.perm || can(it.perm)) && (!it.feature || me?.features?.[it.feature] !== false)) }))
    .filter((g) => g.items.length);
  return (
    <aside className={`${s.rail} ${open ? s.railOpen : ''}`} aria-label="Main navigation">
      <div className={s.brand}>
        <div className={s.mark}>ALM</div>
        <div>
          {t('app.name')}
          <small className={s.tenant}>{t('app.tenant')}</small>
        </div>
      </div>
      <nav>
        {groups.map((g) => (
          <div key={g.labelKey}>
            <div className={s.group}>{t(g.labelKey)}</div>
            {g.items.map((it) => {
              const c = counts[it.path];
              return (
                <div key={it.path}>
                  <NavLink to={it.path} end={it.path === '/'} onClick={onNavigate}
                    className={({ isActive }) => `${s.link} ${isActive && !(it.children && curCat) ? s.active : ''}`}>
                    {t(it.labelKey)}
                    {c && c.count > 0 && <span className={`${s.count} ${c.alert ? s.countAlert : ''}`}>{c.count}</span>}
                  </NavLink>
                  {it.children === 'categories' && tree.length > 0 && (
                    <div role="group" aria-label={t('nav.byCategory')}>
                      {renderTree(tree)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={s.railFoot}>v0.1 · WBS 3.5</div>
    </aside>
  );
}
