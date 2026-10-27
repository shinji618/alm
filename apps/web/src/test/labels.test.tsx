import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import { qrMatrix } from '@/lib/qr';
import { code128Widths } from '@/lib/code128';
import type { LabelJob } from '@/pages/labels/types';

const am: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'am@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_MANAGER' }],
  permissions: ['asset.read', 'label.read', 'label.print'], navCounts: {} };
const job = (o: Partial<LabelJob> = {}): LabelJob => ({ id: 'j1', assetId: 'a1', assetTag: 'AT-000001', description: 'Latitude', model: 'Dell Latitude 7440', sapAssetNo: '1000000',
  roomCode: 'R101', companyName: 'BSG AMERICA', templateId: 't1', templateName: 'QR + Code 128', layout: 'QR_CODE128', source: 'BULK', status: 'QUEUED', copies: 1,
  attemptCount: 0, requestedAt: '2026-10-19T12:00:00Z', ...o });
const TEMPLATES = { items: [{ id: 't1', templateCode: 'STD', name: 'QR + Code 128', layout: 'QR_CODE128', widthIn: 2, heightIn: 1, dpi: 203, zpl: '^XA^XZ', isDefault: true, isActive: true }] };
const PRINTERS = { items: [{ id: 'p1', name: 'ATL ZD421', siteCode: 'ATL', deviceName: 'ZD421', connection: 'USB', dpi: 203, isActive: true }] };

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string } | undefined;
function mockFetch(handler: Handler, bp: 'none' | 'ready' | 'writeFails' = 'none') {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined });
    if (url.startsWith('https://localhost:9101') || url.startsWith('http://localhost:9100')) {
      if (bp === 'none') throw new TypeError('Failed to fetch');
      if (url.endsWith('/available')) return new Response(JSON.stringify({ printer: [{ name: 'ZD421', uid: 'usb1', connection: 'usb' }] }), { status: 200 });
      if (url.includes('/default')) return new Response(JSON.stringify({ name: 'ZD421', uid: 'usb1' }), { status: 200 });
      if (url.endsWith('/write')) return bp === 'writeFails' ? new Response('Printer is offline', { status: 500 }) : new Response('', { status: 200 });
    }
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    if (url.endsWith('/label-templates')) return new Response(JSON.stringify(TEMPLATES), { status: 200 });
    if (url.endsWith('/printers')) return new Response(JSON.stringify(PRINTERS), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.text ?? (r.body === undefined ? null : JSON.stringify(r.body)), { status: r.status ?? 200 });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); try { localStorage.clear(); } catch { /* */ } });

describe('label preview encoders', () => {
  it('QR has finder patterns and grows with the text; Code 128 B has start, check and stop', () => {
    const m = qrMatrix('AT-000001');
    expect(m.length).toBe(21);
    expect(m[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(m[1].slice(1, 6).some(Boolean)).toBe(false);
    expect(qrMatrix('https://alm-dev.pasapps.com/assets/0f62d8c6').length).toBeGreaterThan(21);
    const w = code128Widths('AT-000001');
    expect(w.reduce((a, b) => a + b, 0)).toBe(11 * (1 + 9 + 1) + 13);
    expect(w.slice(0, 6).join('')).toBe('211214');
    expect(w.slice(-7).join('')).toBe('2331112');
  });
});

describe('label printing (ALM-250)', () => {
  it('shows the queue and previews, adds by tag, and explains a missing Browser Print', async () => {
    window.history.pushState({}, '', '/labels');
    let rows = [job()];
    const calls = mockFetch((url, init) => {
      if (url.includes('/label-jobs') && init.method === 'POST') { rows = [...rows, job({ id: 'j2', assetId: 'a2', assetTag: 'AT-000002', model: undefined, sapAssetNo: undefined })];
        return { status: 201, body: { items: [rows[1]], page: 1, pageSize: 1, total: 1 } }; }
      if (url.includes('/label-jobs?')) return { body: { items: rows, page: 1, pageSize: 500, total: rows.length, counts: { QUEUED: rows.length } } };
      return undefined;
    });
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    expect(await screen.findByText('Browser Print not found')).toBeInTheDocument();
    expect(screen.getByText(/Zebra Browser Print is not running on this PC/)).toBeInTheDocument();
    const card = await screen.findByRole('figure', { name: 'AT-000001' });
    expect(within(card).getByText('BSG AMERICA')).toBeInTheDocument();
    expect(within(card).getByText('1000000 R101')).toBeInTheDocument();
    expect(within(card).getByTestId('qr')).toBeInTheDocument();
    expect(within(card).getByTestId('code128')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select j1' }));
    expect(screen.getByRole('button', { name: 'Print (1)' })).toBeDisabled();

    await user.type(screen.getByLabelText(/^Add by asset tag/), 'at-000002{Enter}');
    await waitFor(() => expect(calls.find((x) => x.method === 'POST' && x.url.endsWith('/label-jobs'))?.body).toEqual({ assetTags: ['at-000002'], copies: 1 }));
    expect(await screen.findByText('Added 1 label(s) to the queue')).toBeInTheDocument();
    expect(await screen.findByRole('figure', { name: 'AT-000002' })).toBeInTheDocument();
  }, 20000);

  it('prints through Browser Print and reports the result', async () => {
    window.history.pushState({}, '', '/labels');
    let status: LabelJob['status'] = 'QUEUED';
    const calls = mockFetch((url) => {
      if (url.endsWith('/label-jobs:render')) return { body: { renderId: 'r1', deviceName: 'ZD421', printerName: 'ATL ZD421', items: [{ jobId: 'j1', assetTag: 'AT-000001', zpl: '^XA^FDAT-000001^FS^PQ1^XZ' }] } };
      if (url.endsWith('/label-jobs:report')) { status = 'PRINTED'; return { body: { results: [{ id: 'j1', status: 'OK' }] } }; }
      if (url.includes('/label-jobs?')) return { body: { items: status === 'QUEUED' ? [job()] : [], page: 1, pageSize: 500, total: status === 'QUEUED' ? 1 : 0, counts: {} } };
      return undefined;
    }, 'ready');
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    expect(await screen.findByText('Browser Print: 1 printer(s)')).toBeInTheDocument();
    await screen.findByRole('figure', { name: 'AT-000001' });
    await user.click(screen.getByRole('checkbox', { name: 'Select j1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Print (1)' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Print (1)' }));
    expect(await screen.findByText('Sent 1 label(s) to the printer')).toBeInTheDocument();
    expect(calls.find((x) => x.url.endsWith('/label-jobs:render'))?.body).toEqual({ jobIds: ['j1'], printerId: 'p1' });
    const w = calls.find((x) => x.url.endsWith('/write'));
    expect(w?.body).toEqual({ device: { name: 'ZD421', uid: 'usb1', connection: 'usb' }, data: '^XA^FDAT-000001^FS^PQ1^XZ' });
    expect(calls.find((x) => x.url.endsWith('/label-jobs:report'))?.body).toEqual({ renderId: 'r1', results: [{ jobId: 'j1', status: 'PRINTED' }], clientInfo: 'Browser Print · ZD421' });
    expect(await screen.findByText(/Nothing to print/)).toBeInTheDocument();
  }, 20000);

  it('reports a failed send so the job can be printed again', async () => {
    window.history.pushState({}, '', '/labels');
    const calls = mockFetch((url) => {
      if (url.endsWith('/label-jobs:render')) return { body: { renderId: 'r1', printerName: 'ATL ZD421', items: [{ jobId: 'j1', assetTag: 'AT-000001', zpl: '^XA^XZ' }] } };
      if (url.endsWith('/label-jobs:report')) return { body: { results: [{ id: 'j1', status: 'OK' }] } };
      if (url.includes('/label-jobs?')) return { body: { items: [job()], page: 1, pageSize: 500, total: 1, counts: {} } };
      return undefined;
    }, 'writeFails');
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    await screen.findByText('Browser Print: 1 printer(s)');
    await user.click(await screen.findByRole('checkbox', { name: 'Select j1' }));
    await user.click(screen.getByRole('button', { name: 'Print (1)' }));
    expect(await screen.findByText(/Printed 0, failed 1/)).toBeInTheDocument();
    expect(calls.find((x) => x.url.endsWith('/label-jobs:report'))?.body).toMatchObject({ results: [{ jobId: 'j1', status: 'FAILED', error: 'Printer is offline' }] });
  }, 20000);

  it('asset list: selected assets go to the label queue', async () => {
    window.history.pushState({}, '', '/assets');
    const asset = (id: string, tag: string) => ({ id, assetTag: tag, description: 'Laptop', status: 'IN_USE', stage: 'OPERATE', updatedAt: '2026-10-19T00:00:00Z' });
    const calls = mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: { sites: [], categories: [] } };
      if (url.includes('/assets?')) return { body: { items: [asset('a1', 'AT-000001'), asset('a2', 'AT-000002')], page: 1, pageSize: 50, total: 2 } };
      if (url.endsWith('/label-jobs') && init.method === 'POST') return { status: 201, body: { items: [job(), job({ id: 'j2' })], page: 1, pageSize: 2, total: 2 } };
      if (url.includes('/label-jobs?')) return { body: { items: [], page: 1, pageSize: 500, total: 0, counts: {} } };
      return undefined;
    });
    render(<App initialMe={am} />);
    const user = userEvent.setup();
    const print = await screen.findByRole('button', { name: 'Print labels (0)' });
    expect(print).toBeDisabled();
    await user.click(await screen.findByRole('checkbox', { name: 'Select a1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select a2' }));
    await user.click(screen.getByRole('button', { name: 'Print labels (2)' }));
    await waitFor(() => expect(calls.find((x) => x.method === 'POST' && x.url.endsWith('/label-jobs'))?.body).toEqual({ assetIds: ['a1', 'a2'] }));
    expect(await screen.findByRole('heading', { name: 'Labels & tags' })).toBeInTheDocument();
  }, 20000);
});
