/** 메뉴 구성 — 기능 정의서 3장 화면 목록 */
export interface NavItem {
  path: string;
  labelKey: string;
  screenId: string;
  wbs: string;
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
      { path: '/assets', labelKey: 'nav.assets', screenId: 'ALM-110', wbs: '4.2' },
      { path: '/discovery', labelKey: 'nav.discovery', screenId: 'ALM-120', wbs: '5.1' },
      { path: '/cmdb', labelKey: 'nav.cmdb', screenId: 'ALM-130', wbs: '5.2' },
      { path: '/software', labelKey: 'nav.software', screenId: 'ALM-140', wbs: '5.3' },
    ],
  },
  {
    labelKey: 'nav.lifecycle',
    items: [
      { path: '/procurement', labelKey: 'nav.procurement', screenId: 'ALM-210', wbs: '5.5' },
      { path: '/contracts', labelKey: 'nav.contracts', screenId: 'ALM-220', wbs: '5.4' },
      { path: '/requests', labelKey: 'nav.requests', screenId: 'ALM-230', wbs: '4.3' },
      { path: '/counts', labelKey: 'nav.inventoryCount', screenId: 'ALM-240', wbs: '4.4' },
      { path: '/labels', labelKey: 'nav.labels', screenId: 'ALM-250', wbs: '4.5' },
    ],
  },
  {
    labelKey: 'nav.integration',
    items: [
      { path: '/sap', labelKey: 'nav.sap', screenId: 'ALM-310', wbs: '4.6' },
      { path: '/design', labelKey: 'nav.design', screenId: 'DS', wbs: '3.5' },
    ],
  },
];

export const NAV_ITEMS = NAV.flatMap((g) => g.items);
