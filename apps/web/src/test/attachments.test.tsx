import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { clearToken } from '@/lib/api';
import type { Me } from '@/lib/session';

const mgr: Me = { userId: 'u1', displayName: 'Asset Manager', email: 'm@bsg.test', locale: 'en', tenantCode: 'TEST', roles: [{ role: 'ASSET_MANAGER' }],
  permissions: ['asset.read', 'asset.write'], navCounts: {}, features: { sap: true } };
const ASSET = { id: 'a1', version: 1, assetTag: 'AT-000002', description: 'Laptop', categoryId: 'cat', status: 'IN_STOCK', stage: 'OPERATE', source: 'MANUAL',
  financial: { isCapitalized: false, companyCode: '1000', sapEnabled: true }, openRequests: [], editableFields: [] };

afterEach(() => { vi.unstubAllGlobals(); clearToken(); window.history.pushState({}, '', '/'); });

describe('asset attachments (ALM-111)', () => {
  it('uploads a photo (presign → S3 PUT → complete), previews photos, deletes, and keeps count photos', async () => {
    window.history.pushState({}, '', '/assets/a1');
    const calls: { url: string; method: string; body?: unknown; headers?: unknown }[] = [];
    let items: unknown[] = [
      { id: 'p1', fileName: 'scan.jpg', contentType: 'image/jpeg', sizeBytes: 2048, kind: 'PHOTO', source: 'COUNT', uploadedBy: 'Counter', createdAt: '2026-10-15T15:00:00Z' },
      { id: 'd1', fileName: 'warranty.pdf', contentType: 'application/pdf', sizeBytes: 3 * 1024 * 1024, kind: 'DOCUMENT', source: 'ASSET', uploadedBy: 'Asset Manager', createdAt: '2026-10-15T15:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? 'FILE' : undefined, headers: init.headers });
      const json = (b: unknown, status = 200) => new Response(b === undefined ? null : JSON.stringify(b), { status });
      if (url.endsWith('/auth/refresh')) return json({ accessToken: 'tok' });
      if (url.startsWith('https://s3.test/')) return new Response('', { status: 200 });
      if (url.endsWith('/attachments:presign')) return json({ attachmentId: 'n1', uploadUrl: 'https://s3.test/put/n1', headers: { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'abc' }, expiresAt: 'x' });
      if (url.endsWith('/attachments/n1:complete')) {
        items = [{ id: 'n1', fileName: 'front.jpg', contentType: 'image/jpeg', sizeBytes: 5, kind: 'PHOTO', source: 'ASSET', uploadedBy: 'Asset Manager', createdAt: '2026-10-16T15:00:00Z' }, ...items];
        return json(items[0]);
      }
      if (url.includes(':download')) return url.includes('/p1') ? json({ code: 'ALM-E111', message: 'scan' }, 409) : json({ url: `https://s3.test/get/${url.split('/attachments/')[1]}` });
      if (url.endsWith('/attachments/d1') && method === 'DELETE') { items = items.filter((x) => (x as { id: string }).id !== 'd1'); return json(undefined, 204); }
      if (url.endsWith('/assets/a1/attachments')) return json({ items });
      if (url.includes('/lookups')) return json({});
      if (url.endsWith('/assets/a1')) return json(ASSET);
      return json({ code: 'ALM-E404', message: 'nope' }, 404);
    }));
    render(<App initialMe={mgr} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Attachments' }));
    expect(await screen.findByText('Security scan in progress')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
    expect(screen.getByText('3.0 MB')).toBeInTheDocument();

    const file = new File(['hello'], 'front.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Add photos or files'), file);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/attachments/n1:complete'))).toBe(true));
    const presign = calls.find((c) => c.url.endsWith('/attachments:presign'))!.body as Record<string, unknown>;
    expect(presign).toEqual({ ownerType: 'asset', ownerId: 'a1', fileName: 'front.jpg', contentType: 'image/jpeg', sizeBytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', kind: 'PHOTO' });
    const put = calls.find((c) => c.url === 'https://s3.test/put/n1')!;
    expect(put.method).toBe('PUT'); expect(put.headers).toEqual({ 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'abc' });
    expect(await screen.findByAltText('front.jpg')).toHaveAttribute('src', 'https://s3.test/get/n1:download?inline=true');
    expect(screen.getByText('Done')).toBeInTheDocument();

    const bad = new File(['x'], 'run.exe', { type: 'application/x-msdownload' });
    fireEvent.change(screen.getByLabelText('Add photos or files'), { target: { files: [bad] } });   // accept 필터를 거치지 않은 선택(끌어 놓기 등)
    expect(await screen.findByText(/File type not allowed/)).toBeInTheDocument();

    const docRow = screen.getByText('warranty.pdf').closest('tr')!;
    await user.click(within(docRow).getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('warranty.pdf')).not.toBeInTheDocument());
    // 실사 사진에는 삭제 버튼이 없다
    const countFig = screen.getByText('Count').closest('figure')!;
    expect(within(countFig).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
