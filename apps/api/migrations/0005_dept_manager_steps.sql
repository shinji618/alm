-- 0005 부서 관리자 관리(2026-10-15). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   app_user.phone: 부서 관리자 연락처(관리 > 부서 관리자 화면에서 입력)
--   approval.cost_center_id: 부서 관리자 단계마다 승인할 코스트센터. 이관은 보내는 부서 → 받는 부서 → 자산회계
BEGIN;
ALTER TABLE app_user ADD COLUMN phone varchar(30);
COMMENT ON COLUMN app_user.phone IS '전화번호(부서 관리자 연락처 등, 관리 화면에서 입력)';
ALTER TABLE approval ADD COLUMN cost_center_id uuid;
ALTER TABLE approval ADD CONSTRAINT fk_approval_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
COMMENT ON COLUMN approval.step_no IS '단계(1부터). 부서 관리자 단계(이관은 보내는·받는 부서) 다음 자산회계(최종)';
COMMENT ON COLUMN approval.cost_center_id IS '부서 관리자 단계의 코스트센터(이 코스트센터의 부서 관리자가 승인). 비면 요청의 책임 코스트센터';
COMMIT;
