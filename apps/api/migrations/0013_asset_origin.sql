-- 0013 자산 취득 출처(2026-10-24, WBS 7.5·7.7). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   asset_origin: IF-AA-02 origins로 받은 PO(직접·AuC 정산)와 AuC 자산번호. 수신할 때마다 자산별 목록 전체를 교체
BEGIN;
-- 자산 취득 출처: SAP 자산의 취득 근거 PO와 AuC 정산 출처 (IF-AA-02 origins). 수신할 때마다 그 자산의 목록 전체를 교체
CREATE TABLE asset_origin (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  source_type varchar(6) NOT NULL,
  po_no varchar(10) NOT NULL DEFAULT '',
  po_item varchar(5) NOT NULL DEFAULT '',
  vendor_code varchar(10),
  vendor_name varchar(80),
  po_date date,
  auc_asset_no varchar(12) NOT NULL DEFAULT '',
  auc_sub_no varchar(4) NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (asset_id, source_type, po_no, po_item, auc_asset_no, auc_sub_no)
);
COMMENT ON COLUMN asset_origin.id IS '기본키';
COMMENT ON COLUMN asset_origin.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_origin.asset_id IS '자산';
COMMENT ON COLUMN asset_origin.source_type IS 'DIRECT 이 자산에 직접 걸린 PO / AUC AuC 정산으로 취득';
COMMENT ON COLUMN asset_origin.po_no IS 'EBELN. PO 없이 취득했으면 빈 값';
COMMENT ON COLUMN asset_origin.po_item IS 'EBELP';
COMMENT ON COLUMN asset_origin.vendor_code IS 'LIFNR';
COMMENT ON COLUMN asset_origin.vendor_name IS '공급업체명';
COMMENT ON COLUMN asset_origin.po_date IS 'PO 일자 BEDAT';
COMMENT ON COLUMN asset_origin.auc_asset_no IS 'AUC일 때 정산 원천 AuC 자산번호(ANLN1). AuC 자산은 ALM에 보내지 않고 번호만 둔다';
COMMENT ON COLUMN asset_origin.auc_sub_no IS 'AuC 보조번호(ANLN2)';
COMMENT ON COLUMN asset_origin.received_at IS '수신 일시';
COMMENT ON COLUMN asset_origin.created_at IS '생성 일시';
COMMENT ON COLUMN asset_origin.created_by IS '생성자';
COMMENT ON COLUMN asset_origin.updated_at IS '변경 일시';
COMMENT ON COLUMN asset_origin.updated_by IS '변경자';
COMMENT ON COLUMN asset_origin.version IS '낙관적 잠금';
COMMENT ON TABLE asset_origin IS '자산 취득 출처 — SAP 자산의 취득 근거 PO와 AuC 정산 출처 (IF-AA-02 origins). 수신할 때마다 그 자산의 목록 전체를 교체';
ALTER TABLE asset_origin ADD CONSTRAINT fk_asset_origin_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset_origin ADD CONSTRAINT fk_asset_origin_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE asset_origin ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_origin_tenant ON asset_origin USING (tenant_id = current_setting('app.tenant_id')::uuid);
SET LOCAL ROLE alm_audit_owner;
GRANT EXECUTE ON FUNCTION audit_row() TO SESSION_USER;
RESET ROLE;
CREATE TRIGGER tr_asset_origin_audit AFTER INSERT OR UPDATE OR DELETE ON asset_origin FOR EACH ROW EXECUTE FUNCTION audit_row();
SET LOCAL ROLE alm_audit_owner;
REVOKE EXECUTE ON FUNCTION audit_row() FROM SESSION_USER;
RESET ROLE;
COMMIT;
