import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const me: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'm@bsg.test', locale: 'en', tenantCode: 'TEST',
  roles: [{ role: 'ASSET_MANAGER' }], permissions: ['asset.read', 'asset.write'], navCounts: {} };
const LOOKUPS = {
  companies: [{ id: 'co', code: '1000', label: 'BSG' }], sites: [], rooms: [], costCenters: [], assetClasses: [], models: [], users: [],
  categories: [{ id: 'nb', code: 'NB', label: 'Notebook' }, { id: 'fur', code: 'FUR', label: 'Furniture' }],
};

afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('Assets menu by category', () => {
  it('lists categories under Assets, filters the list and registers in that category', async () => {
    window.history.pushState({}, '', '/assets');
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.includes('/lookups')) return new Response(JSON.stringify(LOOKUPS), { status: 200 });
      if (url.includes('/assets?')) return new Response(JSON.stringify({ items: [], page: 1, pageSize: 50, total: 0 }), { status: 200 });
      return new Response(JSON.stringify({ code: 'ALM-E404', message: 'nope' }), { status: 404 });
    }));
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    const nav = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(within(nav).getByText('Assets')).toBeInTheDocument();
    const group = await within(nav).findByRole('group', { name: 'By category' });
    await user.click(within(group).getByRole('link', { name: 'Furniture' }));
    expect(await screen.findByRole('heading', { name: 'All assets · Furniture' })).toBeInTheDocument();
    expect(urls.some((u) => u.includes('/assets?') && u.includes('categoryId=fur'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Register Furniture' }));
    expect(await screen.findByLabelText(/^Category/)).toHaveValue('fur');
  }, 20000);
});
