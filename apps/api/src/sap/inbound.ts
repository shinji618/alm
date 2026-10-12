// SAP → ALM 수신 공통(08 인터페이스 명세서 4.3, openapi BatchResult). WBS 4.7
//   - Idempotency-Key: 24시간 안 같은 키 + 같은 본문이면 저장된 응답을 그대로, 본문이 다르면 409 ALM-E301
//   - 실행 기록: sap_if_run(배치 1건) + sap_if_message(오류 건, 원문 포함 — 자동 재처리·화면 조회용)
//   - 응답: 오류가 하나라도 있으면 HTTP 207, 건별 결과에는 ERROR·SKIPPED만
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError } from '../common/errors';
import type { SapConn } from '../auth/sap';

export type ItemStatus = 'OK' | 'ERROR' | 'SKIPPED';
export interface ItemResult { key: string; status: ItemStatus; code?: string; message?: string }
export interface BatchResult { batchId: string; received: number; succeeded: number; failed: number; results: ItemResult[] }
export interface Outcome { status: number; body: unknown }

export const IDEM_TTL_HOURS = 24;

// 레코드 처리 결과를 모은다. 오류 건은 원문과 함께 sap_if_message에 남긴다
export class Batch {
  readonly results: ItemResult[] = [];
  readonly errors: { key: string; code: string; message: string; payload: unknown }[] = [];
  readonly extra: { key: string; result: string; message?: string; payload?: unknown }[] = [];   // 분할 기록 등
  ok = 0; skipped = 0;
  constructor(readonly batchId: string, readonly received: number) {}
  okay(_key: string) { this.ok++; }
  skip(key: string, message?: string) { this.skipped++; this.results.push({ key, status: 'SKIPPED', ...(message ? { message } : {}) }); }
  fail(key: string, code: string, message: string, payload?: unknown) {
    this.results.push({ key, status: 'ERROR', code, message });
    this.errors.push({ key, code, message, payload });
  }
  get failed() { return this.errors.length; }
  body(): BatchResult {
    return { batchId: this.batchId, received: this.received, succeeded: this.received - this.failed, failed: this.failed, results: this.results };
  }
  http() { return this.failed ? 207 : 200; }
}

export const hashBody = (body: unknown) => createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

// 같은 트랜잭션 안에서: 이미 처리한 키면 저장된 응답, 아니면 run()을 실행하고 응답을 저장한다.
// 동시에 같은 키가 두 번 오면 고유 제약(tenant, endpoint, key)이 두 번째 트랜잭션을 실패시키고, SAP 재시도가 저장된 응답을 받는다
export async function idempotent(c: PoolClient, tenantId: string, endpoint: string, key: string | undefined, body: unknown,
  run: () => Promise<Outcome>): Promise<Outcome> {
  if (!key) throw new AlmError(400, 'ALM-E101', 'Idempotency-Key 헤더가 필요합니다');
  if (key.length > 80) throw new AlmError(400, 'ALM-E100', 'Idempotency-Key는 80자 이하');
  const hash = hashBody(body);
  const prev = (await c.query(`SELECT request_hash, response_status, response_body FROM idempotency_key
    WHERE endpoint = $1 AND key = $2 AND expires_at > now()`, [endpoint, key])).rows[0];
  if (prev) {
    if (prev.request_hash !== hash) throw new AlmError(409, 'ALM-E301', '같은 Idempotency-Key로 다른 본문이 왔습니다');
    return { status: prev.response_status, body: prev.response_body };
  }
  const out = await run();
  await c.query(`DELETE FROM idempotency_key WHERE endpoint = $1 AND key = $2 AND expires_at <= now()`, [endpoint, key]);
  await c.query(`INSERT INTO idempotency_key (id, tenant_id, endpoint, key, request_hash, response_status, response_body, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))`,
    [randomUUID(), tenantId, endpoint, key, hash, out.status, JSON.stringify(out.body), IDEM_TTL_HOURS]);
  return out;
}

// sap_if_run + 오류 메시지. 배치 하나 = 실행 1건
export async function logRun(c: PoolClient, conn: SapConn, o: { interfaceId: string; batchId: string; correlationId?: string; startedAt: Date; batch: Batch }) {
  const runId = randomUUID();
  const b = o.batch;
  const status = !b.failed ? 'SUCCESS' : b.failed >= b.received && b.received > 0 ? 'FAILED' : 'PARTIAL';
  await c.query(
    `INSERT INTO sap_if_run (id, tenant_id, interface_id, direction, batch_id, correlation_id, sap_system, http_status,
       record_count, success_count, error_count, status, started_at, finished_at)
     VALUES ($1, $2, $3, 'SAP_TO_ALM', $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
    [runId, conn.tenantId, o.interfaceId, o.batchId.slice(0, 40), validUuid(o.correlationId), conn.systemId, b.http(),
      b.received, b.received - b.failed, b.failed, status, o.startedAt]);
  const rows = [...b.errors.map((e) => ({ key: e.key, result: 'ERROR', code: e.code, message: e.message, payload: e.payload })),
    ...b.extra.map((e) => ({ key: e.key, result: e.result, code: null, message: e.message ?? null, payload: e.payload }))];
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const vals: unknown[] = [];
    const tuples = part.map((r, j) => {
      vals.push(randomUUID(), conn.tenantId, runId, r.key.slice(0, 40), r.result, r.code, r.message?.slice(0, 500) ?? null, r.payload === undefined ? null : JSON.stringify(r.payload));
      const k = j * 8;
      return `($${k + 1}, $${k + 2}, $${k + 3}, $${k + 4}, $${k + 5}, $${k + 6}, $${k + 7}, $${k + 8})`;
    });
    await c.query(`INSERT INTO sap_if_message (id, tenant_id, run_id, record_key, result, error_code, message, payload) VALUES ${tuples.join(', ')}`, vals);
  }
  return runId;
}

const validUuid = (s?: string) => (s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null);

// 요청 본문 공통 검사(배치 ID·레코드 배열·최대 건수)
export function batchBody(body: unknown, max: number): { batchId: string; records: Record<string, unknown>[]; b: Record<string, unknown> } {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const errors: { field: string; code: string; message: string }[] = [];
  const batchId = typeof b.batchId === 'string' ? b.batchId.trim() : '';
  if (!batchId) errors.push({ field: 'batchId', code: 'ALM-E101', message: '필수 값입니다' });
  else if (batchId.length > 40) errors.push({ field: 'batchId', code: 'ALM-E100', message: '최대 40자입니다' });
  if (!Array.isArray(b.records)) errors.push({ field: 'records', code: 'ALM-E101', message: '배열이 필요합니다' });
  if (errors.length) throw new AlmError(400, errors.every((e) => e.code === 'ALM-E101') ? 'ALM-E101' : 'ALM-E100',
    `입력 값을 확인하세요: ${errors[0].field} ${errors[0].message}`, { errors });
  const records = b.records as unknown[];
  if (records.length > max) throw new AlmError(400, 'ALM-E106', `한 번에 최대 ${max}건입니다(받은 ${records.length}건)`);
  return { batchId, b, records: records.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as Record<string, unknown>) };
}

// 레코드 필드 읽기(문자열 앞뒤 공백 제거, 최대 길이). 잘못되면 메시지를 던져 그 레코드만 ERROR로
export class Rec {
  constructor(private r: Record<string, unknown>) {}
  str(k: string, max: number, required = false): string | undefined {
    const v = this.r[k];
    if (v === undefined || v === null || v === '') { if (required) throw new RecError('ALM-E101', `${k} 필수`); return undefined; }
    if (typeof v !== 'string') throw new RecError('ALM-E100', `${k}는 문자열`);
    const t = v.trim();
    if (!t && required) throw new RecError('ALM-E101', `${k} 필수`);
    if (t.length > max) throw new RecError('ALM-E100', `${k} 최대 ${max}자`);
    return t || undefined;
  }
  date(k: string): string | undefined {
    const v = this.str(k, 10);
    if (v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new RecError('ALM-E100', `${k} 날짜 형식(YYYY-MM-DD)`);
    return v;
  }
  ts(k: string, required = false): string | undefined {
    const v = this.str(k, 40, required);
    if (v && Number.isNaN(Date.parse(v))) throw new RecError('ALM-E100', `${k} 일시 형식`);
    return v;
  }
  int(k: string, opt: { min?: number; max?: number; required?: boolean } = {}): number | undefined {
    const v = this.r[k];
    if (v === undefined || v === null) { if (opt.required) throw new RecError('ALM-E101', `${k} 필수`); return undefined; }
    if (typeof v !== 'number' || !Number.isInteger(v) || (opt.min !== undefined && v < opt.min) || (opt.max !== undefined && v > opt.max)) {
      throw new RecError('ALM-E100', `${k} 범위 오류`);
    }
    return v;
  }
  num(k: string, required = false): number | undefined {
    const v = this.r[k];
    if (v === undefined || v === null) { if (required) throw new RecError('ALM-E101', `${k} 필수`); return undefined; }
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= 1e13) throw new RecError('ALM-E100', `${k}는 숫자`);
    return Math.round(v * 100) / 100;
  }
  bool(k: string): boolean | undefined {
    const v = this.r[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') throw new RecError('ALM-E100', `${k}는 참·거짓`);
    return v;
  }
}
export class RecError extends Error { constructor(readonly code: string, message: string) { super(message); } }

// 레코드 하나를 SAVEPOINT 안에서 처리: DB 오류가 나도 그 건만 ERROR, 나머지는 계속
export async function each(c: PoolClient, batch: Batch, key: string, payload: unknown, fn: () => Promise<'OK' | 'SKIPPED' | { skip: string }>) {
  await c.query('SAVEPOINT rec');
  try {
    const r = await fn();
    await c.query('RELEASE SAVEPOINT rec');
    if (r === 'OK') batch.okay(key); else if (r === 'SKIPPED') batch.skip(key); else batch.skip(key, r.skip);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT rec');
    if (e instanceof RecError) batch.fail(key, e.code, e.message, payload);
    else batch.fail(key, 'ALM-E500', `처리 오류: ${(e as Error).message}`.slice(0, 300), payload);
  }
}
