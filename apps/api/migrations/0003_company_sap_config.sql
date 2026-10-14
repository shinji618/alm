-- 0003 회사별 SAP 연계 사용·자산 요청 승인 단계(WBS 4.3, 2026-10-13 결정). db/ddl.sql(새 DB)과 결과가 같아야 한다.
-- SAP 연계를 끈 회사: SAP 필드·기능을 숨기고 자산 요청은 승인 후 ALM에만 반영. 승인 단계 1·0은 그런 회사만 쓸 수 있다.
BEGIN;
ALTER TABLE company ADD COLUMN sap_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE company ADD COLUMN approval_steps integer NOT NULL DEFAULT 2;
ALTER TABLE company ADD CONSTRAINT company_check CHECK (approval_steps BETWEEN 0 AND 2 AND (sap_enabled = false OR approval_steps = 2));
COMMENT ON COLUMN company.sap_enabled IS 'SAP 연계 사용. 끄면 SAP 필드·기능을 숨기고 자산 요청은 승인 후 ALM에만 반영';
COMMENT ON COLUMN company.approval_steps IS '자산 요청 승인 단계 2 부서 관리자→자산회계, 1 부서 관리자, 0 없음(SAP 연계를 끈 회사만)';
COMMENT ON TABLE company IS '회사코드 — SAP 회사코드 (IF-MD-01 COMPANY). SAP 연계를 쓰지 않는 회사는 관리 화면에서 등록';
COMMIT;
