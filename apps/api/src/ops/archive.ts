// 감사 기록 월 파티션 관리와 10년 보관(09 8.3, 10 정의서 6.3·7.4). 보관 계정(alm_archive_login = alm_audit_owner 멤버)으로 실행한다.
//   partman       : 매일 — log_partition_maintain(3): 이번 달 ~ 3개월 뒤 파티션, 기본 파티션에 쌓인 행 이동
//   audit-archive : 매월 — 13개월 온라인 기간이 지난 파티션 → S3 감사 버킷(Object Lock 준수 모드 10년)
//                   → 내려받아 체크섬·건수 확인 → log_partition_drop(건수 재확인 후 분리·삭제)
// 형식은 NDJSON + gzip(한 줄 = 한 행, row_to_json). Athena JSON SerDe로 그대로 조회한다.
import { createHash } from 'node:crypto';
import { gunzipSync, createGzip } from 'node:zlib';
import type { ClientBase } from 'pg';
import { log } from '../common/log';

export const LOG_TABLES = ['audit_log', 'security_event'] as const;
export type LogTable = (typeof LOG_TABLES)[number];
const PART = /^(audit_log|security_event)_p(\d{4})(\d{2})$/;
const BATCH = 5000;

// S3 감사 버킷. 시험에서는 메모리 구현으로 바꾼다
export interface ArchiveStore {
  head(key: string): Promise<{ sha256?: string } | null>;              // sha256 = base64(전체 객체 SHA-256)
  put(key: string, body: Buffer, sha256: string, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export interface Candidate { table: LogTable; partition: string; month: string /* YYYY-MM-01 */ }
export interface Exported { body: Buffer; rows: number; sha256: string; minOccurredAt: string | null; maxOccurredAt: string | null }
export interface ArchiveResult extends Candidate { rows: number; bytes: number; key: string; uploaded: boolean; dropped: boolean }

export async function maintainPartitions(c: ClientBase, ahead = 3): Promise<{ tbl: string; part: string; moved: number }[]> {
  const r = await c.query('SELECT tbl, part, moved::int AS moved FROM log_partition_maintain($1)', [ahead]);
  log.info('partitions maintained', { created: r.rows.length, parts: r.rows.map((x) => x.part), moved: r.rows.reduce((s, x) => s + x.moved, 0) });
  return r.rows;
}

// 13개월 온라인 기간(이번 달 포함 14개월)보다 오래된 월 파티션. 이름과 실제 범위가 맞는 것만
export async function candidates(c: ClientBase, now = new Date()): Promise<Candidate[]> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 14, 1));
  const r = await c.query(
    `SELECT c.relname AS partition FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname::text = ANY($1::text[]) AND p.relnamespace = 'public'::regnamespace ORDER BY 1`, [[...LOG_TABLES]]);
  const out: Candidate[] = [];
  for (const row of r.rows as { partition: string }[]) {
    const m = PART.exec(row.partition);
    if (!m) continue;                                                     // 기본 파티션 등
    const month = new Date(Date.UTC(Number(m[2]), Number(m[3]) - 1, 1));
    if (month > cutoff) continue;
    out.push({ table: m[1] as LogTable, partition: row.partition, month: month.toISOString().slice(0, 10) });
  }
  return out;
}

// 파티션 전체를 (occurred_at, id) 순서로 읽어 NDJSON.gz로 만든다. 같은 내용이면 같은 바이트(gzip 헤더 시각 0)
export async function exportPartition(c: ClientBase, p: Candidate): Promise<Exported> {
  if (!PART.test(p.partition)) throw new Error(`잘못된 파티션 이름 ${p.partition}`);
  await c.query(`SET TIME ZONE 'UTC'`);
  const gz = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  gz.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((res, rej) => { gz.on('end', res); gz.on('error', rej); });
  let rows = 0, last: { k: string; id: string } | null = null, min: string | null = null, max: string | null = null;
  for (;;) {
    const r = await c.query(
      `SELECT t.id::text AS id, t.occurred_at::text AS k, row_to_json(t)::text AS j FROM "${p.partition}" t
        ${last ? 'WHERE (t.occurred_at, t.id) > ($1::timestamptz, $2::uuid)' : ''} ORDER BY t.occurred_at, t.id LIMIT ${BATCH}`,
      last ? [last.k, last.id] : []);
    if (!r.rows.length) break;
    for (const row of r.rows as { id: string; k: string; j: string }[]) {
      if (!gz.write(row.j + '\n')) await new Promise((res) => gz.once('drain', res));
      min ??= row.k; max = row.k;
    }
    rows += r.rows.length;
    const tail = r.rows[r.rows.length - 1] as { id: string; k: string };
    last = { k: tail.k, id: tail.id };
    if (r.rows.length < BATCH) break;
  }
  gz.end();
  await done;
  const body = Buffer.concat(chunks);
  return { body, rows, sha256: createHash('sha256').update(body).digest('base64'), minOccurredAt: min, maxOccurredAt: max };
}

export function keysOf(env: string, p: Candidate) {
  const [y, m] = p.month.split('-');
  const base = `${env}/audit/${p.table}/year=${y}/month=${m}/${p.partition}`;
  return { data: `${base}.ndjson.gz`, manifest: `${base}.manifest.json` };
}

export async function archiveOne(c: ClientBase, store: ArchiveStore, env: string, p: Candidate): Promise<ArchiveResult> {
  const t0 = Date.now();
  const x = await exportPartition(c, p);
  const keys = keysOf(env, p);
  // 1) 올리기 — 같은 내용이 이미 있으면(지난번 실행이 삭제 전에 멈춘 경우) 다시 올리지 않는다. 버킷은 버전 관리 + Object Lock
  const existing = await store.head(keys.data);
  const uploaded = existing?.sha256 !== x.sha256;
  if (existing && uploaded) log.warn('archive object differs, uploading new version', { key: keys.data });
  if (uploaded) await store.put(keys.data, x.body, x.sha256, 'application/x-ndjson');
  const manifest = Buffer.from(JSON.stringify({
    version: 1, env, table: p.table, partition: p.partition, month: p.month.slice(0, 7), rows: x.rows, bytes: x.body.length,
    sha256: x.sha256, format: 'ndjson+gzip', minOccurredAt: x.minOccurredAt, maxOccurredAt: x.maxOccurredAt,
    exportedAt: new Date().toISOString(), retention: 'S3 Object Lock COMPLIANCE 10y (bucket default)',
  }, null, 1));
  if (uploaded || !(await store.head(keys.manifest))) {
    await store.put(keys.manifest, manifest, createHash('sha256').update(manifest).digest('base64'), 'application/json');
  }
  // 2) 확인 — 버킷에서 다시 내려받아 체크섬과 행 수를 본다
  const back = await store.get(keys.data);
  const sha = createHash('sha256').update(back).digest('base64');
  if (sha !== x.sha256) throw new Error(`${keys.data}: 체크섬 불일치(올린 ${x.sha256}, 받은 ${sha})`);
  const lines = gunzipSync(back).toString('utf8').split('\n').filter(Boolean).length;
  if (lines !== x.rows) throw new Error(`${keys.data}: 행 수 불일치(DB ${x.rows}, 파일 ${lines})`);
  // 3) 분리·삭제 — 함수가 잠금 후 건수를 다시 세어 다르면 거부한다
  await c.query('SELECT log_partition_drop($1, $2::date, $3)', [p.table, p.month, x.rows]);
  const res = { ...p, rows: x.rows, bytes: x.body.length, key: keys.data, uploaded, dropped: true };
  log.info('partition archived', { ...res, ms: Date.now() - t0 });
  return res;
}

export async function archiveAll(c: ClientBase, store: ArchiveStore, env: string, opts: { dryRun?: boolean; now?: Date } = {}): Promise<ArchiveResult[]> {
  const list = await candidates(c, opts.now);
  log.info('archive candidates', { count: list.length, partitions: list.map((x) => x.partition), dryRun: !!opts.dryRun });
  if (opts.dryRun) return [];
  const out: ArchiveResult[] = [];
  for (const p of list) out.push(await archiveOne(c, store, env, p));    // 하나라도 실패하면 멈춘다(다음 달 다시 시도)
  return out;
}

// 실제 S3(log-archive 계정 감사 버킷). 기본 보존(Object Lock 준수 모드 10년)과 KMS 암호화는 버킷 설정을 따른다
export async function s3Store(bucket: string, region: string): Promise<ArchiveStore> {
  const { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region });
  return {
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
        return { sha256: r.ChecksumSHA256 };
      } catch (e) {
        if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async put(key, body, sha256, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ChecksumSHA256: sha256, ContentType: contentType }));
    },
    async get(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
  };
}
