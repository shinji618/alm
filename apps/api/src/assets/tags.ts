// 번호 채번(number_sequence, 테넌트별). 행 잠금(UPDATE … RETURNING)으로 동시 채번을 줄 세운다. 커밋 전 롤백되면 그 번호는 다시 쓴다.
//   채번을 거치지 않고 들어온 번호(일괄 업로드에 적힌 AT-태그 등)가 다음 값 이상이면 그 뒤로 건너뛴다(중복 태그 500 방지, 2026-10-19)
//   asset_tag     AT-nnnnnn  (05 테이블 정의서 asset.asset_tag = SAP INVNR)
//   asset_request AR-nnnnn
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

const SEQ = {
  asset_tag: { prefix: 'AT-', padding: 6,
    existing: `SELECT coalesce(max(substring(asset_tag FROM 4)::bigint), 0) AS n FROM asset WHERE asset_tag ~ '^AT-[0-9]{6,12}$'` },
  asset_request: { prefix: 'AR-', padding: 5,
    existing: `SELECT coalesce(max(substring(request_no FROM 4)::bigint), 0) AS n FROM asset_request WHERE request_no ~ '^AR-[0-9]{5,9}$'` },
} as const;
export type SeqName = keyof typeof SEQ;

export async function nextNumbers(c: PoolClient, tenantId: string, name: SeqName, n = 1): Promise<string[]> {
  if (n <= 0) return [];
  const s = SEQ[name];
  // 처음이면 이미 쓰인 번호(이 채번 도입 전 데이터) 다음부터
  if (!(await c.query('SELECT 1 FROM number_sequence WHERE seq_name = $1', [name])).rowCount) {
    const used = Number((await c.query(s.existing)).rows[0].n);
    await c.query(`INSERT INTO number_sequence (id, tenant_id, seq_name, prefix, next_value, padding) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, seq_name) DO NOTHING`, [randomUUID(), tenantId, name, s.prefix, used + 1, s.padding]);
  }
  await c.query('SELECT 1 FROM number_sequence WHERE seq_name = $1 FOR UPDATE', [name]);   // 잠근 뒤 쓰인 최댓값을 본다
  const used = Number((await c.query(s.existing)).rows[0].n);
  const r = (await c.query(`UPDATE number_sequence SET next_value = greatest(next_value, $3::bigint + 1) + $2, updated_at = now(), version = version + 1
    WHERE seq_name = $1 RETURNING next_value - $2 AS first, prefix, padding`, [name, n, used])).rows[0];
  return Array.from({ length: n }, (_, i) => `${r.prefix}${String(Number(r.first) + i).padStart(r.padding, '0')}`);
}

export const nextAssetTags = (c: PoolClient, tenantId: string, n: number) => nextNumbers(c, tenantId, 'asset_tag', n);
