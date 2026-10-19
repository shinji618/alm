import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const am: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'am@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_MANAGER' }],
  permissions: ['dashboard.read', 'asset.read', 'asset.write', 'amount.read', 'count.read', 'label.read'], navCounts: {} };
const emp: Me = { ...am, roles: [], permissions: ['asset.read', 'request.read'] };
const DATA = {
  asOf: '2026-10-19T12:00:00Z', valuePeriod: '009/2026',
  kpis: [{ key: 'activeAssets', value: 1234, unit: 'count', link: '/assets' }, { key: 'nbv', value: 700, secondary: 1000, unit: 'usd', link: '/assets?sort=-nbv' },
    { key: 'warrantyExpiring', value: 3, unit: 'count', link: '/assets?quick=WARRANTY_90' }, { key: 'licenseCompliance', value: null, unit: 'percent', link: '/software' },
    { key: 'countVariance', value: 0, unit: 'count', link: '/counts' }, { key: 'sapErrors', value: 2, unit: 'count', link: '/sap' }],
  stages: [{ stage: 'PLAN', count: 1 }, { stage: 'PROCURE', count: 0 }, { stage: 'DEPLOY', count: 4 }, { stage: 'OPERATE', count: 90 }, { stage: 'MAINTAIN', count: 3 }, { stage: 'RETIRE', count: 2 }],
  categories: [{ categoryId: 'nb', name: 'Notebook', total: 80, inUse: 70, inStock: 10, pastUsefulLife: 5, nbv: 700 }],
  renewals: [{ kind: 'WARRANTY', id: 'a1', name: 'AT-000001 · Latitude', endDate: '2026-11-08', daysLeft: 20, link: '/assets/a1' }],
  actions: [{ kind: 'LABEL_QUEUED', count: 4, link: '/labels' }],
  activity: [{ id: 'e1', eventType: 'ASSIGNED', occurredAt: '2026-10-19T11:00:00Z', channel: 'UI', assetId: 'a1', assetTag: 'AT-000001', description: 'Latitude', actorName: 'Kim' }],
};

function mockFetch() {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    if (url.includes('/lookups')) return new Response(JSON.stringify({ sites: [{ id: 's1', code: 'ATL', label: 'Atlanta' }], categories: [] }), { status: 200 });
    if (url.includes('/dashboard')) return new Response(JSON.stringify(DATA), { status: 200 });
    if (url.includes('/assets?')) return new Response(JSON.stringify({ items: [], page: 1, pageSize: 50, total: 0 }), { status: 200 });
    if (url.includes('/label-jobs')) return new Response(JSON.stringify({ items: [], page: 1, pageSize: 500, total: 0, counts: {} }), { status: 200 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }));
  return urls;
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('dashboard (ALM-010)', () => {
  it('shows KPIs, lifecycle, categories, renewals, activity and actions; tiles and stages link to filtered lists', async () => {
    const urls = mockFetch();
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    expect(await screen.findByText('Values as of SAP period 009/2026', { exact: false })).toBeInTheDocument();
    const kpis = screen.getByRole('region', { name: 'Key figures' });
    expect(within(kpis).getByRole('button', { name: /Active assets\s*1,234/ })).toBeInTheDocument();
    expect(within(kpis).getByRole('button', { name: /Net book value\s*\$700\s*APC \$1,000/ })).toBeInTheDocument();
    expect(within(kpis).getByRole('button', { name: /License compliance\s*—/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Plan 1, Procure 0, Deploy 4, Operate 90, Maintain 3, Retire 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notebook' })).toBeInTheDocument();
    expect(screen.getByText('20 days')).toBeInTheDocument();
    expect(screen.getByText('Checked out', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Labels waiting to print')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(urls.some((u) => u.includes('/dashboard?refresh=true'))).toBe(true));
    await user.selectOptions(screen.getByLabelText(/^Site/), 's1');
    await waitFor(() => expect(urls.some((u) => u.includes('/dashboard?siteId=s1'))).toBe(true));

    await user.click(within(kpis).getByRole('button', { name: /Warranty ≤ 90 days/ }));
    await waitFor(() => expect(urls.some((u) => u.includes('/assets?') && u.includes('quick=WARRANTY_90'))).toBe(true));
  }, 20000);

  it('stage card opens the asset list filtered by stage', async () => {
    const urls = mockFetch();
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Maintain\s*3/ }));
    await waitFor(() => expect(urls.some((u) => u.includes('/assets?') && u.includes('stage=MAINTAIN'))).toBe(true));
  }, 20000);

  it('roles without the dashboard see a pointer instead of an error', async () => {
    const urls = mockFetch();
    render(<App initialMe={emp} />);
    expect(await screen.findByText(/Your role has no dashboard/)).toBeInTheDocument();
    expect(urls.some((u) => u.includes('/dashboard'))).toBe(false);
  });
});
