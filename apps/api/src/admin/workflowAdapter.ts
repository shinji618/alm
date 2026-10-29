// 워크플로 정의의 ALM 어댑터(WBS 4.13, 결정 E-11): 대상 유형·담당자 규칙 카탈로그, 기본 정의, 담당자 풀이(시험 실행)
//   기본 정의 = 게시본이 없을 때 requests.ts가 쓰는 내장 규칙과 같은 동작. 게시본이 있으면 승인 실행이 그 정의를 읽는다(requests/approvalAdapter.ts)
//   승인자 자격(역할 행 범위·approval.decide)은 승인 시점에 requests.ts가 따로 확인하므로 여기서는 "누가 담당이 되는가"만 계산한다
import type { PoolClient } from 'pg';
import type { Catalog, DefOptions, Person, ResolveFn, StepDef, WorkflowDef } from '../platform/workflow';
import { DEFAULT_OPTIONS, NONE, SKIP } from '../platform/workflow';

export const SUBJECTS = [
  { code: 'NEW_ASSET', label: '신규 자산 등록' },
  { code: 'CHANGE', label: '자산 정보 변경' },
  { code: 'TRANSFER', label: '자산 이관' },
  { code: 'RETIRE', label: '자산 폐기' },
  { code: 'SALE', label: '자산 매각' },
] as const;

export const PROXY = 'PROXY_ASSET_ACCOUNTANT';

export const ALM_CATALOG: Catalog = {
  subjects: SUBJECTS.map((s) => ({ ...s })),
  resolvers: [
    { code: 'DEPT_MANAGER_RESPONSIBLE', label: '책임 코스트센터의 부서 관리자(신규·변경은 대상, 그 외는 자산의 현재 값)' },
    { code: 'DEPT_MANAGER_SOURCE', label: '보내는(현재) 코스트센터의 부서 관리자', subjects: ['TRANSFER'] },
    { code: 'DEPT_MANAGER_TARGET', label: '받는(대상) 코스트센터의 부서 관리자', subjects: ['TRANSFER'] },
    { code: 'ROLE_ASSET_ACCOUNTANT', label: '자산회계(회사코드 범위)', final: true },
  ],
  fallbacks: [{ code: PROXY, label: '자산회계가 대리 승인(의견에 [대리] 표시)', resolver: 'ROLE_ASSET_ACCOUNTANT' }],
  mandatoryRules: [
    { code: 'H-01', label: '요청자 본인은 승인할 수 없음' },
    { code: 'H-02', label: '같은 요청의 두 단계를 한 사람이 승인할 수 없음' },
  ],
  maxSteps: 5,
};

const dept = (key: string, label: string, resolver: string, fallback: string, mergeSame: boolean): StepDef => ({ key, label, resolver, fallback, mergeSame });
const FINAL: StepDef = { key: 'accounting', label: '자산회계 최종 승인', resolver: 'ROLE_ASSET_ACCOUNTANT', fallback: NONE, mergeSame: false };

// 지금 동작을 그대로 옮긴 정의(저장된 게시본이 없을 때 화면이 보여 주는 기준)
export function defaultDefinition(subjectType: string): WorkflowDef {
  const subject = SUBJECTS.find((s) => s.code === subjectType);
  const options: DefOptions = { ...DEFAULT_OPTIONS };
  const steps = subjectType === 'TRANSFER'
    ? [dept('source_dept', '보내는 부서 관리자', 'DEPT_MANAGER_SOURCE', SKIP, true), dept('target_dept', '받는 부서 관리자', 'DEPT_MANAGER_TARGET', SKIP, true), FINAL]
    : [dept('dept', '부서 관리자', 'DEPT_MANAGER_RESPONSIBLE', PROXY, true), FINAL];
  return { subjectType, name: `${subject?.label ?? subjectType} 승인`, steps, options };
}

// ---- 시험 실행 문맥과 담당자 풀이 ----
export interface SimCtx { sourceCostCenterId?: string; targetCostCenterId?: string; companyId?: string }

const VALID = `du.is_active AND (ur.valid_from IS NULL OR ur.valid_from <= current_date) AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)`;

async function deptManagers(c: PoolClient, ccId: string | undefined): Promise<Person[]> {
  if (!ccId) return [];
  const rows = (await c.query(`SELECT DISTINCT du.id, du.display_name, cc.cost_center_code
      FROM v_alm_user_role ur JOIN app_user du ON du.id = ur.user_id JOIN cost_center cc ON cc.id = ur.cost_center_id
     WHERE ur.role = 'DEPT_MANAGER' AND ur.cost_center_id = $1 AND ${VALID} ORDER BY du.display_name`, [ccId])).rows;
  return rows.map((r) => ({ id: r.id as string, name: r.display_name as string, detail: r.cost_center_code as string }));
}

async function accountants(c: PoolClient, companyId: string | undefined): Promise<Person[]> {
  const rows = (await c.query(`SELECT DISTINCT du.id, du.display_name, ur.company_code
      FROM v_alm_user_role ur JOIN app_user du ON du.id = ur.user_id
     WHERE ur.role = 'ASSET_ACCOUNTANT' AND ${VALID}
       AND ($1::uuid IS NULL OR ur.company_code IS NULL OR ur.company_code = (SELECT company_code FROM company WHERE id = $1))
     ORDER BY du.display_name`, [companyId ?? null])).rows;
  return rows.map((r) => ({ id: r.id as string, name: r.display_name as string, detail: (r.company_code as string | null) ?? '전체 회사' }));
}

export const almResolver = (c: PoolClient): ResolveFn<SimCtx> => async (resolver, ctx) => {
  switch (resolver) {
    case 'DEPT_MANAGER_RESPONSIBLE': return deptManagers(c, ctx.targetCostCenterId ?? ctx.sourceCostCenterId);
    case 'DEPT_MANAGER_SOURCE': return deptManagers(c, ctx.sourceCostCenterId);
    case 'DEPT_MANAGER_TARGET': return deptManagers(c, ctx.targetCostCenterId);
    case 'ROLE_ASSET_ACCOUNTANT': return accountants(c, ctx.companyId);
    default: return [];
  }
};
