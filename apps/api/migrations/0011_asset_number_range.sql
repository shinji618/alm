-- 0011 자산태그 번호 범위(2026-10-19). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   asset_number_range: 태그 앞 2자리(Prefix)·번호 구간·다음 번호. category.number_range_id로 카테고리에 지정(비면 상위 → 기본 범위)
--   기본 범위(AT)는 처음 채번·조회할 때 앱이 만든다(기존 AT-번호 다음부터)
BEGIN;
ALTER TABLE category ADD COLUMN number_range_id uuid;
COMMENT ON COLUMN category.number_range_id IS '자산태그 번호 범위. 비면 상위 카테고리 → 기본 범위';
-- 자산태그 번호 범위: 자산태그 앞 2자리(Prefix)와 번호 구간. 카테고리에 지정해 자동 채번. 태그 = PREFIX-nnnnnn
CREATE TABLE asset_number_range (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  prefix varchar(2) NOT NULL,
  name varchar(60) NOT NULL,
  from_no integer NOT NULL DEFAULT 1,
  to_no integer NOT NULL DEFAULT 999999,
  next_no integer NOT NULL DEFAULT 1,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, prefix)
);
COMMENT ON COLUMN asset_number_range.id IS '기본키';
COMMENT ON COLUMN asset_number_range.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_number_range.prefix IS '태그 앞 2자리(영문 대문자·숫자)';
COMMENT ON COLUMN asset_number_range.name IS '이름';
COMMENT ON COLUMN asset_number_range.from_no IS '시작 번호(1~999999)';
COMMENT ON COLUMN asset_number_range.to_no IS '끝 번호(1~999999)';
COMMENT ON COLUMN asset_number_range.next_no IS '다음 번호. 이미 쓰인 번호는 채번 때 건너뜀';
COMMENT ON COLUMN asset_number_range.is_default IS '기본 범위(카테고리·상위에 지정이 없을 때). 테넌트에 하나';
COMMENT ON COLUMN asset_number_range.is_active IS '사용 여부. 끄면 이 범위로 채번하지 않음';
COMMENT ON COLUMN asset_number_range.created_at IS '생성 일시';
COMMENT ON COLUMN asset_number_range.created_by IS '생성자';
COMMENT ON COLUMN asset_number_range.updated_at IS '변경 일시';
COMMENT ON COLUMN asset_number_range.updated_by IS '변경자';
COMMENT ON COLUMN asset_number_range.version IS '낙관적 잠금';
COMMENT ON TABLE asset_number_range IS '자산태그 번호 범위 — 자산태그 앞 2자리(Prefix)와 번호 구간. 카테고리에 지정해 자동 채번. 태그 = PREFIX-nnnnnn';
ALTER TABLE category ADD CONSTRAINT fk_category_number_range_id FOREIGN KEY (number_range_id) REFERENCES asset_number_range(id);
ALTER TABLE asset_number_range ADD CONSTRAINT fk_asset_number_range_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset_number_range ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_number_range_tenant ON asset_number_range USING (tenant_id = current_setting('app.tenant_id')::uuid);
SET LOCAL ROLE alm_audit_owner;
GRANT EXECUTE ON FUNCTION audit_row() TO SESSION_USER;
RESET ROLE;
CREATE TRIGGER tr_asset_number_range_audit AFTER INSERT OR UPDATE OR DELETE ON asset_number_range FOR EACH ROW EXECUTE FUNCTION audit_row();
SET LOCAL ROLE alm_audit_owner;
REVOKE EXECUTE ON FUNCTION audit_row() FROM SESSION_USER;
RESET ROLE;
COMMIT;
