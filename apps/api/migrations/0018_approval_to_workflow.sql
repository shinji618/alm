-- 0018 ALM 승인 이관(WBS 4.11, 2026-10-29): approval(자산 요청 승인) 행을 workflow_instance·workflow_step으로 옮긴다.
--   구조 변경은 없다(0017이 만든 테이블에 데이터만). approval 테이블은 되돌릴 수 있도록 그대로 두고, DEV 확인 뒤 별도 마이그레이션에서 지운다.
--   · 인스턴스 1개 = 요청 1건(DRAFT 제외). 상태: SUBMITTED·MGR_APPROVED → IN_PROGRESS, REJECTED, CANCELLED, 그 밖(ACCT_APPROVED·POSTED·POST_ERROR) → APPROVED
--   · 단계 id는 approval.id를 그대로 쓴다(승인함·화면이 쥔 approvalId가 이어진다). 키: 부서 관리자 dept<단계>, 자산회계 acct, 그 밖 <역할>_<단계>
--   · 단계의 코스트센터 → params.ccId, 생성자(보정자 판단용)·결정 값·의견·일시는 그대로. 부서 관리자 단계는 병합 대상(merge_same)
--   · 감사 트리거는 켠 채로 넣는다(행위자 없는 이관 기록이 남는다. 옛 결정 이력은 approval의 감사 로그에 그대로 있다)
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM approval WHERE asset_request_id IS NULL) THEN
    RAISE EXCEPTION '구매요청 승인 행(purchase_request_id)이 있어 이관할 수 없습니다(4.11은 자산 요청 승인만 옮김)';
  END IF;
END $$;
INSERT INTO workflow_instance (id, tenant_id, subject_type, subject_id, requester_id, status, current_step, rules, submitted_at, completed_at,
                               created_at, created_by, updated_at, updated_by)
SELECT gen_random_uuid(), r.tenant_id, 'ASSET_REQUEST', r.id, r.requester_id,
       (CASE WHEN r.status IN ('SUBMITTED', 'MGR_APPROVED') THEN 'IN_PROGRESS' WHEN r.status = 'REJECTED' THEN 'REJECTED'
             WHEN r.status = 'CANCELLED' THEN 'CANCELLED' ELSE 'APPROVED' END)::workflow_instance_status,
       coalesce(r.current_step, 1), '{"fixerCannotReapprove": true}'::jsonb,
       coalesce(r.submitted_at, (SELECT min(a.created_at) FROM approval a WHERE a.asset_request_id = r.id)),
       CASE WHEN r.status IN ('SUBMITTED', 'MGR_APPROVED') THEN NULL
            ELSE coalesce(r.completed_at, (SELECT max(a.decided_at) FROM approval a WHERE a.asset_request_id = r.id), r.updated_at) END,
       coalesce(r.submitted_at, r.created_at), r.requester_id, r.updated_at, r.updated_by
FROM asset_request r
WHERE r.status <> 'DRAFT' AND EXISTS (SELECT 1 FROM approval a WHERE a.asset_request_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM workflow_instance wi WHERE wi.subject_type = 'ASSET_REQUEST' AND wi.subject_id = r.id);
INSERT INTO workflow_step (id, tenant_id, instance_id, step_no, step_key, label, resolver, params, proxy, merge_same, min_approvals,
                           status, approver_id, comment, decided_at, created_at, created_by, updated_at, updated_by)
SELECT a.id, a.tenant_id, wi.id, a.step_no,
       CASE a.approver_role WHEN 'DEPT_MANAGER' THEN 'dept' || a.step_no WHEN 'ASSET_ACCOUNTANT' THEN 'acct' ELSE lower(a.approver_role) || '_' || a.step_no END,
       CASE a.approver_role WHEN 'DEPT_MANAGER' THEN '부서 관리자 승인' WHEN 'ASSET_ACCOUNTANT' THEN '자산회계 승인' ELSE a.approver_role END,
       a.approver_role, CASE WHEN a.cost_center_id IS NULL THEN NULL ELSE jsonb_build_object('ccId', a.cost_center_id) END,
       false, a.approver_role = 'DEPT_MANAGER', 1,
       a.decision, a.approver_id, a.comment, a.decided_at, a.created_at, a.created_by, a.updated_at, a.updated_by
FROM approval a
JOIN workflow_instance wi ON wi.subject_type = 'ASSET_REQUEST' AND wi.subject_id = a.asset_request_id
WHERE NOT EXISTS (SELECT 1 FROM workflow_step s WHERE s.id = a.id);
-- 설명 갱신(db/spec/spec.py와 같게)
COMMENT ON TABLE workflow_instance IS '워크플로 인스턴스 — 승인 엔진(4.10)이 실행하는 승인 1건. 대상(subject_type, subject_id)은 제품이 정한다. 진행 중 인스턴스는 대상당 1건(저장소가 잠금으로 보장). ALM 자산 요청 승인은 4.11부터 이 테이블을 쓴다(approval에서 이관, 0018)';
COMMENT ON TABLE approval IS '승인 — 자산 요청·구매요청의 단계별 승인. 둘 중 하나만 채움. 4.11부터 자산 요청 승인은 workflow_step이 맡고 이 테이블은 이관 전 기록 보관용이다(읽기만, 삭제 예정)';
COMMIT;
