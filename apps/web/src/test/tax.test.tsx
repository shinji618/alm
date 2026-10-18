import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { FilingDetail, FilingSummary } from '@/pages/tax/types';
import { nextTaxYear } from '@/pages/tax/TaxHome';

const acct: Me = { userId: 'u1', displayName: 'Accountant', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_ACCOUNTANT' }],
  permissions: ['asset.read', 'tax.read', 'tax.manage'], navCounts: {}, features: { sap: true } };
const viewer: Me = { ...acct, roles: [{ role: 'AUDITOR' }], permissions: ['asset.read', 'tax.read'] };

const summary = (o: Partial<FilingSummary> = {}): FilingSummary => ({ id: 'f25', version: 3, companyId: 'co', companyCode: '1000', jurisdictionId: 'j1', state: 'GA', county: 'Fulton',
  jurisdictionName: 'Fulton County, GA', formCode: 'PT-50P', taxYear: 2025, lienDate: '2025-01-01', dueDate: '2025-04-01', status: 'ASSESSED', assetCount: 40,
  totalCost: 120000, totalMarketValue: 80000, exemption: 0, assessedValue: 32000, estimatedTax: 960, actualTax: 985.5, filedAt: '2025-03-20', ...o });
const detail = (o: Partial<FilingDetail> = {}): FilingDetail => ({ ...summary({ id: 'f26', taxYear: 2026, status: 'DRAFT', actualTax: undefined, filedAt: undefined, lienDate: '2026-01-01',
  dueDate: '2026-04-01', assetCount: 3, totalCost: 12000, totalMarketValue: 9140, assessedValue: 3656, estimatedTax: 109.68 }),
  params: { assessmentRatio: 0.4, millage: 30, exemptionMode: 'NONE', exemptionAmount: 0, factorSet: 'GA_DOR', factorTableYear: 2024, factorSource: 'GA DOR', priorFilingYear: 2025, taxable: true },
  warnings: [{ code: 'UNKNOWN_COST', count: 1, message: '1 asset has no cost' }],
  byType: [{ propertyType: 'EQUIPMENT', count: 2, cost: 12000, marketValue: 9140 }],
  schedule: [{ propertyType: 'EQUIPMENT', acquisitionYear: 2025, lifeClass: 'I', count: 1, cost: 2000, marketValue: 1740, factor: 0.87 }, { propertyType: 'EQUIPMENT', acquisitionYear: 2024, lifeClass: 'I', count: 1, cost: 10000, marketValue: 7400, factor: 0.74 }],
  changes: { NEW: { count: 1, cost: 2000 }, CARRIED: { count: 2, cost: 10000 }, DISPOSED: { count: 1, cost: 500 } },
  prior: { id: 'f25', taxYear: 2025, status: 'ASSESSED', totalCost: 120000, totalMarketValue: 80000, assessedValue: 32000, estimatedTax: 960, actualTax: 985.5 }, ...o });

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown; raw?: Response } | undefined) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    if (r.raw) return r.raw;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('property tax (ALM-260)', () => {
  it('defaults to the next filing year', () => {
    const ga = { lienMonth: 1, lienDay: 1, dueMonth: 4, dueDay: 1 };
    const al = { lienMonth: 10, lienDay: 1, dueMonth: 12, dueDay: 31 };
    expect(nextTaxYear(ga, new Date('2026-10-18T12:00:00Z'))).toBe(2027);
    expect(nextTaxYear(ga, new Date('2026-03-10T12:00:00Z'))).toBe(2026);
    expect(nextTaxYear(al, new Date('2026-10-18T12:00:00Z'))).toBe(2026);
  });

  it('lists past filings and creates a new one', async () => {
    window.history.pushState({}, '', '/tax');
    const calls = mockFetch((url, init) => {
      if (url.includes('/lookups')) return { body: { companies: [{ id: 'co', code: '1000', label: 'BSG America' }] } };
      if (url.endsWith('/tax/jurisdictions')) return { body: { items: [{ id: 'j1', version: 1, state: 'GA', county: 'Fulton', name: 'Fulton County, GA', taxable: true, lienMonth: 1, lienDay: 1,
        assessmentRatio: 0.4, millage: 30, exemptionMode: 'THRESHOLD', exemptionAmount: 20000, factorSet: 'GA_DOR', isActive: true, sites: [{ id: 's1', siteCode: 'ATL', name: 'Atlanta' }] }] } };
      if (url.endsWith('/tax/filings') && init.method === 'POST') return { status: 201, body: detail() };
      if (url.includes('/tax/filings?') || url.endsWith('/tax/filings')) return { body: { items: [summary()], years: [2025] } };
      if (url.endsWith('/tax/filings/f26')) return { body: detail() };
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    expect(await screen.findByText('GA · Fulton')).toBeInTheDocument();
    expect(screen.getByText('$985.50')).toBeInTheDocument();
    expect(screen.getByText(/1 filing\(s\) · estimated \$960\.00 · actual \$985\.50/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New filing' }));
    const drawer = screen.getByRole('dialog');
    await user.selectOptions(await within(drawer).findByLabelText(/^Jurisdiction/), 'j1');
    await user.clear(within(drawer).getByLabelText(/^Tax year/));
    await user.type(within(drawer).getByLabelText(/^Tax year/), '2026');
    expect(within(drawer).getByText('Lien date 2026-01-01')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/tax/filings'))?.body).toEqual({ companyId: 'co', jurisdictionId: 'j1', taxYear: 2026 }));
    expect(await screen.findByText('2026 · Fulton County, GA')).toBeInTheDocument();
    expect(screen.getByText('1 asset has no cost')).toBeInTheDocument();
    expect(screen.getByText('$109.68')).toBeInTheDocument();
  }, 20000);

  it('exports Excel, marks filed and shows changes vs prior year', async () => {
    window.history.pushState({}, '', '/tax/filings/f26');
    let status: FilingDetail['status'] = 'DRAFT';
    const created: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => { created.push('blob'); return 'blob:x'; }, revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/tax/filings/f26/export')) return { raw: new Response(new Blob(['PK']), { status: 200,
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="BPP_2026_GA_Fulton_1000.xlsx"' } }) };
      if (url.endsWith('/tax/filings/f26:file') && init.method === 'POST') { status = 'FILED'; return { body: detail({ status }) }; }
      if (url.endsWith('/tax/filings/f26')) return { body: detail({ status, filedAt: status === 'DRAFT' ? undefined : '2026-03-20' }) };
      if (url.includes('/tax/filings/f26/lines')) return { body: { items: [{ assetTag: 'AT-000009', description: 'Old printer', propertyType: 'EQUIPMENT', change: 'DISPOSED', originalCost: 500, disposalDate: '2025-06-01' }], page: 1, pageSize: 100, total: 1 } };
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    expect(await screen.findByText('2026 · Fulton County, GA')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export Excel' }));
    expect(await screen.findByText('Downloaded BPP_2026_GA_Fulton_1000.xlsx')).toBeInTheDocument();
    expect(created).toHaveLength(1);
    expect(click).toHaveBeenCalled();
    click.mockRestore();

    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));
    const drawer = screen.getByRole('dialog');
    await user.type(within(drawer).getByLabelText(/^Filing reference/), 'FUL-26-001');
    await user.click(within(drawer).getByRole('button', { name: 'Mark as filed' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith(':file'))?.body).toMatchObject({ filingRef: 'FUL-26-001' }));
    expect(await screen.findByRole('button', { name: 'Record assessment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recalculate' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Changes vs prior year' }));
    await user.click(screen.getByRole('button', { name: /Disposals/ }));
    expect(await screen.findByText('AT-000009')).toBeInTheDocument();
  }, 20000);

  it('sets the property type of an asset class', async () => {
    window.history.pushState({}, '', '/tax?tab=types');
    const calls = mockFetch((url, init) => {
      if (url.endsWith('/tax/property-types')) {
        return { body: { assetClasses: [{ id: 'c1', classCode: '00003100', name: 'Vehicles', suggested: 'VEHICLE' }, { id: 'c2', classCode: 'RS1030', name: 'RS1030', suggested: 'EQUIPMENT', propertyType: init.method === 'PUT' ? 'INTANGIBLE' : undefined }],
          categories: [{ id: 'k1', categoryCode: 'NB', name: 'Notebook', classCode: '00003200', inherited: 'EQUIPMENT' }] } };
      }
      return undefined;
    });
    render(<App initialMe={acct} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('option', { name: 'Guess: Vehicles' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'From asset class: Furniture, fixtures, machinery & equipment' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Property type RS1030'), 'INTANGIBLE');
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ assetClasses: [{ id: 'c2', propertyType: 'INTANGIBLE' }] }));
  }, 20000);

  it('read-only users see filings without manage actions', async () => {
    window.history.pushState({}, '', '/tax/filings/f26');
    mockFetch((url) => (url.endsWith('/tax/filings/f26') ? { body: detail() } : undefined));
    render(<App initialMe={viewer} />);
    expect(await screen.findByText('2026 · Fulton County, GA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Excel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as filed' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Property tax' })).toBeInTheDocument();
  });
});
