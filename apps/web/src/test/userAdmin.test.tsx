import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { UserRow } from '@/pages/admin/UserAdmin';

const admin: Me = { userId: 'a1', displayName: 'Admin', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'SYS_ADMIN' }],
  permissions: ['admin.user', 'asset.read'], navCounts: {}, features: { sap: true } };

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

const U = (o: Partial<UserRow>): UserRow => ({ id: 'u1', email: 'staff@bsg.test', displayName: 'Staff One', roles: [{ role: 'EMPLOYEE' }], isActive: true, ...o });
const ITEMS = [U({}), U({ id: 'a1', email: 'a@bsg.test', displayName: 'Admin', roles: [{ role: 'SYS_ADMIN' }, { role: 'EMPLOYEE' }] })];
const list = (url: string) => (url.includes('/admin/users') ? { body: { items: ITEMS, page: 1, pageSize: 200, total: 2 } } : undefined);

describe('user and role administration (ADM-010)', () => {
  it('assigns a department manager role (cost center required) and shows the SoD warning', async () => {
    window.history.pushState({}, '', '/admin/users');
    const puts: unknown[] = [];
    mockFetch((url, init) => {
      if (url.endsWith('/admin/users/u1/roles') && init.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return { body: ITEMS[0], headers: { 'X-SoD-Warning': 'SOD-03' } }; }
      return list(url);
    });
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'Users and roles' })).toBeInTheDocument();
    const row = (await screen.findByText('Staff One')).closest('tr')!;
    expect(within(row).getByText('Active')).toBeInTheDocument();
    await user.click(row);
    const drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Add role' }));
    await user.selectOptions(within(drawer).getByLabelText('Role'), 'DEPT_MANAGER');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(await within(drawer).findByText('A department manager needs a cost center')).toBeInTheDocument();
    expect(puts).toHaveLength(0);
    await user.type(within(drawer).getByLabelText(/^Cost center/), 'FBSG01');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Segregation-of-duties warning: SOD-03/)).toBeInTheDocument();
    expect(puts[0]).toEqual({ roles: [{ role: 'DEPT_MANAGER', costCenterCode: 'FBSG01' }] });
  });

  it('blocks an auditor combined with another role', async () => {
    window.history.pushState({}, '', '/admin/users');
    mockFetch(list);
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    await user.click((await screen.findByText('Staff One')).closest('tr')!);
    const drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Add role' }));
    await user.selectOptions(within(drawer).getByLabelText('Role'), 'AUDITOR');
    await user.click(within(drawer).getByRole('button', { name: 'Add role' }));
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(await within(drawer).findByText('An auditor (AUDITOR) cannot be combined with other roles')).toBeInTheDocument();
  });

  it('starts a new role row empty so a high role is never assigned by accident', async () => {
    window.history.pushState({}, '', '/admin/users');
    const puts: unknown[] = [];
    mockFetch((url, init) => { if (init.method === 'PUT') { puts.push(1); return { body: ITEMS[0] }; } return list(url); });
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    await user.click((await screen.findByText('Staff One')).closest('tr')!);
    const drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Add role' }));
    expect(within(drawer).getByLabelText('Role')).toHaveValue('');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(await within(drawer).findByText('Select a role', { selector: 'p, span, div' })).toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });

  it('locks the signed-in admin\'s own roles', async () => {
    window.history.pushState({}, '', '/admin/users');
    mockFetch(list);
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    await user.click((await screen.findByText('Admin', { selector: 'td' })).closest('tr')!);
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/cannot change your own roles/)).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Add role' })).not.toBeInTheDocument();
  });
});
