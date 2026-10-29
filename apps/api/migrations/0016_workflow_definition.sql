-- 0016 워크플로 정의 관리(WBS 4.13, 결정 E-11, 2026-10-29). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   workflow_definition: 승인 흐름 정의(대상 유형별 버전: 초안·게시·보관). 승인 실행에는 아직 연결하지 않는다(4.10·4.11)
BEGIN;
CREATE TYPE workflow_def_status AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');  -- 워크플로 정의 상태
-- 워크플로 정의: 승인 흐름 정의(4.13, 결정 E-11). 대상 유형별로 버전을 쌓는다. 초안(DRAFT) 1개, 게시(PUBLISHED) 1개, 이전 게시는 ARCHIVED. 게시한 정의를 승인 실행에 연결하는 일은 4.10·4.11
CREATE TABLE workflow_definition (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  subject_type varchar(40) NOT NULL,
  version_no integer NOT NULL,
  status workflow_def_status NOT NULL DEFAULT 'DRAFT',
  name varchar(100) NOT NULL,
  steps jsonb NOT NULL,
  options jsonb NOT NULL,
  change_note varchar(200),
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, subject_type, version_no)
);
COMMENT ON COLUMN workflow_definition.id IS '기본키';
COMMENT ON COLUMN workflow_definition.tenant_id IS '테넌트';
COMMENT ON COLUMN workflow_definition.subject_type IS '대상 유형 코드(제품이 정함. ALM: 자산 요청 유형 NEW_ASSET, CHANGE, TRANSFER, RETIRE, SALE)';
COMMENT ON COLUMN workflow_definition.version_no IS '대상 유형별 버전(1부터)';
COMMENT ON COLUMN workflow_definition.status IS '초안·게시·보관';
COMMENT ON COLUMN workflow_definition.name IS '흐름 이름';
COMMENT ON COLUMN workflow_definition.steps IS '단계 목록. 각 단계: key, label, resolver(담당자 규칙 코드), fallback(담당자가 없을 때), mergeSame';
COMMENT ON COLUMN workflow_definition.options IS '직무 분리 선택 규칙(필수 규칙은 엔진이 항상 적용하므로 저장하지 않음)';
COMMENT ON COLUMN workflow_definition.change_note IS '변경 메모';
COMMENT ON COLUMN workflow_definition.published_at IS '게시 일시';
COMMENT ON COLUMN workflow_definition.published_by IS '게시한 사용자';
COMMENT ON COLUMN workflow_definition.created_at IS '생성 일시';
COMMENT ON COLUMN workflow_definition.created_by IS '생성자';
COMMENT ON COLUMN workflow_definition.updated_at IS '변경 일시';
COMMENT ON COLUMN workflow_definition.updated_by IS '변경자';
COMMENT ON COLUMN workflow_definition.version IS '낙관적 잠금';
COMMENT ON TABLE workflow_definition IS '워크플로 정의 — 승인 흐름 정의(4.13, 결정 E-11). 대상 유형별로 버전을 쌓는다. 초안(DRAFT) 1개, 게시(PUBLISHED) 1개, 이전 게시는 ARCHIVED. 게시한 정의를 승인 실행에 연결하는 일은 4.10·4.11';
CREATE INDEX ix_workflow_definition_tenant_id_subject_type_status ON workflow_definition (tenant_id, subject_type, status);
ALTER TABLE workflow_definition ADD CONSTRAINT fk_workflow_definition_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE workflow_definition ADD CONSTRAINT fk_workflow_definition_published_by FOREIGN KEY (published_by) REFERENCES app_user(id);
ALTER TABLE workflow_definition ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_workflow_definition_tenant ON workflow_definition USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- 감사 트리거: audit_row()는 alm_audit_owner 소유이고 PUBLIC 실행 권한이 없다(0015와 같은 방식)
SET LOCAL ROLE alm_audit_owner;
GRANT EXECUTE ON FUNCTION audit_row() TO SESSION_USER;
RESET ROLE;
CREATE TRIGGER tr_workflow_definition_audit AFTER INSERT OR UPDATE OR DELETE ON workflow_definition FOR EACH ROW EXECUTE FUNCTION audit_row();
SET LOCAL ROLE alm_audit_owner;
REVOKE EXECUTE ON FUNCTION audit_row() FROM SESSION_USER;
RESET ROLE;
COMMIT;
