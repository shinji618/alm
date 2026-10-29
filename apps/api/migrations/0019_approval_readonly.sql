-- 0019 approval 읽기 전용 보관(WBS 4.11 마감, 2026-10-29): 자산 요청 승인은 workflow_step이 맡는다(0018). 옛 approval 테이블은 이관 전 기록으로만 남긴다.
--   · 삭제하지 않는 이유: 감사 보호 장치(et_guard_audit_drop)가 감사 트리거(tr_approval_audit)를 가진 테이블의 삭제를 막는다.
--     옛 결정 이력의 원본(audit_log, 10년 보관)과 같은 근거라서 보호 장치를 풀지 않고 앱 계정의 쓰기 권한만 회수한다.
--   · 이관되지 않은 승인 행(0018 이후 옛 코드가 쓴 행)이 있으면 멈춘다. 그대로 두면 이력이 사라진다.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM approval a JOIN asset_request r ON r.id = a.asset_request_id
              WHERE r.status <> 'DRAFT' AND NOT EXISTS (SELECT 1 FROM workflow_step s WHERE s.id = a.id)) THEN
    RAISE EXCEPTION 'workflow_step으로 옮겨지지 않은 approval 행이 있어 읽기 전용으로 바꿀 수 없습니다(0018을 다시 확인하세요)';
  END IF;
END $$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON approval FROM alm_app;
COMMENT ON TABLE approval IS '승인 — 자산 요청·구매요청의 단계별 승인. 둘 중 하나만 채움. 4.11부터 자산 요청 승인은 workflow_step이 맡고 이 테이블은 이관 전 기록 보관용이다(읽기만. 감사 보호로 삭제하지 않음, 0019)';
COMMIT;
