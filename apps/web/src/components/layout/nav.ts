/** 메뉴 구성 — 기능 정의서 3장 화면 목록 */
export interface NavItem {
  path: string;
  labelKey: string;
  screenId: string;
  wbs: string;
  /** 이 권한 키가 있어야 보인다 */
  perm?: string;
  /** 꺼진 기능이면 숨긴다(/me features) */
  feature?: 'sap';
  /** 아래에 카테고리별 하위 메뉴(/assets?categoryId=…)를 붙인다 */
  children?: 'categories';
}
export interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { labelKey: 'nav.overview', items: [{ path: '/', labelKey: 'nav.dashboard', screenId: 'ALM-010', wbs: '4.1' }] },
  {
    labelKey: 'nav.inventory',
    items: [
      { path: '/assets', labelKey: 'nav.assets', screenId: 'ALM-110', wbs: '4.2', children: 'categories' },
      { path: '/discovery', labelKey: 'nav.discovery', screenId: 'ALM-120', wbs: '5.1' },
      { path: '/cmdb', labelKey: 'nav.cmdb', screenId: 'ALM-130', wbs: '5.2' },
      { path: '/software', labelKey: 'nav.software', screenId: 'ALM-140', wbs: '5.3' },
    ],
  },
  {
    labelKey: 'nav.lifecycle',
    items: [
      // 구매(ALM-210)는 숨김(2026-10-25 결정): 구매·PO 정보는 SAP에서 자산 가액이 생길 때 IF-AA-02 origins로 들어와 자산 상세에 표시된다
      { path: '/contracts', labelKey: 'nav.contracts', screenId: 'ALM-220', wbs: '5.4' },
      { path: '/requests', labelKey: 'nav.requests', screenId: 'ALM-230', wbs: '4.3' },
      { path: '/counts', labelKey: 'nav.inventoryCount', screenId: 'ALM-240', wbs: '4.4', perm: 'count.read' },
      { path: '/labels', labelKey: 'nav.labels', screenId: 'ALM-250', wbs: '4.5', perm: 'label.read' },
      { path: '/tax', labelKey: 'nav.propertyTax', screenId: 'ALM-260', wbs: '4.9', perm: 'tax.read' },
    ],
  },
  {
    labelKey: 'nav.integration',
    items: [
      { path: '/sap', labelKey: 'nav.sap', screenId: 'ALM-310', wbs: '4.6', feature: 'sap', perm: 'sap.status' },
      { path: '/design', labelKey: 'nav.design', screenId: 'DS', wbs: '3.5' },
    ],
  },
  {
    labelKey: 'nav.admin',
    items: [
      { path: '/admin/companies', labelKey: 'nav.companies', screenId: 'ADM-020', wbs: '4.3', perm: 'admin.config' },
      { path: '/admin/categories', labelKey: 'nav.categories', screenId: 'ADM-050', wbs: '4.2', perm: 'master.read' },
      { path: '/admin/number-ranges', labelKey: 'nav.numberRanges', screenId: 'ADM-055', wbs: '4.2', perm: 'master.read' },
      { path: '/admin/fin-masters', labelKey: 'nav.finMasters', screenId: 'ADM-030', wbs: '4.3', perm: 'master.write' },
      { path: '/admin/sap-masters', labelKey: 'nav.sapMasters', screenId: 'ADM-035', wbs: '7.4', perm: 'master.read' },
      { path: '/admin/users', labelKey: 'nav.users', screenId: 'ADM-010', wbs: '4.12', perm: 'admin.user' },
      { path: '/admin/dept-managers', labelKey: 'nav.deptManagers', screenId: 'ADM-040', wbs: '4.3', perm: 'admin.user' },
      { path: '/admin/asset-import', labelKey: 'nav.assetImport', screenId: 'ADM-060', wbs: '9.3', perm: 'asset.write' },
    ],
  },
];

export const NAV_ITEMS = NAV.flatMap((g) => g.items);
