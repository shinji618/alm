import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const acct: Me = { userId: 'u3', displayName: 'Acct', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_ACCOUNTANT' }],
  permissions: ['sap.status', 'sap.monitor', 'sap.operate', 'sap.finance'], navCounts: {}, features: { sap: true } };

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

const STATUS = { systemId: 'S4H-100', companyCodes: ['1000'], lastCallAt: '2026-10-14T12:00:00Z', postingQueue: { READY: 1, CLAIMED: 0, FAILED: 2 },
  interfaces: [{ interfaceId: 'IF-MD-01', name: 'Org master', direction: 'SAP_TO_ALM', everyMinutes: 1440, lastStatus: 'PARTIAL', lastRecordCount: 47, isOverdue: false, runnable: true },
    { interfaceId: 'IF-AA-03', name: 'Create asset', direction: 'ALM_TO_SAP', everyMinutes: 15, isOverdue: true }] };

describe('SAP integration (ALM-310)', () => {
  it('status: KPIs, overdue flag and a manual run request', async () => {
    window.history.pushState({}, '', '/sap');
    const posted: unknown[] = [];
    mockFetch((url, init) => {
      if (url.endsWith('/integration/sap/status')) return { body: posted.length ? { ...STATUS, interfaces: [{ ...STATUS.interfaces[0], runPending: true }, STATUS.interfaces[1]] } : STATUS };
      if (url.endsWith('/integration/sap/run-requests') && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return { status: 201, body: { id: 'r1', status: 'PENDING' } }; }
      if (url.endsWith('/integration/sap/run-requests')) return { body: { items: [] } };
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    expect(await screen.findByText('S4H-100')).toBeInTheDocument();
    const md = screen.getByText('IF-MD-01').closest('tr')!;
    expect(within(md).getByText('Partial')).toBeInTheDocument();
    expect(within(screen.getByText('IF-AA-03').closest('tr')!).getByText('Overdue')).toBeInTheDocument();
    await user.click(within(md).getByRole('button', { name: 'Request run' }));
    await waitFor(() => expect(posted).toEqual([{ interfaceId: 'IF-MD-01' }]));
    expect(await within(screen.getByText('IF-MD-01').closest('tr')!).findByText('Requested')).toBeInTheDocument();
  });

  it('posting queue: exhausted posting needs the SAP check before retry', async () => {
    window.history.pushState({}, '', '/sap?tab=postings');
    const retried: unknown[] = [];
    const row = { id: 'p1', postingId: 'AR-00007', postingType: 'ASSET_RETIRE', status: 'FAILED', companyCode: '1000', assetTag: 'S1', attemptCount: 5,
      lastMessage: 'ALM 306: attempts exceeded', exhausted: true, updatedAt: '2026-10-14T12:00:00Z' };
    mockFetch((url, init) => {
      if (url.includes('/integration/sap/postings/p1:retry')) { retried.push(JSON.parse(String(init.body))); return { body: { ...row, status: 'READY', attemptCount: 0 } }; }
      if (url.endsWith('/integration/sap/postings/p1')) return { body: { summary: { ...row, messages: [{ type: 'E', id: 'ALM', number: '306', text: 'attempts exceeded' }] },
        payload: { retireType: 'SCRAP' }, requestNo: 'AR-00007', requestId: 'r7', requestStatus: 'POST_ERROR', assetId: 'a1' } };
      if (url.includes('/integration/sap/postings')) return { body: { items: [row], page: 1, pageSize: 50, total: 1 } };
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('AR-00007'));
    const drawer = await screen.findByRole('dialog');
    const retry = await within(drawer).findByRole('button', { name: 'Retry' });
    expect(retry).toBeDisabled();
    await user.click(within(drawer).getByLabelText(/I checked SAP/));
    await user.click(retry);
    await waitFor(() => expect(retried).toEqual([{ confirmSapChecked: true }]));
  });

  it('posting queue: release a claimed posting', async () => {
    window.history.pushState({}, '', '/sap?tab=postings');
    const released: unknown[] = [];
    const row = { id: 'p2', postingId: 'AR-00019', postingType: 'ASSET_RETIRE', status: 'CLAIMED', companyCode: '1000', assetTag: 'S9', attemptCount: 1,
      leaseUntil: '2099-01-01T00:00:00Z', updatedAt: '2026-10-25T12:00:00Z' };
    mockFetch((url, init) => {
      if (url.includes('/integration/sap/postings/p2:release')) { released.push(JSON.parse(String(init.body))); return { body: { ...row, status: 'READY', attemptCount: 0 } }; }
      if (url.endsWith('/integration/sap/postings/p2')) return { body: { summary: { ...row, messages: [] }, payload: { retireType: 'SCRAP' }, requestNo: 'AR-00019', requestId: 'r19', requestStatus: 'ACCT_APPROVED', assetId: 'a9' } };
      if (url.includes('/integration/sap/postings')) return { body: { items: [row], page: 1, pageSize: 50, total: 1 } };
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('AR-00019'));
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: 'Release claim' }));
    const ask = await screen.findByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: 'Release claim' }));
    await waitFor(() => expect(released).toEqual([{ confirmed: true }]));
  });

  it('reconciliation: choose actions per difference and apply', async () => {
    window.history.pushState({}, '', '/sap?tab=recon');
    const resolved: unknown[] = [];
    mockFetch((url, init) => {
      if (url.includes('/reconciliation/runs?')) return { body: { items: [{ id: 'rc1', runType: 'WEEKLY', batchId: 'RC-1', snapshotAt: '2026-10-12T12:00:00Z', status: 'SUCCEEDED',
        sapCount: 3, almCount: 3, diffCount: 2, openDiffs: 2 }], page: 1, pageSize: 20, total: 1 } };
      if (url.includes('/reconciliation/runs/rc1/diffs')) return { body: { items: [
        { id: 'd1', diffType: 'SERIAL', assetId: 'a1', assetTag: 'S1', sapAssetNo: '000001000001-0000', almValue: 'SN-1', sapValue: 'SN-X', suggestedAction: 'ALM_TO_SAP', status: 'OPEN', allowedActions: ['ALM_TO_SAP', 'SAP_TO_ALM', 'IGNORE'] },
        { id: 'd2', diffType: 'TAG', assetId: 'a2', assetTag: 'S2', sapAssetNo: '000001000002-0000', almValue: 'S2', sapValue: 'OLD', suggestedAction: 'ALM_TO_SAP', status: 'OPEN', allowedActions: ['ALM_TO_SAP', 'IGNORE'] },
      ], page: 1, pageSize: 100, total: 2 } };
      if (url.endsWith('/reconciliation/diffs:resolve')) { resolved.push(JSON.parse(String(init.body))); return { status: 207, body: { results: [{ id: 'd1', status: 'OK' }, { id: 'd2', status: 'ERROR', code: 'ALM-E315', message: 'open request' }] } }; }
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    const apply = await screen.findByRole('button', { name: 'Apply 0 selected' });
    expect(apply).toBeDisabled();
    await user.selectOptions(await screen.findByLabelText('Action S1'), 'SAP_TO_ALM');
    await user.selectOptions(screen.getByLabelText('Action S2'), 'IGNORE');
    expect(within(screen.getByLabelText('Action S2')).queryByRole('option', { name: 'Apply SAP value' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected' }));
    await waitFor(() => expect(resolved).toEqual([{ items: [{ id: 'd1', action: 'SAP_TO_ALM' }, { id: 'd2', action: 'IGNORE' }] }]));
    expect(await screen.findByText('1 applied, 1 failed')).toBeInTheDocument();
  });

  it('asset manager sees only the status tab', async () => {
    window.history.pushState({}, '', '/sap?tab=postings');
    const mgr: Me = { ...acct, permissions: ['sap.status', 'asset.read'] };
    mockFetch((url) => (url.endsWith('/integration/sap/status') ? { body: STATUS } : undefined));
    render(<App initialMe={mgr} />);
    expect(await screen.findByText('S4H-100')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Posting queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request run' })).not.toBeInTheDocument();
  });
});
