-- 0020 시스템이 만드는 카테고리 'SAP 미분류'의 이름을 영문 'SAP Unclassified'로(2026-10-29): 화면을 영어로 보면 한글이 섞여 보여서.
--   카테고리 이름은 DB에 저장된 값이라 번역 파일로 바꿀 수 없다. 코드(SAP-UNCLASSIFIED)는 그대로이고, 이름이 아직 기본값 그대로인 행만 바꾼다(관리자가 직접 고친 이름은 건드리지 않는다).
BEGIN;
UPDATE category SET name = 'SAP Unclassified' WHERE category_code = 'SAP-UNCLASSIFIED' AND name = 'SAP 미분류';
COMMIT;
