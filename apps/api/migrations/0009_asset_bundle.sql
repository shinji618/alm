-- 0009 Bundle 자산(2026-10-19). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   asset.is_bundle: 구성품을 묶어 SAP에 1건으로 등록하는 자산
--   asset.parent_asset_id(기존 미사용 컬럼): 소속 Bundle. 구성품은 SAP에 보내지 않는다
BEGIN;
ALTER TABLE asset ADD COLUMN is_bundle boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN asset.is_bundle IS 'Bundle 자산. 구성품을 묶어 SAP에 1건으로 등록';
COMMENT ON COLUMN asset.parent_asset_id IS '소속 Bundle(구성품). 구성품은 SAP에 보내지 않음';
CREATE INDEX ix_asset_tenant_id_parent_asset_id ON asset (tenant_id, parent_asset_id);
COMMIT;
