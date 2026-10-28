// DB 접근: 같은 인터페이스로 Data API(Lambda, VPC 밖)와 pg(시험)를 쓴다.
// SQL은 $1·$2 위치 인자로 쓴다. Data API는 배열 인자를 못 받으므로 목록은 JSON 문자열($n::jsonb)로 넘긴다.
export interface Rows<T = Record<string, any>> { rows: T[]; rowCount: number }
export interface Tx { query<T = Record<string, any>>(sql: string, args?: unknown[]): Promise<Rows<T>> }
export interface TxContext { tenantId?: string; actor?: string }
export interface Db {
  // 트랜잭션: app.tenant_id·app.actor를 SET LOCAL(RLS·변경 감사). 실패하면 되돌린다
  withTx<T>(ctx: TxContext, fn: (c: Tx) => Promise<T>): Promise<T>;
}

async function setContext(c: Tx, ctx: TxContext) {
  await c.query(`SELECT set_config('app.tenant_id', $1::text, true) AS tenant, set_config('app.actor', $2::text, true) AS actor`, [ctx.tenantId ?? '', ctx.actor ?? '']);
}

// ---------- pg(시험·로컬) ----------
export function pgDb(pool: { connect(): Promise<any> }): Db {
  return {
    async withTx(ctx, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await setContext(client, ctx);
        const r = await fn(client);
        await client.query('COMMIT');
        return r;
      } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; }
      finally { client.release(); }
    },
  };
}

// ---------- Data API(Aurora) ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function toDataApi(sql: string, args: unknown[] = []) {
  const parameters = args.map((v, i) => {
    const name = `p${i + 1}`;
    if (v === null || v === undefined) return { name, value: { isNull: true } };
    if (typeof v === 'boolean') return { name, value: { booleanValue: v } };
    if (typeof v === 'number') return Number.isInteger(v) ? { name, value: { longValue: v } } : { name, value: { doubleValue: v } };
    if (v instanceof Date) return { name, value: { stringValue: v.toISOString().replace('T', ' ').replace('Z', '') }, typeHint: 'TIMESTAMP' };
    if (typeof v === 'object') return { name, value: { stringValue: JSON.stringify(v) }, typeHint: 'JSON' };
    const s = String(v);
    if (UUID_RE.test(s)) return { name, value: { stringValue: s }, typeHint: 'UUID' };
    if (DATE_RE.test(s)) return { name, value: { stringValue: s }, typeHint: 'DATE' };
    return { name, value: { stringValue: s } };
  });
  // $10 이 $1 보다 먼저 바뀌도록 큰 번호부터
  let out = sql;
  for (let i = args.length; i >= 1; i--) out = out.replace(new RegExp(`\\$${i}(?![0-9])`, 'g'), `:p${i}`);
  return { sql: out, parameters };
}

export interface DataApiClient { send(cmd: any): Promise<any> }
export function dataApiDb(client: DataApiClient, cmds: { Begin: any; Exec: any; Commit: any; Rollback: any },
  cfg: { resourceArn: string; secretArn: string; database: string }): Db {
  const base = { resourceArn: cfg.resourceArn, secretArn: cfg.secretArn, database: cfg.database };
  return {
    async withTx(ctx, fn) {
      const { transactionId } = await retryResume(() => client.send(new cmds.Begin(base)));
      const tx: Tx = {
        async query(sql, args) {
          const p = toDataApi(sql, args);
          const r = await client.send(new cmds.Exec({ ...base, transactionId, sql: p.sql, parameters: p.parameters, formatRecordsAs: 'JSON' }));
          const rows = r.formattedRecords ? JSON.parse(r.formattedRecords) : [];
          return { rows, rowCount: r.numberOfRecordsUpdated || rows.length };
        },
      };
      try {
        await setContext(tx, ctx);
        const out = await fn(tx);
        await client.send(new cmds.Commit({ resourceArn: cfg.resourceArn, secretArn: cfg.secretArn, transactionId }));
        return out;
      } catch (e) {
        await client.send(new cmds.Rollback({ resourceArn: cfg.resourceArn, secretArn: cfg.secretArn, transactionId })).catch(() => undefined);
        throw e;
      }
    },
  };
}

// Aurora 자동 일시정지에서 재개 중이면(DatabaseResumingException) 2초 간격으로 최대 약 30초 재시도
export async function retryResume<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e: any) {
      if (e?.name === 'DatabaseResumingException' && i < 15) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw e;
    }
  }
}
