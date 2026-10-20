// 번호 채번(number_sequence, 테넌트별). 행 잠금(UPDATE … RETURNING)으로 동시 채번을 줄 세운다. 커밋 전 롤백되면 그 번호는 다시 쓴다.
//   채번을 거치지 않고 들어온 번호(일괄 업로드에 적힌 AT-태그 등)가 다음 값 이상이면 그 뒤로 건너뛴다(중복 태그 500 방지, 2026-10-19)
//   asset_tag     PP-nnnnnn  자산태그(= SAP INVNR). 번호 범위(asset_number_range)에서 채번 — 아래 nextAssetTags
//   asset_request AR-nnnnn
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError } from '../common/errors';

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

// ---------------- 자산태그 번호 범위(ADM-055, 2026-10-19) ----------------
//   Prefix(2자리) + '-' + 6자리. 카테고리 → 상위 카테고리 → 기본 범위 순으로 범위를 찾는다(비활성 범위는 건너뜀).
//   채번은 범위 행을 잠그고, 그 Prefix로 이미 쓰인 구간 안 최댓값 다음부터(일괄 업로드로 적힌 태그 등과 겹치지 않게). 끝 번호를 넘으면 409 ALM-E319
export const PREFIX = /^[A-Z0-9]{2}$/;
export const MAX_NO = 999999;
export const tagOf = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;

/** 범위가 하나도 없으면 기본 범위 AT를 만든다(기존 AT-번호·예전 채번 값 다음부터) */
export async function ensureDefaultRange(c: PoolClient, tenantId: string) {
  if ((await c.query('SELECT 1 FROM asset_number_range LIMIT 1')).rowCount) return;
  const seq = Number((await c.query(`SELECT next_value FROM number_sequence WHERE seq_name = 'asset_tag'`)).rows[0]?.next_value ?? 1);
  await c.query(`INSERT INTO asset_number_range (id, tenant_id, prefix, name, from_no, to_no, next_no, is_default) VALUES ($1, $2, 'AT', 'Default', 1, $3, $4, true)
    ON CONFLICT (tenant_id, prefix) DO NOTHING`, [randomUUID(), tenantId, MAX_NO, Math.min(Math.max(seq, 1), MAX_NO + 1)]);
}

/** 카테고리의 번호 범위(상위 상속 → 기본). 없으면 409 ALM-E319 */
export async function rangeFor(c: PoolClient, tenantId: string, categoryId: string | null | undefined): Promise<Record<string, any>> {
  await ensureDefaultRange(c, tenantId);
  if (categoryId) {
    const r = (await c.query(`WITH RECURSIVE up AS (SELECT id, parent_id, number_range_id, 0 AS depth FROM category WHERE id = $1
        UNION ALL SELECT p.id, p.parent_id, p.number_range_id, up.depth + 1 FROM category p JOIN up ON p.id = up.parent_id WHERE up.depth < 20)
      SELECT nr.* FROM up JOIN asset_number_range nr ON nr.id = up.number_range_id AND nr.is_active ORDER BY up.depth LIMIT 1`, [categoryId])).rows[0];
    if (r) return r;
  }
  const d = (await c.query('SELECT * FROM asset_number_range WHERE is_default AND is_active LIMIT 1')).rows[0];
  if (!d) throw new AlmError(409, 'ALM-E319', '자산태그 기본 번호 범위가 없거나 사용 안 함입니다. 관리 > 자산태그 번호 범위에서 기본 범위를 지정하세요');
  return d;
}

/** 그 Prefix로 구간 안에서 이미 쓰인 가장 큰 번호(0 = 없음) */
export async function usedMax(c: PoolClient, prefix: string, from: number, to: number): Promise<number> {
  return Number((await c.query(`SELECT coalesce(max(substring(asset_tag FROM 4)::int), 0) AS n FROM asset
     WHERE asset_tag LIKE $1 AND asset_tag ~ '^[A-Z0-9]{2}-[0-9]{6}$' AND substring(asset_tag FROM 4)::int BETWEEN $2 AND $3`, [`${prefix}-%`, from, to])).rows[0].n);
}

/** 카테고리 번호 범위에서 n개 채번 */
export async function nextAssetTags(c: PoolClient, tenantId: string, n: number, categoryId?: string | null): Promise<string[]> {
  if (n <= 0) return [];
  const pick = await rangeFor(c, tenantId, categoryId);
  const r = (await c.query('SELECT * FROM asset_number_range WHERE id = $1 FOR UPDATE', [pick.id])).rows[0];
  const first = Math.max(Number(r.next_no), Number(r.from_no), (await usedMax(c, r.prefix, r.from_no, r.to_no)) + 1);
  if (first + n - 1 > Number(r.to_no)) {
    throw new AlmError(409, 'ALM-E319', `자산태그 번호 범위 ${r.prefix}(${r.name})가 모자랍니다: 남은 번호 ${Math.max(0, Number(r.to_no) - first + 1)}개, 필요 ${n}개. `
      + '관리 > 자산태그 번호 범위에서 끝 번호를 늘리거나 카테고리에 다른 범위를 지정하세요', { prefix: r.prefix, remaining: Math.max(0, Number(r.to_no) - first + 1) });
  }
  await c.query('UPDATE asset_number_range SET next_no = $2, updated_at = now(), version = version + 1 WHERE id = $1', [r.id, first + n]);
  return Array.from({ length: n }, (_, i) => tagOf(r.prefix, first + i));
}
