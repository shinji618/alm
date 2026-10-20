import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const am: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'am@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_MANAGER' }],
  permissions: ['asset.read', 'asset.write', 'master.read', 'master.write'], navCounts: {} };
const range = (o: Record<string, unknown>) => ({ id: 'r1', version: 1, prefix: 'AT', name: 'Default', fromNo: 1, toNo: 999999, nextNo: 13, nextTag: 'AT-000013',
  sample: 'AT-000001 ~ AT-999999', used: 12, remaining: 999987, nearlyFull: false, exhausted: false, isDefault: true, isActive: true, categories: [], ...o });

afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('asset tag number ranges (ADM-055)', () => {
  it('lists ranges with warnings and adds a prefix range', async () => {
    window.history.pushState({}, '', '/admin/number-ranges');
    const posts: unknown[] = [];
    let items = [range({}), range({ id: 'r2', prefix: 'NB', name: 'Notebooks', toNo: 20, nextTag: 'NB-000019', sample: 'NB-000001 ~ NB-000020', used: 18, remaining: 2,
      nearlyFull: true, isDefault: false, categories: [{ id: 'nb', code: 'NB', name: 'Notebook' }] })];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.endsWith('/admin/number-ranges') && init.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        items = [...items, range({ id: 'r3', prefix: 'MN', name: 'Monitors', isDefault: false, nextTag: 'MN-000001', used: 0 })];
        return new Response(JSON.stringify(items[2]), { status: 201 });
      }
      if (url.endsWith('/admin/number-ranges')) return new Response(JSON.stringify({ items }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    const row = (await screen.findByText('NB-000019')).closest('tr')!;
    expect(within(row).getByText('Running low')).toBeInTheDocument();
    expect(within(row).getAllByText('NB')).toHaveLength(2);
    expect(screen.getByText(/Number ranges running low or used up: NB \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('All categories without a range')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add number range' }));
    await user.type(screen.getByLabelText(/^Prefix/), 'm-n');
    expect(screen.getByLabelText(/^Prefix/)).toHaveValue('MN');
    await user.type(screen.getByLabelText(/^Name/), 'Monitors');
    await user.clear(screen.getByLabelText(/^To number/));
    await user.type(screen.getByLabelText(/^To number/), '5000');
    expect(screen.getByText('MN-000001 ~ MN-005000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts[0]).toEqual({ prefix: 'MN', name: 'Monitors', fromNo: 1, toNo: 5000, nextNo: 1, isDefault: false }));
    expect(await screen.findByText('MN-000001')).toBeInTheDocument();
  }, 20000);
});
