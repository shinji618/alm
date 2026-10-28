// ALM의 공통 사용자 관리 어댑터(문서 17): 범위 차원 = 회사·사이트·코스트센터, 프로필 = 부서·소속 코스트센터
import { PoolClient } from 'pg';
import { E } from '../common/errors';
import { UUID } from '../common/validate';
import { IdentityAdapter, ProfileAdapter, RoleScope, ScopeField } from '../platform/identity/adapter';

const FIELDS: ScopeField[] = [
  { dimension: 'company', field: 'companyCode', max: 4, label: '회사코드' },
  { dimension: 'site', field: 'siteCode', max: 10, label: '사이트' },
  { dimension: 'costCenter', field: 'costCenterCode', max: 10, label: '코스트센터' },
];
const SQL: Record<string, string> = {
  company: 'SELECT id FROM company WHERE company_code = $1',
  site: 'SELECT id FROM site WHERE site_code = $1',
  costCenter: 'SELECT id FROM cost_center WHERE cost_center_code = $1',
};

// 범위 값은 코드로 저장한다(DB FK 없음). 쓸 때 마스터에 하나만 있는지 확인한다
// (코스트센터 코드는 통제영역이 다르면 중복될 수 있어, 여러 건이면 거부)
async function checkScope(c: PoolClient, scope: Record<string, string>, i: number) {
  for (const f of FIELDS) {
    const code = scope[f.dimension];
    if (!code) continue;
    const rows = (await c.query(SQL[f.dimension], [code])).rows;
    if (rows.length !== 1) throw E.badRequest(rows.length ? `${code}가 여러 건입니다` : `없는 코드입니다: ${code}`,
      { errors: [{ field: `roles[${i}].${f.field}`, code: 'ALM-E100', message: rows.length ? '여러 건' : '없는 코드' }] });
  }
}

const profile: ProfileAdapter = {
  joinSql: 'LEFT JOIN alm_user_profile p ON p.user_id = u.id LEFT JOIN cost_center pcc ON pcc.id = p.cost_center_id',
  selectSql: 'p.department, pcc.cost_center_code',
  sorts: { department: 'p.department' },
  parse: (k, o) => ({ department: k.str(o, 'department', { max: 100 }), costCenterId: k.str(o, 'costCenterId', { pattern: UUID }) }),
  async validate(c, v) {
    const id = v.costCenterId as string | undefined;
    if (id && !(await c.query('SELECT 1 FROM cost_center WHERE id = $1', [id])).rowCount)
      throw E.badRequest('없는 코스트센터입니다', { errors: [{ field: 'costCenterId', code: 'ALM-E100', message: '없는 코스트센터' }] });
  },
  async save(c, tenantId, userId, actorId, v) {
    const cols = (['department', 'cost_center_id'] as const).map((col) => [col, v[col === 'department' ? 'department' : 'costCenterId']] as const)
      .filter(([, val]) => val !== undefined);
    if (!cols.length) return;
    const names = cols.map(([n]) => n), vals = cols.map(([, val]) => val);
    await c.query(
      `INSERT INTO alm_user_profile (id, tenant_id, user_id, ${names.join(', ')}, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, ${vals.map((_, i) => `$${i + 4}`).join(', ')}, $3, $3)
       ON CONFLICT (user_id) DO UPDATE SET ${names.map((n, i) => `${n} = $${i + 4}`).join(', ')}, updated_at = now(), updated_by = $3, version = alm_user_profile.version + 1`,
      [tenantId, userId, actorId, ...vals]);
  },
  toRow: (u) => ({ department: u.department, costCenterCode: u.cost_center_code }),
};

export const almIdentity: IdentityAdapter = { scopeFields: FIELDS, checkScope, profile };

// 권한 범위 풀이가 쓰는 ALM 모양(auth/scope.ts·requests.ts)
export interface AlmScope { companyCode?: string; siteCode?: string; costCenterCode?: string }
export const almScope = (r: RoleScope): AlmScope => ({ companyCode: r.scope.company, siteCode: r.scope.site, costCenterCode: r.scope.costCenter });
