// 관리 > SAP 마스터(ADM-035, 읽기 전용): IF-MD-01로 받은 회사·플랜트·프로핏센터·코스트센터·자산클래스를 한곳에서 본다. master.read
//   수정은 없다(SAP이 관리). 비활성 = 마지막 수신 배치에 없어 IF-MD-01이 끈 코드
import type { PoolClient } from 'pg';
import { E } from '../common/errors';

export const SAP_MASTER_TYPES = ['COMPANY', 'PLANT', 'PROFIT_CENTER', 'COST_CENTER', 'ASSET_CLASS'] as const;
type MType = (typeof SAP_MASTER_TYPES)[number];

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

// 종류별 조회. usage = 이 코드를 쓰는 건수(자산·사이트, 없으면 null)
const QUERY: Record<MType, string> = {
  COMPANY: `SELECT id, company_code AS code, name, NULL::text AS company_code, NULL::text AS controlling_area, currency AS detail, is_active, coalesce(sap_synced_at, updated_at) AS updated_at,
      (SELECT count(*) FROM asset a WHERE a.company_id = company.id AND a.status NOT IN ('RETIRED', 'DISPOSED')) AS usage FROM company WHERE sap_enabled`,
  PLANT: `SELECT p.id, p.plant_code AS code, p.name, co.company_code, NULL::text AS controlling_area, p.address AS detail, p.is_active, p.updated_at,
      (SELECT count(*) FROM site s WHERE s.plant_id = p.id) AS usage FROM plant p JOIN company co ON co.id = p.company_id`,
  PROFIT_CENTER: `SELECT id, profit_center_code AS code, name, NULL::text AS company_code, controlling_area, segment AS detail, is_active, updated_at, NULL::bigint AS usage FROM profit_center`,
  COST_CENTER: `SELECT cc.id, cc.cost_center_code AS code, cc.name, co.company_code, cc.controlling_area, cc.responsible AS detail, cc.is_active, cc.updated_at,
      (SELECT count(*) FROM asset a WHERE a.cost_center_id = cc.id AND a.status NOT IN ('RETIRED', 'DISPOSED')) AS usage
      FROM cost_center cc JOIN company co ON co.id = cc.company_id WHERE co.sap_enabled`,
  ASSET_CLASS: `SELECT ac.id, ac.class_code AS code, ac.name, NULL::text AS company_code, NULL::text AS controlling_area,
      CASE WHEN ac.is_low_value THEN 'LOW_VALUE' WHEN ac.is_capitalized THEN 'CAPITALIZED' END AS detail, ac.is_active, ac.updated_at,
      (SELECT count(*) FROM asset a WHERE a.asset_class_id = ac.id AND a.status NOT IN ('RETIRED', 'DISPOSED')) AS usage FROM asset_class ac WHERE NOT ac.is_manual`,
};

export async function sapMasterSummary(c: PoolClient) {
  const items = [];
  for (const type of SAP_MASTER_TYPES) {
    const r = (await c.query(`SELECT count(*) AS total, count(*) FILTER (WHERE is_active) AS active, max(updated_at) AS updated_at FROM (${QUERY[type]}) x`)).rows[0];
    items.push({ type, total: Number(r.total), active: Number(r.active), inactive: Number(r.total) - Number(r.active), updatedAt: iso(r.updated_at) });
  }
  const run = (await c.query(`SELECT batch_id, status, record_count, success_count, error_count, started_at FROM sap_if_run WHERE interface_id = 'IF-MD-01' ORDER BY started_at DESC LIMIT 1`)).rows[0];
  return { items, lastRun: run ? { batchId: run.batch_id, status: run.status, recordCount: run.record_count, successCount: run.success_count, errorCount: run.error_count, startedAt: iso(run.started_at) } : undefined };
}

export async function listSapMasters(c: PoolClient, type: string, q: Record<string, string | undefined>) {
  if (!(SAP_MASTER_TYPES as readonly string[]).includes(type)) throw E.notFound('알 수 없는 마스터 종류입니다');
  if (q.active !== undefined && q.active !== '' && q.active !== 'true' && q.active !== 'false') throw E.badRequest('active는 true 또는 false여야 합니다');
  const active = q.active === 'true' ? true : q.active === 'false' ? false : undefined;
  const rows = (await c.query(`SELECT * FROM (${QUERY[type as MType]}) x WHERE ($1::boolean IS NULL OR is_active = $1) ORDER BY company_code NULLS FIRST, code`, [active ?? null])).rows;
  return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, companyCode: r.company_code ?? undefined, controllingArea: r.controlling_area ?? undefined,
    detail: r.detail ?? undefined, isActive: r.is_active, updatedAt: iso(r.updated_at), usage: r.usage == null ? undefined : Number(r.usage) })) };
}
