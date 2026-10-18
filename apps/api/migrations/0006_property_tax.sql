-- 0006 재산세(사업용 동산, Business Personal Property) 신고·과거 기록(2026-10-17). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   관할(주·카운티)별 기준일·기한·평가율·세율·면제, 감가 계수표, 카테고리 → 내용연수 구분, 신고(회사 × 관할 × 연도)와 자산별 행
--   site.tax_jurisdiction_id: 사이트가 속한 재산세 관할
BEGIN;
CREATE TYPE tax_filing_status AS ENUM ('DRAFT', 'FILED', 'ASSESSED');  -- 재산세 신고 상태
CREATE TYPE tax_exemption_mode AS ENUM ('NONE', 'THRESHOLD', 'DEDUCT');  -- 재산세 면제 방식
ALTER TABLE site ADD COLUMN tax_jurisdiction_id uuid;
COMMENT ON COLUMN site.tax_jurisdiction_id IS '재산세 관할(카운티). 비면 재산세 신고에서 빠짐';
-- 재산세 관할: 사업용 동산 재산세(Business Personal Property) 신고 관할 = 주·카운티. 기준일·기한·평가율·세율·면제·감가표
CREATE TABLE tax_jurisdiction (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  state varchar(2) NOT NULL,
  county varchar(60) NOT NULL,
  name varchar(100) NOT NULL,
  taxable boolean NOT NULL DEFAULT true,
  form_code varchar(20),
  lien_month integer NOT NULL DEFAULT 1,
  lien_day integer NOT NULL DEFAULT 1,
  due_month integer,
  due_day integer,
  assessment_ratio numeric(7,4) NOT NULL DEFAULT 1,
  millage numeric(9,4) NOT NULL DEFAULT 0,
  exemption_mode tax_exemption_mode NOT NULL DEFAULT 'NONE',
  exemption_amount numeric(15,2) NOT NULL DEFAULT 0,
  factor_set varchar(20) NOT NULL,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, state, county)
);
COMMENT ON COLUMN tax_jurisdiction.id IS '기본키';
COMMENT ON COLUMN tax_jurisdiction.tenant_id IS '테넌트';
COMMENT ON COLUMN tax_jurisdiction.state IS '주 (예: GA)';
COMMENT ON COLUMN tax_jurisdiction.county IS '카운티(또는 감정 구역)';
COMMENT ON COLUMN tax_jurisdiction.name IS '표시 이름 (예: Fulton County Board of Assessors)';
COMMENT ON COLUMN tax_jurisdiction.taxable IS '사업용 동산 과세 여부(IL·NJ는 대부분 과세 안 함)';
COMMENT ON COLUMN tax_jurisdiction.form_code IS '신고서 양식 (예: PT-50P, ADV-40, 50-144, BOE-571-L)';
COMMENT ON COLUMN tax_jurisdiction.lien_month IS '기준일(평가일) 월';
COMMENT ON COLUMN tax_jurisdiction.lien_day IS '기준일 일';
COMMENT ON COLUMN tax_jurisdiction.due_month IS '신고 기한 월';
COMMENT ON COLUMN tax_jurisdiction.due_day IS '신고 기한 일';
COMMENT ON COLUMN tax_jurisdiction.assessment_ratio IS '평가율(공정가치 대비, GA 0.4·AL 0.2·TX·CA 1)';
COMMENT ON COLUMN tax_jurisdiction.millage IS '세율(평가액 $1,000당, 밀리지). $100당 세율은 ×10';
COMMENT ON COLUMN tax_jurisdiction.exemption_mode IS '면제 방식: THRESHOLD = 공정가치 합계가 금액 이하면 전액 면제, DEDUCT = 금액만큼 차감';
COMMENT ON COLUMN tax_jurisdiction.exemption_amount IS '면제 금액(공정가치 기준)';
COMMENT ON COLUMN tax_jurisdiction.factor_set IS '감가 계수표 (GA_DOR, AL_ADOR, CA_BOE581, GENERIC_SL)';
COMMENT ON COLUMN tax_jurisdiction.notes IS '메모(제출처 주소·온라인 신고 사이트 등)';
COMMENT ON COLUMN tax_jurisdiction.is_active IS '사용 여부';
COMMENT ON COLUMN tax_jurisdiction.created_at IS '생성 일시';
COMMENT ON COLUMN tax_jurisdiction.created_by IS '생성자';
COMMENT ON COLUMN tax_jurisdiction.updated_at IS '변경 일시';
COMMENT ON COLUMN tax_jurisdiction.updated_by IS '변경자';
COMMENT ON COLUMN tax_jurisdiction.version IS '낙관적 잠금';
COMMENT ON TABLE tax_jurisdiction IS '재산세 관할 — 사업용 동산 재산세(Business Personal Property) 신고 관할 = 주·카운티. 기준일·기한·평가율·세율·면제·감가표';

-- 재산세 감가 계수: 계수표 값: 기준일 연도 × 내용연수 구분 × 경과연수(기준일 연도 − 취득 연도) → 공정가치 = 원가 × 계수
CREATE TABLE tax_factor (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  factor_set varchar(20) NOT NULL,
  table_year integer NOT NULL,
  life_class varchar(10) NOT NULL,
  age integer NOT NULL,
  factor numeric(7,4) NOT NULL,
  source varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, factor_set, table_year, life_class, age)
);
COMMENT ON COLUMN tax_factor.id IS '기본키';
COMMENT ON COLUMN tax_factor.tenant_id IS '테넌트';
COMMENT ON COLUMN tax_factor.factor_set IS '계수표';
COMMENT ON COLUMN tax_factor.table_year IS '적용 기준일 연도';
COMMENT ON COLUMN tax_factor.life_class IS '내용연수 구분 (예: GA I~IV, AL 5·8·10, CA COMP·L10)';
COMMENT ON COLUMN tax_factor.age IS '경과연수. 표의 마지막 경과연수보다 오래되면 마지막 값(하한)';
COMMENT ON COLUMN tax_factor.factor IS '계수(0~1.5, CA는 원가지수 포함)';
COMMENT ON COLUMN tax_factor.source IS '출처(문서·URL)';
COMMENT ON COLUMN tax_factor.created_at IS '생성 일시';
COMMENT ON COLUMN tax_factor.created_by IS '생성자';
COMMENT ON COLUMN tax_factor.updated_at IS '변경 일시';
COMMENT ON COLUMN tax_factor.updated_by IS '변경자';
COMMENT ON COLUMN tax_factor.version IS '낙관적 잠금';
COMMENT ON TABLE tax_factor IS '재산세 감가 계수 — 계수표 값: 기준일 연도 × 내용연수 구분 × 경과연수(기준일 연도 − 취득 연도) → 공정가치 = 원가 × 계수';

-- 재산세 분류 매핑: 카테고리 → 계수표의 내용연수 구분. 없으면 카테고리 내용연수로 자동 구분
CREATE TABLE tax_class_map (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  factor_set varchar(20) NOT NULL,
  category_id uuid NOT NULL,
  life_class varchar(10) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (factor_set, category_id)
);
COMMENT ON COLUMN tax_class_map.id IS '기본키';
COMMENT ON COLUMN tax_class_map.tenant_id IS '테넌트';
COMMENT ON COLUMN tax_class_map.factor_set IS '계수표';
COMMENT ON COLUMN tax_class_map.category_id IS '카테고리';
COMMENT ON COLUMN tax_class_map.life_class IS '내용연수 구분';
COMMENT ON COLUMN tax_class_map.created_at IS '생성 일시';
COMMENT ON COLUMN tax_class_map.created_by IS '생성자';
COMMENT ON COLUMN tax_class_map.updated_at IS '변경 일시';
COMMENT ON COLUMN tax_class_map.updated_by IS '변경자';
COMMENT ON COLUMN tax_class_map.version IS '낙관적 잠금';
COMMENT ON TABLE tax_class_map IS '재산세 분류 매핑 — 카테고리 → 계수표의 내용연수 구분. 없으면 카테고리 내용연수로 자동 구분';

-- 재산세 신고: 회사 × 관할 × 기준일 연도 신고 1건. 신고(FILED) 뒤에는 고정(과거 기록)
CREATE TABLE tax_filing (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  jurisdiction_id uuid NOT NULL,
  tax_year integer NOT NULL,
  lien_date date NOT NULL,
  due_date date,
  status tax_filing_status NOT NULL DEFAULT 'DRAFT',
  asset_count integer NOT NULL DEFAULT 0,
  total_cost numeric(15,2) NOT NULL DEFAULT 0,
  total_market_value numeric(15,2) NOT NULL DEFAULT 0,
  exemption numeric(15,2) NOT NULL DEFAULT 0,
  assessed_value numeric(15,2) NOT NULL DEFAULT 0,
  estimated_tax numeric(15,2) NOT NULL DEFAULT 0,
  params jsonb NOT NULL,
  warnings jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid,
  filed_at date,
  filed_by uuid,
  filing_ref varchar(60),
  actual_assessed numeric(15,2),
  actual_tax numeric(15,2),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (company_id, jurisdiction_id, tax_year)
);
COMMENT ON COLUMN tax_filing.id IS '기본키';
COMMENT ON COLUMN tax_filing.tenant_id IS '테넌트';
COMMENT ON COLUMN tax_filing.company_id IS '회사코드';
COMMENT ON COLUMN tax_filing.jurisdiction_id IS '관할';
COMMENT ON COLUMN tax_filing.tax_year IS '기준일 연도';
COMMENT ON COLUMN tax_filing.lien_date IS '기준일';
COMMENT ON COLUMN tax_filing.due_date IS '신고 기한';
COMMENT ON COLUMN tax_filing.status IS '상태';
COMMENT ON COLUMN tax_filing.asset_count IS '대상 자산 수';
COMMENT ON COLUMN tax_filing.total_cost IS '원가 합계';
COMMENT ON COLUMN tax_filing.total_market_value IS '공정가치 합계(원가 × 계수)';
COMMENT ON COLUMN tax_filing.exemption IS '면제액';
COMMENT ON COLUMN tax_filing.assessed_value IS '평가액((공정가치 − 면제) × 평가율)';
COMMENT ON COLUMN tax_filing.estimated_tax IS '예상 세액(평가액 × 세율 ÷ 1,000)';
COMMENT ON COLUMN tax_filing.params IS '계산 당시 관할 설정·계수표 사본';
COMMENT ON COLUMN tax_filing.warnings IS '계산 경고(원가 없음, 위치 없음 등)';
COMMENT ON COLUMN tax_filing.generated_at IS '계산 일시';
COMMENT ON COLUMN tax_filing.generated_by IS '계산한 사용자';
COMMENT ON COLUMN tax_filing.filed_at IS '신고일';
COMMENT ON COLUMN tax_filing.filed_by IS '신고 처리자';
COMMENT ON COLUMN tax_filing.filing_ref IS '접수 번호·확인 번호';
COMMENT ON COLUMN tax_filing.actual_assessed IS '고지 평가액';
COMMENT ON COLUMN tax_filing.actual_tax IS '고지 세액';
COMMENT ON COLUMN tax_filing.notes IS '메모';
COMMENT ON COLUMN tax_filing.created_at IS '생성 일시';
COMMENT ON COLUMN tax_filing.created_by IS '생성자';
COMMENT ON COLUMN tax_filing.updated_at IS '변경 일시';
COMMENT ON COLUMN tax_filing.updated_by IS '변경자';
COMMENT ON COLUMN tax_filing.version IS '낙관적 잠금';
COMMENT ON TABLE tax_filing IS '재산세 신고 — 회사 × 관할 × 기준일 연도 신고 1건. 신고(FILED) 뒤에는 고정(과거 기록)';
CREATE INDEX ix_tax_filing_tenant_id_tax_year ON tax_filing (tenant_id, tax_year);

-- 재산세 신고 자산: 신고 1건의 자산별 행(계산 당시 사본). change: NEW 신규 · CARRIED 계속 · DISPOSED 전년 대비 처분
CREATE TABLE tax_filing_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  filing_id uuid NOT NULL,
  asset_id uuid,
  asset_tag varchar(25) NOT NULL,
  description varchar(50) NOT NULL,
  category_name varchar(60),
  life_class varchar(10),
  acquisition_date date,
  acquisition_year integer,
  original_cost numeric(15,2),
  cost_source varchar(10),
  age integer,
  factor numeric(7,4),
  market_value numeric(15,2),
  site_code varchar(10),
  room_code varchar(10),
  change varchar(10) NOT NULL,
  disposal_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN tax_filing_line.id IS '기본키';
COMMENT ON COLUMN tax_filing_line.tenant_id IS '테넌트';
COMMENT ON COLUMN tax_filing_line.filing_id IS '신고';
COMMENT ON COLUMN tax_filing_line.asset_id IS '자산';
COMMENT ON COLUMN tax_filing_line.asset_tag IS '자산태그';
COMMENT ON COLUMN tax_filing_line.description IS '자산명';
COMMENT ON COLUMN tax_filing_line.category_name IS '카테고리';
COMMENT ON COLUMN tax_filing_line.life_class IS '내용연수 구분';
COMMENT ON COLUMN tax_filing_line.acquisition_date IS '취득일';
COMMENT ON COLUMN tax_filing_line.acquisition_year IS '취득 연도';
COMMENT ON COLUMN tax_filing_line.original_cost IS '원가(SAP 취득가, 없으면 ALM 구매가). 비면 원가 모름';
COMMENT ON COLUMN tax_filing_line.cost_source IS 'SAP / ALM';
COMMENT ON COLUMN tax_filing_line.age IS '경과연수';
COMMENT ON COLUMN tax_filing_line.factor IS '계수';
COMMENT ON COLUMN tax_filing_line.market_value IS '공정가치';
COMMENT ON COLUMN tax_filing_line.site_code IS '사이트';
COMMENT ON COLUMN tax_filing_line.room_code IS '룸';
COMMENT ON COLUMN tax_filing_line.change IS 'NEW / CARRIED / DISPOSED';
COMMENT ON COLUMN tax_filing_line.disposal_date IS '처분일(DISPOSED)';
COMMENT ON COLUMN tax_filing_line.created_at IS '생성 일시';
COMMENT ON COLUMN tax_filing_line.created_by IS '생성자';
COMMENT ON COLUMN tax_filing_line.updated_at IS '변경 일시';
COMMENT ON COLUMN tax_filing_line.updated_by IS '변경자';
COMMENT ON COLUMN tax_filing_line.version IS '낙관적 잠금';
COMMENT ON TABLE tax_filing_line IS '재산세 신고 자산 — 신고 1건의 자산별 행(계산 당시 사본). change: NEW 신규 · CARRIED 계속 · DISPOSED 전년 대비 처분';
CREATE INDEX ix_tax_filing_line_filing_id ON tax_filing_line (filing_id);

ALTER TABLE site ADD CONSTRAINT fk_site_tax_jurisdiction_id FOREIGN KEY (tax_jurisdiction_id) REFERENCES tax_jurisdiction(id);
ALTER TABLE tax_jurisdiction ADD CONSTRAINT fk_tax_jurisdiction_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE tax_factor ADD CONSTRAINT fk_tax_factor_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE tax_class_map ADD CONSTRAINT fk_tax_class_map_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE tax_class_map ADD CONSTRAINT fk_tax_class_map_category_id FOREIGN KEY (category_id) REFERENCES category(id);
ALTER TABLE tax_filing ADD CONSTRAINT fk_tax_filing_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE tax_filing ADD CONSTRAINT fk_tax_filing_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE tax_filing ADD CONSTRAINT fk_tax_filing_jurisdiction_id FOREIGN KEY (jurisdiction_id) REFERENCES tax_jurisdiction(id);
ALTER TABLE tax_filing ADD CONSTRAINT fk_tax_filing_generated_by FOREIGN KEY (generated_by) REFERENCES app_user(id);
ALTER TABLE tax_filing ADD CONSTRAINT fk_tax_filing_filed_by FOREIGN KEY (filed_by) REFERENCES app_user(id);
ALTER TABLE tax_filing_line ADD CONSTRAINT fk_tax_filing_line_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE tax_filing_line ADD CONSTRAINT fk_tax_filing_line_filing_id FOREIGN KEY (filing_id) REFERENCES tax_filing(id);
ALTER TABLE tax_filing_line ADD CONSTRAINT fk_tax_filing_line_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE tax_jurisdiction ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tax_jurisdiction_tenant ON tax_jurisdiction USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE tax_factor ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tax_factor_tenant ON tax_factor USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE tax_class_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tax_class_map_tenant ON tax_class_map USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE tax_filing ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tax_filing_tenant ON tax_filing USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE tax_filing_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tax_filing_line_tenant ON tax_filing_line USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE TRIGGER tr_tax_jurisdiction_audit AFTER INSERT OR UPDATE OR DELETE ON tax_jurisdiction FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_tax_factor_audit AFTER INSERT OR UPDATE OR DELETE ON tax_factor FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_tax_class_map_audit AFTER INSERT OR UPDATE OR DELETE ON tax_class_map FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_tax_filing_audit AFTER INSERT OR UPDATE OR DELETE ON tax_filing FOR EACH ROW EXECUTE FUNCTION audit_row();
COMMIT;
