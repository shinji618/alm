import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const me: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'am@bsg.test', locale: 'en', tenantCode: 'TEST',
  roles: [{ role: 'ASSET_MANAGER' }], permissions: ['asset.read', 'asset.write', 'amount.read', 'request.create'], navCounts: {} };
const LOOKUPS = {
  companies: [{ id: 'co', code: '1000', label: 'BSG' }], sites: [{ id: 'site', code: 'ATL', label: 'Atlanta' }],
  rooms: [{ id: 'room', code: 'ATL-101', label: 'Office', parentId: 'site' }], costCenters: [{ id: 'cc', code: 'CC100', label: 'IT', extra: { companyCode: '1000' } }],
  assetClasses: [{ id: 'cls', code: '3100', label: 'IT HW', extra: { isCapitalized: true, isLowValue: false } }],
  categories: [{ id: 'cat', code: 'AV', label: 'AV set', extra: { defaultAssetClassId: 'cls' } }], models: [], users: [], vendors: [],
};
const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222';
const comp = (id: string, tag: string, cost: number) => ({ id, assetTag: tag, description: `Part ${tag}`, status: 'IN_STOCK', categoryName: 'AV', roomCode: 'ATL-101', purchaseCost: cost });
const detail = (o: Record<string, unknown> = {}) => ({ id: 'b1', version: 1, assetTag: 'AT-000200', description: 'Board room AV', categoryId: 'cat', status: 'IN_STOCK', stage: 'OPERATE',
  source: 'MANUAL', financial: { isCapitalized: false, companyCode: '1000', sapEnabled: true, tcoEstimate: null }, openRequests: [], editableFields: ['description'], ...o });

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;
function mockFetch(handler: Handler) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    if (url.includes('/lookups')) return new Response(JSON.stringify(LOOKUPS), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('bundle assets', () => {
  it('list: bundle badge, component marker, and "Create bundle" from the selection', async () => {
    window.history.pushState({}, '', '/assets');
    mockFetch((url) => {
      if (url.includes('/assets?')) return { body: { items: [
        { id: 'b1', assetTag: 'AT-000200', description: 'Board room AV', categoryName: 'AV', status: 'IN_STOCK', stage: 'OPERATE', isBundle: true, componentCount: 2, nbv: null, updatedAt: '2026-10-19T00:00:00Z' },
        { id: C1, assetTag: 'AT-000201', description: 'Display', categoryName: 'AV', status: 'IN_STOCK', stage: 'OPERATE', bundleAssetTag: 'AT-000200', nbv: null, updatedAt: '2026-10-19T00:00:00Z' },
        { id: C2, assetTag: 'AT-000202', description: 'Camera', categoryName: 'AV', status: 'IN_STOCK', stage: 'OPERATE', nbv: null, updatedAt: '2026-10-19T00:00:00Z' },
      ], page: 1, pageSize: 50, total: 3 } };
      return undefined;
    });
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    expect(await screen.findByText('Bundle · 2')).toBeInTheDocument();
    expect(screen.getByText('in AT-000200')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: `Select ${C2}` }));
    await user.click(screen.getByRole('button', { name: 'Create bundle (1)' }));
    expect(await screen.findByText(/1 component\(s\) selected/)).toBeInTheDocument();
    expect((screen.getByLabelText('Bundle asset') as HTMLInputElement).checked).toBe(true);
  }, 20000);

  it('register: no model needed, SAP value may come from the components', async () => {
    window.history.pushState({}, '', `/assets/new?bundle=1&components=${C1},${C2}`);
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/assets') && init.method === 'POST') return { status: 201, body: { asset: { id: 'b1', assetTag: 'AT-000200' }, createdRequest: { requestNo: 'AR-00009' } } };
      if (url.endsWith('/assets/b1')) return { body: detail({ isBundle: true, components: [], componentCostTotal: 0 }) };
      return undefined;
    });
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText(/^Category/), 'cat');
    await user.type(screen.getByLabelText(/^Description/), 'Board room AV');
    await user.selectOptions(screen.getByLabelText(/^Cost center/), 'cc');
    await user.selectOptions(screen.getByLabelText(/^Room/), 'room');
    expect((screen.getByLabelText('Register in SAP (fixed asset)') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Leave blank to use the sum of component purchase costs.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/assets'))).toBeDefined());
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/assets'))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ isBundle: true, componentIds: [C1, C2], registerInSap: true, categoryId: 'cat' });
    expect(body.modelId).toBeUndefined();
    expect(body.purchaseCost).toBeUndefined();
  }, 20000);

  it('detail: lists components, adds by tag and removes one', async () => {
    window.history.pushState({}, '', '/assets/b1');
    let comps = [comp(C1, 'AT-000201', 1000)];
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/assets/b1/components') && init.method === 'POST') { comps = [...comps, comp(C2, 'AT-000202', 500)];
        return { body: { added: ['AT-000202'], components: comps, componentCostTotal: 1500 } }; }
      if (url.endsWith(`/assets/b1/components/${C1}`) && init.method === 'DELETE') { comps = comps.filter((x) => x.id !== C1); return { body: { components: comps, componentCostTotal: 500 } }; }
      if (url.endsWith('/assets/b1')) return { body: detail({ isBundle: true, components: comps, componentCostTotal: 1000 }) };
      return undefined;
    });
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Components' });
    expect(within(section).getByText('AT-000201')).toBeInTheDocument();
    expect(within(section).getByText(/SAP registers this asset once for all 1 component/)).toBeInTheDocument();
    await user.type(within(section).getByLabelText(/^Add by asset tag/), 'at-000202{Enter}');
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/components'))?.body).toEqual({ assetTags: ['at-000202'] }));
    expect(await screen.findByText('Added 1 component(s)')).toBeInTheDocument();
    expect(within(section).getByText('$1,500.00')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Remove AT-000201' }));
    expect(await screen.findByText('Removed AT-000201 from the bundle')).toBeInTheDocument();
    expect(within(section).queryByText('AT-000201')).not.toBeInTheDocument();
  }, 20000);

  it('component detail: points to the bundle and offers no SAP registration', async () => {
    window.history.pushState({}, '', `/assets/${C1}`);
    mockFetch((url) => {
      if (url.endsWith(`/assets/${C1}`)) return { body: detail({ id: C1, assetTag: 'AT-000201', description: 'Display', bundle: { id: 'b1', assetTag: 'AT-000200', description: 'Board room AV' } }) };
      return undefined;
    });
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    expect(await screen.findByText(/component of bundle AT-000200/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open bundle' })).toHaveAttribute('href', '/assets/b1');
    await user.click(screen.getByRole('button', { name: 'New request' }));
    const type = await screen.findByLabelText(/^Request type|^Type/);
    expect(within(type as HTMLElement).queryByRole('option', { name: /SAP/ })).not.toBeInTheDocument();
  }, 20000);
});
