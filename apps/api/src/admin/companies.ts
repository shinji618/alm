// 회사코드 설정(openapi listCompanies·createCompany·patchCompany, 관리 화면 "회사·SAP 연계"). 2026-10-13 결정
//   sapEnabled : SAP 연계 사용. 끄면 SAP 연결로 들어오는 호출을 받지 않고(인증 단계), 화면은 SAP 필드·기능을 숨기며,
//                자산 요청은 승인 후 ALM에만 반영한다. 끄기 전에 SAP 전기 대기·실패 건이 있으면 409(먼저 처리·취소)
//   approvalSteps: 2 부서 관리자 → 자산회계, 1 부서 관리자, 0 승인 없음. 1·0은 SAP 연계를 끈 회사만(DB CHECK와 같은 규칙)
//   회사 등록: SAP 연계를 쓰지 않는 회사(SAP 회사는 IF-MD-01로 들어온다). 기본 sapEnabled=false
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError, E } from '../common/errors';
import { Check } from '../common/validate';

const row = (r: Record<string, any>) => ({
  id: r.id, companyCode: r.company_code, name: r.name, currency: r.currency, sapEnabled: r.sap_enabled, approvalSteps: r.approval_steps,
  isActive: r.is_active, sapSyncedAt: r.sap_synced_at ? new Date(r.sap_synced_at).toISOString() : undefined,
  sapConnections: Number(r.connections ?? 0), version: r.version,
});
const SELECT = `SELECT co.*, (SELECT count(*) FROM sap_connection sc WHERE sc.company_id = co.id AND sc.is_active) AS connections FROM company co`;

export async function listCompanies(c: PoolClient) {
  return { items: (await c.query(`${SELECT} ORDER BY co.company_code`)).rows.map(row) };
}

function stepsOk(k: Check, sap: boolean, steps: number) {
  if (sap && steps !== 2) k.fail('approvalSteps', 'SAP 연계를 쓰는 회사는 2단계(부서 관리자 → 자산회계)만');
}

export async function createCompany(c: PoolClient, tenantId: string, actorId: string, body: unknown) {
  const k = new Check(body);
  const b = k.obj();
  const v = {
    companyCode: k.str(b, 'companyCode', { required: true, max: 4, pattern: /^[A-Z0-9]{1,4}$/ }), name: k.str(b, 'name', { required: true, max: 25 }),
    currency: k.str(b, 'currency', { max: 5, pattern: /^[A-Z]{3,5}$/ }) ?? 'USD', sapEnabled: k.bool(b, 'sapEnabled') ?? false,
    approvalSteps: k.int(b, 'approvalSteps', { min: 0, max: 2 }) ?? 2,
  };
  stepsOk(k, v.sapEnabled, v.approvalSteps);
  k.done();
  if ((await c.query('SELECT 1 FROM company WHERE company_code = $1', [v.companyCode])).rowCount) throw E.duplicate(`회사코드 ${v.companyCode}가 이미 있습니다`);
  const id = randomUUID();
  await c.query(`INSERT INTO company (id, tenant_id, company_code, name, currency, sap_enabled, approval_steps, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`, [id, tenantId, v.companyCode, v.name, v.currency, v.sapEnabled, v.approvalSteps, actorId]);
  return row((await c.query(`${SELECT} WHERE co.id = $1`, [id])).rows[0]);
}

export async function patchCompany(c: PoolClient, id: string, actorId: string, body: unknown) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw E.notFound('회사코드를 찾을 수 없습니다');
  const cur = (await c.query('SELECT * FROM company WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw E.notFound('회사코드를 찾을 수 없습니다');
  const k = new Check(body);
  const b = k.obj();
  const has = (f: string) => Object.prototype.hasOwnProperty.call(b, f);
  const name = has('name') ? k.str(b, 'name', { required: true, max: 25 }) : undefined;
  const sap = has('sapEnabled') ? k.bool(b, 'sapEnabled') : undefined;
  let steps = has('approvalSteps') ? k.int(b, 'approvalSteps', { min: 0, max: 2 }) : undefined;
  const nextSap = sap ?? cur.sap_enabled;
  if (nextSap && steps === undefined) steps = 2;   // SAP을 켜면 2단계로
  stepsOk(k, nextSap, steps ?? cur.approval_steps);
  k.done();
  if (cur.sap_enabled && sap === false) {
    const n = (await c.query(`SELECT count(*)::int AS n FROM sap_posting WHERE company_id = $1 AND status IN ('READY', 'CLAIMED', 'FAILED')`, [id])).rows[0].n;
    if (n) throw new AlmError(409, 'ALM-E322', `SAP 전기 대기·실패 건이 ${n}건 있습니다. SAP 연계 화면에서 처리하거나 취소한 뒤 끄세요`);
  }
  await c.query(`UPDATE company SET name = coalesce($2, name), sap_enabled = $3, approval_steps = $4, updated_at = now(), updated_by = $5, version = version + 1
    WHERE id = $1`, [id, name ?? null, nextSap, steps ?? cur.approval_steps, actorId]);
  return row((await c.query(`${SELECT} WHERE co.id = $1`, [id])).rows[0]);
}
