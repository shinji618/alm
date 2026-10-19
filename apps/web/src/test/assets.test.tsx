import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken, request } from '@/lib/api';
import type { Me } from '@/lib/session';

const me: Me = { userId: 'u1', displayName: 'Jiseung Shin', email: 'j@bsg.test', locale: 'en', tenantCode: 'TEST',
  roles: [{ role: 'ASSET_MANAGER' }], permissions: ['asset.read', 'asset.write', 'asset.assign', 'amount.read'], navCounts: {} };

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;
function mockFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
const LOOKUPS = {
  companies: [{ id: 'co', code: '1000', label: 'BSG' }],
  sites: [{ id: 'site', code: 'ATL', label: 'Atlanta' }],
  rooms: [{ id: 'room', code: 'ATL-101', label: 'Office', parentId: 'site' }],
  costCenters: [{ id: 'cc', code: 'CC100', label: 'IT', extra: { companyCode: '1000' } }],
  assetClasses: [{ id: 'cls', code: '3100', label: 'IT HW', extra: { isCapitalized: true, isLowValue: false } }],
  categories: [{ id: 'cat', code: 'NB', label: 'Notebook', extra: { defaultAssetClassId: 'cls' } }],
  models: [{ id: 'mdl', code: 'L7450', label: 'Dell Latitude 7450', parentId: 'cat' }],
  users: [], vendors: [],
};

afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('api client', () => {
  it('refreshes the access token once on 401 and retries', async () => {
    let n = 0;
    const calls = mockFetch((url) => (url.endsWith('/me') ? (++n === 1 ? { status: 401, body: { code: 'ALM-E402', message: 'x' } } : { body: me }) : undefined));
    const r = await request<Me>('/me');
    expect(r.data.displayName).toBe('Jiseung Shin');
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(2);
    const refresh = calls.find((c) => c.url.endsWith('/auth/refresh'))!;
    expect((refresh.init.headers as Record<string, string>)['x-alm-csrf']).toBe('1');
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
});

describe('asset screens', () => {
  it('shows the login screen when there is no session', async () => {
    mockFetch((url) => (url.endsWith('/me') ? { status: 401, body: { code: 'ALM-E402', message: 'x' } } : undefined));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/auth/refresh') ? {} : { code: 'ALM-E402', message: 'x' }), { status: 401 })));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('lists assets from the API with server-side filters in the URL', async () => {
    window.history.pushState({}, '', '/assets?status=IN_USE');
    const calls = mockFetch((url) => {
      if (url.includes('/lookups')) return { body: LOOKUPS };
      if (url.includes('/assets?')) return { body: { items: [{ id: 'a1', assetTag: 'AT-000001', description: 'Latitude 7450', categoryName: 'Notebook', status: 'IN_USE', stage: 'OPERATE',
        siteCode: 'ATL', roomCode: 'ATL-101', assignedUserName: 'Emp', costCenterCode: 'CC100', sapAssetNo: '000000300001-0000', nbv: 1125, updatedAt: '2026-10-12T00:00:00Z' }], page: 1, pageSize: 50, total: 1 } };
      return undefined;
    });
    render(<App initialMe={me} />);
    const row = (await screen.findByText('AT-000001')).closest('tr')!;
    expect(within(row).getByText('In Use')).toBeInTheDocument();
    expect(within(row).getByText('$1,125')).toBeInTheDocument();
    expect(within(row).getByText('300001-0000')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/assets?status=IN_USE&page=1&pageSize=50&sort=-updatedAt'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Register asset' })).toBeInTheDocument();
  });

  it('register: suggests SAP registration for a capitalized class and then requires purchase cost', async () => {
    window.history.pushState({}, '', '/assets/new');
    const posted: unknown[] = [];
    mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: LOOKUPS };
      if (url.endsWith('/assets') && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return { status: 201, body: { asset: { id: 'a9', assetTag: 'AT-000009' }, createdRequest: { requestNo: 'AR-00001' } } }; }
      return undefined;
    });
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText(/^Category/), 'cat');
    expect(screen.getByLabelText(/^Model/)).not.toBeRequired();
    await user.type(screen.getByLabelText(/^Model/), 'Dell Latitude 7450');
    await user.type(screen.getByLabelText(/^Description/), 'Latitude 7450');
    await user.selectOptions(screen.getByLabelText(/^Cost center/), 'cc');
    await user.selectOptions(screen.getByLabelText(/^Room/), 'room');
    const sap = screen.getByLabelText('Register in SAP (fixed asset)') as HTMLInputElement;
    expect(sap.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    await user.type(screen.getByLabelText(/^Purchase cost/), '1500');
    await user.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ categoryId: 'cat', modelName: 'Dell Latitude 7450', companyId: 'co', costCenterId: 'cc', roomId: 'room', purchaseCost: 1500, registerInSap: true });
  });
});
