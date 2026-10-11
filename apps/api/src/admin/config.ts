// 공통 코드·설정(openapi listCodes·putCodeGroup·listSettings·putSetting). 테넌트 트랜잭션 안에서 부른다
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Check } from '../common/validate';
import { E } from '../common/errors';

const CODE = /^[A-Z0-9_.-]{1,30}$/;

export async function listCodes(c: PoolClient) {
  const rows = (await c.query(
    `SELECT code_group, code, label_en, label_ko, sort_order, is_active FROM code ORDER BY code_group, sort_order, code`)).rows;
  const groups = new Map<string, unknown[]>();
  for (const r of rows) {
    const g = groups.get(r.code_group) ?? [];
    g.push({ code: r.code, labelEn: r.label_en, ...(r.label_ko ? { labelKo: r.label_ko } : {}), sortOrder: r.sort_order, isActive: r.is_active });
    groups.set(r.code_group, g);
  }
  return { items: [...groups.entries()].map(([group, codes]) => ({ group, codes })) };
}

// 그룹 전체 교체. 목록에서 빠진 코드는 지우지 않고 비활성(이미 쓰인 값이 화면에서 깨지지 않게)
export async function putCodeGroup(c: PoolClient, tenantId: string, group: string, actorId: string, body: unknown) {
  if (!CODE.test(group)) throw E.badRequest('코드 그룹은 대문자·숫자·_.- 1~30자');
  const k = new Check(body), o = k.obj();
  const g = k.str(o, 'group', { required: true, max: 30 });
  if (g && g !== group) k.fail('group', '경로의 그룹과 같아야 합니다');
  const list = k.arr(o, 'codes', { required: true, max: 500 });
  const codes = list.map((x, i) => {
    const r = k.obj(x, `codes[${i}]`);
    const f = (n: string) => `codes[${i}].${n}`;
    return { code: k.str(r, 'code', { required: true, pattern: CODE, field: f('code') }), labelEn: k.str(r, 'labelEn', { required: true, max: 100, field: f('labelEn') }),
      labelKo: k.str(r, 'labelKo', { max: 100, field: f('labelKo') }), sortOrder: k.int(r, 'sortOrder', { min: 0, max: 100000, field: f('sortOrder') }) ?? (i + 1) * 10,
      isActive: k.bool(r, 'isActive', f('isActive')) ?? true };
  });
  const names = codes.map((x) => x.code);
  if (new Set(names).size !== names.length) k.fail('codes', '같은 코드가 중복되었습니다');
  k.done();
  for (const x of codes) {
    await c.query(
      `INSERT INTO code (id, tenant_id, code_group, code, label_en, label_ko, sort_order, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (tenant_id, code_group, code) DO UPDATE SET label_en = EXCLUDED.label_en, label_ko = EXCLUDED.label_ko,
         sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, updated_at = now(), updated_by = EXCLUDED.updated_by,
         version = code.version + 1`,
      [randomUUID(), tenantId, group, x.code, x.labelEn, x.labelKo ?? null, x.sortOrder, x.isActive, actorId]);
  }
  await c.query(`UPDATE code SET is_active = false, updated_at = now(), updated_by = $3, version = version + 1
                  WHERE code_group = $1 AND is_active AND NOT (code = ANY($2))`, [group, names, actorId]);
  return (await listCodes(c)).items.find((x) => x.group === group) ?? { group, codes: [] };
}

// ---- 설정: 아는 키만, 키별 형식 검사 ----
type Validator = (v: unknown) => string | undefined;
const num = (min: number, max: number, minExclusive = false): Validator => (v) =>
  typeof v !== 'number' || !Number.isFinite(v) || (minExclusive ? v <= min : v < min) || v > max ? `숫자 ${minExclusive ? '>' : '≥'}${min}, ≤${max}` : undefined;
const isoTime = (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
export const SETTINGS: Record<string, { description: string; check: Validator }> = {
  'license.over_threshold': { description: '사용 < 보유 × 이 값이면 과잉 라이선스(기본 0.8)', check: num(0, 1, true) },
  'asset.capitalization_threshold': { description: '자본화 기준 금액(이 금액 이상만 SAP 자산 생성)', check: num(0, 1e12) },
  'sap.posting_blackout': { description: '월말 마감 기간: 이 기간에는 SAP 전기 건을 내주지 않음. {} 이면 끔',
    check: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return '{from, to} 객체';
      const o = v as Record<string, unknown>;
      if (!Object.keys(o).length) return undefined;
      if (Object.keys(o).some((x) => x !== 'from' && x !== 'to')) return 'from, to만 허용';
      if (!isoTime(o.from) || !isoTime(o.to)) return 'from·to는 ISO 일시(예: 2026-10-30T18:00:00-04:00)';
      return Date.parse(o.from as string) < Date.parse(o.to as string) ? undefined : 'from이 to보다 앞서야 합니다';
    } },
  'pda.device_approval': { description: '처음 보는 PDA를 관리자 승인 전까지 막음(파일럿 false)', check: (v) => (typeof v === 'boolean' ? undefined : '참·거짓') },
};

export async function listSettings(c: PoolClient) {
  const rows = (await c.query('SELECT key, value, description FROM setting ORDER BY key')).rows;
  return { items: rows.map((r) => ({ key: r.key, value: r.value, ...(r.description ?? SETTINGS[r.key]?.description ? { description: r.description ?? SETTINGS[r.key]?.description } : {}) })) };
}

export async function putSetting(c: PoolClient, tenantId: string, key: string, actorId: string, body: unknown) {
  const def = SETTINGS[key];
  if (!def) throw E.badRequest(`모르는 설정 키입니다: ${key}`, { errors: [{ field: 'key', code: 'ALM-E100', message: `허용: ${Object.keys(SETTINGS).join(', ')}` }] });
  const k = new Check(body), o = k.obj();
  const bodyKey = k.str(o, 'key', { required: true, max: 60 });
  if (bodyKey && bodyKey !== key) k.fail('key', '경로의 키와 같아야 합니다');
  if (!('value' in o)) k.fail('value', '필수 값입니다');
  else { const err = def.check(o.value); if (err) k.fail('value', err); }
  const description = k.str(o, 'description', { max: 200 });
  k.done();
  const r = (await c.query(
    `INSERT INTO setting (id, tenant_id, key, value, description, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, description = coalesce(EXCLUDED.description, setting.description),
       updated_at = now(), updated_by = EXCLUDED.updated_by, version = setting.version + 1
     RETURNING key, value, description`,
    [randomUUID(), tenantId, key, JSON.stringify(o.value), description ?? null, actorId])).rows[0];
  return { key: r.key, value: r.value, ...(r.description ? { description: r.description } : {}) };
}
