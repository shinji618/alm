// 자산태그 번호 범위(관리 > 자산태그 번호 범위, ADM-055, 2026-10-19 결정)
//   Prefix(태그 앞 2자리, 영문 대문자·숫자) + 6자리 번호 구간(From~To)·다음 번호. 카테고리에 지정하면 그 카테고리 자산은 그 범위로 자동 채번한다.
//   카테고리에 없으면 상위 카테고리, 그래도 없으면 기본 범위(테넌트에 하나, 처음에는 AT). 끝에 가까우면(남은 번호 5% 또는 100개 이하) 경고, 다 쓰면 등록 409.
//   Prefix는 만든 뒤 바꾸지 않는다. 시작 번호는 아직 채번하지 않았을 때만 바꾼다. 다음 번호는 관리자가 조정할 수 있다(이미 쓰인 번호는 채번 때 건너뜀).
//   master.read·master.write
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';
import { ensureDefaultRange, MAX_NO, PREFIX, tagOf, usedMax } from '../assets/tags';

const uuidOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const SELECT = `SELECT nr.*,
    (SELECT count(*) FROM asset a WHERE a.asset_tag LIKE nr.prefix || '-%' AND a.asset_tag ~ '^[A-Z0-9]{2}-[0-9]{6}$'
       AND substring(a.asset_tag FROM 4)::int BETWEEN nr.from_no AND nr.to_no) AS used,
    (SELECT coalesce(json_agg(json_build_object('id', cat.id, 'code', cat.category_code, 'name', cat.name) ORDER BY cat.category_code), '[]')
       FROM category cat WHERE cat.number_range_id = nr.id) AS categories
  FROM asset_number_range nr`;

/** 남은 번호가 이 이하이면 경고 */
export const nearlyFull = (from: number, to: number, remaining: number) => remaining <= Math.max(100, Math.ceil((to - from + 1) * 0.05));

async function row(c: PoolClient, r: Record<string, any>) {
  const from = Number(r.from_no), to = Number(r.to_no);
  const next = Math.max(Number(r.next_no), from, (await usedMax(c, r.prefix, from, to)) + 1);
  const remaining = Math.max(0, to - next + 1);
  return {
    id: r.id, version: r.version, prefix: r.prefix, name: r.name, fromNo: from, toNo: to, nextNo: Number(r.next_no),
    nextTag: next <= to ? tagOf(r.prefix, next) : undefined, sample: `${tagOf(r.prefix, from)} ~ ${tagOf(r.prefix, to)}`,
    used: Number(r.used ?? 0), remaining, nearlyFull: r.is_active && nearlyFull(from, to, remaining), exhausted: remaining === 0,
    isDefault: r.is_default, isActive: r.is_active, categories: r.categories ?? [],
  };
}

export async function listNumberRanges(c: PoolClient, tenantId: string) {
  await ensureDefaultRange(c, tenantId);
  const rows = (await c.query(`${SELECT} ORDER BY nr.is_default DESC, nr.is_active DESC, nr.prefix`)).rows;
  return { items: await Promise.all(rows.map((r) => row(c, r))) };
}

function read(body: unknown, partial: boolean) {
  const k = new Check(body), b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const v = {
    prefix: partial ? undefined : k.str(b, 'prefix', { required: true, max: 2 })?.toUpperCase(),
    name: !partial || has('name') ? k.str(b, 'name', { required: true, max: 60 }) : undefined,
    fromNo: has('fromNo') ? k.int(b, 'fromNo', { min: 1, max: MAX_NO }) : undefined,
    toNo: has('toNo') ? k.int(b, 'toNo', { min: 1, max: MAX_NO }) : undefined,
    nextNo: has('nextNo') ? k.int(b, 'nextNo', { min: 1, max: MAX_NO + 1 }) : undefined,
    isDefault: has('isDefault') ? k.bool(b, 'isDefault') : undefined,
    isActive: partial && has('isActive') ? k.bool(b, 'isActive') : undefined,
  };
  if (v.prefix !== undefined && !PREFIX.test(v.prefix)) k.fail('prefix', '영문 대문자·숫자 2자리입니다(예: NB)');
  if (partial && has('prefix')) k.fail('prefix', 'Prefix는 바꿀 수 없습니다');
  k.done();
  return v;
}

const bad = (field: string, message: string) => E.badRequest(`입력 값을 확인하세요: ${field} ${message}`, { errors: [{ field, code: 'ALM-E100', message }] });

function checkSpan(from: number, to: number, next: number) {
  if (to < from) throw bad('toNo', '시작 번호보다 작을 수 없습니다');
  if (next < from || next > to + 1) throw bad('nextNo', `시작 번호(${from})~끝 번호+1(${to + 1}) 사이여야 합니다`);
}

export async function createNumberRange(c: PoolClient, tenantId: string, actorId: string, body: unknown) {
  await ensureDefaultRange(c, tenantId);
  const v = read(body, false);
  if ((await c.query('SELECT 1 FROM asset_number_range WHERE prefix = $1', [v.prefix])).rowCount) throw E.duplicate(`Prefix ${v.prefix}가 이미 있습니다`);
  const from = v.fromNo ?? 1, to = v.toNo ?? MAX_NO, next = v.nextNo ?? from;
  checkSpan(from, to, next);
  const id = randomUUID();
  if (v.isDefault) await c.query('UPDATE asset_number_range SET is_default = false, updated_at = now(), version = version + 1 WHERE is_default');
  await c.query(`INSERT INTO asset_number_range (id, tenant_id, prefix, name, from_no, to_no, next_no, is_default, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, [id, tenantId, v.prefix, v.name, from, to, next, v.isDefault ?? false, actorId]);
  return row(c, (await c.query(`${SELECT} WHERE nr.id = $1`, [id])).rows[0]);
}

export async function patchNumberRange(c: PoolClient, id: string, actorId: string, body: unknown) {
  if (!uuidOk(id)) throw E.notFound('번호 범위를 찾을 수 없습니다');
  const cur = (await c.query(`${SELECT} WHERE nr.id = $1 FOR UPDATE OF nr`, [id])).rows[0];
  if (!cur) throw E.notFound('번호 범위를 찾을 수 없습니다');
  const v = read(body, true);
  const from = v.fromNo ?? Number(cur.from_no), to = v.toNo ?? Number(cur.to_no);
  if (v.fromNo !== undefined && v.fromNo !== Number(cur.from_no) && (Number(cur.used) || Number(cur.next_no) !== Number(cur.from_no))) {
    throw new AlmError(409, 'ALM-E322', '이미 채번한 범위는 시작 번호를 바꿀 수 없습니다(끝 번호·다음 번호만)');
  }
  const used = await usedMax(c, cur.prefix, Number(cur.from_no), Number(cur.to_no));
  if (v.toNo !== undefined && v.toNo < used) throw bad('toNo', `이미 쓰인 번호(${tagOf(cur.prefix, used)})보다 작을 수 없습니다`);
  const next = v.nextNo ?? (v.fromNo !== undefined ? from : Number(cur.next_no));
  checkSpan(from, to, Math.min(next, to + 1));
  if (v.isDefault === false && cur.is_default) throw new AlmError(409, 'ALM-E322', '기본 범위는 다른 범위를 기본으로 지정해서 바꾸세요');
  if (v.isActive === false && (cur.is_default || v.isDefault)) throw new AlmError(409, 'ALM-E322', '기본 범위는 사용 안 함으로 바꿀 수 없습니다');
  if (v.isDefault && !cur.is_default) {
    if (cur.is_active === false && v.isActive !== true) throw new AlmError(409, 'ALM-E322', '사용 안 함인 범위는 기본으로 지정할 수 없습니다');
    await c.query('UPDATE asset_number_range SET is_default = false, updated_at = now(), version = version + 1 WHERE is_default');
  }
  const sets: string[] = [], args: unknown[] = [id];
  const put = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (v.name !== undefined) put('name', v.name);
  if (v.fromNo !== undefined) put('from_no', v.fromNo);
  if (v.toNo !== undefined) put('to_no', v.toNo);
  if (v.nextNo !== undefined || v.fromNo !== undefined) put('next_no', next);
  if (v.isDefault !== undefined) put('is_default', v.isDefault);
  if (v.isActive !== undefined) put('is_active', v.isActive);
  if (sets.length) {
    args.push(actorId);
    await c.query(`UPDATE asset_number_range SET ${sets.join(', ')}, updated_at = now(), updated_by = $${args.length}, version = version + 1 WHERE id = $1`, args);
  }
  return row(c, (await c.query(`${SELECT} WHERE nr.id = $1`, [id])).rows[0]);
}

/** 삭제: 기본 범위·카테고리에 지정된 범위·이 Prefix로 만든 자산이 있으면 409 ALM-E318(사용 안 함으로) */
export async function deleteNumberRange(c: PoolClient, id: string) {
  if (!uuidOk(id)) throw E.notFound('번호 범위를 찾을 수 없습니다');
  const cur = (await c.query(`${SELECT} WHERE nr.id = $1 FOR UPDATE OF nr`, [id])).rows[0];
  if (!cur) throw E.notFound('번호 범위를 찾을 수 없습니다');
  if (cur.is_default) throw new AlmError(409, 'ALM-E318', '기본 범위는 삭제할 수 없습니다');
  if ((cur.categories ?? []).length) throw new AlmError(409, 'ALM-E318', `카테고리(${cur.categories.map((x: { code: string }) => x.code).join(', ')})에 지정되어 있어 삭제할 수 없습니다`);
  if (Number(cur.used)) throw new AlmError(409, 'ALM-E318', `이 범위로 만든 자산이 ${cur.used}건 있어 삭제할 수 없습니다. 사용 안 함으로 바꾸세요`);
  await c.query('DELETE FROM asset_number_range WHERE id = $1', [id]);
}
