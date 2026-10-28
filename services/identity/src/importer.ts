// 제품 사용자 이관(WBS 3.13): 제품 DB의 사용자·역할을 같은 ID로 올린다(제품이 사용자 ID를 업무 데이터에서 참조하므로).
// 제품 백엔드(write)는 자기 제품을 쓰는 테넌트에만. 다시 실행해도 된다(ID로 갱신). 역할 규칙 위반·이메일 충돌 사용자는 건너뛰고 사유를 돌려준다.
// H-03·H-04(처리자 기준 규칙)는 이관에 적용하지 않는다
import { Tx } from './db';
import { E } from './errors';
import { Check, EMAIL, UUID } from './validate';
import { Catalog, scopeKey } from './catalog';
import { parseAssignments } from './roles';

export async function importUsers(c: Tx, tenantId: string, product: string, cat: Catalog, body: unknown) {
  const k = new Check(body), o = k.obj();
  const list = k.arr(o, 'users', { required: true, max: 2000 });
  k.done();
  let created = 0, updated = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const [i, x] of list.entries()) {
    const uk = new Check(x), u = uk.obj();
    const id = uk.str(u, 'id', { required: true, pattern: UUID }) ?? `#${i}`;
    const email = uk.str(u, 'email', { required: true, max: 254, pattern: EMAIL })?.toLowerCase();
    const displayName = uk.str(u, 'displayName', { required: true, max: 100 });
    const employeeNo = uk.str(u, 'employeeNo', { max: 20 });
    const isActive = uk.bool(u, 'isActive') ?? true;
    const idpSubject = uk.str(u, 'idpSubject', { max: 255, pattern: /^T-[A-Z0-9-]{1,20}_\S+$/ });
    const lastLoginAt = uk.str(u, 'lastLoginAt', { max: 40 });
    if (uk.errors.length) { skipped.push({ id, reason: `${uk.errors[0].field} ${uk.errors[0].message}` }); continue; }
    let roles;
    try { roles = parseAssignments({ roles: u.roles ?? [] }, cat, '9000-01-01'); }   // 최대 유효기간(감사인 1년)은 원래 부여 때 검사했으므로 이관에서는 보지 않는다(기준일을 먼 미래로)
    catch (e: any) { skipped.push({ id, reason: `roles: ${e?.errors?.[0]?.field ?? ''} ${e?.errors?.[0]?.message ?? e?.message}` }); continue; }
    const cur = (await c.query(`SELECT id::text, tenant_id::text FROM app_user WHERE id = $1::uuid`, [id])).rows[0];
    const byEmail = (await c.query(`SELECT id::text FROM app_user WHERE email = $1`, [email])).rows[0];
    if (byEmail && byEmail.id !== id) { skipped.push({ id, reason: `같은 이메일의 다른 사용자가 있음(${byEmail.id})` }); continue; }
    if (idpSubject && (await c.query(`SELECT 1 FROM app_user WHERE idp_subject = $1 AND id <> $2::uuid`, [idpSubject, id])).rowCount) {
      skipped.push({ id, reason: '같은 IdP 사용자가 다른 사용자에 연결됨' }); continue;
    }
    if (cur) {
      await c.query(`UPDATE app_user SET email = $2, display_name = $3, employee_no = $4, is_active = $5, idp_subject = coalesce(idp_subject, $6),
          last_login_at = greatest(last_login_at, $7::timestamptz), updated_at = now(), version = version + 1 WHERE id = $1::uuid`,
        [id, email, displayName, employeeNo ?? null, isActive, idpSubject ?? null, lastLoginAt ?? null]);
      updated++;
    } else {
      // 다른 테넌트에 같은 ID가 있으면 RLS 때문에 보이지 않아 INSERT가 기본 키 충돌로 실패한다 → 건너뜀
      try {
        await c.query('SAVEPOINT imp');
        await c.query(`INSERT INTO app_user (id, tenant_id, email, display_name, employee_no, is_active, idp_subject, last_login_at)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz)`, [id, tenantId, email, displayName, employeeNo ?? null, isActive, idpSubject ?? null, lastLoginAt ?? null]);
        await c.query('RELEASE SAVEPOINT imp');
      } catch (e: any) {
        await c.query('ROLLBACK TO SAVEPOINT imp');
        if (e?.code === '23505' || /duplicate key/.test(String(e?.message))) { skipped.push({ id, reason: 'ID가 이미 있음(다른 테넌트)' }); continue; }
        throw e;
      }
      created++;
    }
    await c.query(`DELETE FROM role_assignment WHERE user_id = $1::uuid AND product_code = $2`, [id, product]);
    for (const r of roles) {
      const aid = (await c.query(`INSERT INTO role_assignment (tenant_id, user_id, product_code, role, scope_key, valid_from, valid_until)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date) RETURNING id::text`,
        [tenantId, id, product, r.role, scopeKey(r.scope), r.validFrom ?? null, r.validUntil ?? null])).rows[0].id;
      for (const [d, v] of Object.entries(r.scope))
        await c.query(`INSERT INTO role_assignment_scope (tenant_id, assignment_id, dimension, value) VALUES ($1::uuid, $2::uuid, $3, $4)`, [tenantId, aid, d, v]);
    }
  }
  if (!list.length) throw E.bad('users가 비었습니다');
  return { created, updated, skipped };
}
