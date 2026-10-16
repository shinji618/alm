// 코스트센터별 부서 관리자(관리 > 부서 관리자, ADM-040, 2026-10-15 결정). admin.user
//   부서 관리자 = user_role(DEPT_MANAGER, cost_center_id). 이름·전화·이메일은 app_user(전화는 ALM에서 입력).
//   SAP 코스트센터 책임자(CSKS-VERAK, 자유 텍스트)는 참고로만 보여 주고 승인에는 쓰지 않는다.
//   지정: 이메일로 사용자를 찾고 없으면 만든다(SSO 첫 로그인 때 idp_subject 연결). 한 코스트센터에 여러 명·유효기간 가능.
//   자기 자신의 역할은 바꿀 수 없다(H-03). 직무 충돌(SOD-04 등)은 막지 않고 sod로 알린다(09 5.2). 변경 이력은 감사 트리거
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { E } from '../common/errors';
import { Check, EMAIL, UUID } from '../common/validate';
import { sodConflicts, SodHit } from './sod';

const PHONE = /^[0-9+()\-.\s]{3,30}$/;
const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

const MGR_SQL = `SELECT ur.id, ur.cost_center_id, ur.valid_from, ur.valid_until, u.id AS user_id, u.display_name, u.email, u.phone, u.is_active,
    u.idp_subject IS NOT NULL AS linked,
    (u.is_active AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)) AS active
  FROM user_role ur JOIN app_user u ON u.id = ur.user_id
 WHERE ur.role = 'DEPT_MANAGER'`;

const mgrRow = (m: Record<string, any>) => clean({
  id: m.id as string, userId: m.user_id as string, displayName: m.display_name as string, email: m.email as string, phone: m.phone ?? undefined,
  validFrom: day(m.valid_from), validUntil: day(m.valid_until), active: !!m.active, linked: !!m.linked,
});

export async function listDeptManagers(c: PoolClient, q: Record<string, string | undefined>) {
  const k = new Check(q);
  const companyId = k.uuid(q, 'companyId');
  k.done();
  const text = q.q?.trim() ? `%${q.q.trim().slice(0, 50).replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const ccs = (await c.query(`SELECT cc.id, cc.cost_center_code, cc.name, cc.responsible, cc.is_active, co.company_code, pc.profit_center_code
      FROM cost_center cc JOIN company co ON co.id = cc.company_id LEFT JOIN profit_center pc ON pc.id = cc.profit_center_id
     WHERE ($1::uuid IS NULL OR cc.company_id = $1) AND (cc.is_active OR EXISTS (SELECT 1 FROM user_role x WHERE x.cost_center_id = cc.id AND x.role = 'DEPT_MANAGER'))
       AND ($2::text IS NULL OR cc.cost_center_code ILIKE $2 OR cc.name ILIKE $2
            OR EXISTS (SELECT 1 FROM user_role x JOIN app_user xu ON xu.id = x.user_id WHERE x.cost_center_id = cc.id AND x.role = 'DEPT_MANAGER'
                        AND (xu.display_name ILIKE $2 OR xu.email ILIKE $2)))
     ORDER BY co.company_code, cc.cost_center_code`, [companyId ?? null, text])).rows;
  const mgrs = (await c.query(`${MGR_SQL} AND ur.cost_center_id = ANY($1) ORDER BY u.display_name`, [ccs.map((x) => x.id)])).rows;
  return {
    items: ccs.map((x) => clean({
      costCenterId: x.id as string, costCenterCode: x.cost_center_code as string, name: x.name as string, companyCode: x.company_code as string,
      profitCenterCode: x.profit_center_code ?? undefined, sapResponsible: x.responsible ?? undefined, isActive: !!x.is_active,
      managers: mgrs.filter((m) => m.cost_center_id === x.id).map(mgrRow),
    })),
  };
}

function parse(body: unknown, create: boolean) {
  const k = new Check(body);
  const b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const v = {
    costCenterId: create ? k.uuid(b, 'costCenterId', { required: true }) : undefined,
    email: create ? k.str(b, 'email', { required: true, max: 254, pattern: EMAIL })?.toLowerCase() : undefined,
    displayName: k.str(b, 'displayName', { max: 100 }),
    phone: k.str(b, 'phone', { max: 30, pattern: PHONE }),
    validFrom: k.date(b, 'validFrom'), validUntil: k.date(b, 'validUntil'),
    has,
  };
  if (!create && !['displayName', 'phone', 'validFrom', 'validUntil'].some(has)) k.fail('$', '바꿀 값이 없습니다');
  if (v.validFrom && v.validUntil && v.validFrom > v.validUntil) k.fail('validUntil', '유효 시작일보다 앞설 수 없습니다');
  k.done();
  return v;
}

async function sodOf(c: PoolClient, userId: string): Promise<SodHit[]> {
  const rows = (await c.query(`SELECT r.role, cc.cost_center_code FROM user_role r LEFT JOIN cost_center cc ON cc.id = r.cost_center_id
     WHERE r.user_id = $1 AND (r.valid_from IS NULL OR r.valid_from <= current_date) AND (r.valid_until IS NULL OR r.valid_until >= current_date)`, [userId])).rows;
  return sodConflicts(rows.map((r) => ({ role: r.role, costCenterCode: r.cost_center_code })));
}

async function one(c: PoolClient, id: string) {
  return mgrRow((await c.query(`${MGR_SQL} AND ur.id = $1`, [id])).rows[0]);
}

export interface MgrResult { manager: ReturnType<typeof mgrRow>; userId: string; sod: SodHit[] }

export async function addDeptManager(c: PoolClient, tenantId: string, actorId: string, body: unknown): Promise<MgrResult> {
  const v = parse(body, true);
  const cc = (await c.query('SELECT id, is_active FROM cost_center WHERE id = $1', [v.costCenterId])).rows[0];
  if (!cc) throw E.notFound('코스트센터를 찾을 수 없습니다');
  if (!cc.is_active) throw E.badRequest('비활성 코스트센터에는 부서 관리자를 지정할 수 없습니다');
  let u = (await c.query('SELECT id, display_name FROM app_user WHERE lower(email) = $1 FOR UPDATE', [v.email])).rows[0];
  if (!u) {
    if (!v.displayName) throw E.badRequest('새 사용자는 이름이 필요합니다', { errors: [{ field: 'displayName', code: 'ALM-E101', message: '필수 값입니다' }] });
    u = { id: randomUUID() };
    await c.query(`INSERT INTO app_user (id, tenant_id, email, display_name, phone, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [u.id, tenantId, v.email, v.displayName, v.phone ?? null, actorId]);
  } else {
    if (u.id === actorId) throw E.sod('자기 자신의 역할은 바꿀 수 없습니다(다른 시스템 관리자가 처리)');
    if (v.displayName !== undefined || v.phone !== undefined) {
      await c.query(`UPDATE app_user SET display_name = coalesce($2, display_name), phone = coalesce($3, phone), updated_at = now(), updated_by = $4,
          version = version + 1 WHERE id = $1`, [u.id, v.displayName ?? null, v.phone ?? null, actorId]);
    }
  }
  if ((await c.query(`SELECT 1 FROM user_role WHERE user_id = $1 AND role = 'DEPT_MANAGER' AND cost_center_id = $2`, [u.id, v.costCenterId])).rowCount) {
    throw E.duplicate('이미 이 코스트센터의 부서 관리자입니다');
  }
  const id = randomUUID();
  await c.query(`INSERT INTO user_role (id, tenant_id, user_id, role, cost_center_id, valid_from, valid_until, created_by, updated_by)
    VALUES ($1, $2, $3, 'DEPT_MANAGER', $4, $5, $6, $7, $7)`, [id, tenantId, u.id, v.costCenterId, v.validFrom ?? null, v.validUntil ?? null, actorId]);
  return { manager: await one(c, id), userId: u.id, sod: await sodOf(c, u.id) };
}

async function roleRow(c: PoolClient, id: string, actorId: string) {
  if (!UUID.test(id)) throw E.notFound('부서 관리자 지정을 찾을 수 없습니다');
  const r = (await c.query(`SELECT * FROM user_role WHERE id = $1 AND role = 'DEPT_MANAGER' FOR UPDATE`, [id])).rows[0];
  if (!r) throw E.notFound('부서 관리자 지정을 찾을 수 없습니다');
  if (r.user_id === actorId) throw E.sod('자기 자신의 역할은 바꿀 수 없습니다(다른 시스템 관리자가 처리)');
  return r;
}

export async function patchDeptManager(c: PoolClient, id: string, actorId: string, body: unknown): Promise<MgrResult> {
  const v = parse(body, false);
  const r = await roleRow(c, id, actorId);
  const from = v.has('validFrom') ? v.validFrom ?? null : r.valid_from, until = v.has('validUntil') ? v.validUntil ?? null : r.valid_until;
  if (from && until && day(from)! > day(until)!) throw E.badRequest('유효 종료일이 시작일보다 앞설 수 없습니다', { errors: [{ field: 'validUntil', code: 'ALM-E100', message: '시작일 이전' }] });
  if (v.has('validFrom') || v.has('validUntil')) {
    await c.query(`UPDATE user_role SET valid_from = $2, valid_until = $3, updated_at = now(), updated_by = $4, version = version + 1 WHERE id = $1`,
      [id, from, until, actorId]);
  }
  if (v.has('displayName') || v.has('phone')) {
    await c.query(`UPDATE app_user SET display_name = CASE WHEN $2 THEN coalesce($3, display_name) ELSE display_name END,
        phone = CASE WHEN $4 THEN $5 ELSE phone END, updated_at = now(), updated_by = $6, version = version + 1 WHERE id = $1`,
    [r.user_id, v.has('displayName'), v.displayName ?? null, v.has('phone'), v.phone ?? null, actorId]);
  }
  return { manager: await one(c, id), userId: r.user_id, sod: await sodOf(c, r.user_id) };
}

export async function removeDeptManager(c: PoolClient, id: string, actorId: string): Promise<string> {
  const r = await roleRow(c, id, actorId);
  await c.query('DELETE FROM user_role WHERE id = $1', [id]);
  return r.user_id as string;
}
