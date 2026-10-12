// IF-MD-01 조직·코드 마스터 수신(08 5.1, openapi sapPostMasterData). WBS 4.7
//   유형별 전체 전송, 분할(chunkNo 1부터). isLast면 이번 배치에 없던 코드를 비활성(삭제하지 않음).
//   분할 순서가 틀리면 409 ALM-E303 → SAP이 그 유형을 새 batchId로 처음부터 다시 보낸다.
//   연결(sap_connection)의 회사코드 밖 레코드는 SKIPPED(같은 SAP의 다른 회사코드는 다른 연결·테넌트 몫).
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError } from '../common/errors';
import type { SapConn } from '../auth/sap';
import { Batch, each, Rec, RecError } from './inbound';

export const MD_TYPES = ['COMPANY', 'PLANT', 'PROFIT_CENTER', 'COST_CENTER', 'ASSET_CLASS', 'LOCATION'] as const;
export type MdType = (typeof MD_TYPES)[number];
const chunkKey = (type: string, n: number) => `CHUNK:${type}:${n}`;

export async function postMasterData(c: PoolClient, conn: SapConn, b: Record<string, unknown>, records: Record<string, unknown>[], batch: Batch) {
  const type = b.type as MdType;
  if (!MD_TYPES.includes(type)) throw new AlmError(400, 'ALM-E100', `type은 ${MD_TYPES.join(', ')} 중 하나`);
  const chunkNo = b.chunkNo;
  if (typeof chunkNo !== 'number' || !Number.isInteger(chunkNo) || chunkNo < 1) throw new AlmError(400, 'ALM-E100', 'chunkNo는 1 이상의 정수');
  const isLast = b.isLast === true;

  // 분할 순서: 1이면 새 배치, 아니면 바로 앞 분할이 이 배치·유형으로 와 있어야 한다. 같은 번호가 다른 키로 다시 오면 순서 오류
  const prev = (await c.query(`SELECT m.record_key FROM sap_if_message m JOIN sap_if_run r ON r.id = m.run_id
     WHERE r.interface_id = 'IF-MD-01' AND r.batch_id = $1 AND m.result = 'CHUNK' AND m.record_key LIKE $2`, [batch.batchId, `CHUNK:${type}:%`])).rows
    .map((r) => Number(String(r.record_key).split(':')[2]));
  if (prev.includes(chunkNo) || (chunkNo > 1 && !prev.includes(chunkNo - 1)) || (chunkNo === 1 && prev.length)) {
    throw new AlmError(409, 'ALM-E303', `분할 순서 오류: ${type} ${chunkNo}번(받은 분할: ${prev.sort((x, y) => x - y).join(',') || '없음'}). 새 batchId로 처음부터 다시 보내세요`);
  }

  const codes: string[] = [];
  for (const r of records) {
    const f = new Rec(r);
    let key = '?';
    try { key = keyOf(type, f); } catch { /* 키 필드 오류는 아래 each에서 ERROR */ }
    await each(c, batch, key, r, async () => {
      key = keyOf(type, f);
      const res = await upsert(c, conn, type, f);
      if (res !== 'FOREIGN') codes.push(key);
      return res === 'FOREIGN' ? { skip: `연결(${conn.companyCode})의 회사코드가 아님` } : res;
    });
  }
  batch.extra.push({ key: chunkKey(type, chunkNo), result: 'CHUNK', message: isLast ? 'last' : undefined, payload: { codes } });

  if (isLast) {
    const all = new Set(codes);
    for (const p of prev) {
      const m = (await c.query(`SELECT m.payload FROM sap_if_message m JOIN sap_if_run r ON r.id = m.run_id
        WHERE r.interface_id = 'IF-MD-01' AND r.batch_id = $1 AND m.result = 'CHUNK' AND m.record_key = $2`, [batch.batchId, chunkKey(type, p)])).rows[0];
      for (const k of (m?.payload?.codes ?? []) as string[]) all.add(k);
    }
    const n = await deactivateMissing(c, conn, type, [...all]);
    const why = type === 'LOCATION' ? 'ALM 사이트의 SAP 위치가 SAP에 없음(사이트 설정 확인)' : '이번 전체 전송에 없어 비활성 처리';
    for (const k of n) batch.skip(`${type}:${k}`, why);
  }
}

function keyOf(type: MdType, f: Rec): string {
  switch (type) {
    case 'COMPANY': return f.str('companyCode', 4, true)!;
    case 'PLANT': return f.str('plantCode', 4, true)!;
    case 'PROFIT_CENTER': return `${f.str('controllingArea', 4, true)}/${f.str('profitCenter', 10, true)}`;
    case 'COST_CENTER': return `${f.str('controllingArea', 4, true)}/${f.str('costCenter', 10, true)}`;
    case 'ASSET_CLASS': return f.str('assetClass', 8, true)!;
    case 'LOCATION': return `${f.str('plantCode', 4, true)}/${f.str('location', 10, true)}`;
  }
}

async function companyId(c: PoolClient, code: string): Promise<string | undefined> {
  return (await c.query('SELECT id FROM company WHERE company_code = $1', [code])).rows[0]?.id;
}

// 바뀐 값이 있을 때만 UPDATE(감사 로그에 같은 값이 쌓이지 않게) → OK, 같으면 SKIPPED. 연결 밖 회사코드면 FOREIGN
async function upsert(c: PoolClient, conn: SapConn, type: MdType, f: Rec): Promise<'OK' | 'SKIPPED' | 'FOREIGN'> {
  const changed = (rowCount: number | null) => (rowCount ? 'OK' : 'SKIPPED') as 'OK' | 'SKIPPED';
  switch (type) {
    case 'COMPANY': {
      const code = f.str('companyCode', 4, true)!, name = f.str('name', 25, true)!, cur = f.str('currency', 5, true)!;
      if (code !== conn.companyCode) return 'FOREIGN';
      const r = await c.query(`INSERT INTO company (id, tenant_id, company_code, name, currency, sap_synced_at) VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (tenant_id, company_code) DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency, is_active = true,
          sap_synced_at = now(), updated_at = now(), version = company.version + 1
        WHERE (company.name, company.currency, company.is_active) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.currency, true)`,
        [randomUUID(), conn.tenantId, code, name, cur]);
      return changed(r.rowCount);
    }
    case 'PLANT': {
      const code = f.str('plantCode', 4, true)!, cc = f.str('companyCode', 4, true)!, name = f.str('name', 30, true)!, addr = f.str('address', 200) ?? null;
      if (cc !== conn.companyCode) return 'FOREIGN';
      const co = await companyId(c, cc);
      if (!co) throw new RecError('ALM-E100', `회사코드 ${cc}가 ALM에 없음(COMPANY를 먼저 보내야 함)`);
      const r = await c.query(`INSERT INTO plant (id, tenant_id, company_id, plant_code, name, address) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, plant_code) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name, address = EXCLUDED.address,
          is_active = true, updated_at = now(), version = plant.version + 1
        WHERE (plant.company_id, plant.name, plant.address, plant.is_active) IS DISTINCT FROM (EXCLUDED.company_id, EXCLUDED.name, EXCLUDED.address, true)`,
        [randomUUID(), conn.tenantId, co, code, name, addr]);
      return changed(r.rowCount);
    }
    case 'PROFIT_CENTER': {
      const ka = f.str('controllingArea', 4, true)!, code = f.str('profitCenter', 10, true)!, name = f.str('name', 20, true)!, seg = f.str('segment', 10) ?? null;
      const r = await c.query(`INSERT INTO profit_center (id, tenant_id, controlling_area, profit_center_code, name, segment) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, controlling_area, profit_center_code) DO UPDATE SET name = EXCLUDED.name, segment = EXCLUDED.segment,
          is_active = true, updated_at = now(), version = profit_center.version + 1
        WHERE (profit_center.name, profit_center.segment, profit_center.is_active) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.segment, true)`,
        [randomUUID(), conn.tenantId, ka, code, name, seg]);
      return changed(r.rowCount);
    }
    case 'COST_CENTER': {
      const ka = f.str('controllingArea', 4, true)!, code = f.str('costCenter', 10, true)!, name = f.str('name', 20, true)!;
      const cc = f.str('companyCode', 4, true)!, pc = f.str('profitCenter', 10), resp = f.str('responsible', 20) ?? null;
      const from = f.date('validFrom') ?? null, to = f.date('validTo') ?? null;
      if (cc !== conn.companyCode) return 'FOREIGN';
      const co = await companyId(c, cc);
      if (!co) throw new RecError('ALM-E100', `회사코드 ${cc}가 ALM에 없음`);
      const pcId = pc ? (await c.query('SELECT id FROM profit_center WHERE controlling_area = $1 AND profit_center_code = $2', [ka, pc])).rows[0]?.id ?? null : null;
      const r = await c.query(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id, profit_center_id, responsible, valid_from, valid_to)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (tenant_id, controlling_area, cost_center_code) DO UPDATE SET name = EXCLUDED.name, company_id = EXCLUDED.company_id,
          profit_center_id = EXCLUDED.profit_center_id, responsible = EXCLUDED.responsible, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
          is_active = true, updated_at = now(), version = cost_center.version + 1
        WHERE (cost_center.name, cost_center.company_id, cost_center.profit_center_id, cost_center.responsible, cost_center.valid_from, cost_center.valid_to, cost_center.is_active)
          IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.company_id, EXCLUDED.profit_center_id, EXCLUDED.responsible, EXCLUDED.valid_from, EXCLUDED.valid_to, true)`,
        [randomUUID(), conn.tenantId, ka, code, name, co, pcId, resp, from, to]);
      return changed(r.rowCount);
    }
    case 'ASSET_CLASS': {
      const code = f.str('assetClass', 8, true)!, name = f.str('name', 50, true)!, low = f.bool('isLowValue') ?? false;
      const life = f.int('usefulLifeYears', { min: 0, max: 100 }) ?? null;
      const r = await c.query(`INSERT INTO asset_class (id, tenant_id, class_code, name, is_low_value, default_useful_life_years) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, class_code) DO UPDATE SET name = EXCLUDED.name, is_low_value = EXCLUDED.is_low_value,
          default_useful_life_years = EXCLUDED.default_useful_life_years, is_active = true, updated_at = now(), version = asset_class.version + 1
        WHERE (asset_class.name, asset_class.is_low_value, asset_class.default_useful_life_years, asset_class.is_active)
          IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.is_low_value, EXCLUDED.default_useful_life_years, true)`,
        [randomUUID(), conn.tenantId, code, name, low, life]);
      return changed(r.rowCount);
    }
    case 'LOCATION': {
      // SAP 위치(T499S)는 ALM 사이트의 sap_location이 맞는지 확인하는 용도. 저장하지 않는다
      f.str('plantCode', 4, true); f.str('location', 10, true); f.str('name', 40, true);
      return 'SKIPPED';
    }
  }
}

// isLast: 이번 배치에 없던 코드 비활성. 회사코드에 딸린 마스터는 이 연결의 회사코드 범위에서만
async function deactivateMissing(c: PoolClient, conn: SapConn, type: MdType, keys: string[]): Promise<string[]> {
  const q = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows.map((r) => String(r.k));
  const off = 'is_active = false, updated_at = now(), version = version + 1';
  switch (type) {
    case 'COMPANY': return [];   // 연결의 회사코드 자체는 연결이 있는 동안 비활성으로 바꾸지 않는다
    case 'PLANT':
      return q(`UPDATE plant SET ${off} WHERE is_active AND company_id = $1 AND NOT (plant_code = ANY($2)) RETURNING plant_code AS k`, [conn.companyId, keys]);
    case 'PROFIT_CENTER':
      return q(`UPDATE profit_center SET ${off} WHERE is_active AND NOT ((controlling_area || '/' || profit_center_code) = ANY($1))
        RETURNING controlling_area || '/' || profit_center_code AS k`, [keys]);
    case 'COST_CENTER':
      return q(`UPDATE cost_center SET ${off} WHERE is_active AND company_id = $1 AND NOT ((controlling_area || '/' || cost_center_code) = ANY($2))
        RETURNING controlling_area || '/' || cost_center_code AS k`, [conn.companyId, keys]);
    case 'ASSET_CLASS':
      return q(`UPDATE asset_class SET ${off} WHERE is_active AND NOT (class_code = ANY($1)) RETURNING class_code AS k`, [keys]);
    case 'LOCATION': {
      // ALM 사이트의 SAP 위치가 SAP에 없으면 알려 준다(바꾸지는 않음)
      return q(`SELECT s.site_code || ' → ' || coalesce(p.plant_code, '?') || '/' || s.sap_location AS k FROM site s LEFT JOIN plant p ON p.id = s.plant_id
        WHERE s.is_active AND s.sap_location IS NOT NULL AND p.company_id = $1 AND NOT ((coalesce(p.plant_code, '') || '/' || s.sap_location) = ANY($2))`, [conn.companyId, keys]);
    }
  }
}
