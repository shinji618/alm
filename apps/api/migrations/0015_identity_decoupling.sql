-- 0015 사용자 관리 결합 해소(WBS 3.10, 2026-10-28). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   user_role.role·approval.approver_role: DB enum(role_code) → 문자열 코드. 역할 집합은 제품의 권한 카탈로그가 정한다
--   user_role.company_id·site_id·cost_center_id → user_role_scope(차원·값 행). 값은 코드(회사코드·사이트 코드·코스트센터 코드)
--   user_role.scope_key: 범위 정규화 키(중복 방지용 유일 키)
--   app_user.department·cost_center_id → alm_user_profile(ALM 프로필)
--   v_alm_user_role: 역할 행 + 범위 풀이(부서 관리자·승인자 판정)
BEGIN;
ALTER TABLE user_role ALTER COLUMN role TYPE varchar(40) USING role::text;
ALTER TABLE approval ALTER COLUMN approver_role TYPE varchar(40) USING approver_role::text;
DROP TYPE role_code;
COMMENT ON COLUMN user_role.role IS '역할 코드(제품의 권한 카탈로그가 정의. ALM: SYS_ADMIN, ASSET_MANAGER, DEPT_MANAGER, ASSET_ACCOUNTANT, COUNTER, EMPLOYEE, AUDITOR)';
COMMENT ON COLUMN approval.approver_role IS '승인 역할 코드(제품의 권한 카탈로그가 정의)';

-- 사용자 역할 범위: 역할 행의 범위 제한. 한 역할 행의 여러 차원은 AND, 차원 하나에 값 하나
CREATE TABLE user_role_scope (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_role_id uuid NOT NULL,
  dimension varchar(30) NOT NULL,
  value varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (user_role_id, dimension)
);
COMMENT ON COLUMN user_role_scope.id IS '기본키';
COMMENT ON COLUMN user_role_scope.tenant_id IS '테넌트';
COMMENT ON COLUMN user_role_scope.user_role_id IS '역할 행';
COMMENT ON COLUMN user_role_scope.dimension IS '범위 차원(제품의 권한 카탈로그가 정의. ALM: company, site, costCenter)';
COMMENT ON COLUMN user_role_scope.value IS '범위 값(ALM: SAP 회사코드·사이트 코드·코스트센터 코드)';
COMMENT ON COLUMN user_role_scope.created_at IS '생성 일시';
COMMENT ON COLUMN user_role_scope.created_by IS '생성자';
COMMENT ON COLUMN user_role_scope.updated_at IS '변경 일시';
COMMENT ON COLUMN user_role_scope.updated_by IS '변경자';
COMMENT ON COLUMN user_role_scope.version IS '낙관적 잠금';
COMMENT ON TABLE user_role_scope IS '사용자 역할 범위 — 역할 행의 범위 제한. 한 역할 행의 여러 차원은 AND, 차원 하나에 값 하나';
CREATE INDEX ix_user_role_scope_tenant_id_dimension_value ON user_role_scope (tenant_id, dimension, value);

INSERT INTO user_role_scope (id, tenant_id, user_role_id, dimension, value, created_by, updated_by)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'company', co.company_code, r.created_by, r.updated_by FROM user_role r JOIN company co ON co.id = r.company_id;
INSERT INTO user_role_scope (id, tenant_id, user_role_id, dimension, value, created_by, updated_by)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'site', s.site_code, r.created_by, r.updated_by FROM user_role r JOIN site s ON s.id = r.site_id;
INSERT INTO user_role_scope (id, tenant_id, user_role_id, dimension, value, created_by, updated_by)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'costCenter', cc.cost_center_code, r.created_by, r.updated_by FROM user_role r JOIN cost_center cc ON cc.id = r.cost_center_id;

ALTER TABLE user_role ADD COLUMN scope_key varchar(200) NOT NULL DEFAULT '';
COMMENT ON COLUMN user_role.scope_key IS '범위 정규화 키(범위 행을 `차원=값`으로 정렬해 세로선으로 이음, 범위 없으면 빈 문자열). 같은 사용자·역할·범위의 중복을 막는 유일 키';
-- 소유자 세션의 값 보정은 감사 로그에 UPDATE로 남는다(처리자 없음, db_user = 마이그레이션 계정)
UPDATE user_role r SET scope_key = coalesce((SELECT string_agg(s.dimension || '=' || s.value, '|' ORDER BY s.dimension) FROM user_role_scope s WHERE s.user_role_id = r.id), '');
ALTER TABLE user_role DROP COLUMN company_id, DROP COLUMN site_id, DROP COLUMN cost_center_id;
ALTER TABLE user_role ADD UNIQUE NULLS NOT DISTINCT (user_id, role, scope_key);
COMMENT ON TABLE user_role IS '사용자 역할 — 역할 부여. 범위는 user_role_scope(차원·값 행)에 둔다. 범위 행이 없으면 전체';

-- ALM 사용자 프로필: ALM이 사용자에 덧붙이는 정보(부서·소속 코스트센터). 공통 사용자 정보(app_user)와 분리
CREATE TABLE alm_user_profile (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL UNIQUE,
  department varchar(100),
  cost_center_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN alm_user_profile.id IS '기본키';
COMMENT ON COLUMN alm_user_profile.tenant_id IS '테넌트';
COMMENT ON COLUMN alm_user_profile.user_id IS '사용자';
COMMENT ON COLUMN alm_user_profile.department IS '부서명';
COMMENT ON COLUMN alm_user_profile.cost_center_id IS '소속 코스트센터';
COMMENT ON COLUMN alm_user_profile.created_at IS '생성 일시';
COMMENT ON COLUMN alm_user_profile.created_by IS '생성자';
COMMENT ON COLUMN alm_user_profile.updated_at IS '변경 일시';
COMMENT ON COLUMN alm_user_profile.updated_by IS '변경자';
COMMENT ON COLUMN alm_user_profile.version IS '낙관적 잠금';
COMMENT ON TABLE alm_user_profile IS 'ALM 사용자 프로필 — ALM이 사용자에 덧붙이는 정보(부서·소속 코스트센터). 공통 사용자 정보(app_user)와 분리';

INSERT INTO alm_user_profile (id, tenant_id, user_id, department, cost_center_id, created_by, updated_by)
SELECT gen_random_uuid(), u.tenant_id, u.id, u.department, u.cost_center_id, u.created_by, u.updated_by FROM app_user u WHERE u.department IS NOT NULL OR u.cost_center_id IS NOT NULL;
ALTER TABLE app_user DROP COLUMN department, DROP COLUMN cost_center_id;

-- ALM 역할 행 + 범위 풀이: 범위 값(코드)을 열로 펴고 코스트센터는 id까지 푼다(부서 관리자·승인자 판정용)
CREATE VIEW v_alm_user_role WITH (security_invoker = true) AS
SELECT ur.id, ur.tenant_id, ur.user_id, ur.role, ur.valid_from, ur.valid_until,
       (SELECT s.value FROM user_role_scope s WHERE s.user_role_id = ur.id AND s.dimension = 'company') AS company_code,
       (SELECT s.value FROM user_role_scope s WHERE s.user_role_id = ur.id AND s.dimension = 'site') AS site_code,
       (SELECT s.value FROM user_role_scope s WHERE s.user_role_id = ur.id AND s.dimension = 'costCenter') AS cost_center_code,
       (SELECT cc.id FROM cost_center cc JOIN user_role_scope s ON s.user_role_id = ur.id AND s.dimension = 'costCenter'
         WHERE cc.tenant_id = ur.tenant_id AND cc.cost_center_code = s.value ORDER BY cc.id LIMIT 1) AS cost_center_id
  FROM user_role ur;

ALTER TABLE user_role_scope ADD CONSTRAINT fk_user_role_scope_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE user_role_scope ADD CONSTRAINT fk_user_role_scope_user_role_id FOREIGN KEY (user_role_id) REFERENCES user_role(id);
ALTER TABLE alm_user_profile ADD CONSTRAINT fk_alm_user_profile_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE alm_user_profile ADD CONSTRAINT fk_alm_user_profile_user_id FOREIGN KEY (user_id) REFERENCES app_user(id);
ALTER TABLE alm_user_profile ADD CONSTRAINT fk_alm_user_profile_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE user_role_scope ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_user_role_scope_tenant ON user_role_scope USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE alm_user_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_alm_user_profile_tenant ON alm_user_profile USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- 감사 트리거: audit_row()는 alm_audit_owner 소유이고 PUBLIC 실행 권한이 없다. RDS(비 슈퍼유저 소유자)에서는 트리거를 만드는 동안만
-- 소유자 세션에 EXECUTE를 주고 바로 회수한다(러너 withAuditOwner가 이 트랜잭션 동안 SET ROLE 권한을 준다)
SET LOCAL ROLE alm_audit_owner;
GRANT EXECUTE ON FUNCTION audit_row() TO SESSION_USER;
RESET ROLE;
CREATE TRIGGER tr_user_role_scope_audit AFTER INSERT OR UPDATE OR DELETE ON user_role_scope FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_alm_user_profile_audit AFTER INSERT OR UPDATE OR DELETE ON alm_user_profile FOR EACH ROW EXECUTE FUNCTION audit_row();
SET LOCAL ROLE alm_audit_owner;
REVOKE EXECUTE ON FUNCTION audit_row() FROM SESSION_USER;
RESET ROLE;
COMMIT;
