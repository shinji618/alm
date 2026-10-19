// 드롭다운 값(openapi getLookups). types에 적은 것만. 사용자 범위(회사코드·사이트) 밖의 회사·사이트·룸·코스트센터는 뺀다(09 4.1).
// 사용자 목록은 approval.decide·asset.assign·count.manage·admin.user 중 하나가 있어야 하고, 이름·이메일·부서만(최대 50).
import type { PoolClient } from 'pg';
import { Check } from '../common/validate';
import type { Principal } from '../auth/principal';
import { assetScope, can, Params, scopeRows } from '../auth/scope';

const TYPES = ['companies', 'sites', 'rooms', 'costCenters', 'assetClasses', 'categories', 'models', 'vendors', 'users', 'codes'] as const;
type T = (typeof TYPES)[number];
const USER_PERMS = ['approval.decide', 'asset.assign', 'count.manage', 'admin.user'];

interface Item { id: string; code: string; label: string; parentId?: string; extra?: Record<string, unknown> }

// 회사코드·사이트 제한: 범위 없는 역할 행이 하나라도 있으면 제한 없음. 모두 제한돼 있으면 그 값들만
function placeLimit(p: Principal) {
  const rows = scopeRows(p, 'asset.read').concat(scopeRows(p, 'master.read'));
  const wide = rows.filter((r) => r.scope === 'ALL' || r.scope === '-');
  if (!wide.length || wide.some((r) => !r.companyCode && !r.siteCode)) return { companies: null, sites: null };
  const companies = wide.every((r) => r.companyCode) ? [...new Set(wide.map((r) => r.companyCode!))] : null;
  const sites = wide.every((r) => r.siteCode) ? [...new Set(wide.map((r) => r.siteCode!))] : null;
  return { companies, sites };
}

export async function lookups(c: PoolClient, p: Principal, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const want = (q.types ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = want.filter((t) => !TYPES.includes(t as T));
  if (!want.length) k.errors.push({ field: 'types', code: 'ALM-E101', message: `${TYPES.join(', ')} 중 하나 이상` });
  else if (bad.length) k.fail('types', `알 수 없는 유형: ${bad.join(', ')}`);
  const siteId = k.uuid(q, 'siteId');
  k.done();
  const lim = placeLimit(p);
  const ko = p.locale?.startsWith('ko');
  const out: Record<string, unknown> = {};
  const has = (t: T) => want.includes(t);
  const items = (rows: Record<string, any>[], f: (r: Record<string, any>) => Item) => rows.map(f).map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v != null)));

  if (has('companies')) {
    out.companies = items((await c.query(`SELECT id, company_code, name, currency, sap_enabled, approval_steps FROM company WHERE is_active AND ($1::text[] IS NULL OR company_code = ANY($1))
      ORDER BY company_code`, [lim.companies])).rows, (r) => ({ id: r.id, code: r.company_code, label: r.name, extra: { currency: r.currency, sapEnabled: r.sap_enabled, approvalSteps: r.approval_steps } }));
  }
  if (has('sites')) {
    out.sites = items((await c.query(`SELECT s.id, s.site_code, s.name, p.plant_code, co.company_code FROM site s LEFT JOIN plant p ON p.id = s.plant_id
      LEFT JOIN company co ON co.id = p.company_id
      WHERE s.is_active AND ($1::text[] IS NULL OR s.site_code = ANY($1)) AND ($2::text[] IS NULL OR co.company_code = ANY($2) OR co.company_code IS NULL)
      ORDER BY s.site_code`, [lim.sites, lim.companies])).rows,
    (r) => ({ id: r.id, code: r.site_code, label: r.name, extra: { plantCode: r.plant_code, companyCode: r.company_code } }));
  }
  if (has('rooms')) {
    out.rooms = items((await c.query(`SELECT r.id, r.room_code, r.name, r.site_id, r.is_storage FROM room r JOIN site s ON s.id = r.site_id
      WHERE r.is_active AND s.is_active AND ($1::uuid IS NULL OR r.site_id = $1) AND ($2::text[] IS NULL OR s.site_code = ANY($2))
      ORDER BY s.site_code, r.room_code LIMIT 5000`, [siteId ?? null, lim.sites])).rows,
    (r) => ({ id: r.id, code: r.room_code, label: r.name, parentId: r.site_id, extra: { isStorage: r.is_storage } }));
  }
  if (has('costCenters')) {
    out.costCenters = items((await c.query(`SELECT cc.id, cc.cost_center_code, cc.name, cc.controlling_area, co.company_code, pc.profit_center_code
      FROM cost_center cc JOIN company co ON co.id = cc.company_id LEFT JOIN profit_center pc ON pc.id = cc.profit_center_id
      WHERE cc.is_active AND ($1::text[] IS NULL OR co.company_code = ANY($1)) ORDER BY co.company_code, cc.cost_center_code`, [lim.companies])).rows,
    (r) => ({ id: r.id, code: r.cost_center_code, label: r.name, extra: { companyCode: r.company_code, controllingArea: r.controlling_area, profitCenter: r.profit_center_code } }));
  }
  if (has('assetClasses')) {
    out.assetClasses = items((await c.query(`SELECT id, class_code, name, is_low_value, is_capitalized, default_useful_life_years, is_manual FROM asset_class
      WHERE is_active AND NOT is_manual ORDER BY class_code`)).rows,
    (r) => ({ id: r.id, code: r.class_code, label: r.name, extra: { isLowValue: r.is_low_value, isCapitalized: r.is_capitalized, usefulLifeYears: r.default_useful_life_years, isManual: r.is_manual } }));
  }
  if (has('categories')) {
    // counts=true: 카테고리별 자산 수(이 카테고리에 직접 등록된 것, 사용자의 asset.read 범위 안, 상태 무관). 메뉴의 카테고리 옆 숫자용.
    //   하위 카테고리 합계는 화면에서 parentId로 더한다. asset.read가 없으면 수를 넣지 않는다
    const counts = new Map<string, number>();
    if (q.counts === 'true' && can(p, 'asset.read')) {
      const ps = new Params();
      for (const r of (await c.query(`SELECT a.category_id, count(*)::int AS n FROM asset a WHERE ${assetScope(p, 'asset.read', ps)} GROUP BY a.category_id`, ps.values)).rows) {
        counts.set(r.category_id, r.n);
      }
      // 메뉴 'All assets' 옆 숫자: 범위 안 전체 자산 수(카테고리 없는 자산·비활성 카테고리 자산 포함)
      out.assetTotal = [...counts.values()].reduce((n, x) => n + x, 0);
    }
    out.categories = items((await c.query(`SELECT id, category_code, name, parent_id, default_asset_class_id, useful_life_years FROM category
      WHERE is_active ORDER BY category_code`)).rows,
    (r) => ({ id: r.id, code: r.category_code, label: r.name, parentId: r.parent_id, extra: { defaultAssetClassId: r.default_asset_class_id, usefulLifeYears: r.useful_life_years,
      ...(q.counts === 'true' && can(p, 'asset.read') ? { assetCount: counts.get(r.id) ?? 0 } : {}) } }));
  }
  if (has('models')) {
    out.models = items((await c.query(`SELECT id, manufacturer, model_name, part_no, category_id FROM model WHERE is_active ORDER BY manufacturer, model_name LIMIT 5000`)).rows,
      (r) => ({ id: r.id, code: r.part_no ?? r.model_name, label: `${r.manufacturer} ${r.model_name}`, parentId: r.category_id }));
  }
  if (has('vendors')) {
    out.vendors = items((await c.query(`SELECT id, vendor_no, name FROM vendor WHERE is_active ORDER BY name LIMIT 5000`)).rows,
      (r) => ({ id: r.id, code: r.vendor_no ?? '', label: r.name }));
  }
  if (has('users')) {
    if (!USER_PERMS.some((x) => can(p, x))) out.users = [];
    else {
      const t = q.q?.trim() ? `%${q.q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      // role: 그 역할이 지금 유효한 사용자만(실사 룸 배정은 COUNTER)
      const role = q.role?.trim() && /^[A-Z_]{2,30}$/.test(q.role.trim()) ? q.role.trim() : null;
      out.users = items((await c.query(`SELECT id, display_name, email, department FROM app_user u WHERE is_active
        AND ($1::text IS NULL OR display_name ILIKE $1 OR email ILIKE $1 OR employee_no ILIKE $1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.id AND ur.role::text = $2
          AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)))
        ORDER BY display_name LIMIT 50`, [t, role])).rows,
      (r) => ({ id: r.id, code: r.email, label: r.display_name, extra: { email: r.email, department: r.department } }));
    }
  }
  if (has('codes')) {
    const groups = new Map<string, unknown[]>();
    for (const r of (await c.query(`SELECT id, code_group, code, label_en, label_ko FROM code WHERE is_active ORDER BY code_group, sort_order, code`)).rows) {
      const list = groups.get(r.code_group) ?? [];
      list.push({ id: r.id, code: r.code, label: (ko && r.label_ko) || r.label_en });
      groups.set(r.code_group, list);
    }
    out.codes = Object.fromEntries(groups);
  }
  return out;
}
