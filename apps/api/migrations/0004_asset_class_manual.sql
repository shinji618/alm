-- 0004 ALM에서 직접 등록하는 자산클래스(SAP 연계를 쓰지 않는 회사용, 2026-10-13). db/ddl.sql(새 DB)과 결과가 같아야 한다.
-- 코스트센터는 회사코드에 딸려 있어(SAP 회사만 IF-MD-01이 관리) 표시가 필요 없다.
BEGIN;
ALTER TABLE asset_class ADD COLUMN is_manual boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN asset_class.is_manual IS 'ALM에서 직접 등록(SAP 연계를 쓰지 않는 회사용). SAP 수신이 비활성화하지 않고, SAP 신규 등록 요청에 쓸 수 없다. 같은 코드가 SAP에서 오면 SAP 것으로 바뀜';
COMMIT;
