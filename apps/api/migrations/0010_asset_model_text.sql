-- 0010 자산 모델 직접 입력(2026-10-19). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   모델은 선택 항목. 모델 마스터에 있으면 model_id, 없으면 입력한 글자를 model_text에 둔다
BEGIN;
ALTER TABLE asset ADD COLUMN model_text varchar(100);
COMMENT ON COLUMN asset.model_text IS '모델(직접 입력). 모델 마스터에 없을 때';
COMMIT;
