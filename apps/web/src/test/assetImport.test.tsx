import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { ImportResult } from '@/pages/admin/AssetImport';

const am: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'am@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_MANAGER' }],
  permissions: ['asset.read', 'asset.write'], navCounts: {} };
const result = (applied: boolean): ImportResult => ({
  fileName: 'assets.xlsx', applied, unknownColumns: ['Color'],
  summary: { rows: 3, create: 1, update: 1, unchanged: 0, errors: 1, warnings: 1 },
  rows: [
    { rowNo: 2, action: 'CREATE', status: 'OK', assetTag: applied ? 'AT-000010' : undefined, description: 'New laptop', errors: [], warnings: [] },
    { rowNo: 3, action: 'UPDATE', status: 'WARN', assetTag: 'AT-000001', description: 'Renamed', changes: ['description'], errors: [],
      warnings: [{ code: 'IGNORED_ON_UPDATE', message: 'companyCode' }] },
    { rowNo: 4, action: 'CREATE', status: 'ERROR', description: 'Broken', errors: [{ field: 'categoryCode', code: 'UNKNOWN_CATEGORY', message: '활성 카테고리 코드가 아닙니다: XX' }], warnings: [] },
  ],
});

afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('bulk asset upload (ADM-060)', () => {
  it('previews a file, shows row problems in the user language, then applies', async () => {
    window.history.pushState({}, '', '/admin/asset-import');
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
      if (url.endsWith('/asset-import:preview')) return new Response(JSON.stringify(result(false)), { status: 200 });
      if (url.endsWith('/asset-import:apply')) return new Response(JSON.stringify(result(true)), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    const nav = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Bulk asset upload' })).toBeInTheDocument();
    const file = new File(['PKfake'], 'assets.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await user.upload(screen.getByLabelText('Choose file'), file);
    expect(await screen.findByText('Preview — nothing has been changed yet')).toBeInTheDocument();
    const prev = calls.find((c) => c.url.endsWith(':preview'))?.body as { fileName: string; contentBase64: string };
    expect(prev.fileName).toBe('assets.xlsx');
    expect(atob(prev.contentBase64)).toBe('PKfake');
    expect(screen.getByText('Not an active category code')).toBeInTheDocument();
    expect(screen.getByText('Ignored on update (use a transfer or check-out request, or SAP): companyCode')).toBeInTheDocument();
    expect(screen.getByText('Ignored columns: Color')).toBeInTheDocument();
    expect(screen.getAllByText('(next AT-number)')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.queryByText('Renamed')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All' }));

    await user.click(screen.getByRole('button', { name: 'Apply 2 row(s)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Create 1 and update 1 asset\(s\)\? 1 row\(s\) with errors will be skipped/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Applied')).toBeInTheDocument();
    await waitFor(() => expect(calls.find((c) => c.url.endsWith(':apply'))?.body).toEqual(prev));
    expect(screen.getByText('AT-000010')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Apply \d/ })).not.toBeInTheDocument();
  }, 20000);
});
