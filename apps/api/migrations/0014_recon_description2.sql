-- 0014 대사 스냅샷 설명 2행(2026-10-25, WBS 7.8). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   위치·룸을 SAP 위치(STORT)가 아니라 자산 설명 2행(ANLA-TXA50)으로 보내기로 바꿨으므로(D-09) 대사도 그 값을 비교한다
BEGIN;
ALTER TABLE recon_snapshot ADD COLUMN description2 varchar(50);
COMMENT ON COLUMN recon_snapshot.description2 IS 'ANLA-TXA50 자산 설명 2행 = ALM 위치·룸(Location: 사이트 · Room: 룸, D-09 2026-10-25)';
COMMIT;
