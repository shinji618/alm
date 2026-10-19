-- 0008 라벨 출력(ALM-250, 2026-10-19). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   label_print_job.render_id: ZPL 발급(:render) 묶음 id. 결과 회신(:report)은 이 id의 작업만 받는다
BEGIN;
ALTER TABLE label_print_job ADD COLUMN render_id uuid;
COMMENT ON COLUMN label_print_job.render_id IS '마지막 ZPL 발급 묶음 id(결과 회신 :report는 이 id의 작업만 받음)';
COMMIT;
