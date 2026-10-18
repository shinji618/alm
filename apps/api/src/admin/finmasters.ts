// 코스트센터·자산클래스 직접 관리(관리 > 코스트센터·자산클래스, 2026-10-13 결정). master.read·master.write
//   코스트센터: SAP 연계를 끈 회사만 등록·수정한다(SAP 회사는 IF-MD-01이 관리해 직접 바꾸면 다음 수신 때 덮어쓴다 → 409).
//               관리 영역(KOKRS) 자리는 'ALM'. 자산이 쓰고 있으면 비활성화할 수 없다(409 ALM-E318)
//   자산클래스: SAP에서 받은 것만 쓴다(IF-MD-01, 2026-10-18 결정). 이 화면은 조회만 한다.
//               예전에 ALM에서 직접 만든 클래스(is_manual)는 목록에 표시만 하고 등록·카테고리에서 고를 수 없다
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';

const CODE = /^[A-Za-z0-9_.-]+$/;
export const ALM_KOKRS = 'ALM';
const uuidOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

// ---------------- 코스트센터 ----------------
const ccRow = (r: Record<string, any>) => ({
  id: r.id, companyId: r.company_id, companyCode: r.company_code, costCenterCode: r.cost_center_code, name: r.name, responsible: r.responsible ?? undefined,
  controllingArea: r.controlling_area, isActive: r.is_active, editable: !r.sap_enabled, assetCount: Number(r.assets ?? 0), version: r.version,
});
const CC_SELECT = `SELECT cc.*, co.company_code, co.sap_enabled, (SELECT count(*) FROM asset a WHERE a.cost_center_id = cc.id AND a.status NOT IN ('RETIRED', 'DISPOSED')) AS assets
  FROM cost_center cc JOIN company co ON co.id = cc.company_id`;

export async function listCostCenters(c: PoolClient, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const companyId = k.uuid(q, 'companyId');
  k.done();
  return { items: (await c.query(`${CC_SELECT} WHERE ($1::uuid IS NULL OR cc.company_id = $1) ORDER BY co.company_code, cc.cost_center_code`, [companyId ?? null])).rows.map(ccRow) };
}

async function noSapCompany(c: PoolClient, companyId: string) {
  const co = (await c.query('SELECT sap_enabled, is_active FROM company WHERE id = $1', [companyId])).rows[0];
  if (!co) throw E.notFound('회사코드를 찾을 수 없습니다');
  if (co.sap_enabled) throw new AlmError(409, 'ALM-E322', 'SAP 연계를 쓰는 회사의 코스트센터는 SAP 마스터 수신(IF-MD-01)으로만 바뀝니다');
}

export async function createCostCenter(c: PoolClient, tenantId: string, actorId: string, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const v = { companyId: k.uuid(b, 'companyId', { required: true }), code: k.str(b, 'costCenterCode', { required: true, max: 10, pattern: CODE }),
    name: k.str(b, 'name', { required: true, max: 20 }), responsible: k.str(b, 'responsible', { max: 20 }) };
  k.done();
  await noSapCompany(c, v.companyId!);
  // 코드는 관리 영역과 상관없이 하나만(역할 범위·화면이 코드로 찾는다)
  if ((await c.query('SELECT 1 FROM cost_center WHERE cost_center_code = $1', [v.code])).rowCount) {
    throw E.duplicate(`코스트센터 ${v.code}가 이미 있습니다`);
  }
  const id = randomUUID();
  await c.query(`INSERT INTO cost_center (id, tenant_id, controlling_area, cost_center_code, name, company_id, responsible, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`, [id, tenantId, ALM_KOKRS, v.code, v.name, v.companyId, v.responsible ?? null, actorId]);
  return ccRow((await c.query(`${CC_SELECT} WHERE cc.id = $1`, [id])).rows[0]);
}

export async function patchCostCenter(c: PoolClient, id: string, actorId: string, body: unknown) {
  if (!uuidOk(id)) throw E.notFound('코스트센터를 찾을 수 없습니다');
  const cur = (await c.query(`${CC_SELECT} WHERE cc.id = $1`, [id])).rows[0];
  if (!cur) throw E.notFound('코스트센터를 찾을 수 없습니다');
  await noSapCompany(c, cur.company_id);
  const k = new Check(body);
  const b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const name = has('name') ? k.str(b, 'name', { required: true, max: 20 }) : undefined;
  const responsible = has('responsible') ? k.str(b, 'responsible', { max: 20 }) ?? null : undefined;
  const active = has('isActive') ? k.bool(b, 'isActive') : undefined;
  k.done();
  if (active === false && cur.is_active && Number(cur.assets) > 0) {
    throw new AlmError(409, 'ALM-E318', `이 코스트센터를 쓰는 자산이 ${cur.assets}건 있어 비활성화할 수 없습니다`);
  }
  await c.query(`UPDATE cost_center SET name = coalesce($2, name), responsible = CASE WHEN $3 THEN $4 ELSE responsible END, is_active = coalesce($5, is_active),
      updated_at = now(), updated_by = $6, version = version + 1 WHERE id = $1`, [id, name ?? null, responsible !== undefined, responsible ?? null, active ?? null, actorId]);
  return ccRow((await c.query(`${CC_SELECT} WHERE cc.id = $1`, [id])).rows[0]);
}

// ---------------- 자산클래스 ----------------
const clsRow = (r: Record<string, any>) => ({
  id: r.id, classCode: r.class_code, name: r.name, isLowValue: r.is_low_value, isCapitalized: r.is_capitalized,
  defaultUsefulLifeYears: r.default_useful_life_years ?? undefined, isManual: r.is_manual, isActive: r.is_active, assetCount: Number(r.assets ?? 0), version: r.version,
});
const CLS_SELECT = `SELECT ac.*, (SELECT count(*) FROM asset a WHERE a.asset_class_id = ac.id AND a.status NOT IN ('RETIRED', 'DISPOSED')) AS assets FROM asset_class ac`;

export async function listAssetClasses(c: PoolClient) {
  return { items: (await c.query(`${CLS_SELECT} ORDER BY ac.class_code`)).rows.map(clsRow) };
}
