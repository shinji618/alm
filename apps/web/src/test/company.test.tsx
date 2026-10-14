import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const admin: Me = { userId: 'a1', displayName: 'Admin', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'SYS_ADMIN' }],
  permissions: ['admin.config', 'asset.read', 'amount.read'], navCounts: {}, features: { sap: true } };

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

const CO = { id: 'c2', companyCode: '2000', name: 'No SAP Inc', currency: 'USD', sapEnabled: false, approvalSteps: 2, isActive: true, sapConnections: 0, version: 1 };

describe('company settings', () => {
  it('lists companies and saves SAP off with 1 approval step; SAP on forces 2 steps', async () => {
    window.history.pushState({}, '', '/admin/companies');
    const patched: { body: unknown; ifMatch?: string }[] = [];
    mockFetch((url, init) => {
      if (url.endsWith('/admin/companies')) return { body: { items: [{ ...CO, id: 'c1', companyCode: '1000', name: 'BSG', sapEnabled: true, sapConnections: 1 }, CO] } };
      if (url.endsWith('/admin/companies/c2') && init.method === 'PATCH') {
        patched.push({ body: JSON.parse(String(init.body)), ifMatch: (init.headers as Record<string, string>)['if-match'] });
        return { body: { ...CO, approvalSteps: 1, version: 2 } };
      }
      if (url.endsWith('/me')) return { body: admin };
      return undefined;
    });
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'Companies & SAP' })).toBeInTheDocument();
    const row = (await screen.findByText('2000')).closest('tr')!;
    expect(within(row).getByText('Off')).toBeInTheDocument();
    await user.click(row);
    const drawer = screen.getByRole('dialog');
    const steps = within(drawer).getByLabelText(/^Approval steps/) as HTMLSelectElement;
    await user.selectOptions(steps, '1');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ body: { name: 'No SAP Inc', sapEnabled: false, approvalSteps: 1 }, ifMatch: '"1"' });
  });

  it('hides the SAP menu and SAP values when no company uses SAP', async () => {
    window.history.pushState({}, '', '/assets/a1');
    const me: Me = { ...admin, permissions: ['asset.read', 'amount.read'], features: { sap: false } };
    mockFetch((url) => {
      if (url.includes('/lookups')) return { body: {} };
      if (url.endsWith('/assets/a1')) return { body: { id: 'a1', version: 1, assetTag: 'NS-0001', description: 'Laptop', categoryId: 'cat', status: 'IN_STOCK', stage: 'OPERATE',
        source: 'MANUAL', financial: { isCapitalized: false, companyCode: '2000', sapEnabled: false, sapAssetNo: '000009000001', sapSubNo: '0000', netBookValue: 99, tcoEstimate: 1200 },
        openRequests: [], editableFields: [] } };
      return undefined;
    });
    render(<App initialMe={me} />);
    const user = userEvent.setup();
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'SAP FI-AA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Companies & SAP' })).not.toBeInTheDocument();
    expect(screen.queryByText(/SAP 2000\//)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Financial & SAP' }));
    expect(await screen.findByText('This company does not use SAP. Amounts are based on the purchase cost.')).toBeInTheDocument();
    expect(screen.getByText('$1,200.00')).toBeInTheDocument();
    expect(screen.queryByText('$99.00')).not.toBeInTheDocument();
  });
});
