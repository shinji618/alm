import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';
import type { WfCatalog, WfDetail, WfStep } from '@/pages/admin/Workflows';

const admin: Me = { userId: 'a1', displayName: 'Admin', email: 'a@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'SYS_ADMIN' }],
  permissions: ['admin.config', 'master.read', 'asset.read'], navCounts: {}, features: { sap: true } };

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 });
    const r = handler(url, init) ?? { status: 404, body: { code: 'ALM-E404', message: 'nope' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

const STEPS: WfStep[] = [
  { key: 'dept', label: 'Department manager', resolver: 'DEPT_MANAGER_RESPONSIBLE', fallback: 'PROXY_ASSET_ACCOUNTANT', mergeSame: true },
  { key: 'accounting', label: 'Asset accounting', resolver: 'ROLE_ASSET_ACCOUNTANT', fallback: 'NONE', mergeSame: false },
];
const OPTIONS = { fixerCannotReapprove: true, requesterNoStep: false, proxyIfAllSkipped: true };
const CATALOG: WfCatalog = {
  subjects: [{ code: 'NEW_ASSET', label: 'New asset registration' }],
  resolvers: [
    { code: 'DEPT_MANAGER_RESPONSIBLE', label: 'Department manager of the responsible cost center' },
    { code: 'DEPT_MANAGER_SOURCE', label: 'Source department manager', subjects: ['TRANSFER'] },
    { code: 'ROLE_ASSET_ACCOUNTANT', label: 'Asset accountant', final: true },
  ],
  fallbacks: [{ code: 'PROXY_ASSET_ACCOUNTANT', label: 'Asset accountant approves as proxy', resolver: 'ROLE_ASSET_ACCOUNTANT' }],
  mandatoryRules: [{ code: 'H-01', label: 'Requester cannot approve' }], maxSteps: 5, appliedToApprovals: false,
};
const DETAIL: WfDetail = { subjectType: 'NEW_ASSET', label: 'New asset registration', appliedToApprovals: false,
  defaultDefinition: { name: 'New asset approval', steps: STEPS, options: OPTIONS }, versions: [] };

describe('workflow definitions (ADM-070)', () => {
  it('lists request types, saves a draft with an added step, then publishes', async () => {
    window.history.pushState({}, '', '/admin/workflows');
    const puts: Array<{ body: any; ifMatch?: string }> = [];
    const calls: string[] = [];
    let detail: WfDetail = DETAIL;
    mockFetch((url, init) => {
      const m = init.method ?? 'GET';
      if (url.endsWith('/admin/workflows') && m === 'GET') {
        return { body: { appliedToApprovals: false, items: [{ subjectType: 'NEW_ASSET', label: 'New asset registration', name: detail.draft?.name ?? 'New asset approval',
          steps: STEPS, hasDraft: !!detail.draft, draftVersion: detail.draft?.versionNo, usesDefault: !detail.published }] } };
      }
      if (url.endsWith('/admin/workflows/catalog')) return { body: CATALOG };
      if (url.includes('/admin/cost-centers')) return { body: { items: [] } };
      if (url.endsWith('/admin/workflows/NEW_ASSET/draft') && m === 'PUT') {
        const b = JSON.parse(String(init.body));
        puts.push({ body: b, ifMatch: (init.headers as Record<string, string>)['if-match'] });
        const v = { id: 'd1', subjectType: 'NEW_ASSET', versionNo: 1, status: 'DRAFT', ...b, version: 1 };
        detail = { ...detail, draft: v };
        return { body: v };
      }
      if (url.endsWith('/admin/workflows/NEW_ASSET/draft:publish')) {
        calls.push(`publish ${(init.headers as Record<string, string>)['if-match']}`);
        const v = { ...detail.draft!, status: 'PUBLISHED' };
        detail = { ...detail, draft: undefined, published: v };
        return { body: v };
      }
      if (url.endsWith('/admin/workflows/NEW_ASSET')) return { body: detail };
      if (url.endsWith('/me')) return { body: admin };
      return undefined;
    });
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'Approval workflows' })).toBeInTheDocument();
    expect(await screen.findByText(/not used when requests are submitted yet/)).toBeInTheDocument();
    const row = (await screen.findByText('New asset registration')).closest('tr')!;
    expect(within(row).getByText('Built-in default')).toBeInTheDocument();
    expect(within(row).getByText('Department manager → Asset accounting')).toBeInTheDocument();

    await user.click(row);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findAllByTestId('wf-step')).toHaveLength(2);
    // TRANSFER 전용 규칙은 이 유형에서 고를 수 없다
    expect(within(drawer).queryByText('Source department manager')).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Add step' }));
    const steps = within(drawer).getAllByTestId('wf-step');
    expect(steps).toHaveLength(3);
    expect(within(steps[2]).getByText('Final')).toBeInTheDocument();      // 새 단계는 최종 단계 앞에 들어간다
    await user.click(within(drawer).getByLabelText('Also exclude the requester from fallback approvers (strict)'));
    await user.click(within(drawer).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].ifMatch).toBeUndefined();
    expect(puts[0].body.steps.map((x: WfStep) => x.key)).toEqual(['dept', 's1', 'accounting']);
    expect(puts[0].body.options.requesterNoStep).toBe(true);
    expect(await within(drawer).findByText('Draft v1')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Publish' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls).toEqual(['publish "1"']));
    expect(puts).toHaveLength(2);
    expect(puts[1].ifMatch).toBe('"1"');
  });

  it('shows server validation errors on the step and runs a test', async () => {
    window.history.pushState({}, '', '/admin/workflows');
    mockFetch((url, init) => {
      const m = init.method ?? 'GET';
      if (url.endsWith('/admin/workflows') && m === 'GET') {
        return { body: { appliedToApprovals: false, items: [{ subjectType: 'NEW_ASSET', label: 'New asset registration', name: 'New asset approval', steps: STEPS, hasDraft: false, usesDefault: true }] } };
      }
      if (url.endsWith('/admin/workflows/catalog')) return { body: CATALOG };
      if (url.includes('/admin/cost-centers')) return { body: { items: [{ id: 'cc1', companyId: 'co1', companyCode: '1000', costCenterCode: 'FBSG01', name: 'FCM', isActive: true }] } };
      if (url.endsWith('/draft') && m === 'PUT') {
        return { status: 400, body: { code: 'ALM-E100', message: 'bad', errors: [{ field: 'steps[1].fallback', code: 'ALM-E100', message: 'Cannot skip the final step' }] } };
      }
      if (url.endsWith('/admin/workflows/NEW_ASSET:simulate')) {
        return { body: { subjectType: 'NEW_ASSET', source: 'INPUT', canSubmit: false, steps: [
          { key: 'dept', label: 'Department manager', resolver: 'DEPT_MANAGER_RESPONSIBLE', status: 'ACTIVE', proxy: false, approvers: [{ id: 'u1', name: 'HOD Manager', detail: 'FBSG01' }] },
          { key: 'accounting', label: 'Asset accounting', resolver: 'ROLE_ASSET_ACCOUNTANT', status: 'ACTIVE', proxy: false, missing: true, approvers: [] }] } };
      }
      if (url.endsWith('/admin/workflows/NEW_ASSET')) return { body: DETAIL };
      if (url.endsWith('/me')) return { body: admin };
      return undefined;
    });
    render(<App initialMe={admin} />);
    const user = userEvent.setup();
    await user.click((await screen.findByText('New asset registration')).closest('tr')!);
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findAllByTestId('wf-step');
    await user.click(within(drawer).getByRole('button', { name: 'Save draft' }));
    expect(await within(drawer).findByText('Cannot skip the final step')).toBeInTheDocument();

    await user.selectOptions(within(drawer).getByLabelText('Cost center'), 'cc1');
    await user.click(within(drawer).getByRole('button', { name: 'Run test' }));
    const sim = await within(drawer).findByTestId('wf-sim');
    expect(within(sim).getByText('HOD Manager (FBSG01)')).toBeInTheDocument();
    expect(within(sim).getByText('No approver')).toBeInTheDocument();
    expect(within(sim).getByText(/could not be submitted/)).toBeInTheDocument();
  });
});
