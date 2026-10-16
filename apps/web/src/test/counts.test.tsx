import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { CampaignDetail, CountItemRow } from '@/pages/counts/types';

const mgr: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'm@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_MANAGER' }],
  permissions: ['asset.read', 'count.read', 'count.manage'], navCounts: {}, features: { sap: true } };

const ROOMS = [
  { taskId: 't1', roomCode: 'ATL-101', status: 'NOT_STARTED', expected: 2, found: 0, pending: 2 },
  { taskId: 't2', roomCode: 'ATL-102', assigneeName: 'Counter Two', status: 'NOT_STARTED', expected: 1, found: 0, pending: 1 },
];
const detail = (o: Partial<CampaignDetail> = {}): CampaignDetail => ({ id: 'c1', version: 1, status: 'SCOPING', companyCode: '1000', sapEnabled: true,
  campaign: { campaignCode: 'PI26Q4', name: 'Q4 count', companyId: 'co', keyDate: '2026-10-15', dueDate: '2026-10-31', scope: { siteIds: ['s1'] } },
  progress: { total: 0, found: 0, misplaced: 0, pending: 0, notFound: 0, unregistered: 0, rooms: ROOMS as CampaignDetail['progress']['rooms'] }, postings: {}, ...o });

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('inventory count (ALM-240)', () => {
  it('creates a campaign with sites in scope and opens it', async () => {
    window.history.pushState({}, '', '/counts');
    const calls = mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: { companies: [{ id: 'co', code: '1000', label: 'BSG America' }], sites: [{ id: 's1', code: 'ATL', label: 'Atlanta' }, { id: 's2', code: 'NYC', label: 'New York' }] } };
      if (url.endsWith('/count-campaigns') && init.method === 'POST') return { status: 201, body: detail() };
      if (url.includes('/count-campaigns?')) return { body: { items: [{ id: 'old', campaignCode: 'PI26Q3', name: 'Q3', status: 'CLOSED', companyCode: '1000', keyDate: '2026-07-15', dueDate: '2026-07-31', totalItems: 10, countedItems: 10, varianceItems: 0 }], page: 1, pageSize: 200, total: 1 } };
      if (url.endsWith('/count-campaigns/c1')) return { body: detail() };
      if (url.endsWith('/count-campaigns/c1/tasks')) return { body: detail().progress };
      return undefined;
    });
    render(<App initialMe={mgr} />);
    const user = userEvent.setup();
    expect(await screen.findByText('PI26Q3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New count campaign' }));
    const drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Create campaign' }));
    expect(within(drawer).getByText('Choose at least one site')).toBeInTheDocument();
    await user.type(within(drawer).getByLabelText(/^Code/), 'pi26q4');
    await user.type(within(drawer).getByLabelText(/^Name/), 'Q4 count');
    await user.click(await within(drawer).findByLabelText('ATL · Atlanta'));
    await user.click(within(drawer).getByLabelText('Capitalized (SAP) assets only'));
    await user.click(within(drawer).getByRole('button', { name: 'Create campaign' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/count-campaigns'))).toBe(true));
    const today = new Date().toISOString().slice(0, 10);
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/count-campaigns'))!.body).toEqual({ campaignCode: 'PI26Q4', name: 'Q4 count', companyId: 'co', keyDate: today, dueDate: today,
      scope: { siteIds: ['s1'], includeNonCapitalized: false } });
    expect(await screen.findByText('PI26Q4 · Q4 count')).toBeInTheDocument();
    expect(screen.getByText(/1 room\(s\) have no counter yet/)).toBeInTheDocument();
  });

  it('assigns a counter to a room and starts counting', async () => {
    window.history.pushState({}, '', '/counts/c1');
    let state = detail();
    const calls = mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: { users: [{ id: 'cu1', code: 'one@bsg.test', label: 'Counter One' }] } };
      if (url.endsWith('/count-tasks/t1') && init.method === 'PATCH') {
        state = detail({ version: 2, progress: { ...state.progress, rooms: [{ ...ROOMS[0], assigneeName: 'Counter One' }, ROOMS[1]] as CampaignDetail['progress']['rooms'] } });
        return { body: { ...ROOMS[0], assigneeName: 'Counter One' } };
      }
      if (url.endsWith('/count-campaigns/c1:start')) { state = detail({ version: 3, status: 'COUNTING', progress: { ...state.progress, total: 3, pending: 3 } }); return { body: state }; }
      if (url.endsWith('/count-campaigns/c1/tasks')) return { body: state.progress };
      if (url.endsWith('/count-campaigns/c1')) return { body: state };
      return undefined;
    });
    render(<App initialMe={mgr} />);
    const user = userEvent.setup();
    const select = await screen.findByLabelText('Counter for ATL-101');
    await waitFor(() => expect(within(select).getByRole('option', { name: /Counter One/ })).toBeInTheDocument());
    await user.selectOptions(select, 'cu1');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ assigneeId: 'cu1' }));
    expect(calls.some((c) => c.url.includes('/lookups?types=users&role=COUNTER'))).toBe(true);
    await waitFor(() => expect(screen.queryByText(/have no counter yet/)).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Start counting' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start counting' }));
    expect(await screen.findByRole('button', { name: 'End counting' })).toBeInTheDocument();
  });

  it('resolves selected variances in review and shows partial failures', async () => {
    window.history.pushState({}, '', '/counts/c1');
    const item = (o: Partial<CountItemRow>): CountItemRow => ({ id: 'i', assetId: 'a', assetTag: 'AT-1', description: 'Laptop', assetStatus: 'IN_USE', expectedRoomCode: 'ATL-101',
      result: 'NOT_FOUND', photoCount: 0, ...o });
    let items = [item({ id: 'i1', assetTag: 'AT-000004' }), item({ id: 'i2', assetTag: 'AT-000003', result: 'MISPLACED', foundRoomCode: 'ATL-101', expectedRoomCode: 'ATL-102' })];
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/count-items:resolve') && init.method === 'POST') {
        items = items.map((x) => ({ ...x, varianceAction: 'ACCEPT' as const }));
        return { status: 207, body: { results: [{ id: 'i1', status: 'OK' }, { id: 'i2', status: 'ERROR', code: 'ALM-E322', message: 'locked' }] } };
      }
      if (url.includes('/count-campaigns/c1/items')) return { body: { items, page: 1, pageSize: 100, total: items.length } };
      if (url.endsWith('/count-campaigns/c1')) return { body: detail({ status: 'REVIEW', progress: { ...detail().progress, total: 3, found: 1, misplaced: 1, notFound: 1 } }) };
      return undefined;
    });
    render(<App initialMe={{ ...mgr, permissions: [...mgr.permissions, 'count.post'] }} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'Post results' })).toBeInTheDocument();
    const row1 = (await screen.findByText('AT-000004')).closest('tr')!;
    await user.click(within(row1).getByRole('checkbox'));
    // NOT_FOUND 하나만: 재실사·폐기·분실·수용
    const action = screen.getByLabelText('Resolution');
    expect(within(action).getAllByRole('option').map((o) => o.textContent)).toEqual(['—', 'Recount', 'Retire (request)', 'Mark missing', 'Accept as is']);
    await user.click(within(screen.getByText('AT-000003').closest('tr')!).getByRole('checkbox'));
    expect(within(action).getAllByRole('option').map((o) => o.textContent)).toEqual(['—', 'Recount', 'Accept as is']);
    await user.selectOptions(action, 'ACCEPT');
    await user.type(screen.getByLabelText('Note'), 'checked');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/count-items:resolve'))?.body).toEqual({ items: [
      { id: 'i1', action: 'ACCEPT', note: 'checked' }, { id: 'i2', action: 'ACCEPT', note: 'checked' }] }));
    expect(await screen.findByText(/1 resolved, 1 failed: locked/)).toBeInTheDocument();
  });
});
