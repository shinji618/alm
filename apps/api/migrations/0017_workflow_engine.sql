-- 0017 워크플로 엔진 실행 테이블(WBS 4.10, 2026-10-29). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   workflow_instance·workflow_step: 승인 엔진(platform/workflow)이 실행하는 승인과 단계. 4.11 전까지 ALM 승인은 approval 테이블을 그대로 쓴다
BEGIN;
CREATE TYPE workflow_instance_status AS ENUM ('IN_PROGRESS', 'APPROVED', 'REJECTED', 'CANCELLED');  -- 워크플로 인스턴스 상태
-- 워크플로 인스턴스: 승인 엔진(4.10)이 실행하는 승인 1건. 대상(subject_type, subject_id)은 제품이 정한다. 진행 중 인스턴스는 대상당 1건(저장소가 잠금으로 보장). 4.11 전까지 ALM 승인은 approval 테이블을 쓴다
CREATE TABLE workflow_instance (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  subject_type varchar(40) NOT NULL,
  subject_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  status workflow_instance_status NOT NULL DEFAULT 'IN_PROGRESS',
  current_step integer NOT NULL DEFAULT 1,
  rules jsonb NOT NULL,
  submitted_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN workflow_instance.id IS '기본키';
COMMENT ON COLUMN workflow_instance.tenant_id IS '테넌트';
COMMENT ON COLUMN workflow_instance.subject_type IS '대상 유형(ALM: 자산 요청 유형)';
COMMENT ON COLUMN workflow_instance.subject_id IS '대상 id(제품 테이블의 행, FK 없음)';
COMMENT ON COLUMN workflow_instance.requester_id IS '요청자(본인 승인 불가 판단)';
COMMENT ON COLUMN workflow_instance.status IS '진행·승인·반려·취소';
COMMENT ON COLUMN workflow_instance.current_step IS '지금 단계 번호';
COMMENT ON COLUMN workflow_instance.rules IS '직무 분리 선택 규칙(fixerCannotReapprove). 제출 때 정의에서 복사해 이후 정의가 바뀌어도 진행 중 건은 그대로';
COMMENT ON COLUMN workflow_instance.submitted_at IS '제출(재시작) 일시';
COMMENT ON COLUMN workflow_instance.completed_at IS '완료(승인·반려·취소) 일시';
COMMENT ON COLUMN workflow_instance.created_at IS '생성 일시';
COMMENT ON COLUMN workflow_instance.created_by IS '생성자';
COMMENT ON COLUMN workflow_instance.updated_at IS '변경 일시';
COMMENT ON COLUMN workflow_instance.updated_by IS '변경자';
COMMENT ON COLUMN workflow_instance.version IS '낙관적 잠금';
COMMENT ON TABLE workflow_instance IS '워크플로 인스턴스 — 승인 엔진(4.10)이 실행하는 승인 1건. 대상(subject_type, subject_id)은 제품이 정한다. 진행 중 인스턴스는 대상당 1건(저장소가 잠금으로 보장). 4.11 전까지 ALM 승인은 approval 테이블을 쓴다';
CREATE INDEX ix_workflow_instance_tenant_id_subject_type_subject_id ON workflow_instance (tenant_id, subject_type, subject_id);
CREATE INDEX ix_workflow_instance_tenant_id_status ON workflow_instance (tenant_id, status);

-- 워크플로 단계: 승인 엔진 인스턴스의 단계. 담당자는 미리 정하지 않고 결정 시점에 제품의 자격 판단(역할·범위)으로 확인한다. 결정 값은 승인 테이블과 같은 ApprovalDecision
CREATE TABLE workflow_step (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  step_no integer NOT NULL,
  step_key varchar(30) NOT NULL,
  label varchar(40) NOT NULL,
  resolver varchar(60) NOT NULL,
  params jsonb,
  proxy boolean NOT NULL DEFAULT false,
  merge_same boolean NOT NULL DEFAULT false,
  min_approvals integer NOT NULL DEFAULT 1,
  due_at timestamptz,
  status approval_decision NOT NULL DEFAULT 'PENDING',
  approver_id uuid,
  comment varchar(500),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (instance_id, step_no),
  UNIQUE (instance_id, step_key)
);
COMMENT ON COLUMN workflow_step.id IS '기본키';
COMMENT ON COLUMN workflow_step.tenant_id IS '테넌트';
COMMENT ON COLUMN workflow_step.instance_id IS '인스턴스';
COMMENT ON COLUMN workflow_step.step_no IS '단계(1부터)';
COMMENT ON COLUMN workflow_step.step_key IS '단계 키(정의의 key)';
COMMENT ON COLUMN workflow_step.label IS '화면 이름';
COMMENT ON COLUMN workflow_step.resolver IS '담당자 규칙 코드';
COMMENT ON COLUMN workflow_step.params IS '제품이 담당자 판단에 쓰는 값(예: 코스트센터 id)';
COMMENT ON COLUMN workflow_step.proxy IS '담당자가 없어 대리 규칙으로 정한 단계';
COMMENT ON COLUMN workflow_step.merge_same IS '앞 단계 승인자가 이 단계 자격도 있으면 함께 승인';
COMMENT ON COLUMN workflow_step.min_approvals IS 'N명 중 M명(지금은 1만, 멀티 뱅크 자리)';
COMMENT ON COLUMN workflow_step.due_at IS '승인 기한(지금은 기록만)';
COMMENT ON COLUMN workflow_step.status IS '결정';
COMMENT ON COLUMN workflow_step.approver_id IS '승인자(결정 시 기록)';
COMMENT ON COLUMN workflow_step.comment IS '의견';
COMMENT ON COLUMN workflow_step.decided_at IS '결정 일시';
COMMENT ON COLUMN workflow_step.created_at IS '생성 일시';
COMMENT ON COLUMN workflow_step.created_by IS '생성자';
COMMENT ON COLUMN workflow_step.updated_at IS '변경 일시';
COMMENT ON COLUMN workflow_step.updated_by IS '변경자';
COMMENT ON COLUMN workflow_step.version IS '낙관적 잠금';
COMMENT ON TABLE workflow_step IS '워크플로 단계 — 승인 엔진 인스턴스의 단계. 담당자는 미리 정하지 않고 결정 시점에 제품의 자격 판단(역할·범위)으로 확인한다. 결정 값은 승인 테이블과 같은 ApprovalDecision';
CREATE INDEX ix_workflow_step_tenant_id_status ON workflow_step (tenant_id, status);
ALTER TABLE workflow_instance ADD CONSTRAINT fk_workflow_instance_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE workflow_instance ADD CONSTRAINT fk_workflow_instance_requester_id FOREIGN KEY (requester_id) REFERENCES app_user(id);
ALTER TABLE workflow_step ADD CONSTRAINT fk_workflow_step_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE workflow_step ADD CONSTRAINT fk_workflow_step_instance_id FOREIGN KEY (instance_id) REFERENCES workflow_instance(id);
ALTER TABLE workflow_step ADD CONSTRAINT fk_workflow_step_approver_id FOREIGN KEY (approver_id) REFERENCES app_user(id);
ALTER TABLE workflow_instance ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_workflow_instance_tenant ON workflow_instance USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE workflow_step ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_workflow_step_tenant ON workflow_step USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- 감사 트리거: audit_row()는 alm_audit_owner 소유이고 PUBLIC 실행 권한이 없다(0015·0016과 같은 방식)
SET LOCAL ROLE alm_audit_owner;
GRANT EXECUTE ON FUNCTION audit_row() TO SESSION_USER;
RESET ROLE;
CREATE TRIGGER tr_workflow_instance_audit AFTER INSERT OR UPDATE OR DELETE ON workflow_instance FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_workflow_step_audit AFTER INSERT OR UPDATE OR DELETE ON workflow_step FOR EACH ROW EXECUTE FUNCTION audit_row();
SET LOCAL ROLE alm_audit_owner;
REVOKE EXECUTE ON FUNCTION audit_row() FROM SESSION_USER;
RESET ROLE;
COMMIT;
