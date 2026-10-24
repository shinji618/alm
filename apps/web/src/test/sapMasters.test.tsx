import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const me = (perms: string[]): Me => ({ userId: 'a1', displayName: 'Admin', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'SYS_ADMIN' }],
  permissions: perms, navCounts: {}, features: { sap: true } });

function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    if (init.method && init.method !== 'GET') throw new Error('read-only screen must not write');
    const body = handler(url);
    return body === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('SAP master data (ADM-035)', () => {
  it('shows the last receive, per-type counts and a read-only list with inactive codes', async () => {
    window.history.pushState({}, '', '/admin/sap-masters');
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.includes('/admin/sap-masters/summary')) return { items: [
        { type: 'COMPANY', total: 1, active: 1, inactive: 0 }, { type: 'PLANT', total: 2, active: 2, inactive: 0 }, { type: 'PROFIT_CENTER', total: 1, active: 1, inactive: 0 },
        { type: 'COST_CENTER', total: 8, active: 8, inactive: 0 }, { type: 'ASSET_CLASS', total: 29, active: 19, inactive: 10 }],
      lastRun: { batchId: 'B1', status: 'SUCCESS', recordCount: 41, successCount: 41, errorCount: 0, startedAt: '2026-10-24T14:00:00Z' } };
      if (url.includes('/admin/sap-masters/COMPANY')) return { items: [{ id: 'c1', code: '1000', name: 'BSG America', detail: 'USD', isActive: true, updatedAt: '2026-10-24T14:00:00Z', usage: 12 }] };
      if (url.includes('/admin/sap-masters/ASSET_CLASS')) return { items: [
        { id: 'k1', code: '1100', name: 'IT equipment', detail: 'CAPITALIZED', isActive: true, usage: 5 },
        { id: 'k2', code: '9999', name: 'Old class', isActive: false, usage: 0 }] };
      if (url.endsWith('/me')) return me(['master.read']);
      return undefined;
    });
    render(<App initialMe={me(['master.read'])} />);
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'SAP master data' })).toBeInTheDocument();
    expect(await screen.findByText('BSG America')).toBeInTheDocument();
    expect(screen.getByText(/41 records/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Asset classes \(19\/29\)/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Asset classes/ }));
    expect(await screen.findByText('Old class')).toBeInTheDocument();
    expect(screen.getByText('Capitalized')).toBeInTheDocument();
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0);
    await waitFor(() => expect(urls.some((u) => u.includes('/admin/sap-masters/ASSET_CLASS'))).toBe(true));
    expect(screen.queryByRole('button', { name: /add|save/i })).toBeNull();
  });

  it('hides the menu without master.read', async () => {
    mockFetch((url) => (url.endsWith('/me') ? me(['asset.read']) : undefined));
    render(<App initialMe={me(['asset.read'])} />);
    await screen.findByRole('navigation');
    expect(screen.queryByRole('link', { name: 'SAP master data' })).toBeNull();
  });
});
