-- 0007 재산세 자산 구분(ALM-260, 2026-10-18): 가구·기계·차량·건물 등 전 자산 대상화
--   asset_class·category.tax_property_type(카테고리 우선, 비면 클래스, 둘 다 비면 클래스 이름으로 추정)
--   tax_jurisdiction.include_vehicles(TX)·include_cip·include_leasehold, tax_filing_line.property_type
BEGIN;

CREATE TYPE tax_property_type AS ENUM ('EQUIPMENT', 'LEASEHOLD', 'VEHICLE', 'CIP', 'LEASED_IN', 'REAL_PROPERTY', 'INTANGIBLE', 'EXCLUDED');  -- 재산세 자산 구분

ALTER TABLE asset_class ADD COLUMN tax_property_type tax_property_type;
COMMENT ON COLUMN asset_class.tax_property_type IS '재산세 구분(장비·임차개량·차량·건설중·임차자산·부동산·무형·제외). 비면 클래스 이름으로 추정';

ALTER TABLE category ADD COLUMN tax_property_type tax_property_type;
COMMENT ON COLUMN category.tax_property_type IS '재산세 구분(자산클래스보다 우선). 비면 자산클래스 구분';

ALTER TABLE tax_jurisdiction ADD COLUMN include_vehicles boolean NOT NULL DEFAULT false;
ALTER TABLE tax_jurisdiction ADD COLUMN include_cip boolean NOT NULL DEFAULT true;
ALTER TABLE tax_jurisdiction ADD COLUMN include_leasehold boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN tax_jurisdiction.include_vehicles IS '차량(VEHICLE)을 신고에 포함(TX). GA·AL·CA는 차량 등록 때 따로 과세';
COMMENT ON COLUMN tax_jurisdiction.include_cip IS '건설중자산(CIP)을 원가 그대로 포함';
COMMENT ON COLUMN tax_jurisdiction.include_leasehold IS '임차개량(LEASEHOLD)을 포함. GA는 건물 일부가 되는 개량을 동산으로 신고하지 않음';

ALTER TABLE tax_filing_line ADD COLUMN property_type tax_property_type NOT NULL DEFAULT 'EQUIPMENT';
COMMENT ON COLUMN tax_filing_line.property_type IS '재산세 구분';

COMMIT;
