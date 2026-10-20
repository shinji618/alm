// 자산 카테고리 관리(관리 > 자산 카테고리, ADM-050, 2026-10-18 결정): 카테고리는 ALM에서 정의하고, 자산클래스는 SAP에서 받은 것만 쓴다.
//   카테고리 = ALM 운영 분류(메뉴·조회·모델·CMDB·교체 내용연수). 기본 자산클래스는 SAP 클래스(is_manual=false)만 고를 수 있다.
//   코드는 만든 뒤 바꾸지 않는다. 삭제 대신 비활성(쓰는 자산·하위 카테고리가 있으면 409 ALM-E318). master.read·master.write
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';
import { PROPERTY_TYPES, type PropertyType } from '../tax/reference';

const CODE = /^[A-Za-z0-9_.-]+$/;
const uuidOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const SELECT = `SELECT cat.*, p.name AS parent_name, ac.class_code, ac.name AS class_name, nr.prefix AS range_prefix,
    (SELECT count(*) FROM asset a WHERE a.category_id = cat.id AND a.status NOT IN ('RETIRED', 'DISPOSED')) AS assets,
    (SELECT count(*) FROM model m WHERE m.category_id = cat.id AND m.is_active) AS models
  FROM category cat LEFT JOIN category p ON p.id = cat.parent_id LEFT JOIN asset_class ac ON ac.id = cat.default_asset_class_id
  LEFT JOIN asset_number_range nr ON nr.id = cat.number_range_id`;

const row = (r: Record<string, any>) => ({
  id: r.id, version: r.version, categoryCode: r.category_code, name: r.name, parentId: r.parent_id ?? undefined, parentName: r.parent_name ?? undefined,
  defaultAssetClassId: r.default_asset_class_id ?? undefined, assetClassCode: r.class_code ?? undefined, assetClassName: r.class_name ?? undefined,
  usefulLifeYears: r.useful_life_years ?? undefined, isCi: r.is_ci, taxPropertyType: r.tax_property_type ?? undefined, isActive: r.is_active,
  assetCount: Number(r.assets ?? 0), modelCount: Number(r.models ?? 0),
  numberRangeId: r.number_range_id ?? undefined, numberRangePrefix: r.range_prefix ?? undefined,
});

export async function listCategories(c: PoolClient, q: Record<string, string | undefined>) {
  const args: unknown[] = [];
  const w: string[] = [];
  if (q.q?.trim()) { args.push(`%${q.q.trim().slice(0, 40).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); w.push(`(cat.category_code ILIKE $1 OR cat.name ILIKE $1)`); }
  if (q.active === 'true') w.push('cat.is_active');
  const rows = (await c.query(`${SELECT} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY cat.is_active DESC, cat.category_code`, args)).rows;
  const eff = await effectivePrefixes(c);
  return { items: rows.map((r) => ({ ...row(r), tagPrefix: eff.get(r.id as string) })) };
}

/** 카테고리별 실제 채번 Prefix(지정 → 상위 → 기본 범위) */
export async function effectivePrefixes(c: PoolClient): Promise<Map<string, string>> {
  const cats = (await c.query('SELECT cat.id, cat.parent_id, nr.prefix FROM category cat LEFT JOIN asset_number_range nr ON nr.id = cat.number_range_id AND nr.is_active')).rows;
  const def = (await c.query('SELECT prefix FROM asset_number_range WHERE is_default AND is_active LIMIT 1')).rows[0]?.prefix ?? 'AT';
  const by = new Map(cats.map((x) => [x.id as string, x]));
  const out = new Map<string, string>();
  for (const x of cats) {
    let cur: Record<string, any> | undefined = x, hops = 0;
    while (cur && !cur.prefix && hops++ < 20) cur = cur.parent_id ? by.get(cur.parent_id) : undefined;
    out.set(x.id, cur?.prefix ?? def);
  }
  return out;
}

function read(body: unknown, partial: boolean) {
  const k = new Check(body), b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const v = {
    code: partial ? undefined : k.str(b, 'categoryCode', { required: true, max: 20, pattern: CODE })?.toUpperCase(),
    name: !partial || has('name') ? k.str(b, 'name', { required: true, max: 60 }) : undefined,
    parentId: has('parentId') ? (b.parentId === null ? null : k.uuid(b, 'parentId')) : undefined,
    classId: has('defaultAssetClassId') ? (b.defaultAssetClassId === null ? null : k.uuid(b, 'defaultAssetClassId')) : undefined,
    life: has('usefulLifeYears') ? (b.usefulLifeYears === null ? null : k.int(b, 'usefulLifeYears', { min: 1, max: 50 })) : undefined,
    isCi: has('isCi') ? k.bool(b, 'isCi') : undefined,
    taxType: has('taxPropertyType') ? (b.taxPropertyType === null ? null : (k.oneOf(b, 'taxPropertyType', PROPERTY_TYPES) as PropertyType | undefined)) : undefined,
    isActive: partial && has('isActive') ? k.bool(b, 'isActive') : undefined,
    rangeId: has('numberRangeId') ? (b.numberRangeId === null ? null : k.uuid(b, 'numberRangeId')) : undefined,
  };
  if (partial && has('categoryCode')) k.fail('categoryCode', '코드는 바꿀 수 없습니다');
  k.done();
  return v;
}

/** 기본 자산클래스는 SAP에서 받은 활성 클래스만 */
async function checkClass(c: PoolClient, id: string | null | undefined) {
  if (!id) return;
  const cls = (await c.query('SELECT is_active, is_manual FROM asset_class WHERE id = $1', [id])).rows[0];
  if (!cls?.is_active || cls.is_manual) {
    throw new AlmError(400, 'ALM-E100', '입력 값을 확인하세요: defaultAssetClassId SAP에서 받은 활성 자산클래스만 쓸 수 있습니다',
      { errors: [{ field: 'defaultAssetClassId', code: 'ALM-E100', message: 'SAP 자산클래스가 아님' }] });
  }
}

/** 자산태그 번호 범위는 사용 중인 것만(ADM-055) */
async function checkRange(c: PoolClient, id: string | null | undefined) {
  if (!id) return;
  if (!(await c.query('SELECT 1 FROM asset_number_range WHERE id = $1 AND is_active', [id])).rowCount) {
    throw E.badRequest('입력 값을 확인하세요: numberRangeId 사용 중인 번호 범위가 아닙니다', { errors: [{ field: 'numberRangeId', code: 'ALM-E100', message: '없음' }] });
  }
}

async function checkParent(c: PoolClient, id: string | null | undefined, self?: string) {
  if (!id) return;
  if (id === self) throw E.badRequest('입력 값을 확인하세요: parentId 자기 자신은 상위가 될 수 없습니다', { errors: [{ field: 'parentId', code: 'ALM-E100', message: '순환' }] });
  if (!(await c.query('SELECT 1 FROM category WHERE id = $1 AND is_active', [id])).rowCount) {
    throw E.badRequest('입력 값을 확인하세요: parentId 활성 카테고리가 아닙니다', { errors: [{ field: 'parentId', code: 'ALM-E100', message: '없음' }] });
  }
  if (self) {
    const cyc = (await c.query(`WITH RECURSIVE up AS (SELECT id, parent_id FROM category WHERE id = $1
        UNION ALL SELECT p.id, p.parent_id FROM category p JOIN up ON p.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`, [id, self])).rowCount;
    if (cyc) throw E.badRequest('입력 값을 확인하세요: parentId 하위 카테고리를 상위로 둘 수 없습니다', { errors: [{ field: 'parentId', code: 'ALM-E100', message: '순환' }] });
  }
}

export async function createCategory(c: PoolClient, tenantId: string, actorId: string, body: unknown) {
  const v = read(body, false);
  if ((await c.query('SELECT 1 FROM category WHERE category_code = $1', [v.code])).rowCount) throw E.duplicate(`카테고리 ${v.code}가 이미 있습니다`);
  await checkParent(c, v.parentId);
  await checkClass(c, v.classId);
  await checkRange(c, v.rangeId);
  const id = randomUUID();
  await c.query(`INSERT INTO category (id, tenant_id, category_code, name, parent_id, default_asset_class_id, useful_life_years, is_ci, tax_property_type, created_by, updated_by,
      number_range_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
  [id, tenantId, v.code, v.name, v.parentId ?? null, v.classId ?? null, v.life ?? null, v.isCi ?? false, v.taxType ?? null, actorId, v.rangeId ?? null]);
  return row((await c.query(`${SELECT} WHERE cat.id = $1`, [id])).rows[0]);
}

export async function patchCategory(c: PoolClient, id: string, actorId: string, body: unknown) {
  if (!uuidOk(id)) throw E.notFound('카테고리를 찾을 수 없습니다');
  const cur = (await c.query(`${SELECT} WHERE cat.id = $1 FOR UPDATE OF cat`, [id])).rows[0];
  if (!cur) throw E.notFound('카테고리를 찾을 수 없습니다');
  const v = read(body, true);
  await checkParent(c, v.parentId, id);
  await checkClass(c, v.classId);
  await checkRange(c, v.rangeId);
  if (v.isActive === false && cur.is_active) {
    const kids = Number((await c.query('SELECT count(*) AS n FROM category WHERE parent_id = $1 AND is_active', [id])).rows[0].n);
    if (Number(cur.assets) || kids) {
      throw new AlmError(409, 'ALM-E318', `이 카테고리를 쓰는 자산 ${cur.assets}건, 하위 카테고리 ${kids}건이 있어 비활성화할 수 없습니다`);
    }
  }
  const sets: string[] = [], args: unknown[] = [id];
  const put = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (v.name !== undefined) put('name', v.name);
  if (v.parentId !== undefined) put('parent_id', v.parentId);
  if (v.classId !== undefined) put('default_asset_class_id', v.classId);
  if (v.life !== undefined) put('useful_life_years', v.life);
  if (v.isCi !== undefined) put('is_ci', v.isCi);
  if (v.taxType !== undefined) put('tax_property_type', v.taxType);
  if (v.isActive !== undefined) put('is_active', v.isActive);
  if (v.rangeId !== undefined) put('number_range_id', v.rangeId);
  if (sets.length) {
    args.push(actorId);
    await c.query(`UPDATE category SET ${sets.join(', ')}, updated_at = now(), updated_by = $${args.length}, version = version + 1 WHERE id = $1`, args);
  }
  return row((await c.query(`${SELECT} WHERE cat.id = $1`, [id])).rows[0]);
}

/** 삭제: 이 카테고리로 등록된 자산(상태 무관)·하위 카테고리·구매요청·실사 미등록 기록이 있으면 409 ALM-E318.
 *  카테고리의 모델(자산이 쓰지 않는)과 재산세 내용연수 구분 매핑은 함께 지운다 */
export async function deleteCategory(c: PoolClient, id: string) {
  if (!uuidOk(id)) throw E.notFound('카테고리를 찾을 수 없습니다');
  const cur = (await c.query('SELECT id, category_code, name FROM category WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound('카테고리를 찾을 수 없습니다');
  const assets = (await c.query(`SELECT asset_tag FROM asset WHERE category_id = $1 ORDER BY asset_tag`, [id])).rows.map((r) => r.asset_tag as string);
  if (assets.length) {
    throw new AlmError(409, 'ALM-E318', `${cur.name}(${cur.category_code}) 카테고리로 등록된 자산이 ${assets.length}건 있어 삭제할 수 없습니다`
      + ` (${assets.slice(0, 5).join(', ')}${assets.length > 5 ? ' 외' : ''}). 자산의 카테고리를 바꾸거나, 삭제 대신 사용 안 함으로 바꾸세요`, { assets: assets.length });
  }
  const kids = (await c.query('SELECT category_code FROM category WHERE parent_id = $1 ORDER BY category_code', [id])).rows.map((r) => r.category_code as string);
  if (kids.length) throw new AlmError(409, 'ALM-E318', `하위 카테고리(${kids.join(', ')})가 있어 삭제할 수 없습니다. 하위 카테고리를 먼저 옮기거나 지우세요`, { children: kids.length });
  const used = Number((await c.query(`SELECT (SELECT count(*) FROM purchase_request_item WHERE category_id = $1
      OR model_id IN (SELECT id FROM model WHERE category_id = $1)) + (SELECT count(*) FROM count_unregistered WHERE category_id = $1) AS n`, [id])).rows[0].n);
  if (used) throw new AlmError(409, 'ALM-E318', `구매요청·실사 미등록 기록 ${used}건에서 쓰고 있어 삭제할 수 없습니다. 삭제 대신 사용 안 함으로 바꾸세요`, { history: used });
  await c.query('DELETE FROM tax_class_map WHERE category_id = $1', [id]);
  await c.query('DELETE FROM model WHERE category_id = $1', [id]);
  await c.query('DELETE FROM category WHERE id = $1', [id]);
}
