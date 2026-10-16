import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { CostCenterManagers } from '@/pages/admin/DeptManagers';

const admin: Me = { userId: 'a1', displayName: 'Admin', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'SYS_ADMIN' }],
  permissions: ['admin.user', 'asset.read'], navCounts: {}, features: { sap: true } };

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

const MGR = { id: 'r1', userId: 'u1', displayName: 'HOD Manager', email: 'hod@bsg.test', phone: '404-555-0100', active: true, linked: true };

describe('department managers (ADM-040)', () => {
  it('lists cost centers with managers, assigns a new manager and removes one', async () => {
    window.history.pushState({}, '', '/admin/dept-managers');
    const posted: unknown[] = [];
    const deleted: string[] = [];
    let items: CostCenterManagers[] = [
      { costCenterId: 'cc1', costCenterCode: 'FBSG01', name: 'FCM', companyCode: '1000', profitCenterCode: 'P100', sapResponsible: 'J. Shin', isActive: true, managers: [MGR] },
      { costCenterId: 'cc2', costCenterCode: 'FBSG02', name: 'Sales', companyCode: '1000', isActive: true, managers: [] },
    ];
    mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: { companies: [{ id: 'co', code: '1000', label: 'BSG America' }] } };
      if (url.endsWith('/admin/dept-managers') && init.method === 'POST') {
        const b = JSON.parse(String(init.body));
        posted.push(b);
        items = items.map((x) => (x.costCenterId === b.costCenterId ? { ...x, managers: [{ id: 'r2', userId: 'u2', displayName: b.displayName, email: b.email, phone: b.phone, active: true, linked: false }] } : x));
        return { status: 201, body: {} };
      }
      if (url.endsWith('/admin/dept-managers/r1') && init.method === 'DELETE') { deleted.push('r1'); return { status: 204 }; }
      if (url.includes('/admin/dept-managers')) return { body: { items } };
      if (url.endsWith('/me')) return { body: admin };
      return undefined;
    });
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'Department managers' })).toBeInTheDocument();
    const row1 = (await screen.findByText('FBSG01')).closest('tr')!;
    expect(within(row1).getByText(/hod@bsg.test · 404-555-0100/)).toBeInTheDocument();
    const row2 = screen.getByText('FBSG02').closest('tr')!;
    expect(within(row2).getByText('None')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Without a manager only'));
    expect(screen.queryByText('FBSG01')).not.toBeInTheDocument();
    await user.click(screen.getByText('FBSG02').closest('tr')!);
    let drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Assign department manager' }));
    await user.type(within(drawer).getByLabelText(/^Email/), 'new@bsg');
    await user.type(within(drawer).getByLabelText(/^Phone/), 'call me');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(await within(drawer).findByText('Check the email format')).toBeInTheDocument();
    expect(within(drawer).getByText(/Digits, \+/)).toBeInTheDocument();
    await user.type(within(drawer).getByLabelText(/^Email/), '.test');
    await user.type(within(drawer).getByLabelText(/^Name/), 'Sales Head');
    await user.clear(within(drawer).getByLabelText(/^Phone/));
    await user.type(within(drawer).getByLabelText(/^Phone/), '+1 404 555 0111');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted).toEqual([{ costCenterId: 'cc2', email: 'new@bsg.test', displayName: 'Sales Head', phone: '+1 404 555 0111' }]));
    expect(await within(drawer).findByText('Not signed in yet')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByLabelText('Without a manager only'));
    await user.click((await screen.findByText('FBSG01')).closest('tr')!);
    drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Remove' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleted).toEqual(['r1']));
  });
});
