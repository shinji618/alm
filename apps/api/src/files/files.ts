// 첨부·사진(openapi presignAttachment·downloadAttachment·pdaPresignPhoto, 10 정의서 7.2, 09 10장).
// 파일은 서버를 거치지 않는다: api는 S3 사전 서명 URL만 주고 브라우저·PDA가 S3에 직접 PUT/GET 한다.
// PUT URL에는 Content-Type·Content-Length·SHA-256 체크섬을 서명해 넣어, 신고한 파일과 다른 파일은 S3가 거절한다.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check, UUID } from '../common/validate';
import type { Principal } from '../auth/principal';

export interface FileStore {
  presignPut(key: string, o: { contentType: string; size: number; sha256b64: string; expiresSec: number }): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, o: { fileName: string; contentType: string; expiresSec: number }): Promise<string>;
  head(key: string): Promise<{ size: number; sha256b64?: string } | null>;
  scanStatus(key: string): Promise<string | undefined>;      // GuardDuty S3 악성코드 검사 태그
}

// 대상 종류 → 표, 올리기(쓰기)·내려받기(조회) 권한. 범위(회사코드·코스트센터 등) 판정은 각 업무 화면(4.x)의 ScopeService가 더한다
export const OWNERS = {
  asset: { table: 'asset', write: ['asset.write'], read: ['asset.read'] },
  asset_request: { table: 'asset_request', write: ['request.create', 'asset.write'], read: ['request.read'] },
  contract: { table: 'contract', write: ['contract.write'], read: ['contract.read'] },
  count_item: { table: 'count_item', write: ['count.manage', 'count.scan'], read: ['count.read'] },
  count_unregistered: { table: 'count_unregistered', write: ['count.manage', 'count.scan'], read: ['count.read'] },
} as const;
export type OwnerType = keyof typeof OWNERS;

const MB = 1024 * 1024;
export const LIMITS = { web: 25 * MB, pda: 5 * MB };
export const TTL = { webPut: 300, pdaPut: 900, get: 300 };   // 초. PDA는 약한 무선망에서 올리므로 15분
// 실행 파일·스크립트는 받지 않는다(허용 목록)
const DOC_TYPES = new Set(['application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const BAD_EXT = /\.(exe|dll|bat|cmd|com|msi|ps1|vbs|js|jar|sh|scr|hta|lnk|iso)$/i;

const keyOf = (tenantId: string, ownerType: string, id: string) => `tenant/${tenantId}/${ownerType}/${id}`;
const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
// 범위가 테넌트 전체(ALL)인 권한만 통과시킨다. 본인(OWN)·담당 코스트센터(CC)·배정(TASK) 범위는 대상 행을 따져야 하므로
// 업무 화면의 ScopeService(4.2·4.3·4.4)가 붙을 때까지 거부한다(기본 거부: 일반 사용자가 남의 자산 첨부를 받지 못하게)
const can = (p: Principal, perms: readonly string[]) => perms.some((x) => (p.permissions.get(x) ?? []).some((s) => s === 'ALL' || s === '-'));

export interface PresignOut { attachmentId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }

function oneOf<T extends string>(chk: Check, o: Record<string, unknown>, k: string, values: readonly T[], required = true): T | undefined {
  const v = chk.str(o, k, { required });
  if (v !== undefined && !values.includes(v as T)) { chk.fail(k, `허용 값: ${values.join(', ')}`); return undefined; }
  return v as T | undefined;
}

function checkFile(chk: Check, o: Record<string, unknown>, max: number, types: Set<string>) {
  const fileName = chk.str(o, 'fileName', { required: true, max: 200 });
  const contentType = chk.str(o, 'contentType', { required: true, max: 100 });
  const size = chk.int(o, 'sizeBytes', { min: 1 });
  if (o.sizeBytes === undefined) chk.fail('sizeBytes', '필수 값입니다');
  const sha = chk.str(o, 'sha256', { required: true, pattern: /^[0-9a-f]{64}$/i });
  if (fileName && (BAD_EXT.test(fileName) || /[\\/\u0000-\u001f]/.test(fileName))) chk.fail('fileName', '허용되지 않는 파일 이름·형식');
  if (contentType && !types.has(contentType.toLowerCase())) chk.fail('contentType', `허용 형식: ${[...types].join(', ')}`);
  chk.done();
  if (size! > max) throw new AlmError(413, 'ALM-E100', `파일이 너무 큽니다(최대 ${max / MB} MB)`);
  return { fileName: fileName!, contentType: contentType!.toLowerCase(), size: size!, sha: sha!.toLowerCase() };
}

// 웹: 대상(자산·요청·계약·실사 항목)이 정해져 있으므로 발급 때 owner_id·linked_at을 채운다
export async function presignWeb(c: PoolClient, store: FileStore, p: Principal, body: unknown, now = new Date()): Promise<PresignOut> {
  const chk = new Check(body);
  const b = chk.obj();
  const ownerType = oneOf(chk, b, 'ownerType', Object.keys(OWNERS) as OwnerType[]);
  const ownerId = chk.str(b, 'ownerId', { required: true, pattern: UUID });
  const kind = oneOf(chk, b, 'kind', ['PHOTO', 'DOCUMENT'] as const);
  const f = checkFile(chk, b, LIMITS.web, kind === 'PHOTO' ? IMAGE_TYPES : new Set([...DOC_TYPES, ...IMAGE_TYPES]));
  const o = OWNERS[ownerType!];
  if (!can(p, o.write)) throw E.forbidden('이 대상에 파일을 올릴 권한이 없습니다');
  // 대상 행이 같은 테넌트에 있는지(RLS). 표 이름은 OWNERS 상수에서만 온다
  const exists = (await c.query(`SELECT 1 FROM ${o.table} WHERE id = $1`, [ownerId])).rowCount;
  if (!exists) throw E.notFound('대상을 찾을 수 없습니다');
  return issue(c, store, p, { ownerType: ownerType!, ownerId: ownerId!, kind: kind!, ...f }, TTL.webPut, now);
}

// PDA 실사 사진: 대상(스캔·미등록)은 나중에 전송될 때 연결한다(linked_at 비움, 24시간 안에 연결 안 되면 정리 대상 — 4.8)
export async function presignPda(c: PoolClient, store: FileStore, p: Principal, body: unknown, now = new Date()): Promise<PresignOut> {
  const chk = new Check(body);
  const b = chk.obj();
  const ownerType = oneOf(chk, b, 'ownerType', ['count_item', 'count_unregistered'] as const, false) ?? 'count_item';
  const f = checkFile(chk, b, LIMITS.pda, new Set(['image/jpeg', 'image/png']));
  return issue(c, store, p, { ownerType, ownerId: null, kind: 'PHOTO', ...f }, TTL.pdaPut, now);
}

async function issue(c: PoolClient, store: FileStore, p: Principal,
  a: { ownerType: OwnerType; ownerId: string | null; kind: string; fileName: string; contentType: string; size: number; sha: string }, ttl: number, now: Date): Promise<PresignOut> {
  const id = randomUUID();
  const key = keyOf(p.tenantId, a.ownerType, id);
  await c.query(
    `INSERT INTO attachment (id, tenant_id, owner_type, owner_id, kind, file_name, content_type, size_bytes, s3_key, sha256, linked_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, p.tenantId, a.ownerType, a.ownerId, a.kind, a.fileName, a.contentType, a.size, key, a.sha, a.ownerId ? now : null, p.userId]);
  const put = await store.presignPut(key, { contentType: a.contentType, size: a.size, sha256b64: hexToB64(a.sha), expiresSec: ttl });
  return { attachmentId: id, uploadUrl: put.url, headers: put.headers, expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
}

export async function downloadUrl(c: PoolClient, store: FileStore, p: Principal, id: string, scanRequired: boolean, now = new Date()) {
  const a = (await c.query(`SELECT owner_type, file_name, content_type, s3_key, sha256, linked_at FROM attachment WHERE id = $1`, [id])).rows[0] as
    { owner_type: string; file_name: string; content_type: string; s3_key: string; sha256: string | null; linked_at: Date | null } | undefined;
  if (!a || !a.linked_at) throw E.notFound('첨부를 찾을 수 없습니다');
  const o = OWNERS[a.owner_type as OwnerType];
  if (!o || !can(p, o.read)) throw E.forbidden('이 첨부를 볼 권한이 없습니다');
  const obj = await store.head(a.s3_key);
  if (!obj) throw new AlmError(409, 'ALM-E111', '파일 업로드가 끝나지 않았습니다');
  if (a.sha256 && obj.sha256b64 && obj.sha256b64 !== hexToB64(a.sha256)) throw new AlmError(409, 'ALM-E111', '파일이 등록된 내용과 다릅니다');
  if (scanRequired) {
    const s = await store.scanStatus(a.s3_key);
    if (s === 'THREATS_FOUND') throw new AlmError(403, 'ALM-E401', '악성코드가 발견된 파일은 내려받을 수 없습니다');
    if (s !== 'NO_THREATS_FOUND') throw new AlmError(409, 'ALM-E111', '보안 검사가 끝나지 않았습니다. 잠시 뒤 다시 시도하세요');
  }
  const url = await store.presignGet(a.s3_key, { fileName: a.file_name, contentType: a.content_type, expiresSec: TTL.get });
  return { url, expiresAt: new Date(now.getTime() + TTL.get * 1000).toISOString() };
}

export async function s3FileStore(bucket: string, region: string): Promise<FileStore> {
  const [{ S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, GetObjectTaggingCommand }, { getSignedUrl }] =
    await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
  // 체크섬은 우리가 직접 넣는다(SDK가 CRC32를 따로 붙이지 않게)
  const s3 = new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const signed = new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']);
  return {
    async presignPut(key, o) {
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: o.contentType, ContentLength: o.size, ChecksumSHA256: o.sha256b64 }),
        { expiresIn: o.expiresSec, signableHeaders: signed, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
      return { url, headers: { 'Content-Type': o.contentType, 'x-amz-checksum-sha256': o.sha256b64 } };
    },
    async presignGet(key, o) {
      const name = encodeURIComponent(o.fileName).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: o.contentType,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${name}` }), { expiresIn: o.expiresSec });
    },
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
        return { size: Number(r.ContentLength ?? 0), sha256b64: r.ChecksumSHA256 };
      } catch (e) {
        if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async scanStatus(key) {
      const r = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      return r.TagSet?.find((t) => t.Key === 'GuardDutyMalwareScanStatus')?.Value;
    },
  };
}
