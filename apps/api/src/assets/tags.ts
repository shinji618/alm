// 자산태그 자동 채번: AT-nnnnnn(테넌트별 일련번호, 6자리, 넘으면 자리 늘림). 05 테이블 정의서 asset.asset_tag
// 같은 테넌트의 동시 채번은 트랜잭션 잠금(pg_advisory_xact_lock)으로 줄을 세운다. 커밋되면 풀린다
import type { PoolClient } from 'pg';

export async function nextAssetTags(c: PoolClient, tenantId: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('asset_tag:' || $1))`, [tenantId]);
  const max = (await c.query(`SELECT coalesce(max(substring(asset_tag FROM 4)::bigint), 0)::bigint AS n FROM asset
     WHERE asset_tag ~ '^AT-[0-9]{6,12}$'`)).rows[0].n;
  const start = Number(max) + 1;
  return Array.from({ length: n }, (_, i) => `AT-${String(start + i).padStart(6, '0')}`);
}
