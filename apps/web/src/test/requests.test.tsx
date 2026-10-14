import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const approver: Me = { userId: 'u2', displayName: 'Dept Manager', email: 'd@bsg.test', locale: 'en', tenantCode: 'TEST',
  roles: [{ role: 'DEPT_MANAGER', costCenterCode: 'CC300' }], permissions: ['request.read', 'request.create', 'approval.decide', 'asset.read'], navCounts: { requests: 1 } };
const manager: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'm@bsg.test', locale: 'en', tenantCode: 'TEST',
  roles: [{ role: 'ASSET_MANAGER' }], permissions: ['asset.read', 'asset.write', 'asset.assign', 'amount.read', 'request.read', 'request.create'], navCounts: {} };

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;
function mockFetch(handler: Handler) {
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

const detail = (o: Record<string, unknown> = {}) => ({
  id: 'r1', version: 2, requestNo: 'AR-00001', status: 'SUBMITTED', source: 'USER', currentStep: 1, requesterId: 'u1', requesterName: 'Asset Manager',
  submittedAt: '2026-10-13T15:00:00Z', createdAt: '2026-10-13T14:00:00Z',
  request: { requestType: 'TRANSFER', assetId: 'a1', reason: 'Move to sales', targetCostCenterId: 'cc3', effectiveDate: '2026-11-01' },
  labels: { targetCostCenter: 'CC300 · Sales', currentCostCenter: 'CC100 · IT' }, amountMasked: false, isProfitCenterChange: true,
  asset: { id: 'a1', assetTag: 'S1000000', description: 'Note book', status: 'IN_USE', sapAssetNo: '000001000000-0000', companyCode: '1000' },
  approvals: [{ id: 'ap1', stepNo: 1, approverRole: 'DEPT_MANAGER', decision: 'PENDING' }, { id: 'ap2', stepNo: 2, approverRole: 'ASSET_ACCOUNTANT', decision: 'PENDING' }],
  attachments: [], actions: { approve: 'ap1' }, ...o,
});

describe('request screens (ALM-230)', () => {
  it('inbox → detail → approve with comment', async () => {
    window.history.pushState({}, '', '/requests');
    const posted: { url: string; body: unknown }[] = [];
    let approved = false;
    mockFetch((url, init) => {
      if (url.includes('/approvals/inbox')) return { body: { items: [{ approvalId: 'ap1', kind: 'ASSET_REQUEST', targetId: 'r1', targetNo: 'AR-00001', requestType: 'TRANSFER',
        summary: 'S1000000 → CC300 (손익센터 변경)', requesterName: 'Asset Manager', stepNo: 1, approverRole: 'DEPT_MANAGER', waitingSince: '2026-10-13T15:00:00Z' }], page: 1, pageSize: 50, total: 1 } };
      if (url.includes('/approvals/ap1:approve') && init.method === 'POST') {
        posted.push({ url, body: JSON.parse(String(init.body)) }); approved = true;
        return { body: { id: 'ap1', stepNo: 1, approverRole: 'DEPT_MANAGER', decision: 'APPROVED', requestStatus: 'MGR_APPROVED' } };
      }
      if (url.endsWith('/asset-requests/r1')) return { body: approved ? detail({ status: 'MGR_APPROVED', currentStep: 2, actions: {} }) : detail() };
      if (url.endsWith('/me')) return { body: approver };
      return undefined;
    });
    render(<App initialMe={approver} />);
    const user = userEvent.setup();
    const row = (await screen.findByText('AR-00001')).closest('tr')!;
    expect(within(row).getByText('Transfer (cost center)')).toBeInTheDocument();
    await user.click(row);
    expect(await screen.findByText('CC300 · Sales')).toBeInTheDocument();
    expect(screen.getByText('Yes (ABUMN transfer)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.type(await screen.findByLabelText(/^Comment/), 'OK for Q4');
    const drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ comment: 'OK for Q4' });
    expect(await screen.findByText('Awaiting accountant')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('reject requires a comment', async () => {
    window.history.pushState({}, '', '/requests/r1');
    const posted: unknown[] = [];
    mockFetch((url, init) => {
      if (url.includes(':reject')) { posted.push(JSON.parse(String(init.body))); return { body: { id: 'ap1', stepNo: 1, approverRole: 'DEPT_MANAGER', decision: 'REJECTED' } }; }
      if (url.endsWith('/asset-requests/r1')) return { body: detail() };
      if (url.endsWith('/me')) return { body: approver };
      return undefined;
    });
    render(<App initialMe={approver} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const drawer = screen.getByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Enter a reason for rejection')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    await user.type(within(drawer).getByLabelText(/^Comment/), 'Repairable');
    await user.click(within(drawer).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posted).toEqual([{ comment: 'Repairable' }]));
  });

  it('asset detail: new transfer request validates and submits, purchase section shows the GR', async () => {
    window.history.pushState({}, '', '/assets/a1');
    const posted: unknown[] = [];
    mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: { costCenters: [{ id: 'cc1', code: 'CC100', label: 'IT', extra: { companyCode: '1000' } }, { id: 'cc3', code: 'CC300', label: 'Sales', extra: { companyCode: '1000' } }],
        rooms: [], sites: [], categories: [], models: [], users: [], vendors: [], assetClasses: [] } };
      if (url.endsWith('/asset-requests') && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return { status: 201, body: detail({ status: 'SUBMITTED' }) }; }
      if (url.endsWith('/asset-requests/r1')) return { body: detail({ actions: {} }) };
      if (url.endsWith('/assets/a1')) return { body: { id: 'a1', version: 3, assetTag: 'S1000000', description: 'Note book', categoryId: 'cat', status: 'IN_USE', stage: 'OPERATE',
        source: 'SAP', costCenterId: 'cc1', financial: { isCapitalized: true, companyCode: '1000', sapAssetNo: '000001000000', sapSubNo: '0000', acquisitionValue: 1500 },
        purchase: { poNo: '4500000029', poItem: '00010', vendorName: 'Dell', description: 'Latitude', quantity: 1, grQuantity: 1, unitPrice: 1500,
          goodsReceipt: { materialDoc: '5000000050', docYear: 2026, docItem: '0001', movementType: '101', quantity: 1, postingDate: '2026-10-13' } },
        openRequests: [], editableFields: [] } };
      return undefined;
    });
    render(<App initialMe={manager} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Financial & SAP' }));
    expect(await screen.findByText('5000000050/2026/0001 · 101')).toBeInTheDocument();
    expect(screen.getByText('4500000029/00010')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New request' }));
    const drawer = screen.getByRole('dialog');
    expect((within(drawer).getByLabelText(/^Type/) as HTMLSelectElement).value).toBe('TRANSFER');
    expect(within(drawer).queryByRole('option', { name: 'Register in SAP' })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Submit' }));
    expect((await within(drawer).findAllByText('Required')).length).toBeGreaterThanOrEqual(2);
    await user.selectOptions(within(drawer).getByLabelText(/^Cost center/), 'cc3');
    await user.type(within(drawer).getByLabelText(/^Reason/), 'Move to sales');
    await user.click(within(drawer).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ requestType: 'TRANSFER', assetId: 'a1', reason: 'Move to sales', targetCostCenterId: 'cc3', submit: true });
    expect(await screen.findByText('CC300 · Sales')).toBeInTheDocument();
  });

  it('fix posting error: accounting change restarts approval, sent with If-Match', async () => {
    window.history.pushState({}, '', '/requests/r9');
    const acctMe: Me = { ...approver, permissions: ['request.read', 'sap.finance', 'approval.decide'] };
    const sent: { body: unknown; ifMatch?: string }[] = [];
    const base = detail({ id: 'r9', version: 5, status: 'POST_ERROR', request: { requestType: 'RETIRE', assetId: 'a1', reason: 'old', retireType: 'SCRAP', effectiveDate: '2026-10-01' },
      approvals: [], actions: { fix: true }, posting: { id: 'p9', postingId: 'AR-00009', postingType: 'ASSET_RETIRE', status: 'FAILED', attemptCount: 1, messages: [{ type: 'E', id: 'AA', number: '1', text: 'closed' }] } });
    mockFetch((url, init) => {
      if (url.endsWith('/asset-requests/r9:fix')) {
        sent.push({ body: JSON.parse(String(init.body)), ifMatch: (init.headers as Record<string, string>)['if-match'] });
        return { body: { ...base, status: 'SUBMITTED', actions: {} } };
      }
      if (url.endsWith('/asset-requests/r9')) return { body: base };
      if (url.endsWith('/me')) return { body: acctMe };
      return undefined;
    });
    render(<App initialMe={acctMe} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Fix posting error' }));
    const drawer = screen.getByRole('dialog');
    await user.selectOptions(within(drawer).getByLabelText(/^Retirement type/), 'LOSS');
    expect(within(drawer).getByText(/restarts approval/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Fix' }));
    expect(await within(drawer).findByText('Enter a reason')).toBeInTheDocument();
    await user.type(within(drawer).getByLabelText(/^Reason/), 'It was lost');
    await user.click(within(drawer).getByRole('button', { name: 'Fix' }));
    await waitFor(() => expect(sent).toEqual([{ body: { comment: 'It was lost', changes: { retireType: 'LOSS' } }, ifMatch: '"5"' }]));
    expect(await screen.findByText('Awaiting manager')).toBeInTheDocument();
  });
});
