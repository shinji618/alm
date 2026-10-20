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

describe('Asset categories admin (ADM-050)', () => {
  it('adds a category with an SAP asset class as default', async () => {
    window.history.pushState({}, '', '/admin/categories');
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.includes('/lookups')) return new Response(JSON.stringify({ ...LOOKUPS, assetClasses: [{ id: 'c3000', code: '00003000', label: 'Fixtures and fittings' }] }), { status: 200 });
      if (url.endsWith('/admin/categories') && init.method === 'POST') { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'n' }), { status: 201 }); }
      if (url.includes('/admin/categories')) return new Response(JSON.stringify({ items: [{ id: 'nb', version: 1, categoryCode: 'NB', name: 'Notebook', isCi: true, isActive: true, assetCount: 2, modelCount: 1 }] }), { status: 200 });
      return new Response(JSON.stringify({ code: 'ALM-E404', message: 'nope' }), { status: 404 });
    }));
    render(<App initialMe={{ ...me, permissions: ['asset.read', 'master.read', 'master.write'] }} />);
    const user = userEvent.setup();
    expect(await screen.findByText('Notebook', { selector: 'td' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    const d = screen.getByRole('dialog');
    await user.type(within(d).getByLabelText(/^Code/), 'fur');
    await user.type(within(d).getByLabelText(/^Name/), 'Furniture');
    await user.selectOptions(await within(d).findByLabelText(/^Default asset class/), 'c3000');
    await user.type(within(d).getByLabelText(/^Replacement life/), '7');
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(posts[0]).toEqual({ categoryCode: 'FUR', name: 'Furniture', parentId: null, defaultAssetClassId: 'c3000', usefulLifeYears: 7,
      isCi: false, taxPropertyType: null, numberRangeId: null }));
  }, 20000);
});

describe('Asset categories delete', () => {
  it('shows the server reason when assets use the category', async () => {
    window.history.pushState({}, '', '/admin/categories');
    const msg = 'Notebook(NB) 카테고리로 등록된 자산이 2건 있어 삭제할 수 없습니다 (AT-000001, AT-000002). 자산의 카테고리를 바꾸거나, 삭제 대신 사용 안 함으로 바꾸세요';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.includes('/lookups')) return new Response(JSON.stringify(LOOKUPS), { status: 200 });
      if (url.endsWith('/admin/categories/nb') && init.method === 'DELETE') return new Response(JSON.stringify({ code: 'ALM-E318', detail: msg, status: 409 }), { status: 409 });
      if (url.includes('/admin/categories')) return new Response(JSON.stringify({ items: [{ id: 'nb', version: 1, categoryCode: 'NB', name: 'Notebook', isCi: true, isActive: true, assetCount: 2, modelCount: 1 }] }), { status: 200 });
      return new Response(JSON.stringify({ code: 'ALM-E404', message: 'nope' }), { status: 404 });
    }));
    render(<App initialMe={{ ...me, permissions: ['asset.read', 'master.read', 'master.write'] }} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Notebook', { selector: 'td' }));
    const d = screen.getByRole('dialog');
    await user.click(within(d).getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('자산이 2건 있어 삭제할 수 없습니다');
  }, 20000);
});

describe('Assets menu refresh', () => {
  it('drops a category from the menu right after it is deactivated', async () => {
    window.history.pushState({}, '', '/admin/categories');
    let active = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.includes('/lookups')) return new Response(JSON.stringify({ ...LOOKUPS, categories: active ? LOOKUPS.categories : [LOOKUPS.categories[0]] }), { status: 200 });
      if (url.endsWith('/admin/categories/fur') && init.method === 'PATCH') { active = false; return new Response(JSON.stringify({ id: 'fur' }), { status: 200 }); }
      if (url.includes('/admin/categories')) {
        return new Response(JSON.stringify({ items: [{ id: 'fur', version: 1, categoryCode: 'FUR', name: 'Furniture', isCi: false, isActive: active, assetCount: 0, modelCount: 0 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 'ALM-E404', message: 'nope' }), { status: 404 });
    }));
    render(<App initialMe={{ ...me, permissions: ['asset.read', 'master.read', 'master.write'] }} />);
    const user = userEvent.setup();
    const nav = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(await within(nav).findByRole('link', { name: 'Furniture' })).toBeInTheDocument();
    await user.click(await screen.findByText('Furniture', { selector: 'td' }));
    const d = screen.getByRole('dialog');
    await user.click(within(d).getByLabelText('Active'));
    await user.click(within(d).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(within(nav).queryByRole('link', { name: 'Furniture' })).not.toBeInTheDocument());
  }, 20000);
});

describe('Assets menu tree with counts', () => {
  it('nests sub-categories under their parent and shows rolled-up asset counts', async () => {
    window.history.pushState({}, '', '/assets');
    const tree = [
      { id: 'it', code: 'IT', label: 'IT Hardware', extra: { assetCount: 1 } },
      { id: 'nb', code: 'NB', label: 'Notebook', parentId: 'it', extra: { assetCount: 2 } },
      { id: 'srv', code: 'SRV', label: 'Server', parentId: 'it', extra: { assetCount: 0 } },
      { id: 'fur', code: 'FUR', label: 'Furniture', extra: { assetCount: 4 } },
    ];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.includes('/lookups')) return new Response(JSON.stringify({ ...LOOKUPS, categories: tree, assetTotal: 9 }), { status: 200 });
      if (url.includes('/assets?')) return new Response(JSON.stringify({ items: [], page: 1, pageSize: 50, total: 0 }), { status: 200 });
      return new Response(JSON.stringify({ code: 'ALM-E404', message: 'nope' }), { status: 404 });
    }));
    render(<App initialMe={me} />);
    const nav = screen.getByRole('complementary', { name: 'Main navigation' });
    const group = await within(nav).findByRole('group', { name: 'By category' });
    const links = within(group).getAllByRole('link').map((a) => a.getAttribute('aria-label'));
    expect(links).toEqual(['Furniture (4 assets)', 'IT Hardware (3 assets)', 'Notebook (2 assets)', 'Server (0 assets)']);
    const nbLink = within(group).getByRole('link', { name: 'Notebook (2 assets)' });
    expect(nbLink.style.paddingLeft).toBe('38px');
    // All assets: 범위 안 전체 수(카테고리 없는 자산 포함이라 카테고리 합 7보다 클 수 있다)
    expect(within(nav).getByRole('link', { name: 'All assets (9 assets)' })).toHaveTextContent('9');
    expect(urls.some((u) => u.includes('/lookups?types=categories&counts=true'))).toBe(true);
  }, 20000);
});
