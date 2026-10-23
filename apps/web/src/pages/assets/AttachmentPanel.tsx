// 사진·첨부(ALM-111 첨부 탭, 요청 등에서도 재사용). 파일은 서버를 거치지 않는다:
//   SHA-256 계산 → POST /attachments:presign → S3에 직접 PUT → POST /attachments/{id}:complete(크기·체크섬 확인 뒤 연결)
//   사진은 미리보기(download?inline=true, 5분 URL). 보안 검사(GuardDuty)가 끝나기 전에는 '검사 중'
import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DataTable, EmptyState, StatusPill, useConfirm, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import s from './assets.module.css';

export interface AttachmentRow { id: string; fileName: string; contentType: string; sizeBytes: number; kind: 'PHOTO' | 'DOCUMENT'; source?: 'ASSET' | 'COUNT' | 'OTHER';
  uploadedBy: string; createdAt: string }
interface Presign { attachmentId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }
interface Upload { key: string; name: string; state: 'working' | 'done' | 'error'; error?: string }

const MB = 1024 * 1024;
const MAX = 25 * MB;
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const DOCS = ['application/pdf', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
const BY_EXT = new Map([['heic', 'image/heic'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['pdf', 'application/pdf'],
  ['csv', 'text/csv'], ['txt', 'text/plain']]);
const typeOf = (f: File) => (f.type || BY_EXT.get(f.name.split('.').pop()?.toLowerCase() ?? '') || '').toLowerCase();
const size = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function bytes(f: File): Promise<ArrayBuffer> {
  if (typeof f.arrayBuffer === 'function') return f.arrayBuffer();
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as ArrayBuffer);
    r.onerror = () => fail(r.error);
    r.readAsArrayBuffer(f);
  });
}

async function sha256Hex(f: File): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array(await bytes(f)));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function AttachmentPanel({ ownerType, ownerId, listPath, canWrite }: { ownerType: 'asset' | 'asset_request'; ownerId: string; listPath: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const list = useAsync((sig) => api.get<{ items: AttachmentRow[] }>(listPath, sig), [listPath]);
  const rows = list.data?.items ?? [];
  const photos = rows.filter((x) => x.kind === 'PHOTO');
  const docs = rows.filter((x) => x.kind !== 'PHOTO');

  const setUp = (key: string, u: Partial<Upload>) => setUploads((xs) => xs.map((x) => (x.key === key ? { ...x, ...u } : x)));
  const send = async (files: File[]) => {
    const batch = files.map((f, i) => ({ f, key: `${Date.now()}-${i}-${f.name}` }));
    setUploads((xs) => [...xs.filter((x) => x.state !== 'done'), ...batch.map((b) => ({ key: b.key, name: b.f.name, state: 'working' as const }))]);
    for (const { f, key } of batch) {
      const type = typeOf(f);
      try {
        if (f.size > MAX) throw new Error(t('asset.att.tooLarge'));
        if (![...IMAGES, ...DOCS].includes(type)) throw new Error(t('asset.att.badType'));
        const ps = await api.post<Presign>('/attachments:presign', { ownerType, ownerId, fileName: f.name, contentType: type, sizeBytes: f.size,
          sha256: await sha256Hex(f), kind: IMAGES.includes(type) ? 'PHOTO' : 'DOCUMENT' });
        const put = await fetch(ps.uploadUrl, { method: 'PUT', headers: ps.headers, body: f });
        if (!put.ok) throw new Error(t('asset.att.putFailed', { status: put.status }));
        await api.post(`/attachments/${ps.attachmentId}:complete`);
        setUp(key, { state: 'done' });
      } catch (e) {
        setUp(key, { state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    list.reload();
  };
  const pick = (fl: FileList | null) => { if (fl?.length) void send(Array.from(fl)); };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (canWrite) pick(e.dataTransfer.files); };

  const open = async (x: AttachmentRow) => {
    try {
      const r = await api.get<{ url: string }>(`/attachments/${x.id}:download${x.kind === 'PHOTO' ? '?inline=true' : ''}`);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const remove = async (x: AttachmentRow) => {
    if (!(await confirm({ title: t('asset.att.deleteTitle', { name: x.fileName }), message: t('asset.att.deleteMessage'), danger: true, confirmLabel: t('asset.att.delete') }))) return;
    try {
      await api.del(`/attachments/${x.id}`);
      toast.show(t('asset.att.deleted'), 'success');
      list.reload();
    } catch (e) { toast.show(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const deletable = (x: AttachmentRow) => canWrite && x.source !== 'COUNT';

  return (
    <div>
      {canWrite && (
        <div className={over ? `${s.dropZone} ${s.dropOver}` : s.dropZone} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <span className="muted">{t('asset.att.drop')}</span>
          <Button onClick={() => input.current?.click()}>{t('asset.att.add')}</Button>
          <input ref={input} type="file" multiple hidden aria-label={t('asset.att.add')} accept={[...IMAGES, ...DOCS, '.heic'].join(',')}
            onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
        </div>
      )}
      {uploads.length > 0 && (
        <ul className={s.uploads} aria-live="polite">
          {uploads.map((u) => (
            <li key={u.key}>
              <StatusPill tone={u.state === 'done' ? 'ok' : u.state === 'error' ? 'bad' : 'info'}>{t(`asset.att.${u.state}`)}</StatusPill> {u.name}
              {u.error && <span className="small"> · {u.error}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className={s.attHead}>
        <h3>{t('asset.att.photos')} <span className="muted small">({photos.length})</span></h3>
        {canWrite && <>
          <Button size="sm" onClick={() => photoInput.current?.click()}>{t('asset.att.addPhoto')}</Button>
          <input ref={photoInput} type="file" multiple hidden aria-label={t('asset.att.addPhoto')} accept={[...IMAGES, '.heic'].join(',')}
            onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
        </>}
      </div>
      {photos.length ? (
        <div className={s.thumbs}>
          {photos.map((x) => (
            <figure key={x.id} className={s.thumb}>
              <button type="button" className={s.thumbBtn} onClick={() => void open(x)} aria-label={t('asset.att.open', { name: x.fileName })}>
                <Thumb id={x.id} alt={x.fileName} />
              </button>
              <figcaption className="small">
                {x.source === 'COUNT' && <StatusPill tone="accent">{t('asset.att.fromCount')}</StatusPill>} {x.uploadedBy} · {formatDateTime(x.createdAt)}
                {deletable(x) && <> · <button type="button" className="link" onClick={() => void remove(x)}>{t('asset.att.delete')}</button></>}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : <EmptyState message={t('asset.att.noPhotos')} />}

      <div className={s.attHead}>
        <h3>{t('asset.att.documents')} <span className="muted small">({docs.length})</span></h3>
        {canWrite && <>
          <Button size="sm" onClick={() => docInput.current?.click()}>{t('asset.att.addDoc')}</Button>
          <input ref={docInput} type="file" multiple hidden aria-label={t('asset.att.addDoc')} accept={[...DOCS, '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt'].join(',')}
            onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
        </>}
      </div>
      <DataTable rows={docs} loading={list.loading} rowId={(x) => x.id} empty={<EmptyState message={t('asset.detail.noAttachments')} />}
        columns={[
          { key: 'fileName', label: t('asset.attachmentCol.name'), render: (x) => <button type="button" className="link" onClick={() => void open(x)}>{x.fileName}</button> },
          { key: 'sizeBytes', label: t('asset.attachmentCol.size'), align: 'right', render: (x) => size(x.sizeBytes) },
          { key: 'uploadedBy', label: t('asset.attachmentCol.by') },
          { key: 'createdAt', label: t('asset.attachmentCol.at'), render: (x) => formatDateTime(x.createdAt) },
          { key: 'id', label: '', render: (x) => (deletable(x) ? <button type="button" className="link" onClick={() => void remove(x)}>{t('asset.att.delete')}</button> : null) },
        ]} />
    </div>
  );
}

// 사진 미리보기: 짧은 URL(5분)을 받아 표시. 보안 검사 전(409)이면 '검사 중'
function Thumb({ id, alt }: { id: string; alt: string }) {
  const { t } = useTranslation();
  const r = useAsync((sig) => api.get<{ url: string }>(`/attachments/${id}:download?inline=true`, sig), [id]);
  if (r.error) return <span className={s.thumbEmpty}>{r.error instanceof ApiError && r.error.status === 409 ? t('asset.att.scanning') : t('asset.att.unavailable')}</span>;
  if (!r.data) return <span className={s.thumbEmpty}>{t('common.loading')}</span>;
  return <img src={r.data.url} alt={alt} loading="lazy" />;
}
