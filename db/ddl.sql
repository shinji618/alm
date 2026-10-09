-- ALM data model DDL (PostgreSQL 16). Generated from db spec (WBS 2.5).
-- Prisma migrations are the deploy path; this file is the reviewed reference.

BEGIN;

CREATE TYPE role_code AS ENUM ('SYS_ADMIN', 'ASSET_MANAGER', 'DEPT_MANAGER', 'ASSET_ACCOUNTANT', 'COUNTER', 'EMPLOYEE', 'AUDITOR');  -- 사용자 역할
CREATE TYPE asset_status AS ENUM ('ON_ORDER', 'IN_STOCK', 'IN_USE', 'IN_REPAIR', 'MISSING', 'RETIRED', 'DISPOSED');  -- 자산 상태
CREATE TYPE asset_source AS ENUM ('MANUAL', 'DISCOVERY', 'GOODS_RECEIPT', 'SAP', 'PDA_COUNT', 'IMPORT');  -- 자산 생성 출처
CREATE TYPE asset_event_type AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ASSIGNED', 'RETURNED', 'TRANSFERRED', 'REPAIR_IN', 'REPAIR_OUT', 'COUNTED', 'LABEL_PRINTED', 'SAP_POSTED', 'SAP_SYNCED', 'RETIRED', 'DISPOSED');  -- 자산 이력 유형
CREATE TYPE ci_type AS ENUM ('BUSINESS_SERVICE', 'APPLICATION', 'DATABASE', 'SERVER', 'VIRTUAL_MACHINE', 'NETWORK', 'OT_DEVICE', 'OTHER');  -- CI 유형
CREATE TYPE ci_relation_type AS ENUM ('DEPENDS_ON', 'RUNS_ON', 'CONNECTED_TO', 'INSTALLED_ON');  -- CI 관계 유형
CREATE TYPE discovery_method AS ENUM ('AGENT', 'NETWORK_SCAN', 'VCENTER');  -- 수집 방식
CREATE TYPE run_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');  -- 작업 실행 상태
CREATE TYPE discovery_match AS ENUM ('NEW', 'CONFLICT', 'UNMANAGED', 'MATCHED', 'IGNORED');  -- 수집 결과 분류
CREATE TYPE discovery_resolution AS ENUM ('REGISTERED', 'UPDATED', 'QUARANTINED', 'IGNORED');  -- 수집 결과 처리
CREATE TYPE license_model AS ENUM ('PER_USER', 'PER_DEVICE', 'PER_CORE', 'NETWORK');  -- 라이선스 모델
CREATE TYPE contract_type AS ENUM ('MAINTENANCE', 'LEASE', 'SERVICE', 'SUBSCRIPTION');  -- 계약 유형
CREATE TYPE purchase_request_status AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PO_REQUESTED', 'PO_CREATED', 'PO_ERROR', 'CANCELLED');  -- 구매요청 상태
CREATE TYPE request_type AS ENUM ('NEW_ASSET', 'CHANGE', 'TRANSFER', 'RETIRE', 'SALE');  -- 자산 요청 유형
CREATE TYPE request_status AS ENUM ('DRAFT', 'SUBMITTED', 'MGR_APPROVED', 'ACCT_APPROVED', 'POSTED', 'POST_ERROR', 'REJECTED', 'CANCELLED');  -- 자산 요청 상태
CREATE TYPE request_source AS ENUM ('USER', 'ASSIGNMENT', 'COUNT_VARIANCE', 'RECONCILIATION', 'GOODS_RECEIPT');  -- 요청 발생 출처
CREATE TYPE retire_type AS ENUM ('SCRAP', 'SALE', 'LOSS');  -- 폐기 유형
CREATE TYPE approval_decision AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');  -- 승인 결정
CREATE TYPE campaign_status AS ENUM ('SCOPING', 'COUNTING', 'REVIEW', 'POSTING', 'CLOSED', 'CANCELLED');  -- 실사 캠페인 단계
CREATE TYPE count_task_status AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');  -- 룸 실사 작업 상태
CREATE TYPE count_result AS ENUM ('PENDING', 'FOUND', 'MISPLACED', 'NOT_FOUND');  -- 실사 대상 판정
CREATE TYPE scan_result AS ENUM ('FOUND', 'MISPLACED', 'OUT_OF_SCOPE', 'UNREGISTERED', 'DUPLICATE', 'RETIRED_ASSET');  -- 스캔 판정
CREATE TYPE asset_condition AS ENUM ('GOOD', 'DAMAGED', 'UNUSED');  -- 자산 상태(실사)
CREATE TYPE variance_action AS ENUM ('NONE', 'MASTER_CHANGE', 'RECOUNT', 'RETIRE_REQUEST', 'MARK_MISSING', 'REPAIR', 'ACCEPT', 'REGISTER', 'NON_ASSET');  -- 차이 처리
CREATE TYPE label_layout AS ENUM ('QR_CODE128', 'QR_ONLY', 'CODE128_ONLY');  -- 라벨 레이아웃
CREATE TYPE print_source AS ENUM ('ASSET_DETAIL', 'GOODS_RECEIPT', 'PDA_REQUEST', 'BULK');  -- 출력 요청 출처
CREATE TYPE print_status AS ENUM ('QUEUED', 'RENDERED', 'PRINTED', 'FAILED', 'CANCELLED');  -- 출력 상태
CREATE TYPE printer_connection AS ENUM ('USB', 'NETWORK');  -- 프린터 연결
CREATE TYPE posting_type AS ENUM ('ASSET_CREATE', 'ASSET_CHANGE', 'ASSET_TRANSFER', 'ASSET_RETIRE', 'COUNT_RESULT', 'PO_CREATE');  -- SAP 전기 유형
CREATE TYPE posting_status AS ENUM ('READY', 'CLAIMED', 'POSTED', 'FAILED', 'CANCELLED');  -- SAP 전기 상태
CREATE TYPE if_direction AS ENUM ('SAP_TO_ALM', 'ALM_TO_SAP');  -- 데이터 방향
CREATE TYPE if_status AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');  -- IF 실행 결과
CREATE TYPE recon_diff_type AS ENUM ('SAP_ONLY', 'ALM_ONLY', 'COST_CENTER', 'LOCATION', 'SERIAL', 'TAG', 'RETIRED');  -- 대사 차이 유형
CREATE TYPE recon_action AS ENUM ('SAP_TO_ALM', 'ALM_TO_SAP', 'REVIEW', 'IGNORE');  -- 대사 조치
CREATE TYPE recon_status AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');  -- 대사 처리 상태
CREATE TYPE master_system AS ENUM ('SAP', 'ALM');  -- 기준 시스템
CREATE TYPE notification_channel AS ENUM ('EMAIL', 'IN_APP');  -- 알림 채널
CREATE TYPE notification_status AS ENUM ('QUEUED', 'SENT', 'FAILED');  -- 알림 상태
CREATE TYPE audit_action AS ENUM ('INSERT', 'UPDATE', 'DELETE');  -- 감사 동작
CREATE TYPE security_event_type AS ENUM ('LOGIN', 'LOGIN_DENIED', 'LOGOUT', 'ACCESS_DENIED', 'EXPORT', 'SECRET_ROTATED', 'SAP_AUTH_FAILED', 'DEVICE_BLOCKED', 'SUPPORT_ACCESS');  -- 보안 이벤트
CREATE TYPE idp_type AS ENUM ('SAML', 'OIDC');  -- IdP 연동 방식

-- 테넌트: 서비스 고객사. 단일 고객이면 1행
CREATE TABLE tenant (
  id uuid PRIMARY KEY,
  code varchar(20) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  sap_system_id varchar(10),
  idp_type idp_type NOT NULL DEFAULT 'SAML',
  idp_provider_name varchar(32) NOT NULL UNIQUE,
  jit_provision boolean NOT NULL DEFAULT false,
  time_zone varchar(40) NOT NULL DEFAULT 'America/New_York',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  CHECK (idp_provider_name ~ '^T-[A-Z0-9-]+$')
);
COMMENT ON COLUMN tenant.id IS '기본키';
COMMENT ON COLUMN tenant.code IS '테넌트 코드';
COMMENT ON COLUMN tenant.name IS '고객사 이름';
COMMENT ON COLUMN tenant.sap_system_id IS 'SAP 시스템 ID-클라이언트 (예: PRD-100)';
COMMENT ON COLUMN tenant.idp_type IS '고객사 SSO 방식';
COMMENT ON COLUMN tenant.idp_provider_name IS 'Cognito IdP 이름 (예: T-ACME, 밑줄 금지). 토큰 username이 `<이 값>_`으로 시작하면 이 테넌트';
COMMENT ON COLUMN tenant.jit_provision IS '첫 로그인 때 사용자 자동 생성(역할 EMPLOYEE만)';
COMMENT ON COLUMN tenant.time_zone IS '화면 표시 시간대';
COMMENT ON COLUMN tenant.is_active IS '사용 여부';
COMMENT ON COLUMN tenant.created_at IS '생성 일시';
COMMENT ON COLUMN tenant.created_by IS '생성자';
COMMENT ON COLUMN tenant.updated_at IS '변경 일시';
COMMENT ON COLUMN tenant.updated_by IS '변경자';
COMMENT ON COLUMN tenant.version IS '낙관적 잠금';
COMMENT ON TABLE tenant IS '테넌트 — 서비스 고객사. 단일 고객이면 1행';

-- 테넌트 이메일 도메인: 로그인 화면에서 이메일 도메인으로 테넌트 IdP를 고름(홈 렐름 판별). 도메인은 전체 테넌트에서 유일
CREATE TABLE tenant_domain (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  domain varchar(253) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN tenant_domain.id IS '기본키';
COMMENT ON COLUMN tenant_domain.tenant_id IS '테넌트';
COMMENT ON COLUMN tenant_domain.domain IS '이메일 도메인(소문자, 예: acme.com)';
COMMENT ON COLUMN tenant_domain.is_active IS '사용 여부';
COMMENT ON COLUMN tenant_domain.created_at IS '생성 일시';
COMMENT ON COLUMN tenant_domain.created_by IS '생성자';
COMMENT ON COLUMN tenant_domain.updated_at IS '변경 일시';
COMMENT ON COLUMN tenant_domain.updated_by IS '변경자';
COMMENT ON COLUMN tenant_domain.version IS '낙관적 잠금';
COMMENT ON TABLE tenant_domain IS '테넌트 이메일 도메인 — 로그인 화면에서 이메일 도메인으로 테넌트 IdP를 고름(홈 렐름 판별). 도메인은 전체 테넌트에서 유일';

-- 사용자: SSO 로그인 사용자
CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  email varchar(254) NOT NULL,
  display_name varchar(100) NOT NULL,
  idp_subject varchar(200),
  employee_no varchar(20),
  department varchar(100),
  cost_center_id uuid,
  locale varchar(5) NOT NULL DEFAULT 'en',
  last_login_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, idp_subject)
);
COMMENT ON COLUMN app_user.id IS '기본키';
COMMENT ON COLUMN app_user.tenant_id IS '테넌트';
COMMENT ON COLUMN app_user.email IS '이메일(로그인 ID)';
COMMENT ON COLUMN app_user.display_name IS '이름';
COMMENT ON COLUMN app_user.idp_subject IS 'IdP 사용자 식별자. Cognito username의 `<IdP>_` 뒤 값(SAML NameID = Entra oid, OIDC sub)';
COMMENT ON COLUMN app_user.employee_no IS '사번';
COMMENT ON COLUMN app_user.department IS '부서명';
COMMENT ON COLUMN app_user.cost_center_id IS '소속 코스트센터';
COMMENT ON COLUMN app_user.locale IS '화면 언어 en/ko';
COMMENT ON COLUMN app_user.last_login_at IS '마지막 로그인';
COMMENT ON COLUMN app_user.is_active IS '사용 여부';
COMMENT ON COLUMN app_user.created_at IS '생성 일시';
COMMENT ON COLUMN app_user.created_by IS '생성자';
COMMENT ON COLUMN app_user.updated_at IS '변경 일시';
COMMENT ON COLUMN app_user.updated_by IS '변경자';
COMMENT ON COLUMN app_user.version IS '낙관적 잠금';
COMMENT ON TABLE app_user IS '사용자 — SSO 로그인 사용자';

-- 사용자 역할: 역할 부여와 범위(회사코드·사이트). 범위가 비면 전체
CREATE TABLE user_role (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role role_code NOT NULL,
  company_id uuid,
  site_id uuid,
  cost_center_id uuid,
  valid_from date,
  valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (user_id, role, company_id, site_id, cost_center_id)
);
COMMENT ON COLUMN user_role.id IS '기본키';
COMMENT ON COLUMN user_role.tenant_id IS '테넌트';
COMMENT ON COLUMN user_role.user_id IS '사용자';
COMMENT ON COLUMN user_role.role IS '역할';
COMMENT ON COLUMN user_role.company_id IS '회사코드 범위';
COMMENT ON COLUMN user_role.site_id IS '사이트 범위';
COMMENT ON COLUMN user_role.cost_center_id IS '코스트센터 범위(DEPT_MANAGER)';
COMMENT ON COLUMN user_role.valid_from IS '유효 시작일(비면 즉시)';
COMMENT ON COLUMN user_role.valid_until IS '유효 종료일(임시 실사 담당·감사인). 지나면 권한 없음';
COMMENT ON COLUMN user_role.created_at IS '생성 일시';
COMMENT ON COLUMN user_role.created_by IS '생성자';
COMMENT ON COLUMN user_role.updated_at IS '변경 일시';
COMMENT ON COLUMN user_role.updated_by IS '변경자';
COMMENT ON COLUMN user_role.version IS '낙관적 잠금';
COMMENT ON TABLE user_role IS '사용자 역할 — 역할 부여와 범위(회사코드·사이트). 범위가 비면 전체';
CREATE INDEX ix_user_role_tenant_id_role ON user_role (tenant_id, role);

-- 회사코드: SAP 회사코드 (IF-MD-01 COMPANY)
CREATE TABLE company (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_code varchar(4) NOT NULL,
  name varchar(25) NOT NULL,
  currency varchar(5) NOT NULL DEFAULT 'USD',
  sap_synced_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, company_code)
);
COMMENT ON COLUMN company.id IS '기본키';
COMMENT ON COLUMN company.tenant_id IS '테넌트';
COMMENT ON COLUMN company.company_code IS 'BUKRS';
COMMENT ON COLUMN company.name IS 'BUTXT';
COMMENT ON COLUMN company.currency IS 'WAERS';
COMMENT ON COLUMN company.sap_synced_at IS '마지막 SAP 수신';
COMMENT ON COLUMN company.is_active IS '수신 목록에 없으면 false';
COMMENT ON COLUMN company.created_at IS '생성 일시';
COMMENT ON COLUMN company.created_by IS '생성자';
COMMENT ON COLUMN company.updated_at IS '변경 일시';
COMMENT ON COLUMN company.updated_by IS '변경자';
COMMENT ON COLUMN company.version IS '낙관적 잠금';
COMMENT ON TABLE company IS '회사코드 — SAP 회사코드 (IF-MD-01 COMPANY)';

-- 플랜트: SAP 플랜트 (IF-MD-01 PLANT)
CREATE TABLE plant (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  plant_code varchar(4) NOT NULL,
  name varchar(30) NOT NULL,
  address varchar(200),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, plant_code)
);
COMMENT ON COLUMN plant.id IS '기본키';
COMMENT ON COLUMN plant.tenant_id IS '테넌트';
COMMENT ON COLUMN plant.company_id IS '회사코드';
COMMENT ON COLUMN plant.plant_code IS 'WERKS';
COMMENT ON COLUMN plant.name IS 'NAME1';
COMMENT ON COLUMN plant.address IS '주소';
COMMENT ON COLUMN plant.is_active IS '사용 여부';
COMMENT ON COLUMN plant.created_at IS '생성 일시';
COMMENT ON COLUMN plant.created_by IS '생성자';
COMMENT ON COLUMN plant.updated_at IS '변경 일시';
COMMENT ON COLUMN plant.updated_by IS '변경자';
COMMENT ON COLUMN plant.version IS '낙관적 잠금';
COMMENT ON TABLE plant IS '플랜트 — SAP 플랜트 (IF-MD-01 PLANT)';

-- 손익센터: SAP 손익센터 (IF-MD-01 PROFIT_CENTER)
CREATE TABLE profit_center (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  controlling_area varchar(4) NOT NULL,
  profit_center_code varchar(10) NOT NULL,
  name varchar(20) NOT NULL,
  segment varchar(10),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, controlling_area, profit_center_code)
);
COMMENT ON COLUMN profit_center.id IS '기본키';
COMMENT ON COLUMN profit_center.tenant_id IS '테넌트';
COMMENT ON COLUMN profit_center.controlling_area IS 'KOKRS';
COMMENT ON COLUMN profit_center.profit_center_code IS 'PRCTR';
COMMENT ON COLUMN profit_center.name IS 'KTEXT';
COMMENT ON COLUMN profit_center.segment IS 'SEGMENT. 이관 시 ABUMN 판단에 사용';
COMMENT ON COLUMN profit_center.is_active IS '사용 여부';
COMMENT ON COLUMN profit_center.created_at IS '생성 일시';
COMMENT ON COLUMN profit_center.created_by IS '생성자';
COMMENT ON COLUMN profit_center.updated_at IS '변경 일시';
COMMENT ON COLUMN profit_center.updated_by IS '변경자';
COMMENT ON COLUMN profit_center.version IS '낙관적 잠금';
COMMENT ON TABLE profit_center IS '손익센터 — SAP 손익센터 (IF-MD-01 PROFIT_CENTER)';

-- 코스트센터: SAP 코스트센터 (IF-MD-01 COST_CENTER). 기준일 현재 유효한 1행만 보관
CREATE TABLE cost_center (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  controlling_area varchar(4) NOT NULL,
  cost_center_code varchar(10) NOT NULL,
  name varchar(20) NOT NULL,
  company_id uuid NOT NULL,
  profit_center_id uuid,
  responsible varchar(20),
  valid_from date,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, controlling_area, cost_center_code)
);
COMMENT ON COLUMN cost_center.id IS '기본키';
COMMENT ON COLUMN cost_center.tenant_id IS '테넌트';
COMMENT ON COLUMN cost_center.controlling_area IS 'KOKRS';
COMMENT ON COLUMN cost_center.cost_center_code IS 'KOSTL';
COMMENT ON COLUMN cost_center.name IS 'KTEXT';
COMMENT ON COLUMN cost_center.company_id IS 'BUKRS';
COMMENT ON COLUMN cost_center.profit_center_id IS 'PRCTR. 이관 판단(AS02/ABUMN)';
COMMENT ON COLUMN cost_center.responsible IS 'VERAK 책임자';
COMMENT ON COLUMN cost_center.valid_from IS 'DATAB';
COMMENT ON COLUMN cost_center.valid_to IS 'DATBI';
COMMENT ON COLUMN cost_center.is_active IS '사용 여부';
COMMENT ON COLUMN cost_center.created_at IS '생성 일시';
COMMENT ON COLUMN cost_center.created_by IS '생성자';
COMMENT ON COLUMN cost_center.updated_at IS '변경 일시';
COMMENT ON COLUMN cost_center.updated_by IS '변경자';
COMMENT ON COLUMN cost_center.version IS '낙관적 잠금';
COMMENT ON TABLE cost_center IS '코스트센터 — SAP 코스트센터 (IF-MD-01 COST_CENTER). 기준일 현재 유효한 1행만 보관';

-- 자산클래스: SAP 자산클래스 (IF-MD-01 ASSET_CLASS)
CREATE TABLE asset_class (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  class_code varchar(8) NOT NULL,
  name varchar(50) NOT NULL,
  is_low_value boolean NOT NULL DEFAULT false,
  is_capitalized boolean NOT NULL DEFAULT true,
  default_useful_life_years integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, class_code)
);
COMMENT ON COLUMN asset_class.id IS '기본키';
COMMENT ON COLUMN asset_class.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_class.class_code IS 'ANLKL';
COMMENT ON COLUMN asset_class.name IS 'TXK50';
COMMENT ON COLUMN asset_class.is_low_value IS '저가자산 여부';
COMMENT ON COLUMN asset_class.is_capitalized IS '자본화 대상. true면 등록 시 SAP 생성 요청';
COMMENT ON COLUMN asset_class.default_useful_life_years IS '내용연수 기본값(년)';
COMMENT ON COLUMN asset_class.is_active IS '사용 여부';
COMMENT ON COLUMN asset_class.created_at IS '생성 일시';
COMMENT ON COLUMN asset_class.created_by IS '생성자';
COMMENT ON COLUMN asset_class.updated_at IS '변경 일시';
COMMENT ON COLUMN asset_class.updated_by IS '변경자';
COMMENT ON COLUMN asset_class.version IS '낙관적 잠금';
COMMENT ON TABLE asset_class IS '자산클래스 — SAP 자산클래스 (IF-MD-01 ASSET_CLASS)';

-- 사이트: ALM 사이트(건물·거점). SAP 위치(T499S)와 연결
CREATE TABLE site (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_code varchar(10) NOT NULL,
  name varchar(60) NOT NULL,
  plant_id uuid,
  sap_location varchar(10),
  address varchar(200),
  time_zone varchar(40),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, site_code)
);
COMMENT ON COLUMN site.id IS '기본키';
COMMENT ON COLUMN site.tenant_id IS '테넌트';
COMMENT ON COLUMN site.site_code IS '사이트 코드 (예: ATL1)';
COMMENT ON COLUMN site.name IS '이름';
COMMENT ON COLUMN site.plant_id IS 'SAP 플랜트';
COMMENT ON COLUMN site.sap_location IS 'T499S STAND';
COMMENT ON COLUMN site.address IS '주소';
COMMENT ON COLUMN site.time_zone IS '시간대(비면 테넌트 기본)';
COMMENT ON COLUMN site.is_active IS '사용 여부';
COMMENT ON COLUMN site.created_at IS '생성 일시';
COMMENT ON COLUMN site.created_by IS '생성자';
COMMENT ON COLUMN site.updated_at IS '변경 일시';
COMMENT ON COLUMN site.updated_by IS '변경자';
COMMENT ON COLUMN site.version IS '낙관적 잠금';
COMMENT ON TABLE site IS '사이트 — ALM 사이트(건물·거점). SAP 위치(T499S)와 연결';

-- 룸: 실사·위치의 최소 단위. room_code를 SAP STORT에 전송
CREATE TABLE room (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  room_code varchar(10) NOT NULL,
  name varchar(60) NOT NULL,
  floor varchar(10),
  sap_room_no varchar(8),
  barcode varchar(30) NOT NULL,
  is_storage boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, room_code),
  UNIQUE (tenant_id, barcode)
);
COMMENT ON COLUMN room.id IS '기본키';
COMMENT ON COLUMN room.tenant_id IS '테넌트';
COMMENT ON COLUMN room.site_id IS '사이트';
COMMENT ON COLUMN room.room_code IS '룸 코드 (예: ATL1-2F-IT) = SAP STORT';
COMMENT ON COLUMN room.name IS '이름';
COMMENT ON COLUMN room.floor IS '층';
COMMENT ON COLUMN room.sap_room_no IS 'SAP RAUMNR 8자 약어(ZALM_MAP)';
COMMENT ON COLUMN room.barcode IS '룸 바코드 값. 기본 = room_code';
COMMENT ON COLUMN room.is_storage IS 'IT 창고 여부(반납 시 기본 위치)';
COMMENT ON COLUMN room.is_active IS '사용 여부';
COMMENT ON COLUMN room.created_at IS '생성 일시';
COMMENT ON COLUMN room.created_by IS '생성자';
COMMENT ON COLUMN room.updated_at IS '변경 일시';
COMMENT ON COLUMN room.updated_by IS '변경자';
COMMENT ON COLUMN room.version IS '낙관적 잠금';
COMMENT ON TABLE room IS '룸 — 실사·위치의 최소 단위. room_code를 SAP STORT에 전송';

-- 카테고리: 자산 분류(노트북, 서버 등). 계층 구조
CREATE TABLE category (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  category_code varchar(20) NOT NULL,
  name varchar(60) NOT NULL,
  parent_id uuid,
  default_asset_class_id uuid,
  useful_life_years integer,
  is_ci boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, category_code)
);
COMMENT ON COLUMN category.id IS '기본키';
COMMENT ON COLUMN category.tenant_id IS '테넌트';
COMMENT ON COLUMN category.category_code IS '코드';
COMMENT ON COLUMN category.name IS '이름';
COMMENT ON COLUMN category.parent_id IS '상위 카테고리';
COMMENT ON COLUMN category.default_asset_class_id IS '등록 시 기본 자산클래스';
COMMENT ON COLUMN category.useful_life_years IS '내용연수 경과 판정 기준(년)';
COMMENT ON COLUMN category.is_ci IS '등록 시 CMDB CI 자동 생성';
COMMENT ON COLUMN category.is_active IS '사용 여부';
COMMENT ON COLUMN category.created_at IS '생성 일시';
COMMENT ON COLUMN category.created_by IS '생성자';
COMMENT ON COLUMN category.updated_at IS '변경 일시';
COMMENT ON COLUMN category.updated_by IS '변경자';
COMMENT ON COLUMN category.version IS '낙관적 잠금';
COMMENT ON TABLE category IS '카테고리 — 자산 분류(노트북, 서버 등). 계층 구조';

-- 모델: 제조사·모델 마스터
CREATE TABLE model (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  category_id uuid NOT NULL,
  manufacturer varchar(60) NOT NULL,
  model_name varchar(100) NOT NULL,
  part_no varchar(40),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, manufacturer, model_name)
);
COMMENT ON COLUMN model.id IS '기본키';
COMMENT ON COLUMN model.tenant_id IS '테넌트';
COMMENT ON COLUMN model.category_id IS '카테고리';
COMMENT ON COLUMN model.manufacturer IS '제조사';
COMMENT ON COLUMN model.model_name IS '모델명';
COMMENT ON COLUMN model.part_no IS '제조사 부품번호';
COMMENT ON COLUMN model.is_active IS '사용 여부';
COMMENT ON COLUMN model.created_at IS '생성 일시';
COMMENT ON COLUMN model.created_by IS '생성자';
COMMENT ON COLUMN model.updated_at IS '변경 일시';
COMMENT ON COLUMN model.updated_by IS '변경자';
COMMENT ON COLUMN model.version IS '낙관적 잠금';
COMMENT ON TABLE model IS '모델 — 제조사·모델 마스터';

-- 공급사: 공급사. SAP 공급사 번호와 연결
CREATE TABLE vendor (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  vendor_no varchar(10),
  name varchar(80) NOT NULL,
  email varchar(254),
  phone varchar(30),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, vendor_no)
);
COMMENT ON COLUMN vendor.id IS '기본키';
COMMENT ON COLUMN vendor.tenant_id IS '테넌트';
COMMENT ON COLUMN vendor.vendor_no IS 'LIFNR. SAP에 없는 공급사는 비움';
COMMENT ON COLUMN vendor.name IS '이름';
COMMENT ON COLUMN vendor.email IS '대표 이메일';
COMMENT ON COLUMN vendor.phone IS '전화';
COMMENT ON COLUMN vendor.is_active IS '사용 여부';
COMMENT ON COLUMN vendor.created_at IS '생성 일시';
COMMENT ON COLUMN vendor.created_by IS '생성자';
COMMENT ON COLUMN vendor.updated_at IS '변경 일시';
COMMENT ON COLUMN vendor.updated_by IS '변경자';
COMMENT ON COLUMN vendor.version IS '낙관적 잠금';
COMMENT ON TABLE vendor IS '공급사 — 공급사. SAP 공급사 번호와 연결';

-- 자산: 자산 대장. 하드웨어·설비·집기 1건 = 1행
CREATE TABLE asset (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_tag varchar(25) NOT NULL,
  description varchar(50) NOT NULL,
  category_id uuid NOT NULL,
  model_id uuid,
  serial_no varchar(40),
  status asset_status NOT NULL DEFAULT 'IN_STOCK',
  status_before_missing asset_status,
  source asset_source NOT NULL,
  company_id uuid NOT NULL,
  site_id uuid,
  room_id uuid,
  cost_center_id uuid,
  assigned_user_id uuid,
  assigned_at timestamptz,
  due_back_date date,
  asset_class_id uuid,
  is_capitalized boolean NOT NULL DEFAULT false,
  sap_asset_no varchar(12),
  sap_sub_no varchar(4),
  sap_cap_date date,
  sap_deact_date date,
  last_count_date date,
  last_count_note varchar(15),
  hostname varchar(63),
  ip_address inet,
  mac_address varchar(17),
  bios_asset_tag varchar(40),
  os_name varchar(60),
  purchase_date date,
  purchase_cost numeric(15,2),
  warranty_end_date date,
  po_item_id uuid,
  goods_receipt_id uuid,
  is_gr_cancelled boolean NOT NULL DEFAULT false,
  parent_asset_id uuid,
  last_seen_at timestamptz,
  sap_synced_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, asset_tag),
  UNIQUE (tenant_id, company_id, sap_asset_no, sap_sub_no)
);
COMMENT ON COLUMN asset.id IS '기본키';
COMMENT ON COLUMN asset.tenant_id IS '테넌트';
COMMENT ON COLUMN asset.asset_tag IS '자산태그 AT-nnnnnn = SAP INVNR, 라벨 바코드 값';
COMMENT ON COLUMN asset.description IS '자산명 = SAP TXT50';
COMMENT ON COLUMN asset.category_id IS '카테고리';
COMMENT ON COLUMN asset.model_id IS '모델';
COMMENT ON COLUMN asset.serial_no IS '시리얼. SAP SERNR(18자) 초과 시 전송 검증 오류';
COMMENT ON COLUMN asset.status IS '상태 7종';
COMMENT ON COLUMN asset.status_before_missing IS 'Missing 전 상태. 다음 스캔 시 복원';
COMMENT ON COLUMN asset.source IS '생성 출처';
COMMENT ON COLUMN asset.company_id IS '회사코드';
COMMENT ON COLUMN asset.site_id IS '사이트';
COMMENT ON COLUMN asset.room_id IS '룸';
COMMENT ON COLUMN asset.cost_center_id IS '코스트센터. 자본화 자산은 SAP 기준';
COMMENT ON COLUMN asset.assigned_user_id IS '사용자(할당)';
COMMENT ON COLUMN asset.assigned_at IS '할당 일시';
COMMENT ON COLUMN asset.due_back_date IS '반납 예정일';
COMMENT ON COLUMN asset.asset_class_id IS '자산클래스';
COMMENT ON COLUMN asset.is_capitalized IS 'SAP 자본화 자산 여부';
COMMENT ON COLUMN asset.sap_asset_no IS 'ANLN1';
COMMENT ON COLUMN asset.sap_sub_no IS 'ANLN2';
COMMENT ON COLUMN asset.sap_cap_date IS 'AKTIV 취득일';
COMMENT ON COLUMN asset.sap_deact_date IS 'DEAKT 비활성일';
COMMENT ON COLUMN asset.last_count_date IS 'IVDAT 마지막 실사일. ALM 기준';
COMMENT ON COLUMN asset.last_count_note IS 'INVZU 실사 비고';
COMMENT ON COLUMN asset.hostname IS '호스트명';
COMMENT ON COLUMN asset.ip_address IS 'IP';
COMMENT ON COLUMN asset.mac_address IS 'MAC';
COMMENT ON COLUMN asset.bios_asset_tag IS 'BIOS 자산태그';
COMMENT ON COLUMN asset.os_name IS 'OS';
COMMENT ON COLUMN asset.purchase_date IS '구매일(비자본화 자산 참고용)';
COMMENT ON COLUMN asset.purchase_cost IS '구매가(비자본화 자산 참고용). 회계 금액은 asset_value';
COMMENT ON COLUMN asset.warranty_end_date IS '제조사 보증 종료일';
COMMENT ON COLUMN asset.po_item_id IS '구매오더 항목';
COMMENT ON COLUMN asset.goods_receipt_id IS '입고 문서(입고로 생성된 경우)';
COMMENT ON COLUMN asset.is_gr_cancelled IS '입고 취소(102) 표시';
COMMENT ON COLUMN asset.parent_asset_id IS '상위 자산(구성품)';
COMMENT ON COLUMN asset.last_seen_at IS 'Discovery 마지막 확인';
COMMENT ON COLUMN asset.sap_synced_at IS '마지막 SAP 수신';
COMMENT ON COLUMN asset.notes IS '메모';
COMMENT ON COLUMN asset.created_at IS '생성 일시';
COMMENT ON COLUMN asset.created_by IS '생성자';
COMMENT ON COLUMN asset.updated_at IS '변경 일시';
COMMENT ON COLUMN asset.updated_by IS '변경자';
COMMENT ON COLUMN asset.version IS '낙관적 잠금';
COMMENT ON TABLE asset IS '자산 — 자산 대장. 하드웨어·설비·집기 1건 = 1행';
CREATE INDEX ix_asset_tenant_id_status ON asset (tenant_id, status);
CREATE INDEX ix_asset_tenant_id_serial_no ON asset (tenant_id, serial_no);
CREATE INDEX ix_asset_tenant_id_room_id ON asset (tenant_id, room_id);
CREATE INDEX ix_asset_tenant_id_cost_center_id ON asset (tenant_id, cost_center_id);
CREATE INDEX ix_asset_tenant_id_assigned_user_id ON asset (tenant_id, assigned_user_id);
CREATE INDEX ix_asset_tenant_id_hostname ON asset (tenant_id, hostname);
CREATE INDEX ix_asset_tenant_id_mac_address ON asset (tenant_id, mac_address);

-- 자산 금액: SAP 기간별 누적 금액 (IF-AA-02). 최신 값은 뷰 v_asset_value_latest
CREATE TABLE asset_value (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  fiscal_year integer NOT NULL,
  period integer NOT NULL,
  dep_area varchar(2) NOT NULL DEFAULT '01',
  acquisition_value numeric(15,2) NOT NULL,
  accum_depreciation numeric(15,2) NOT NULL,
  net_book_value numeric(15,2) NOT NULL,
  useful_life_years integer,
  useful_life_periods integer,
  dep_key varchar(4),
  is_closed boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (asset_id, fiscal_year, period, dep_area)
);
COMMENT ON COLUMN asset_value.id IS '기본키';
COMMENT ON COLUMN asset_value.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_value.asset_id IS '자산';
COMMENT ON COLUMN asset_value.fiscal_year IS 'GJAHR';
COMMENT ON COLUMN asset_value.period IS '기간 1~16';
COMMENT ON COLUMN asset_value.dep_area IS 'AFABE 상각영역';
COMMENT ON COLUMN asset_value.acquisition_value IS '취득가(APC) 누계';
COMMENT ON COLUMN asset_value.accum_depreciation IS '감가상각누계액(음수)';
COMMENT ON COLUMN asset_value.net_book_value IS '장부가액(NBV)';
COMMENT ON COLUMN asset_value.useful_life_years IS 'NDJAR';
COMMENT ON COLUMN asset_value.useful_life_periods IS 'NDPER';
COMMENT ON COLUMN asset_value.dep_key IS 'AFASL';
COMMENT ON COLUMN asset_value.is_closed IS '마감값(isClosing 수신). true면 이후 일반 수신으로 덮어쓰지 않음';
COMMENT ON COLUMN asset_value.received_at IS '수신 일시';
COMMENT ON COLUMN asset_value.created_at IS '생성 일시';
COMMENT ON COLUMN asset_value.created_by IS '생성자';
COMMENT ON COLUMN asset_value.updated_at IS '변경 일시';
COMMENT ON COLUMN asset_value.updated_by IS '변경자';
COMMENT ON COLUMN asset_value.version IS '낙관적 잠금';
COMMENT ON TABLE asset_value IS '자산 금액 — SAP 기간별 누적 금액 (IF-AA-02). 최신 값은 뷰 v_asset_value_latest';

-- 자산 할당: Check-out·반납 이력. 반납 전 행이 현재 할당
CREATE TABLE asset_assignment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  user_id uuid,
  cost_center_id uuid,
  room_id uuid,
  checked_out_at timestamptz NOT NULL,
  due_back_date date,
  returned_at timestamptz,
  note varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN asset_assignment.id IS '기본키';
COMMENT ON COLUMN asset_assignment.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_assignment.asset_id IS '자산';
COMMENT ON COLUMN asset_assignment.user_id IS '사용자';
COMMENT ON COLUMN asset_assignment.cost_center_id IS '코스트센터';
COMMENT ON COLUMN asset_assignment.room_id IS '룸';
COMMENT ON COLUMN asset_assignment.checked_out_at IS '할당 일시';
COMMENT ON COLUMN asset_assignment.due_back_date IS '반납 예정일';
COMMENT ON COLUMN asset_assignment.returned_at IS '반납 일시';
COMMENT ON COLUMN asset_assignment.note IS '메모';
COMMENT ON COLUMN asset_assignment.created_at IS '생성 일시';
COMMENT ON COLUMN asset_assignment.created_by IS '생성자';
COMMENT ON COLUMN asset_assignment.updated_at IS '변경 일시';
COMMENT ON COLUMN asset_assignment.updated_by IS '변경자';
COMMENT ON COLUMN asset_assignment.version IS '낙관적 잠금';
COMMENT ON TABLE asset_assignment IS '자산 할당 — Check-out·반납 이력. 반납 전 행이 현재 할당';
CREATE INDEX ix_asset_assignment_asset_id_checked_out_at ON asset_assignment (asset_id, checked_out_at);

-- 자산 이력: 자산의 업무 이력(History 탭). 변경 전후값 포함
CREATE TABLE asset_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  event_type asset_event_type NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  channel varchar(20) NOT NULL,
  changes jsonb,
  reason varchar(200),
  asset_request_id uuid,
  count_campaign_id uuid,
  sap_document_no varchar(10),
  sap_fiscal_year integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN asset_event.id IS '기본키';
COMMENT ON COLUMN asset_event.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_event.asset_id IS '자산';
COMMENT ON COLUMN asset_event.event_type IS '이력 유형';
COMMENT ON COLUMN asset_event.occurred_at IS '발생 일시';
COMMENT ON COLUMN asset_event.actor_id IS '처리자(비면 시스템)';
COMMENT ON COLUMN asset_event.channel IS 'UI / API / SAP / PDA / DISCOVERY';
COMMENT ON COLUMN asset_event.changes IS '필드별 {before, after}';
COMMENT ON COLUMN asset_event.reason IS '사유';
COMMENT ON COLUMN asset_event.asset_request_id IS '관련 자산 요청';
COMMENT ON COLUMN asset_event.count_campaign_id IS '관련 실사 캠페인';
COMMENT ON COLUMN asset_event.sap_document_no IS 'SAP 전표번호 BELNR';
COMMENT ON COLUMN asset_event.sap_fiscal_year IS 'GJAHR';
COMMENT ON COLUMN asset_event.created_at IS '생성 일시';
COMMENT ON TABLE asset_event IS '자산 이력 — 자산의 업무 이력(History 탭). 변경 전후값 포함';
CREATE INDEX ix_asset_event_asset_id_occurred_at ON asset_event (asset_id, occurred_at);

-- 수집 작업: Discovery 스캔 작업 설정
CREATE TABLE discovery_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  method discovery_method NOT NULL,
  targets jsonb NOT NULL,
  schedule_cron varchar(50),
  credential_ref varchar(200),
  site_id uuid,
  last_run_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN discovery_job.id IS '기본키';
COMMENT ON COLUMN discovery_job.tenant_id IS '테넌트';
COMMENT ON COLUMN discovery_job.name IS '작업명';
COMMENT ON COLUMN discovery_job.method IS '에이전트 / 네트워크 스캔 / vCenter';
COMMENT ON COLUMN discovery_job.targets IS 'IP 대역, vCenter URL 목록';
COMMENT ON COLUMN discovery_job.schedule_cron IS '실행 주기(cron). 비면 수동';
COMMENT ON COLUMN discovery_job.credential_ref IS 'AWS Secrets Manager ARN. 자격증명은 저장하지 않음';
COMMENT ON COLUMN discovery_job.site_id IS '대상 사이트';
COMMENT ON COLUMN discovery_job.last_run_at IS '마지막 실행';
COMMENT ON COLUMN discovery_job.is_active IS '사용 여부';
COMMENT ON COLUMN discovery_job.created_at IS '생성 일시';
COMMENT ON COLUMN discovery_job.created_by IS '생성자';
COMMENT ON COLUMN discovery_job.updated_at IS '변경 일시';
COMMENT ON COLUMN discovery_job.updated_by IS '변경자';
COMMENT ON COLUMN discovery_job.version IS '낙관적 잠금';
COMMENT ON TABLE discovery_job IS '수집 작업 — Discovery 스캔 작업 설정';

-- 수집 실행: 수집 작업 1회 실행. 에이전트 상시 보고는 일 단위 1행
CREATE TABLE discovery_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid,
  status run_status NOT NULL DEFAULT 'QUEUED',
  started_at timestamptz,
  finished_at timestamptz,
  found_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN discovery_run.id IS '기본키';
COMMENT ON COLUMN discovery_run.tenant_id IS '테넌트';
COMMENT ON COLUMN discovery_run.job_id IS '수집 작업(에이전트 보고는 비움)';
COMMENT ON COLUMN discovery_run.status IS '상태';
COMMENT ON COLUMN discovery_run.started_at IS '시작';
COMMENT ON COLUMN discovery_run.finished_at IS '종료';
COMMENT ON COLUMN discovery_run.found_count IS '수집 건수';
COMMENT ON COLUMN discovery_run.new_count IS '신규';
COMMENT ON COLUMN discovery_run.conflict_count IS '충돌';
COMMENT ON COLUMN discovery_run.error_message IS '오류';
COMMENT ON COLUMN discovery_run.created_at IS '생성 일시';
COMMENT ON COLUMN discovery_run.created_by IS '생성자';
COMMENT ON COLUMN discovery_run.updated_at IS '변경 일시';
COMMENT ON COLUMN discovery_run.updated_by IS '변경자';
COMMENT ON COLUMN discovery_run.version IS '낙관적 잠금';
COMMENT ON TABLE discovery_run IS '수집 실행 — 수집 작업 1회 실행. 에이전트 상시 보고는 일 단위 1행';
CREATE INDEX ix_discovery_run_tenant_id_started_at ON discovery_run (tenant_id, started_at);

-- 수집 결과: 장비 1대의 수집 결과와 대사 큐 처리
CREATE TABLE discovery_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  collected_at timestamptz NOT NULL,
  hostname varchar(63),
  serial_no varchar(40),
  manufacturer varchar(60),
  model varchar(100),
  bios_asset_tag varchar(40),
  mac_address varchar(17),
  ip_address inet,
  os_name varchar(60),
  raw jsonb NOT NULL,
  match_status discovery_match NOT NULL,
  match_rule varchar(30),
  matched_asset_id uuid,
  conflict_fields jsonb,
  resolution discovery_resolution,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN discovery_item.id IS '기본키';
COMMENT ON COLUMN discovery_item.tenant_id IS '테넌트';
COMMENT ON COLUMN discovery_item.run_id IS '수집 실행';
COMMENT ON COLUMN discovery_item.collected_at IS '수집 일시';
COMMENT ON COLUMN discovery_item.hostname IS '호스트명';
COMMENT ON COLUMN discovery_item.serial_no IS '시리얼';
COMMENT ON COLUMN discovery_item.manufacturer IS '제조사';
COMMENT ON COLUMN discovery_item.model IS '모델';
COMMENT ON COLUMN discovery_item.bios_asset_tag IS 'BIOS 자산태그';
COMMENT ON COLUMN discovery_item.mac_address IS 'MAC';
COMMENT ON COLUMN discovery_item.ip_address IS 'IP';
COMMENT ON COLUMN discovery_item.os_name IS 'OS';
COMMENT ON COLUMN discovery_item.raw IS '수집 원본';
COMMENT ON COLUMN discovery_item.match_status IS 'New / Conflict / Unmanaged / Matched / Ignored';
COMMENT ON COLUMN discovery_item.match_rule IS '매칭 규칙 SERIAL_MFR, BIOS_TAG, MAC, HOSTNAME_MODEL';
COMMENT ON COLUMN discovery_item.matched_asset_id IS '매칭된 자산';
COMMENT ON COLUMN discovery_item.conflict_fields IS '충돌 필드 {field: {alm, discovered}}';
COMMENT ON COLUMN discovery_item.resolution IS '처리 결과';
COMMENT ON COLUMN discovery_item.resolved_by IS '처리자';
COMMENT ON COLUMN discovery_item.resolved_at IS '처리 일시';
COMMENT ON COLUMN discovery_item.created_at IS '생성 일시';
COMMENT ON COLUMN discovery_item.created_by IS '생성자';
COMMENT ON COLUMN discovery_item.updated_at IS '변경 일시';
COMMENT ON COLUMN discovery_item.updated_by IS '변경자';
COMMENT ON COLUMN discovery_item.version IS '낙관적 잠금';
COMMENT ON TABLE discovery_item IS '수집 결과 — 장비 1대의 수집 결과와 대사 큐 처리';
CREATE INDEX ix_discovery_item_tenant_id_match_status ON discovery_item (tenant_id, match_status);

-- CI: CMDB 구성항목. 하드웨어 CI는 자산과 1:1
CREATE TABLE config_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ci_type ci_type NOT NULL,
  name varchar(100) NOT NULL,
  asset_id uuid UNIQUE,
  owner_user_id uuid,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN config_item.id IS '기본키';
COMMENT ON COLUMN config_item.tenant_id IS '테넌트';
COMMENT ON COLUMN config_item.ci_type IS 'CI 유형';
COMMENT ON COLUMN config_item.name IS '이름';
COMMENT ON COLUMN config_item.asset_id IS '하드웨어 CI면 자산';
COMMENT ON COLUMN config_item.owner_user_id IS '담당자';
COMMENT ON COLUMN config_item.description IS '설명';
COMMENT ON COLUMN config_item.is_active IS '사용 여부';
COMMENT ON COLUMN config_item.created_at IS '생성 일시';
COMMENT ON COLUMN config_item.created_by IS '생성자';
COMMENT ON COLUMN config_item.updated_at IS '변경 일시';
COMMENT ON COLUMN config_item.updated_by IS '변경자';
COMMENT ON COLUMN config_item.version IS '낙관적 잠금';
COMMENT ON TABLE config_item IS 'CI — CMDB 구성항목. 하드웨어 CI는 자산과 1:1';
CREATE INDEX ix_config_item_tenant_id_ci_type ON config_item (tenant_id, ci_type);

-- CI 관계: source가 target에 대해 갖는 관계 (예: 앱 runs on 서버)
CREATE TABLE ci_relation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  source_ci_id uuid NOT NULL,
  target_ci_id uuid NOT NULL,
  relation_type ci_relation_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (source_ci_id, target_ci_id, relation_type)
);
COMMENT ON COLUMN ci_relation.id IS '기본키';
COMMENT ON COLUMN ci_relation.tenant_id IS '테넌트';
COMMENT ON COLUMN ci_relation.source_ci_id IS '출발 CI';
COMMENT ON COLUMN ci_relation.target_ci_id IS '도착 CI';
COMMENT ON COLUMN ci_relation.relation_type IS '관계 유형';
COMMENT ON COLUMN ci_relation.created_at IS '생성 일시';
COMMENT ON COLUMN ci_relation.created_by IS '생성자';
COMMENT ON COLUMN ci_relation.updated_at IS '변경 일시';
COMMENT ON COLUMN ci_relation.updated_by IS '변경자';
COMMENT ON COLUMN ci_relation.version IS '낙관적 잠금';
COMMENT ON TABLE ci_relation IS 'CI 관계 — source가 target에 대해 갖는 관계 (예: 앱 runs on 서버)';
CREATE INDEX ix_ci_relation_target_ci_id ON ci_relation (target_ci_id);

-- 티켓 연결: ITSM 인시던트·변경 참조
CREATE TABLE ticket_link (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  config_item_id uuid NOT NULL,
  itsm_system varchar(20) NOT NULL,
  ticket_no varchar(30) NOT NULL,
  ticket_type varchar(20) NOT NULL,
  title varchar(200),
  ticket_status varchar(20),
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (config_item_id, itsm_system, ticket_no)
);
COMMENT ON COLUMN ticket_link.id IS '기본키';
COMMENT ON COLUMN ticket_link.tenant_id IS '테넌트';
COMMENT ON COLUMN ticket_link.config_item_id IS 'CI';
COMMENT ON COLUMN ticket_link.itsm_system IS 'ITSM 시스템';
COMMENT ON COLUMN ticket_link.ticket_no IS '티켓 번호';
COMMENT ON COLUMN ticket_link.ticket_type IS 'INCIDENT / CHANGE';
COMMENT ON COLUMN ticket_link.title IS '제목';
COMMENT ON COLUMN ticket_link.ticket_status IS '상태';
COMMENT ON COLUMN ticket_link.opened_at IS '접수 일시';
COMMENT ON COLUMN ticket_link.created_at IS '생성 일시';
COMMENT ON COLUMN ticket_link.created_by IS '생성자';
COMMENT ON COLUMN ticket_link.updated_at IS '변경 일시';
COMMENT ON COLUMN ticket_link.updated_by IS '변경자';
COMMENT ON COLUMN ticket_link.version IS '낙관적 잠금';
COMMENT ON TABLE ticket_link IS '티켓 연결 — ITSM 인시던트·변경 참조';

-- 소프트웨어 제품: 라이선스 관리 대상 제품과 설치명 매칭 규칙
CREATE TABLE software_product (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  publisher varchar(80) NOT NULL,
  name varchar(120) NOT NULL,
  is_commercial boolean NOT NULL DEFAULT true,
  match_pattern varchar(200),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, publisher, name)
);
COMMENT ON COLUMN software_product.id IS '기본키';
COMMENT ON COLUMN software_product.tenant_id IS '테넌트';
COMMENT ON COLUMN software_product.publisher IS '게시자';
COMMENT ON COLUMN software_product.name IS '제품명';
COMMENT ON COLUMN software_product.is_commercial IS '상용 여부(비인가 설치 판정)';
COMMENT ON COLUMN software_product.match_pattern IS '설치 목록 이름 매칭 정규식';
COMMENT ON COLUMN software_product.is_active IS '사용 여부';
COMMENT ON COLUMN software_product.created_at IS '생성 일시';
COMMENT ON COLUMN software_product.created_by IS '생성자';
COMMENT ON COLUMN software_product.updated_at IS '변경 일시';
COMMENT ON COLUMN software_product.updated_by IS '변경자';
COMMENT ON COLUMN software_product.version IS '낙관적 잠금';
COMMENT ON TABLE software_product IS '소프트웨어 제품 — 라이선스 관리 대상 제품과 설치명 매칭 규칙';

-- 라이선스: 보유 라이선스. 사용 수량·준수 판정은 뷰 v_license_compliance
CREATE TABLE license (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  license_model license_model NOT NULL,
  owned_quantity integer NOT NULL,
  unit_cost numeric(15,2),
  renewal_date date,
  contract_id uuid,
  po_no varchar(10),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN license.id IS '기본키';
COMMENT ON COLUMN license.tenant_id IS '테넌트';
COMMENT ON COLUMN license.product_id IS '제품';
COMMENT ON COLUMN license.license_model IS '사용자 / 장치 / 코어 / 네트워크';
COMMENT ON COLUMN license.owned_quantity IS '보유 수량';
COMMENT ON COLUMN license.unit_cost IS '단가(USD, 연간)';
COMMENT ON COLUMN license.renewal_date IS '갱신일';
COMMENT ON COLUMN license.contract_id IS '연결 계약';
COMMENT ON COLUMN license.po_no IS '구매 PO';
COMMENT ON COLUMN license.notes IS '메모';
COMMENT ON COLUMN license.created_at IS '생성 일시';
COMMENT ON COLUMN license.created_by IS '생성자';
COMMENT ON COLUMN license.updated_at IS '변경 일시';
COMMENT ON COLUMN license.updated_by IS '변경자';
COMMENT ON COLUMN license.version IS '낙관적 잠금';
COMMENT ON TABLE license IS '라이선스 — 보유 라이선스. 사용 수량·준수 판정은 뷰 v_license_compliance';
CREATE INDEX ix_license_tenant_id_product_id ON license (tenant_id, product_id);

-- 라이선스 할당: 사용자형 라이선스의 좌석 할당. 장치형은 software_install로 계산
CREATE TABLE license_assignment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  license_id uuid NOT NULL,
  user_id uuid,
  asset_id uuid,
  assigned_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN license_assignment.id IS '기본키';
COMMENT ON COLUMN license_assignment.tenant_id IS '테넌트';
COMMENT ON COLUMN license_assignment.license_id IS '라이선스';
COMMENT ON COLUMN license_assignment.user_id IS '사용자';
COMMENT ON COLUMN license_assignment.asset_id IS '장치';
COMMENT ON COLUMN license_assignment.assigned_at IS '할당 일시';
COMMENT ON COLUMN license_assignment.released_at IS '회수 일시';
COMMENT ON COLUMN license_assignment.created_at IS '생성 일시';
COMMENT ON COLUMN license_assignment.created_by IS '생성자';
COMMENT ON COLUMN license_assignment.updated_at IS '변경 일시';
COMMENT ON COLUMN license_assignment.updated_by IS '변경자';
COMMENT ON COLUMN license_assignment.version IS '낙관적 잠금';
COMMENT ON TABLE license_assignment IS '라이선스 할당 — 사용자형 라이선스의 좌석 할당. 장치형은 software_install로 계산';
CREATE INDEX ix_license_assignment_license_id_released_at ON license_assignment (license_id, released_at);

-- 설치 소프트웨어: 에이전트가 수집한 자산별 설치 목록
CREATE TABLE software_install (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  product_id uuid,
  raw_name varchar(200) NOT NULL,
  product_version varchar(50) NOT NULL DEFAULT '',
  install_date date,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  is_removed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (asset_id, raw_name, product_version)
);
COMMENT ON COLUMN software_install.id IS '기본키';
COMMENT ON COLUMN software_install.tenant_id IS '테넌트';
COMMENT ON COLUMN software_install.asset_id IS '자산';
COMMENT ON COLUMN software_install.product_id IS '매칭된 제품(비면 미분류)';
COMMENT ON COLUMN software_install.raw_name IS '설치 목록 원본 이름';
COMMENT ON COLUMN software_install.product_version IS '버전';
COMMENT ON COLUMN software_install.install_date IS '설치일';
COMMENT ON COLUMN software_install.first_seen_at IS '최초 수집';
COMMENT ON COLUMN software_install.last_seen_at IS '최근 수집';
COMMENT ON COLUMN software_install.is_removed IS '최근 수집에서 사라짐';
COMMENT ON COLUMN software_install.created_at IS '생성 일시';
COMMENT ON COLUMN software_install.created_by IS '생성자';
COMMENT ON COLUMN software_install.updated_at IS '변경 일시';
COMMENT ON COLUMN software_install.updated_by IS '변경자';
COMMENT ON COLUMN software_install.version IS '낙관적 잠금';
COMMENT ON TABLE software_install IS '설치 소프트웨어 — 에이전트가 수집한 자산별 설치 목록';
CREATE INDEX ix_software_install_tenant_id_product_id ON software_install (tenant_id, product_id);

-- 계약: 유지보수·리스·서비스·구독 계약
CREATE TABLE contract (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contract_no varchar(30) NOT NULL,
  contract_type contract_type NOT NULL,
  title varchar(120) NOT NULL,
  vendor_id uuid,
  start_date date NOT NULL,
  end_date date,
  amount numeric(15,2),
  is_auto_renew boolean NOT NULL DEFAULT false,
  owner_user_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, contract_no)
);
COMMENT ON COLUMN contract.id IS '기본키';
COMMENT ON COLUMN contract.tenant_id IS '테넌트';
COMMENT ON COLUMN contract.contract_no IS '계약번호';
COMMENT ON COLUMN contract.contract_type IS '계약 유형';
COMMENT ON COLUMN contract.title IS '계약명';
COMMENT ON COLUMN contract.vendor_id IS '공급사';
COMMENT ON COLUMN contract.start_date IS '시작일';
COMMENT ON COLUMN contract.end_date IS '종료일';
COMMENT ON COLUMN contract.amount IS '계약 금액(USD)';
COMMENT ON COLUMN contract.is_auto_renew IS '자동갱신';
COMMENT ON COLUMN contract.owner_user_id IS '담당자(만료 알림 수신)';
COMMENT ON COLUMN contract.notes IS '메모';
COMMENT ON COLUMN contract.created_at IS '생성 일시';
COMMENT ON COLUMN contract.created_by IS '생성자';
COMMENT ON COLUMN contract.updated_at IS '변경 일시';
COMMENT ON COLUMN contract.updated_by IS '변경자';
COMMENT ON COLUMN contract.version IS '낙관적 잠금';
COMMENT ON TABLE contract IS '계약 — 유지보수·리스·서비스·구독 계약';
CREATE INDEX ix_contract_tenant_id_end_date ON contract (tenant_id, end_date);

-- 계약 대상 자산: 계약과 자산 N:M
CREATE TABLE contract_asset (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (contract_id, asset_id)
);
COMMENT ON COLUMN contract_asset.id IS '기본키';
COMMENT ON COLUMN contract_asset.tenant_id IS '테넌트';
COMMENT ON COLUMN contract_asset.contract_id IS '계약';
COMMENT ON COLUMN contract_asset.asset_id IS '자산';
COMMENT ON COLUMN contract_asset.created_at IS '생성 일시';
COMMENT ON COLUMN contract_asset.created_by IS '생성자';
COMMENT ON COLUMN contract_asset.updated_at IS '변경 일시';
COMMENT ON COLUMN contract_asset.updated_by IS '변경자';
COMMENT ON COLUMN contract_asset.version IS '낙관적 잠금';
COMMENT ON TABLE contract_asset IS '계약 대상 자산 — 계약과 자산 N:M';
CREATE INDEX ix_contract_asset_asset_id ON contract_asset (asset_id);

-- 구매요청: 구매요청 헤더. 승인 후 SAP PO 생성(IF-MM-02)
CREATE TABLE purchase_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  pr_no varchar(12) NOT NULL,
  title varchar(120) NOT NULL,
  requester_id uuid NOT NULL,
  company_id uuid NOT NULL,
  cost_center_id uuid NOT NULL,
  status purchase_request_status NOT NULL DEFAULT 'DRAFT',
  estimated_amount numeric(15,2),
  needed_by date,
  reason text,
  source varchar(20) NOT NULL DEFAULT 'USER',
  license_id uuid,
  contract_id uuid,
  vendor_id uuid,
  purchasing_org varchar(4),
  purchasing_group varchar(3),
  sap_po_no varchar(10),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, pr_no)
);
COMMENT ON COLUMN purchase_request.id IS '기본키';
COMMENT ON COLUMN purchase_request.tenant_id IS '테넌트';
COMMENT ON COLUMN purchase_request.pr_no IS '요청번호 PR-nnnnn = SAP postingId';
COMMENT ON COLUMN purchase_request.title IS '제목';
COMMENT ON COLUMN purchase_request.requester_id IS '요청자';
COMMENT ON COLUMN purchase_request.company_id IS '회사코드';
COMMENT ON COLUMN purchase_request.cost_center_id IS '코스트센터';
COMMENT ON COLUMN purchase_request.status IS '상태';
COMMENT ON COLUMN purchase_request.estimated_amount IS '예상금액(USD)';
COMMENT ON COLUMN purchase_request.needed_by IS '필요일';
COMMENT ON COLUMN purchase_request.reason IS '사유';
COMMENT ON COLUMN purchase_request.source IS 'USER / LICENSE_SHORTAGE / CONTRACT_RENEWAL';
COMMENT ON COLUMN purchase_request.license_id IS '라이선스 부족분 구매';
COMMENT ON COLUMN purchase_request.contract_id IS '갱신 대상 계약';
COMMENT ON COLUMN purchase_request.vendor_id IS '공급사';
COMMENT ON COLUMN purchase_request.purchasing_org IS 'EKORG';
COMMENT ON COLUMN purchase_request.purchasing_group IS 'EKGRP';
COMMENT ON COLUMN purchase_request.sap_po_no IS '생성된 PO 번호';
COMMENT ON COLUMN purchase_request.created_at IS '생성 일시';
COMMENT ON COLUMN purchase_request.created_by IS '생성자';
COMMENT ON COLUMN purchase_request.updated_at IS '변경 일시';
COMMENT ON COLUMN purchase_request.updated_by IS '변경자';
COMMENT ON COLUMN purchase_request.version IS '낙관적 잠금';
COMMENT ON TABLE purchase_request IS '구매요청 — 구매요청 헤더. 승인 후 SAP PO 생성(IF-MM-02)';
CREATE INDEX ix_purchase_request_tenant_id_status ON purchase_request (tenant_id, status);

-- 구매요청 품목: 구매요청 품목
CREATE TABLE purchase_request_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  line_no integer NOT NULL,
  description varchar(40) NOT NULL,
  category_id uuid,
  model_id uuid,
  asset_class_id uuid,
  quantity integer NOT NULL,
  unit_price numeric(15,2),
  sap_asset_no varchar(12),
  sap_sub_no varchar(4),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (request_id, line_no)
);
COMMENT ON COLUMN purchase_request_item.id IS '기본키';
COMMENT ON COLUMN purchase_request_item.tenant_id IS '테넌트';
COMMENT ON COLUMN purchase_request_item.request_id IS '구매요청';
COMMENT ON COLUMN purchase_request_item.line_no IS '항목 번호';
COMMENT ON COLUMN purchase_request_item.description IS '품목명 = EKPO TXZ01';
COMMENT ON COLUMN purchase_request_item.category_id IS '카테고리';
COMMENT ON COLUMN purchase_request_item.model_id IS '모델';
COMMENT ON COLUMN purchase_request_item.asset_class_id IS '자산클래스';
COMMENT ON COLUMN purchase_request_item.quantity IS '수량';
COMMENT ON COLUMN purchase_request_item.unit_price IS '단가(USD)';
COMMENT ON COLUMN purchase_request_item.sap_asset_no IS '지정 자산번호(IF-AA-03 선처리)';
COMMENT ON COLUMN purchase_request_item.sap_sub_no IS '보조번호';
COMMENT ON COLUMN purchase_request_item.created_at IS '생성 일시';
COMMENT ON COLUMN purchase_request_item.created_by IS '생성자';
COMMENT ON COLUMN purchase_request_item.updated_at IS '변경 일시';
COMMENT ON COLUMN purchase_request_item.updated_by IS '변경자';
COMMENT ON COLUMN purchase_request_item.version IS '낙관적 잠금';
COMMENT ON TABLE purchase_request_item IS '구매요청 품목 — 구매요청 품목';

-- 구매오더 항목: SAP 자산 PO 항목 (IF-MM-01, 계정지정 A)
CREATE TABLE po_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  po_no varchar(10) NOT NULL,
  item_no varchar(5) NOT NULL,
  company_id uuid NOT NULL,
  vendor_id uuid,
  vendor_name varchar(80),
  description varchar(40) NOT NULL,
  quantity numeric(13,3) NOT NULL,
  unit_price numeric(15,2),
  cost_center_id uuid,
  purchase_request_id uuid,
  gr_quantity numeric(13,3) NOT NULL DEFAULT 0,
  is_deleted boolean NOT NULL DEFAULT false,
  sap_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, po_no, item_no)
);
COMMENT ON COLUMN po_item.id IS '기본키';
COMMENT ON COLUMN po_item.tenant_id IS '테넌트';
COMMENT ON COLUMN po_item.po_no IS 'EBELN';
COMMENT ON COLUMN po_item.item_no IS 'EBELP';
COMMENT ON COLUMN po_item.company_id IS '회사코드';
COMMENT ON COLUMN po_item.vendor_id IS '공급사';
COMMENT ON COLUMN po_item.vendor_name IS '공급사명(수신 원본)';
COMMENT ON COLUMN po_item.description IS 'TXZ01';
COMMENT ON COLUMN po_item.quantity IS 'MENGE';
COMMENT ON COLUMN po_item.unit_price IS 'NETPR';
COMMENT ON COLUMN po_item.cost_center_id IS 'EKKN KOSTL';
COMMENT ON COLUMN po_item.purchase_request_id IS 'ALM 구매요청에서 생성된 경우';
COMMENT ON COLUMN po_item.gr_quantity IS '누적 입고 수량';
COMMENT ON COLUMN po_item.is_deleted IS 'LOEKZ. 입고 대기 취소';
COMMENT ON COLUMN po_item.sap_synced_at IS '마지막 수신';
COMMENT ON COLUMN po_item.created_at IS '생성 일시';
COMMENT ON COLUMN po_item.created_by IS '생성자';
COMMENT ON COLUMN po_item.updated_at IS '변경 일시';
COMMENT ON COLUMN po_item.updated_by IS '변경자';
COMMENT ON COLUMN po_item.version IS '낙관적 잠금';
COMMENT ON TABLE po_item IS '구매오더 항목 — SAP 자산 PO 항목 (IF-MM-01, 계정지정 A)';

-- PO 지정 자산: PO 항목에 지정된 SAP 자산번호(EKKN). 항목당 여러 개
CREATE TABLE po_item_asset (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  po_item_id uuid NOT NULL,
  sap_asset_no varchar(12) NOT NULL,
  sap_sub_no varchar(4) NOT NULL,
  asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (po_item_id, sap_asset_no, sap_sub_no)
);
COMMENT ON COLUMN po_item_asset.id IS '기본키';
COMMENT ON COLUMN po_item_asset.tenant_id IS '테넌트';
COMMENT ON COLUMN po_item_asset.po_item_id IS 'PO 항목';
COMMENT ON COLUMN po_item_asset.sap_asset_no IS 'ANLN1';
COMMENT ON COLUMN po_item_asset.sap_sub_no IS 'ANLN2';
COMMENT ON COLUMN po_item_asset.asset_id IS '연결된 ALM 자산';
COMMENT ON COLUMN po_item_asset.created_at IS '생성 일시';
COMMENT ON COLUMN po_item_asset.created_by IS '생성자';
COMMENT ON COLUMN po_item_asset.updated_at IS '변경 일시';
COMMENT ON COLUMN po_item_asset.updated_by IS '변경자';
COMMENT ON COLUMN po_item_asset.version IS '낙관적 잠금';
COMMENT ON TABLE po_item_asset IS 'PO 지정 자산 — PO 항목에 지정된 SAP 자산번호(EKKN). 항목당 여러 개';

-- 입고: SAP 입고 문서 항목 (IF-MM-03). 101 수신 시 자산 생성
CREATE TABLE goods_receipt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  po_item_id uuid NOT NULL,
  material_doc varchar(10) NOT NULL,
  doc_year integer NOT NULL,
  doc_item varchar(4) NOT NULL,
  movement_type varchar(3) NOT NULL,
  quantity numeric(13,3) NOT NULL,
  posting_date date NOT NULL,
  assets_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, material_doc, doc_year, doc_item)
);
COMMENT ON COLUMN goods_receipt.id IS '기본키';
COMMENT ON COLUMN goods_receipt.tenant_id IS '테넌트';
COMMENT ON COLUMN goods_receipt.po_item_id IS 'PO 항목';
COMMENT ON COLUMN goods_receipt.material_doc IS 'MBLNR';
COMMENT ON COLUMN goods_receipt.doc_year IS 'MJAHR';
COMMENT ON COLUMN goods_receipt.doc_item IS 'ZEILE';
COMMENT ON COLUMN goods_receipt.movement_type IS 'BWART 101 입고 / 102 취소';
COMMENT ON COLUMN goods_receipt.quantity IS 'MENGE';
COMMENT ON COLUMN goods_receipt.posting_date IS 'BUDAT';
COMMENT ON COLUMN goods_receipt.assets_created_at IS '자산 생성 완료 일시';
COMMENT ON COLUMN goods_receipt.created_at IS '생성 일시';
COMMENT ON COLUMN goods_receipt.created_by IS '생성자';
COMMENT ON COLUMN goods_receipt.updated_at IS '변경 일시';
COMMENT ON COLUMN goods_receipt.updated_by IS '변경자';
COMMENT ON COLUMN goods_receipt.version IS '낙관적 잠금';
COMMENT ON TABLE goods_receipt IS '입고 — SAP 입고 문서 항목 (IF-MM-03). 101 수신 시 자산 생성';

-- 자산 요청: 신규·변경·이관·폐기·매각 요청. 부서 관리자·자산회계 승인 후 SAP 전기
CREATE TABLE asset_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_no varchar(12) NOT NULL,
  request_type request_type NOT NULL,
  status request_status NOT NULL DEFAULT 'SUBMITTED',
  source request_source NOT NULL DEFAULT 'USER',
  asset_id uuid,
  requester_id uuid NOT NULL,
  submitted_at timestamptz,
  reason varchar(200),
  current_step integer NOT NULL DEFAULT 1,
  asset_class_id uuid,
  acquisition_value numeric(15,2),
  po_item_id uuid,
  target_cost_center_id uuid,
  target_room_id uuid,
  is_profit_center_change boolean NOT NULL DEFAULT false,
  changes jsonb,
  effective_date date,
  retire_type retire_type,
  sale_amount numeric(15,2),
  buyer varchar(80),
  count_item_id uuid,
  recon_diff_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, request_no)
);
COMMENT ON COLUMN asset_request.id IS '기본키';
COMMENT ON COLUMN asset_request.tenant_id IS '테넌트';
COMMENT ON COLUMN asset_request.request_no IS '요청번호 AR-nnnnn = SAP postingId, BKTXT';
COMMENT ON COLUMN asset_request.request_type IS '요청 유형';
COMMENT ON COLUMN asset_request.status IS '상태';
COMMENT ON COLUMN asset_request.source IS '발생 출처';
COMMENT ON COLUMN asset_request.asset_id IS '대상 자산(신규는 ALM 자산 생성 후 연결)';
COMMENT ON COLUMN asset_request.requester_id IS '요청자';
COMMENT ON COLUMN asset_request.submitted_at IS '제출 일시';
COMMENT ON COLUMN asset_request.reason IS '사유';
COMMENT ON COLUMN asset_request.current_step IS '현재 승인 단계 1 부서 관리자, 2 자산회계';
COMMENT ON COLUMN asset_request.asset_class_id IS '신규: 자산클래스';
COMMENT ON COLUMN asset_request.acquisition_value IS '신규: 예상 취득가';
COMMENT ON COLUMN asset_request.po_item_id IS '신규: 참조 PO';
COMMENT ON COLUMN asset_request.target_cost_center_id IS '신규·이관: 코스트센터';
COMMENT ON COLUMN asset_request.target_room_id IS '변경: 새 룸';
COMMENT ON COLUMN asset_request.is_profit_center_change IS '손익센터·세그먼트 변경 → ABUMN';
COMMENT ON COLUMN asset_request.changes IS '변경: {field: {before, after}}';
COMMENT ON COLUMN asset_request.effective_date IS '이관일·폐기일·가치일(BZDAT)';
COMMENT ON COLUMN asset_request.retire_type IS '폐기 유형';
COMMENT ON COLUMN asset_request.sale_amount IS '매각금액(SALE 필수)';
COMMENT ON COLUMN asset_request.buyer IS '매입처';
COMMENT ON COLUMN asset_request.count_item_id IS '실사 차이에서 생성';
COMMENT ON COLUMN asset_request.recon_diff_id IS '대사 차이에서 생성';
COMMENT ON COLUMN asset_request.completed_at IS '전기 완료·반려 일시';
COMMENT ON COLUMN asset_request.created_at IS '생성 일시';
COMMENT ON COLUMN asset_request.created_by IS '생성자';
COMMENT ON COLUMN asset_request.updated_at IS '변경 일시';
COMMENT ON COLUMN asset_request.updated_by IS '변경자';
COMMENT ON COLUMN asset_request.version IS '낙관적 잠금';
COMMENT ON TABLE asset_request IS '자산 요청 — 신규·변경·이관·폐기·매각 요청. 부서 관리자·자산회계 승인 후 SAP 전기';
CREATE INDEX ix_asset_request_tenant_id_status ON asset_request (tenant_id, status);
CREATE INDEX ix_asset_request_asset_id ON asset_request (asset_id);

-- 승인: 자산 요청·구매요청의 단계별 승인. 둘 중 하나만 채움
CREATE TABLE approval (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_request_id uuid,
  purchase_request_id uuid,
  step_no integer NOT NULL,
  approver_role role_code NOT NULL,
  approver_id uuid,
  decision approval_decision NOT NULL DEFAULT 'PENDING',
  comment varchar(500),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (asset_request_id, step_no),
  UNIQUE (purchase_request_id, step_no),
  CHECK (num_nonnulls(asset_request_id, purchase_request_id) = 1)
);
COMMENT ON COLUMN approval.id IS '기본키';
COMMENT ON COLUMN approval.tenant_id IS '테넌트';
COMMENT ON COLUMN approval.asset_request_id IS '자산 요청';
COMMENT ON COLUMN approval.purchase_request_id IS '구매요청';
COMMENT ON COLUMN approval.step_no IS '단계 1 부서 관리자, 2 자산회계(최종)';
COMMENT ON COLUMN approval.approver_role IS '승인 역할';
COMMENT ON COLUMN approval.approver_id IS '승인자(결정 시 기록)';
COMMENT ON COLUMN approval.decision IS '결정';
COMMENT ON COLUMN approval.comment IS '의견';
COMMENT ON COLUMN approval.decided_at IS '결정 일시';
COMMENT ON COLUMN approval.created_at IS '생성 일시';
COMMENT ON COLUMN approval.created_by IS '생성자';
COMMENT ON COLUMN approval.updated_at IS '변경 일시';
COMMENT ON COLUMN approval.updated_by IS '변경자';
COMMENT ON COLUMN approval.version IS '낙관적 잠금';
COMMENT ON TABLE approval IS '승인 — 자산 요청·구매요청의 단계별 승인. 둘 중 하나만 채움';
CREATE INDEX ix_approval_tenant_id_approver_role_decision ON approval (tenant_id, approver_role, decision);

-- 실사 캠페인: 실물 실사 캠페인
CREATE TABLE count_campaign (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_code varchar(6) NOT NULL,
  name varchar(100) NOT NULL,
  company_id uuid NOT NULL,
  key_date date NOT NULL,
  due_date date NOT NULL,
  status campaign_status NOT NULL DEFAULT 'SCOPING',
  scope jsonb NOT NULL,
  scope_frozen_at timestamptz,
  closed_at timestamptz,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, campaign_code)
);
COMMENT ON COLUMN count_campaign.id IS '기본키';
COMMENT ON COLUMN count_campaign.tenant_id IS '테넌트';
COMMENT ON COLUMN count_campaign.campaign_code IS '코드 (예: PI26Q4) = INVZU 접두어';
COMMENT ON COLUMN count_campaign.name IS '이름';
COMMENT ON COLUMN count_campaign.company_id IS '회사코드';
COMMENT ON COLUMN count_campaign.key_date IS '기준일(SAP 키 데이트)';
COMMENT ON COLUMN count_campaign.due_date IS '기한';
COMMENT ON COLUMN count_campaign.status IS '단계';
COMMENT ON COLUMN count_campaign.scope IS '범위 조건(사이트·룸·자산클래스)';
COMMENT ON COLUMN count_campaign.scope_frozen_at IS '범위 확정 일시(count_item 생성)';
COMMENT ON COLUMN count_campaign.closed_at IS '종료 일시';
COMMENT ON COLUMN count_campaign.owner_id IS '담당 자산 관리자';
COMMENT ON COLUMN count_campaign.created_at IS '생성 일시';
COMMENT ON COLUMN count_campaign.created_by IS '생성자';
COMMENT ON COLUMN count_campaign.updated_at IS '변경 일시';
COMMENT ON COLUMN count_campaign.updated_by IS '변경자';
COMMENT ON COLUMN count_campaign.version IS '낙관적 잠금';
COMMENT ON TABLE count_campaign IS '실사 캠페인 — 실물 실사 캠페인';

-- 룸 실사 작업: 캠페인 × 룸. 실사 담당자 배정 단위
CREATE TABLE count_task (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  room_id uuid NOT NULL,
  assignee_id uuid,
  status count_task_status NOT NULL DEFAULT 'NOT_STARTED',
  expected_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, room_id)
);
COMMENT ON COLUMN count_task.id IS '기본키';
COMMENT ON COLUMN count_task.tenant_id IS '테넌트';
COMMENT ON COLUMN count_task.campaign_id IS '캠페인';
COMMENT ON COLUMN count_task.room_id IS '룸';
COMMENT ON COLUMN count_task.assignee_id IS '실사 담당자';
COMMENT ON COLUMN count_task.status IS '상태';
COMMENT ON COLUMN count_task.expected_count IS '대상 자산 수';
COMMENT ON COLUMN count_task.started_at IS '시작';
COMMENT ON COLUMN count_task.completed_at IS '룸 완료(PDA-07)';
COMMENT ON COLUMN count_task.created_at IS '생성 일시';
COMMENT ON COLUMN count_task.created_by IS '생성자';
COMMENT ON COLUMN count_task.updated_at IS '변경 일시';
COMMENT ON COLUMN count_task.updated_by IS '변경자';
COMMENT ON COLUMN count_task.version IS '낙관적 잠금';
COMMENT ON TABLE count_task IS '룸 실사 작업 — 캠페인 × 룸. 실사 담당자 배정 단위';
CREATE INDEX ix_count_task_assignee_id_status ON count_task (assignee_id, status);

-- 실사 대상: 캠페인 범위 확정 시 자산별 1행. 판정·차이 처리 결과
CREATE TABLE count_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  task_id uuid NOT NULL,
  expected_room_id uuid NOT NULL,
  result count_result NOT NULL DEFAULT 'PENDING',
  found_room_id uuid,
  condition asset_condition,
  is_user_confirmed boolean NOT NULL DEFAULT false,
  note varchar(200),
  counted_by uuid,
  counted_at timestamptz,
  needs_relabel boolean NOT NULL DEFAULT false,
  variance_action variance_action,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, asset_id)
);
COMMENT ON COLUMN count_item.id IS '기본키';
COMMENT ON COLUMN count_item.tenant_id IS '테넌트';
COMMENT ON COLUMN count_item.campaign_id IS '캠페인';
COMMENT ON COLUMN count_item.asset_id IS '자산';
COMMENT ON COLUMN count_item.task_id IS '등록 룸의 작업';
COMMENT ON COLUMN count_item.expected_room_id IS '등록 룸(확정 시점)';
COMMENT ON COLUMN count_item.result IS '판정';
COMMENT ON COLUMN count_item.found_room_id IS '발견 룸';
COMMENT ON COLUMN count_item.condition IS '정상 / 파손 / 미사용';
COMMENT ON COLUMN count_item.is_user_confirmed IS '사용자 확인';
COMMENT ON COLUMN count_item.note IS '메모';
COMMENT ON COLUMN count_item.counted_by IS '실사자';
COMMENT ON COLUMN count_item.counted_at IS '실사 일시';
COMMENT ON COLUMN count_item.needs_relabel IS '라벨 재출력 요청';
COMMENT ON COLUMN count_item.variance_action IS '차이 처리';
COMMENT ON COLUMN count_item.resolved_by IS '처리자';
COMMENT ON COLUMN count_item.resolved_at IS '처리 일시';
COMMENT ON COLUMN count_item.created_at IS '생성 일시';
COMMENT ON COLUMN count_item.created_by IS '생성자';
COMMENT ON COLUMN count_item.updated_at IS '변경 일시';
COMMENT ON COLUMN count_item.updated_by IS '변경자';
COMMENT ON COLUMN count_item.version IS '낙관적 잠금';
COMMENT ON TABLE count_item IS '실사 대상 — 캠페인 범위 확정 시 자산별 1행. 판정·차이 처리 결과';
CREATE INDEX ix_count_item_task_id ON count_item (task_id);
CREATE INDEX ix_count_item_campaign_id_result ON count_item (campaign_id, result);

-- 스캔 기록: PDA 스캔 원본. 재전송 중복은 client_scan_id로 막음
CREATE TABLE count_scan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  task_id uuid,
  room_id uuid NOT NULL,
  client_scan_id uuid NOT NULL,
  device_id uuid,
  scanned_by uuid NOT NULL,
  barcode varchar(40) NOT NULL,
  input_method varchar(10) NOT NULL,
  result scan_result NOT NULL,
  asset_id uuid,
  count_item_id uuid,
  condition asset_condition,
  note varchar(200),
  scanned_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_scan_id)
);
COMMENT ON COLUMN count_scan.id IS '기본키';
COMMENT ON COLUMN count_scan.tenant_id IS '테넌트';
COMMENT ON COLUMN count_scan.campaign_id IS '캠페인';
COMMENT ON COLUMN count_scan.task_id IS '룸 작업';
COMMENT ON COLUMN count_scan.room_id IS '스캔 위치 룸';
COMMENT ON COLUMN count_scan.client_scan_id IS 'PDA가 만든 UUID(멱등성)';
COMMENT ON COLUMN count_scan.device_id IS '기기';
COMMENT ON COLUMN count_scan.scanned_by IS '실사자';
COMMENT ON COLUMN count_scan.barcode IS '읽은 값';
COMMENT ON COLUMN count_scan.input_method IS 'TRIGGER / CAMERA / MANUAL';
COMMENT ON COLUMN count_scan.result IS '판정';
COMMENT ON COLUMN count_scan.asset_id IS '자산';
COMMENT ON COLUMN count_scan.count_item_id IS '실사 대상';
COMMENT ON COLUMN count_scan.condition IS '상태 입력';
COMMENT ON COLUMN count_scan.note IS '메모';
COMMENT ON COLUMN count_scan.scanned_at IS '기기 스캔 시각';
COMMENT ON COLUMN count_scan.received_at IS '서버 수신 시각';
COMMENT ON COLUMN count_scan.created_at IS '생성 일시';
COMMENT ON TABLE count_scan IS '스캔 기록 — PDA 스캔 원본. 재전송 중복은 client_scan_id로 막음';
CREATE INDEX ix_count_scan_campaign_id_scanned_at ON count_scan (campaign_id, scanned_at);
CREATE INDEX ix_count_scan_count_item_id ON count_scan (count_item_id);

-- 미등록 자산: 실사 중 발견한 대장 미등록 자산. 사진은 attachment
CREATE TABLE count_unregistered (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  temp_no varchar(12) NOT NULL,
  room_id uuid NOT NULL,
  category_id uuid,
  description varchar(100) NOT NULL,
  serial_no varchar(40),
  scanned_barcode varchar(40),
  client_scan_id uuid NOT NULL,
  reported_by uuid NOT NULL,
  reported_at timestamptz NOT NULL,
  resolution variance_action,
  created_asset_id uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, temp_no),
  UNIQUE (tenant_id, client_scan_id)
);
COMMENT ON COLUMN count_unregistered.id IS '기본키';
COMMENT ON COLUMN count_unregistered.tenant_id IS '테넌트';
COMMENT ON COLUMN count_unregistered.campaign_id IS '캠페인';
COMMENT ON COLUMN count_unregistered.temp_no IS '임시번호 UNREG-nnnn';
COMMENT ON COLUMN count_unregistered.room_id IS '발견 룸';
COMMENT ON COLUMN count_unregistered.category_id IS '카테고리';
COMMENT ON COLUMN count_unregistered.description IS '설명';
COMMENT ON COLUMN count_unregistered.serial_no IS '시리얼';
COMMENT ON COLUMN count_unregistered.scanned_barcode IS '읽은 값(있으면)';
COMMENT ON COLUMN count_unregistered.client_scan_id IS 'PDA UUID(멱등성)';
COMMENT ON COLUMN count_unregistered.reported_by IS '보고자';
COMMENT ON COLUMN count_unregistered.reported_at IS '보고 일시';
COMMENT ON COLUMN count_unregistered.resolution IS 'REGISTER / NON_ASSET';
COMMENT ON COLUMN count_unregistered.created_asset_id IS '등록된 자산';
COMMENT ON COLUMN count_unregistered.resolved_by IS '처리자';
COMMENT ON COLUMN count_unregistered.resolved_at IS '처리 일시';
COMMENT ON COLUMN count_unregistered.created_at IS '생성 일시';
COMMENT ON COLUMN count_unregistered.created_by IS '생성자';
COMMENT ON COLUMN count_unregistered.updated_at IS '변경 일시';
COMMENT ON COLUMN count_unregistered.updated_by IS '변경자';
COMMENT ON COLUMN count_unregistered.version IS '낙관적 잠금';
COMMENT ON TABLE count_unregistered IS '미등록 자산 — 실사 중 발견한 대장 미등록 자산. 사진은 attachment';

-- PDA 기기: 실사 기기와 마지막 동기화
CREATE TABLE pda_device (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_serial varchar(40) NOT NULL,
  model varchar(40),
  app_version varchar(20),
  last_user_id uuid,
  last_sync_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, device_serial)
);
COMMENT ON COLUMN pda_device.id IS '기본키';
COMMENT ON COLUMN pda_device.tenant_id IS '테넌트';
COMMENT ON COLUMN pda_device.device_serial IS '기기 시리얼';
COMMENT ON COLUMN pda_device.model IS '모델 (예: TC58)';
COMMENT ON COLUMN pda_device.app_version IS '앱 버전';
COMMENT ON COLUMN pda_device.last_user_id IS '마지막 사용자';
COMMENT ON COLUMN pda_device.last_sync_at IS '마지막 동기화';
COMMENT ON COLUMN pda_device.is_active IS '사용 여부';
COMMENT ON COLUMN pda_device.created_at IS '생성 일시';
COMMENT ON COLUMN pda_device.created_by IS '생성자';
COMMENT ON COLUMN pda_device.updated_at IS '변경 일시';
COMMENT ON COLUMN pda_device.updated_by IS '변경자';
COMMENT ON COLUMN pda_device.version IS '낙관적 잠금';
COMMENT ON TABLE pda_device IS 'PDA 기기 — 실사 기기와 마지막 동기화';

-- 라벨 템플릿: ZPL 라벨 템플릿
CREATE TABLE label_template (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_code varchar(20) NOT NULL,
  name varchar(60) NOT NULL,
  layout label_layout NOT NULL,
  width_in numeric(4,2) NOT NULL DEFAULT 2,
  height_in numeric(4,2) NOT NULL DEFAULT 1,
  dpi integer NOT NULL DEFAULT 203,
  zpl text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, template_code)
);
COMMENT ON COLUMN label_template.id IS '기본키';
COMMENT ON COLUMN label_template.tenant_id IS '테넌트';
COMMENT ON COLUMN label_template.template_code IS '코드';
COMMENT ON COLUMN label_template.name IS '이름';
COMMENT ON COLUMN label_template.layout IS 'QR+Code128 / QR / Code128';
COMMENT ON COLUMN label_template.width_in IS '폭(인치)';
COMMENT ON COLUMN label_template.height_in IS '높이(인치)';
COMMENT ON COLUMN label_template.dpi IS '해상도';
COMMENT ON COLUMN label_template.zpl IS 'ZPL 본문(치환 변수 포함)';
COMMENT ON COLUMN label_template.is_default IS '기본 템플릿';
COMMENT ON COLUMN label_template.is_active IS '사용 여부';
COMMENT ON COLUMN label_template.created_at IS '생성 일시';
COMMENT ON COLUMN label_template.created_by IS '생성자';
COMMENT ON COLUMN label_template.updated_at IS '변경 일시';
COMMENT ON COLUMN label_template.updated_by IS '변경자';
COMMENT ON COLUMN label_template.version IS '낙관적 잠금';
COMMENT ON TABLE label_template IS '라벨 템플릿 — ZPL 라벨 템플릿';

-- 라벨 프린터: 사이트 라벨 프린터. 출력은 PC의 Zebra Browser Print가 하고, ALM은 고르기·기록용으로만 둠(서버가 직접 연결하지 않음)
CREATE TABLE printer (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name varchar(60) NOT NULL,
  site_id uuid,
  device_name varchar(100),
  connection printer_connection NOT NULL DEFAULT 'USB',
  host varchar(100),
  dpi integer NOT NULL DEFAULT 203,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);
COMMENT ON COLUMN printer.id IS '기본키';
COMMENT ON COLUMN printer.tenant_id IS '테넌트';
COMMENT ON COLUMN printer.name IS '이름';
COMMENT ON COLUMN printer.site_id IS '사이트';
COMMENT ON COLUMN printer.device_name IS 'Browser Print가 보여 주는 장치 이름(이 이름으로 PC의 프린터를 고름)';
COMMENT ON COLUMN printer.connection IS '연결 방식(PC USB, 사내 네트워크)';
COMMENT ON COLUMN printer.host IS 'IP 또는 호스트(NETWORK일 때 참고용)';
COMMENT ON COLUMN printer.dpi IS '해상도';
COMMENT ON COLUMN printer.is_active IS '사용 여부';
COMMENT ON COLUMN printer.created_at IS '생성 일시';
COMMENT ON COLUMN printer.created_by IS '생성자';
COMMENT ON COLUMN printer.updated_at IS '변경 일시';
COMMENT ON COLUMN printer.updated_by IS '변경자';
COMMENT ON COLUMN printer.version IS '낙관적 잠금';
COMMENT ON TABLE printer IS '라벨 프린터 — 사이트 라벨 프린터. 출력은 PC의 Zebra Browser Print가 하고, ALM은 고르기·기록용으로만 둠(서버가 직접 연결하지 않음)';

-- 라벨 출력: 출력 대기열과 출력 이력
CREATE TABLE label_print_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  template_id uuid NOT NULL,
  printer_id uuid,
  source print_source NOT NULL,
  status print_status NOT NULL DEFAULT 'QUEUED',
  copies integer NOT NULL DEFAULT 1,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  rendered_by uuid,
  rendered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  printed_at timestamptz,
  client_info varchar(200),
  error_message varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN label_print_job.id IS '기본키';
COMMENT ON COLUMN label_print_job.tenant_id IS '테넌트';
COMMENT ON COLUMN label_print_job.asset_id IS '자산';
COMMENT ON COLUMN label_print_job.template_id IS '템플릿';
COMMENT ON COLUMN label_print_job.printer_id IS '프린터(출력 시 지정)';
COMMENT ON COLUMN label_print_job.source IS '요청 출처';
COMMENT ON COLUMN label_print_job.status IS '상태(QUEUED 대기 → RENDERED ZPL 발급 → PRINTED·FAILED 브라우저 회신)';
COMMENT ON COLUMN label_print_job.copies IS '매수';
COMMENT ON COLUMN label_print_job.requested_by IS '요청자';
COMMENT ON COLUMN label_print_job.requested_at IS '요청 일시';
COMMENT ON COLUMN label_print_job.rendered_by IS 'ZPL을 받아 출력한 사용자';
COMMENT ON COLUMN label_print_job.rendered_at IS 'ZPL 발급 일시';
COMMENT ON COLUMN label_print_job.attempt_count IS '출력 시도 횟수';
COMMENT ON COLUMN label_print_job.printed_at IS '출력 확인 일시(Browser Print 전송 성공)';
COMMENT ON COLUMN label_print_job.client_info IS 'Browser Print 버전·장치 이름';
COMMENT ON COLUMN label_print_job.error_message IS '오류';
COMMENT ON COLUMN label_print_job.created_at IS '생성 일시';
COMMENT ON COLUMN label_print_job.created_by IS '생성자';
COMMENT ON COLUMN label_print_job.updated_at IS '변경 일시';
COMMENT ON COLUMN label_print_job.updated_by IS '변경자';
COMMENT ON COLUMN label_print_job.version IS '낙관적 잠금';
COMMENT ON TABLE label_print_job IS '라벨 출력 — 출력 대기열과 출력 이력';
CREATE INDEX ix_label_print_job_tenant_id_status ON label_print_job (tenant_id, status);
CREATE INDEX ix_label_print_job_asset_id ON label_print_job (asset_id);

-- SAP 전기 큐: 승인 완료 건의 전기 대기열 (IF-AA-03~07, IF-MM-02). claim 시 15분 잠금
CREATE TABLE sap_posting (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  posting_id varchar(12) NOT NULL,
  posting_type posting_type NOT NULL,
  status posting_status NOT NULL DEFAULT 'READY',
  company_id uuid NOT NULL,
  asset_request_id uuid,
  purchase_request_id uuid,
  count_item_id uuid,
  asset_id uuid,
  posting_date date,
  value_date date,
  payload jsonb NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  claim_batch_id varchar(40),
  claimed_at timestamptz,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  result_at timestamptz,
  sap_document_no varchar(10),
  sap_fiscal_year integer,
  sap_asset_no varchar(12),
  sap_sub_no varchar(4),
  sap_po_no varchar(10),
  messages jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, posting_id)
);
COMMENT ON COLUMN sap_posting.id IS '기본키';
COMMENT ON COLUMN sap_posting.tenant_id IS '테넌트';
COMMENT ON COLUMN sap_posting.posting_id IS '요청번호(멱등성 키). 실사 결과는 캠페인코드-nnnnn';
COMMENT ON COLUMN sap_posting.posting_type IS '전기 유형';
COMMENT ON COLUMN sap_posting.status IS '상태';
COMMENT ON COLUMN sap_posting.company_id IS '회사코드';
COMMENT ON COLUMN sap_posting.asset_request_id IS '자산 요청';
COMMENT ON COLUMN sap_posting.purchase_request_id IS '구매요청';
COMMENT ON COLUMN sap_posting.count_item_id IS '실사 결과';
COMMENT ON COLUMN sap_posting.asset_id IS '대상 자산';
COMMENT ON COLUMN sap_posting.posting_date IS '전기일';
COMMENT ON COLUMN sap_posting.value_date IS '가치일 BZDAT';
COMMENT ON COLUMN sap_posting.payload IS '전송 봉투 payload';
COMMENT ON COLUMN sap_posting.approved_by IS '최종 승인자';
COMMENT ON COLUMN sap_posting.approved_at IS '최종 승인 일시';
COMMENT ON COLUMN sap_posting.claim_batch_id IS '가져간 SAP 배치 ID';
COMMENT ON COLUMN sap_posting.claimed_at IS '가져간 일시';
COMMENT ON COLUMN sap_posting.lease_until IS '잠금 만료';
COMMENT ON COLUMN sap_posting.attempt_count IS '시도 횟수';
COMMENT ON COLUMN sap_posting.result_at IS '결과 수신';
COMMENT ON COLUMN sap_posting.sap_document_no IS 'BELNR';
COMMENT ON COLUMN sap_posting.sap_fiscal_year IS 'GJAHR';
COMMENT ON COLUMN sap_posting.sap_asset_no IS '생성·이관된 자산번호';
COMMENT ON COLUMN sap_posting.sap_sub_no IS '보조번호';
COMMENT ON COLUMN sap_posting.sap_po_no IS '생성된 PO 번호';
COMMENT ON COLUMN sap_posting.messages IS 'BAPI RETURN 메시지';
COMMENT ON COLUMN sap_posting.created_at IS '생성 일시';
COMMENT ON COLUMN sap_posting.created_by IS '생성자';
COMMENT ON COLUMN sap_posting.updated_at IS '변경 일시';
COMMENT ON COLUMN sap_posting.updated_by IS '변경자';
COMMENT ON COLUMN sap_posting.version IS '낙관적 잠금';
COMMENT ON TABLE sap_posting IS 'SAP 전기 큐 — 승인 완료 건의 전기 대기열 (IF-AA-03~07, IF-MM-02). claim 시 15분 잠금';
CREATE INDEX ix_sap_posting_tenant_id_status_lease_until ON sap_posting (tenant_id, status, lease_until);

-- IF 실행 로그: SAP 호출 1회(배치 1건) 로그. 10년 보관
CREATE TABLE sap_if_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  interface_id varchar(10) NOT NULL,
  direction if_direction NOT NULL,
  batch_id varchar(40) NOT NULL,
  correlation_id uuid,
  sap_system varchar(10),
  http_status integer,
  record_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  status if_status NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN sap_if_run.id IS '기본키';
COMMENT ON COLUMN sap_if_run.tenant_id IS '테넌트';
COMMENT ON COLUMN sap_if_run.interface_id IS 'IF ID (예: IF-AA-01)';
COMMENT ON COLUMN sap_if_run.direction IS '데이터 방향';
COMMENT ON COLUMN sap_if_run.batch_id IS '배치 ID';
COMMENT ON COLUMN sap_if_run.correlation_id IS 'X-Correlation-Id';
COMMENT ON COLUMN sap_if_run.sap_system IS 'X-SAP-System';
COMMENT ON COLUMN sap_if_run.http_status IS '응답 코드';
COMMENT ON COLUMN sap_if_run.record_count IS '건수';
COMMENT ON COLUMN sap_if_run.success_count IS '성공';
COMMENT ON COLUMN sap_if_run.error_count IS '오류';
COMMENT ON COLUMN sap_if_run.status IS '결과';
COMMENT ON COLUMN sap_if_run.started_at IS '시작';
COMMENT ON COLUMN sap_if_run.finished_at IS '종료';
COMMENT ON COLUMN sap_if_run.created_at IS '생성 일시';
COMMENT ON TABLE sap_if_run IS 'IF 실행 로그 — SAP 호출 1회(배치 1건) 로그. 10년 보관';
CREATE INDEX ix_sap_if_run_tenant_id_interface_id_started_at ON sap_if_run (tenant_id, interface_id, started_at);

-- IF 건별 결과: IF 실행의 건별 결과. 오류 건은 원본 레코드 보관
CREATE TABLE sap_if_message (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  record_key varchar(40) NOT NULL,
  result varchar(10) NOT NULL,
  error_code varchar(12),
  message varchar(500),
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN sap_if_message.id IS '기본키';
COMMENT ON COLUMN sap_if_message.tenant_id IS '테넌트';
COMMENT ON COLUMN sap_if_message.run_id IS 'IF 실행';
COMMENT ON COLUMN sap_if_message.record_key IS '레코드 키 (예: 1000/000300001234/0000)';
COMMENT ON COLUMN sap_if_message.result IS 'OK / ERROR';
COMMENT ON COLUMN sap_if_message.error_code IS 'ALM 오류 코드 (예: ALM-E104)';
COMMENT ON COLUMN sap_if_message.message IS '메시지';
COMMENT ON COLUMN sap_if_message.payload IS '원본 레코드(오류 건만)';
COMMENT ON COLUMN sap_if_message.created_at IS '생성 일시';
COMMENT ON TABLE sap_if_message IS 'IF 건별 결과 — IF 실행의 건별 결과. 오류 건은 원본 레코드 보관';
CREATE INDEX ix_sap_if_message_run_id ON sap_if_message (run_id);
CREATE INDEX ix_sap_if_message_tenant_id_record_key ON sap_if_message (tenant_id, record_key);

-- 멱등성 키: Idempotency-Key 24시간 보관. 같은 키 재요청은 저장된 응답 반환
CREATE TABLE idempotency_key (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  endpoint varchar(80) NOT NULL,
  key varchar(80) NOT NULL,
  request_hash varchar(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint, key)
);
COMMENT ON COLUMN idempotency_key.id IS '기본키';
COMMENT ON COLUMN idempotency_key.tenant_id IS '테넌트';
COMMENT ON COLUMN idempotency_key.endpoint IS 'API 경로';
COMMENT ON COLUMN idempotency_key.key IS 'Idempotency-Key';
COMMENT ON COLUMN idempotency_key.request_hash IS '요청 본문 SHA-256';
COMMENT ON COLUMN idempotency_key.response_status IS '응답 코드';
COMMENT ON COLUMN idempotency_key.response_body IS '응답 본문';
COMMENT ON COLUMN idempotency_key.expires_at IS '만료(생성 + 24시간)';
COMMENT ON COLUMN idempotency_key.created_at IS '생성 일시';
COMMENT ON TABLE idempotency_key IS '멱등성 키 — Idempotency-Key 24시간 보관. 같은 키 재요청은 저장된 응답 반환';
CREATE INDEX ix_idempotency_key_expires_at ON idempotency_key (expires_at);

-- 대사 실행: IF-RC-01 스냅샷 1회와 대사 결과 요약
CREATE TABLE recon_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_type varchar(10) NOT NULL,
  batch_id varchar(40) NOT NULL,
  count_campaign_id uuid,
  status run_status NOT NULL DEFAULT 'RUNNING',
  snapshot_at timestamptz NOT NULL,
  sap_count integer NOT NULL DEFAULT 0,
  alm_count integer NOT NULL DEFAULT 0,
  diff_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, batch_id)
);
COMMENT ON COLUMN recon_run.id IS '기본키';
COMMENT ON COLUMN recon_run.tenant_id IS '테넌트';
COMMENT ON COLUMN recon_run.run_type IS 'WEEKLY / CAMPAIGN';
COMMENT ON COLUMN recon_run.batch_id IS 'SAP 배치 ID';
COMMENT ON COLUMN recon_run.count_campaign_id IS '실사 종료 대사';
COMMENT ON COLUMN recon_run.status IS '상태';
COMMENT ON COLUMN recon_run.snapshot_at IS '스냅샷 시각';
COMMENT ON COLUMN recon_run.sap_count IS 'SAP 자산 수';
COMMENT ON COLUMN recon_run.alm_count IS 'ALM 자본화 자산 수';
COMMENT ON COLUMN recon_run.diff_count IS '차이 수';
COMMENT ON COLUMN recon_run.created_at IS '생성 일시';
COMMENT ON COLUMN recon_run.created_by IS '생성자';
COMMENT ON COLUMN recon_run.updated_at IS '변경 일시';
COMMENT ON COLUMN recon_run.updated_by IS '변경자';
COMMENT ON COLUMN recon_run.version IS '낙관적 잠금';
COMMENT ON TABLE recon_run IS '대사 실행 — IF-RC-01 스냅샷 1회와 대사 결과 요약';

-- 대사 스냅샷: SAP 자본화 자산 스냅샷 원본(분할 수신)
CREATE TABLE recon_snapshot (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  company_code varchar(4) NOT NULL,
  sap_asset_no varchar(12) NOT NULL,
  sap_sub_no varchar(4) NOT NULL,
  inventory_no varchar(25),
  serial_no varchar(18),
  cost_center_code varchar(10),
  location varchar(10),
  room_no varchar(8),
  deact_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, company_code, sap_asset_no, sap_sub_no)
);
COMMENT ON COLUMN recon_snapshot.id IS '기본키';
COMMENT ON COLUMN recon_snapshot.tenant_id IS '테넌트';
COMMENT ON COLUMN recon_snapshot.run_id IS '대사 실행';
COMMENT ON COLUMN recon_snapshot.company_code IS 'BUKRS';
COMMENT ON COLUMN recon_snapshot.sap_asset_no IS 'ANLN1';
COMMENT ON COLUMN recon_snapshot.sap_sub_no IS 'ANLN2';
COMMENT ON COLUMN recon_snapshot.inventory_no IS 'INVNR';
COMMENT ON COLUMN recon_snapshot.serial_no IS 'SERNR';
COMMENT ON COLUMN recon_snapshot.cost_center_code IS 'KOSTL';
COMMENT ON COLUMN recon_snapshot.location IS 'STORT';
COMMENT ON COLUMN recon_snapshot.room_no IS 'RAUMNR';
COMMENT ON COLUMN recon_snapshot.deact_date IS 'DEAKT';
COMMENT ON COLUMN recon_snapshot.created_at IS '생성 일시';
COMMENT ON TABLE recon_snapshot IS '대사 스냅샷 — SAP 자본화 자산 스냅샷 원본(분할 수신)';

-- 대사 차이: 차이 1건과 조치
CREATE TABLE recon_diff (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  diff_type recon_diff_type NOT NULL,
  asset_id uuid,
  sap_asset_no varchar(12),
  sap_sub_no varchar(4),
  alm_value varchar(100),
  sap_value varchar(100),
  action recon_action NOT NULL,
  status recon_status NOT NULL DEFAULT 'OPEN',
  sap_posting_id uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN recon_diff.id IS '기본키';
COMMENT ON COLUMN recon_diff.tenant_id IS '테넌트';
COMMENT ON COLUMN recon_diff.run_id IS '대사 실행';
COMMENT ON COLUMN recon_diff.diff_type IS '차이 유형';
COMMENT ON COLUMN recon_diff.asset_id IS 'ALM 자산';
COMMENT ON COLUMN recon_diff.sap_asset_no IS 'ANLN1';
COMMENT ON COLUMN recon_diff.sap_sub_no IS 'ANLN2';
COMMENT ON COLUMN recon_diff.alm_value IS 'ALM 값';
COMMENT ON COLUMN recon_diff.sap_value IS 'SAP 값';
COMMENT ON COLUMN recon_diff.action IS '조치(기본값은 규칙으로 제안)';
COMMENT ON COLUMN recon_diff.status IS '처리 상태';
COMMENT ON COLUMN recon_diff.sap_posting_id IS 'ALM 값 전송 시 전기 건';
COMMENT ON COLUMN recon_diff.resolved_by IS '처리자';
COMMENT ON COLUMN recon_diff.resolved_at IS '처리 일시';
COMMENT ON COLUMN recon_diff.created_at IS '생성 일시';
COMMENT ON COLUMN recon_diff.created_by IS '생성자';
COMMENT ON COLUMN recon_diff.updated_at IS '변경 일시';
COMMENT ON COLUMN recon_diff.updated_by IS '변경자';
COMMENT ON COLUMN recon_diff.version IS '낙관적 잠금';
COMMENT ON TABLE recon_diff IS '대사 차이 — 차이 1건과 조치';
CREATE INDEX ix_recon_diff_run_id_status ON recon_diff (run_id, status);

-- 필드 매핑: ALM 필드 ↔ SAP 필드와 기준 시스템(F-310-06)
CREATE TABLE field_mapping (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  alm_field varchar(60) NOT NULL,
  sap_table varchar(30),
  sap_field varchar(30),
  master_system master_system NOT NULL,
  interface_ids varchar(100),
  description varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, alm_field)
);
COMMENT ON COLUMN field_mapping.id IS '기본키';
COMMENT ON COLUMN field_mapping.tenant_id IS '테넌트';
COMMENT ON COLUMN field_mapping.alm_field IS 'ALM 테이블.컬럼';
COMMENT ON COLUMN field_mapping.sap_table IS 'SAP 테이블';
COMMENT ON COLUMN field_mapping.sap_field IS 'SAP 필드';
COMMENT ON COLUMN field_mapping.master_system IS '기준 시스템';
COMMENT ON COLUMN field_mapping.interface_ids IS '사용 IF';
COMMENT ON COLUMN field_mapping.description IS '설명';
COMMENT ON COLUMN field_mapping.created_at IS '생성 일시';
COMMENT ON COLUMN field_mapping.created_by IS '생성자';
COMMENT ON COLUMN field_mapping.updated_at IS '변경 일시';
COMMENT ON COLUMN field_mapping.updated_by IS '변경자';
COMMENT ON COLUMN field_mapping.version IS '낙관적 잠금';
COMMENT ON TABLE field_mapping IS '필드 매핑 — ALM 필드 ↔ SAP 필드와 기준 시스템(F-310-06)';

-- SAP 연결: SAP 시스템과 API 클라이언트. 비밀은 Secrets Manager
CREATE TABLE sap_connection (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  system_id varchar(10) NOT NULL,
  company_id uuid NOT NULL,
  oauth_client_id varchar(100) NOT NULL,
  last_call_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  allowed_cidrs jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, system_id, company_id),
  UNIQUE (oauth_client_id)
);
COMMENT ON COLUMN sap_connection.id IS '기본키';
COMMENT ON COLUMN sap_connection.tenant_id IS '테넌트';
COMMENT ON COLUMN sap_connection.system_id IS '시스템 ID-클라이언트 (예: PRD-100)';
COMMENT ON COLUMN sap_connection.company_id IS '회사코드';
COMMENT ON COLUMN sap_connection.oauth_client_id IS 'OAuth 클라이언트 ID';
COMMENT ON COLUMN sap_connection.last_call_at IS '마지막 호출';
COMMENT ON COLUMN sap_connection.is_active IS '사용 여부';
COMMENT ON COLUMN sap_connection.allowed_cidrs IS 'SAP 출구 IP 대역(예: ["203.0.113.10/32"]). 비면 WAF 전역 목록만 적용';
COMMENT ON COLUMN sap_connection.created_at IS '생성 일시';
COMMENT ON COLUMN sap_connection.created_by IS '생성자';
COMMENT ON COLUMN sap_connection.updated_at IS '변경 일시';
COMMENT ON COLUMN sap_connection.updated_by IS '변경자';
COMMENT ON COLUMN sap_connection.version IS '낙관적 잠금';
COMMENT ON TABLE sap_connection IS 'SAP 연결 — SAP 시스템과 API 클라이언트. 비밀은 Secrets Manager';

-- SAP 실행 요청: 화면의 수동 실행 요청(F-310-04). SAP 잡이 GET /sap/run-requests로 가져가 실행
CREATE TABLE sap_run_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  interface_id varchar(10) NOT NULL,
  params jsonb,
  status varchar(10) NOT NULL DEFAULT 'PENDING',
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  picked_at timestamptz,
  sap_if_run_id uuid,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN sap_run_request.id IS '기본키';
COMMENT ON COLUMN sap_run_request.tenant_id IS '테넌트';
COMMENT ON COLUMN sap_run_request.interface_id IS '실행할 수신 IF (IF-MD-01, IF-AA-01, IF-AA-02, IF-MM-01, IF-RC-01)';
COMMENT ON COLUMN sap_run_request.params IS '실행 조건 (IF-RC-01: runType, campaignCode / IF-AA-02: isClosing)';
COMMENT ON COLUMN sap_run_request.status IS 'PENDING / PICKED / DONE / CANCELLED';
COMMENT ON COLUMN sap_run_request.requested_by IS '요청자';
COMMENT ON COLUMN sap_run_request.requested_at IS '요청 일시';
COMMENT ON COLUMN sap_run_request.picked_at IS 'SAP이 가져간 일시';
COMMENT ON COLUMN sap_run_request.sap_if_run_id IS '실행 결과 로그';
COMMENT ON COLUMN sap_run_request.done_at IS '완료 일시';
COMMENT ON COLUMN sap_run_request.created_at IS '생성 일시';
COMMENT ON COLUMN sap_run_request.created_by IS '생성자';
COMMENT ON COLUMN sap_run_request.updated_at IS '변경 일시';
COMMENT ON COLUMN sap_run_request.updated_by IS '변경자';
COMMENT ON COLUMN sap_run_request.version IS '낙관적 잠금';
COMMENT ON TABLE sap_run_request IS 'SAP 실행 요청 — 화면의 수동 실행 요청(F-310-04). SAP 잡이 GET /sap/run-requests로 가져가 실행';
CREATE INDEX ix_sap_run_request_tenant_id_status ON sap_run_request (tenant_id, status);

-- 공통 코드: 고객이 바꾸는 코드값(폐기 사유, 실사 비고 등)
CREATE TABLE code (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  code_group varchar(30) NOT NULL,
  code varchar(30) NOT NULL,
  label_en varchar(100) NOT NULL,
  label_ko varchar(100),
  sort_order integer NOT NULL DEFAULT 0,
  attributes jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code_group, code)
);
COMMENT ON COLUMN code.id IS '기본키';
COMMENT ON COLUMN code.tenant_id IS '테넌트';
COMMENT ON COLUMN code.code_group IS '코드 그룹';
COMMENT ON COLUMN code.code IS '코드';
COMMENT ON COLUMN code.label_en IS '영문 이름';
COMMENT ON COLUMN code.label_ko IS '한글 이름';
COMMENT ON COLUMN code.sort_order IS '정렬 순서';
COMMENT ON COLUMN code.attributes IS '추가 속성';
COMMENT ON COLUMN code.is_active IS '사용 여부';
COMMENT ON COLUMN code.created_at IS '생성 일시';
COMMENT ON COLUMN code.created_by IS '생성자';
COMMENT ON COLUMN code.updated_at IS '변경 일시';
COMMENT ON COLUMN code.updated_by IS '변경자';
COMMENT ON COLUMN code.version IS '낙관적 잠금';
COMMENT ON TABLE code IS '공통 코드 — 고객이 바꾸는 코드값(폐기 사유, 실사 비고 등)';

-- 설정: 테넌트 설정값 (예: 라이선스 과잉 기준 80%, 자본화 기준금액)
CREATE TABLE setting (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  key varchar(60) NOT NULL,
  value jsonb NOT NULL,
  description varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);
COMMENT ON COLUMN setting.id IS '기본키';
COMMENT ON COLUMN setting.tenant_id IS '테넌트';
COMMENT ON COLUMN setting.key IS '설정 키';
COMMENT ON COLUMN setting.value IS '값';
COMMENT ON COLUMN setting.description IS '설명';
COMMENT ON COLUMN setting.created_at IS '생성 일시';
COMMENT ON COLUMN setting.created_by IS '생성자';
COMMENT ON COLUMN setting.updated_at IS '변경 일시';
COMMENT ON COLUMN setting.updated_by IS '변경자';
COMMENT ON COLUMN setting.version IS '낙관적 잠금';
COMMENT ON TABLE setting IS '설정 — 테넌트 설정값 (예: 라이선스 과잉 기준 80%, 자본화 기준금액)';

-- 채번: 업무 번호 채번(AT-, AR-, PR-, UNREG-). 행 잠금으로 증가
CREATE TABLE number_sequence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  seq_name varchar(30) NOT NULL,
  prefix varchar(10) NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  padding integer NOT NULL DEFAULT 6,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, seq_name)
);
COMMENT ON COLUMN number_sequence.id IS '기본키';
COMMENT ON COLUMN number_sequence.tenant_id IS '테넌트';
COMMENT ON COLUMN number_sequence.seq_name IS 'ASSET_TAG / ASSET_REQUEST / PURCHASE_REQUEST / UNREG';
COMMENT ON COLUMN number_sequence.prefix IS '접두어 (예: AT-)';
COMMENT ON COLUMN number_sequence.next_value IS '다음 번호';
COMMENT ON COLUMN number_sequence.padding IS '자릿수';
COMMENT ON COLUMN number_sequence.created_at IS '생성 일시';
COMMENT ON COLUMN number_sequence.created_by IS '생성자';
COMMENT ON COLUMN number_sequence.updated_at IS '변경 일시';
COMMENT ON COLUMN number_sequence.updated_by IS '변경자';
COMMENT ON COLUMN number_sequence.version IS '낙관적 잠금';
COMMENT ON TABLE number_sequence IS '채번 — 업무 번호 채번(AT-, AR-, PR-, UNREG-). 행 잠금으로 증가';

-- 첨부: 사진·문서. 파일은 S3, 메타만 저장
CREATE TABLE attachment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_type varchar(30) NOT NULL,
  owner_id uuid,
  kind varchar(20) NOT NULL DEFAULT 'DOCUMENT',
  file_name varchar(200) NOT NULL,
  content_type varchar(100) NOT NULL,
  size_bytes bigint NOT NULL,
  s3_key varchar(500) NOT NULL,
  sha256 varchar(64),
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN attachment.id IS '기본키';
COMMENT ON COLUMN attachment.tenant_id IS '테넌트';
COMMENT ON COLUMN attachment.owner_type IS '대상 테이블 (asset, count_item, count_unregistered, asset_request, contract)';
COMMENT ON COLUMN attachment.owner_id IS '대상 행 id. PDA 사진은 업로드 직후 비어 있음';
COMMENT ON COLUMN attachment.kind IS 'PHOTO / DOCUMENT';
COMMENT ON COLUMN attachment.file_name IS '파일명';
COMMENT ON COLUMN attachment.content_type IS 'MIME';
COMMENT ON COLUMN attachment.size_bytes IS '크기';
COMMENT ON COLUMN attachment.s3_key IS 'S3 객체 키';
COMMENT ON COLUMN attachment.sha256 IS '해시';
COMMENT ON COLUMN attachment.linked_at IS '대상 연결 일시. 비어 있으면 업로드 대기(24시간 뒤 정리)';
COMMENT ON COLUMN attachment.created_at IS '생성 일시';
COMMENT ON COLUMN attachment.created_by IS '생성자';
COMMENT ON COLUMN attachment.updated_at IS '변경 일시';
COMMENT ON COLUMN attachment.updated_by IS '변경자';
COMMENT ON COLUMN attachment.version IS '낙관적 잠금';
COMMENT ON TABLE attachment IS '첨부 — 사진·문서. 파일은 S3, 메타만 저장';
CREATE INDEX ix_attachment_tenant_id_owner_type_owner_id ON attachment (tenant_id, owner_type, owner_id);

-- 알림: 이메일·화면 알림 발송 기록
CREATE TABLE notification (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel notification_channel NOT NULL,
  recipient_id uuid,
  recipient_email varchar(254),
  template varchar(40) NOT NULL,
  subject_type varchar(30),
  subject_id uuid,
  title varchar(200) NOT NULL,
  status notification_status NOT NULL DEFAULT 'QUEUED',
  sent_at timestamptz,
  error_message varchar(500),
  dedupe_key varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, dedupe_key)
);
COMMENT ON COLUMN notification.id IS '기본키';
COMMENT ON COLUMN notification.tenant_id IS '테넌트';
COMMENT ON COLUMN notification.channel IS '채널';
COMMENT ON COLUMN notification.recipient_id IS '수신자';
COMMENT ON COLUMN notification.recipient_email IS '수신 이메일';
COMMENT ON COLUMN notification.template IS '템플릿 (예: CONTRACT_EXPIRY_90)';
COMMENT ON COLUMN notification.subject_type IS '대상 테이블';
COMMENT ON COLUMN notification.subject_id IS '대상 행 id';
COMMENT ON COLUMN notification.title IS '제목';
COMMENT ON COLUMN notification.status IS '상태';
COMMENT ON COLUMN notification.sent_at IS '발송 일시';
COMMENT ON COLUMN notification.error_message IS '오류';
COMMENT ON COLUMN notification.dedupe_key IS '중복 발송 방지 키';
COMMENT ON COLUMN notification.created_at IS '생성 일시';
COMMENT ON COLUMN notification.created_by IS '생성자';
COMMENT ON COLUMN notification.updated_at IS '변경 일시';
COMMENT ON COLUMN notification.updated_by IS '변경자';
COMMENT ON COLUMN notification.version IS '낙관적 잠금';
COMMENT ON TABLE notification IS '알림 — 이메일·화면 알림 발송 기록';
CREATE INDEX ix_notification_recipient_id_status ON notification (recipient_id, status);

-- 감사 로그: 업무 테이블의 생성·변경·삭제 전후값(DB 트리거가 기록). 10년 보관, 월 파티션
CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  table_name varchar(63) NOT NULL,
  row_id uuid NOT NULL,
  action audit_action NOT NULL,
  before jsonb,
  after jsonb,
  actor_id uuid,
  actor_type varchar(10) NOT NULL,
  correlation_id uuid,
  ip_address inet,
  db_user varchar(63) NOT NULL,
  tx_id bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN audit_log.id IS '기본키';
COMMENT ON COLUMN audit_log.tenant_id IS '테넌트';
COMMENT ON COLUMN audit_log.table_name IS '테이블';
COMMENT ON COLUMN audit_log.row_id IS '행 id';
COMMENT ON COLUMN audit_log.action IS '동작';
COMMENT ON COLUMN audit_log.before IS '변경 전';
COMMENT ON COLUMN audit_log.after IS '변경 후';
COMMENT ON COLUMN audit_log.actor_id IS '사용자 id(FK 없음, 사용자 삭제 대비)';
COMMENT ON COLUMN audit_log.actor_type IS 'USER / SYSTEM / SAP / PDA';
COMMENT ON COLUMN audit_log.correlation_id IS '요청 추적 ID';
COMMENT ON COLUMN audit_log.ip_address IS '접속 IP';
COMMENT ON COLUMN audit_log.db_user IS '실제 DB 로그인 계정(session_user). 앱 계정이 아닌 직접 수정 식별';
COMMENT ON COLUMN audit_log.tx_id IS 'DB 트랜잭션 ID(같은 트랜잭션 변경 묶음)';
COMMENT ON COLUMN audit_log.occurred_at IS '발생 일시';
COMMENT ON COLUMN audit_log.created_at IS '생성 일시';
COMMENT ON TABLE audit_log IS '감사 로그 — 업무 테이블의 생성·변경·삭제 전후값(DB 트리거가 기록). 10년 보관, 월 파티션';
CREATE INDEX ix_audit_log_tenant_id_table_name_row_id ON audit_log (tenant_id, table_name, row_id);
CREATE INDEX ix_audit_log_tenant_id_occurred_at ON audit_log (tenant_id, occurred_at);

-- 보안 이벤트: 로그인·권한 거부·내보내기·비밀 교체 등. 10년 보관, 월 파티션. 테넌트를 알 수 없는 로그인 실패는 CloudWatch에만
CREATE TABLE security_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_type security_event_type NOT NULL,
  actor_id uuid,
  actor_type varchar(10) NOT NULL,
  channel varchar(5) NOT NULL,
  client_id varchar(100),
  ip_address inet,
  user_agent varchar(300),
  target varchar(200),
  detail jsonb,
  correlation_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN security_event.id IS '기본키';
COMMENT ON COLUMN security_event.tenant_id IS '테넌트';
COMMENT ON COLUMN security_event.event_type IS '이벤트';
COMMENT ON COLUMN security_event.actor_id IS '사용자 id(FK 없음)';
COMMENT ON COLUMN security_event.actor_type IS 'USER / SYSTEM / SAP / PDA';
COMMENT ON COLUMN security_event.channel IS 'WEB / PDA / SAP';
COMMENT ON COLUMN security_event.client_id IS 'Cognito 앱 클라이언트 ID';
COMMENT ON COLUMN security_event.ip_address IS '접속 IP';
COMMENT ON COLUMN security_event.user_agent IS '브라우저·앱 정보';
COMMENT ON COLUMN security_event.target IS '대상(API 경로, 사용자 id, 연결 id 등)';
COMMENT ON COLUMN security_event.detail IS '상세(거부 사유, 권한 키, 내보내기 행 수 등)';
COMMENT ON COLUMN security_event.correlation_id IS '요청 추적 ID';
COMMENT ON COLUMN security_event.occurred_at IS '발생 일시';
COMMENT ON COLUMN security_event.created_at IS '생성 일시';
COMMENT ON TABLE security_event IS '보안 이벤트 — 로그인·권한 거부·내보내기·비밀 교체 등. 10년 보관, 월 파티션. 테넌트를 알 수 없는 로그인 실패는 CloudWatch에만';
CREATE INDEX ix_security_event_tenant_id_occurred_at ON security_event (tenant_id, occurred_at);
CREATE INDEX ix_security_event_tenant_id_event_type_occurred_at ON security_event (tenant_id, event_type, occurred_at);

ALTER TABLE tenant_domain ADD CONSTRAINT fk_tenant_domain_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE app_user ADD CONSTRAINT fk_app_user_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE app_user ADD CONSTRAINT fk_app_user_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE user_role ADD CONSTRAINT fk_user_role_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE user_role ADD CONSTRAINT fk_user_role_user_id FOREIGN KEY (user_id) REFERENCES app_user(id);
ALTER TABLE user_role ADD CONSTRAINT fk_user_role_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE user_role ADD CONSTRAINT fk_user_role_site_id FOREIGN KEY (site_id) REFERENCES site(id);
ALTER TABLE user_role ADD CONSTRAINT fk_user_role_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE company ADD CONSTRAINT fk_company_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE plant ADD CONSTRAINT fk_plant_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE plant ADD CONSTRAINT fk_plant_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE profit_center ADD CONSTRAINT fk_profit_center_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE cost_center ADD CONSTRAINT fk_cost_center_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE cost_center ADD CONSTRAINT fk_cost_center_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE cost_center ADD CONSTRAINT fk_cost_center_profit_center_id FOREIGN KEY (profit_center_id) REFERENCES profit_center(id);
ALTER TABLE asset_class ADD CONSTRAINT fk_asset_class_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE site ADD CONSTRAINT fk_site_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE site ADD CONSTRAINT fk_site_plant_id FOREIGN KEY (plant_id) REFERENCES plant(id);
ALTER TABLE room ADD CONSTRAINT fk_room_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE room ADD CONSTRAINT fk_room_site_id FOREIGN KEY (site_id) REFERENCES site(id);
ALTER TABLE category ADD CONSTRAINT fk_category_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE category ADD CONSTRAINT fk_category_parent_id FOREIGN KEY (parent_id) REFERENCES category(id);
ALTER TABLE category ADD CONSTRAINT fk_category_default_asset_class_id FOREIGN KEY (default_asset_class_id) REFERENCES asset_class(id);
ALTER TABLE model ADD CONSTRAINT fk_model_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE model ADD CONSTRAINT fk_model_category_id FOREIGN KEY (category_id) REFERENCES category(id);
ALTER TABLE vendor ADD CONSTRAINT fk_vendor_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_category_id FOREIGN KEY (category_id) REFERENCES category(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_model_id FOREIGN KEY (model_id) REFERENCES model(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_site_id FOREIGN KEY (site_id) REFERENCES site(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_room_id FOREIGN KEY (room_id) REFERENCES room(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_assigned_user_id FOREIGN KEY (assigned_user_id) REFERENCES app_user(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_asset_class_id FOREIGN KEY (asset_class_id) REFERENCES asset_class(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_po_item_id FOREIGN KEY (po_item_id) REFERENCES po_item(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_goods_receipt_id FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipt(id);
ALTER TABLE asset ADD CONSTRAINT fk_asset_parent_asset_id FOREIGN KEY (parent_asset_id) REFERENCES asset(id);
ALTER TABLE asset_value ADD CONSTRAINT fk_asset_value_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset_value ADD CONSTRAINT fk_asset_value_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE asset_assignment ADD CONSTRAINT fk_asset_assignment_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset_assignment ADD CONSTRAINT fk_asset_assignment_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE asset_assignment ADD CONSTRAINT fk_asset_assignment_user_id FOREIGN KEY (user_id) REFERENCES app_user(id);
ALTER TABLE asset_assignment ADD CONSTRAINT fk_asset_assignment_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE asset_assignment ADD CONSTRAINT fk_asset_assignment_room_id FOREIGN KEY (room_id) REFERENCES room(id);
ALTER TABLE asset_event ADD CONSTRAINT fk_asset_event_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset_event ADD CONSTRAINT fk_asset_event_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE asset_event ADD CONSTRAINT fk_asset_event_actor_id FOREIGN KEY (actor_id) REFERENCES app_user(id);
ALTER TABLE asset_event ADD CONSTRAINT fk_asset_event_asset_request_id FOREIGN KEY (asset_request_id) REFERENCES asset_request(id);
ALTER TABLE asset_event ADD CONSTRAINT fk_asset_event_count_campaign_id FOREIGN KEY (count_campaign_id) REFERENCES count_campaign(id);
ALTER TABLE discovery_job ADD CONSTRAINT fk_discovery_job_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE discovery_job ADD CONSTRAINT fk_discovery_job_site_id FOREIGN KEY (site_id) REFERENCES site(id);
ALTER TABLE discovery_run ADD CONSTRAINT fk_discovery_run_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE discovery_run ADD CONSTRAINT fk_discovery_run_job_id FOREIGN KEY (job_id) REFERENCES discovery_job(id);
ALTER TABLE discovery_item ADD CONSTRAINT fk_discovery_item_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE discovery_item ADD CONSTRAINT fk_discovery_item_run_id FOREIGN KEY (run_id) REFERENCES discovery_run(id);
ALTER TABLE discovery_item ADD CONSTRAINT fk_discovery_item_matched_asset_id FOREIGN KEY (matched_asset_id) REFERENCES asset(id);
ALTER TABLE discovery_item ADD CONSTRAINT fk_discovery_item_resolved_by FOREIGN KEY (resolved_by) REFERENCES app_user(id);
ALTER TABLE config_item ADD CONSTRAINT fk_config_item_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE config_item ADD CONSTRAINT fk_config_item_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE config_item ADD CONSTRAINT fk_config_item_owner_user_id FOREIGN KEY (owner_user_id) REFERENCES app_user(id);
ALTER TABLE ci_relation ADD CONSTRAINT fk_ci_relation_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE ci_relation ADD CONSTRAINT fk_ci_relation_source_ci_id FOREIGN KEY (source_ci_id) REFERENCES config_item(id);
ALTER TABLE ci_relation ADD CONSTRAINT fk_ci_relation_target_ci_id FOREIGN KEY (target_ci_id) REFERENCES config_item(id);
ALTER TABLE ticket_link ADD CONSTRAINT fk_ticket_link_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE ticket_link ADD CONSTRAINT fk_ticket_link_config_item_id FOREIGN KEY (config_item_id) REFERENCES config_item(id);
ALTER TABLE software_product ADD CONSTRAINT fk_software_product_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE license ADD CONSTRAINT fk_license_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE license ADD CONSTRAINT fk_license_product_id FOREIGN KEY (product_id) REFERENCES software_product(id);
ALTER TABLE license ADD CONSTRAINT fk_license_contract_id FOREIGN KEY (contract_id) REFERENCES contract(id);
ALTER TABLE license_assignment ADD CONSTRAINT fk_license_assignment_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE license_assignment ADD CONSTRAINT fk_license_assignment_license_id FOREIGN KEY (license_id) REFERENCES license(id);
ALTER TABLE license_assignment ADD CONSTRAINT fk_license_assignment_user_id FOREIGN KEY (user_id) REFERENCES app_user(id);
ALTER TABLE license_assignment ADD CONSTRAINT fk_license_assignment_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE software_install ADD CONSTRAINT fk_software_install_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE software_install ADD CONSTRAINT fk_software_install_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE software_install ADD CONSTRAINT fk_software_install_product_id FOREIGN KEY (product_id) REFERENCES software_product(id);
ALTER TABLE contract ADD CONSTRAINT fk_contract_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE contract ADD CONSTRAINT fk_contract_vendor_id FOREIGN KEY (vendor_id) REFERENCES vendor(id);
ALTER TABLE contract ADD CONSTRAINT fk_contract_owner_user_id FOREIGN KEY (owner_user_id) REFERENCES app_user(id);
ALTER TABLE contract_asset ADD CONSTRAINT fk_contract_asset_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE contract_asset ADD CONSTRAINT fk_contract_asset_contract_id FOREIGN KEY (contract_id) REFERENCES contract(id);
ALTER TABLE contract_asset ADD CONSTRAINT fk_contract_asset_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_requester_id FOREIGN KEY (requester_id) REFERENCES app_user(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_license_id FOREIGN KEY (license_id) REFERENCES license(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_contract_id FOREIGN KEY (contract_id) REFERENCES contract(id);
ALTER TABLE purchase_request ADD CONSTRAINT fk_purchase_request_vendor_id FOREIGN KEY (vendor_id) REFERENCES vendor(id);
ALTER TABLE purchase_request_item ADD CONSTRAINT fk_purchase_request_item_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE purchase_request_item ADD CONSTRAINT fk_purchase_request_item_request_id FOREIGN KEY (request_id) REFERENCES purchase_request(id);
ALTER TABLE purchase_request_item ADD CONSTRAINT fk_purchase_request_item_category_id FOREIGN KEY (category_id) REFERENCES category(id);
ALTER TABLE purchase_request_item ADD CONSTRAINT fk_purchase_request_item_model_id FOREIGN KEY (model_id) REFERENCES model(id);
ALTER TABLE purchase_request_item ADD CONSTRAINT fk_purchase_request_item_asset_class_id FOREIGN KEY (asset_class_id) REFERENCES asset_class(id);
ALTER TABLE po_item ADD CONSTRAINT fk_po_item_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE po_item ADD CONSTRAINT fk_po_item_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE po_item ADD CONSTRAINT fk_po_item_vendor_id FOREIGN KEY (vendor_id) REFERENCES vendor(id);
ALTER TABLE po_item ADD CONSTRAINT fk_po_item_cost_center_id FOREIGN KEY (cost_center_id) REFERENCES cost_center(id);
ALTER TABLE po_item ADD CONSTRAINT fk_po_item_purchase_request_id FOREIGN KEY (purchase_request_id) REFERENCES purchase_request(id);
ALTER TABLE po_item_asset ADD CONSTRAINT fk_po_item_asset_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE po_item_asset ADD CONSTRAINT fk_po_item_asset_po_item_id FOREIGN KEY (po_item_id) REFERENCES po_item(id);
ALTER TABLE po_item_asset ADD CONSTRAINT fk_po_item_asset_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE goods_receipt ADD CONSTRAINT fk_goods_receipt_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE goods_receipt ADD CONSTRAINT fk_goods_receipt_po_item_id FOREIGN KEY (po_item_id) REFERENCES po_item(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_requester_id FOREIGN KEY (requester_id) REFERENCES app_user(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_asset_class_id FOREIGN KEY (asset_class_id) REFERENCES asset_class(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_po_item_id FOREIGN KEY (po_item_id) REFERENCES po_item(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_target_cost_center_id FOREIGN KEY (target_cost_center_id) REFERENCES cost_center(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_target_room_id FOREIGN KEY (target_room_id) REFERENCES room(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_count_item_id FOREIGN KEY (count_item_id) REFERENCES count_item(id);
ALTER TABLE asset_request ADD CONSTRAINT fk_asset_request_recon_diff_id FOREIGN KEY (recon_diff_id) REFERENCES recon_diff(id);
ALTER TABLE approval ADD CONSTRAINT fk_approval_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE approval ADD CONSTRAINT fk_approval_asset_request_id FOREIGN KEY (asset_request_id) REFERENCES asset_request(id);
ALTER TABLE approval ADD CONSTRAINT fk_approval_purchase_request_id FOREIGN KEY (purchase_request_id) REFERENCES purchase_request(id);
ALTER TABLE approval ADD CONSTRAINT fk_approval_approver_id FOREIGN KEY (approver_id) REFERENCES app_user(id);
ALTER TABLE count_campaign ADD CONSTRAINT fk_count_campaign_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE count_campaign ADD CONSTRAINT fk_count_campaign_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE count_campaign ADD CONSTRAINT fk_count_campaign_owner_id FOREIGN KEY (owner_id) REFERENCES app_user(id);
ALTER TABLE count_task ADD CONSTRAINT fk_count_task_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE count_task ADD CONSTRAINT fk_count_task_campaign_id FOREIGN KEY (campaign_id) REFERENCES count_campaign(id);
ALTER TABLE count_task ADD CONSTRAINT fk_count_task_room_id FOREIGN KEY (room_id) REFERENCES room(id);
ALTER TABLE count_task ADD CONSTRAINT fk_count_task_assignee_id FOREIGN KEY (assignee_id) REFERENCES app_user(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_campaign_id FOREIGN KEY (campaign_id) REFERENCES count_campaign(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_task_id FOREIGN KEY (task_id) REFERENCES count_task(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_expected_room_id FOREIGN KEY (expected_room_id) REFERENCES room(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_found_room_id FOREIGN KEY (found_room_id) REFERENCES room(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_counted_by FOREIGN KEY (counted_by) REFERENCES app_user(id);
ALTER TABLE count_item ADD CONSTRAINT fk_count_item_resolved_by FOREIGN KEY (resolved_by) REFERENCES app_user(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_campaign_id FOREIGN KEY (campaign_id) REFERENCES count_campaign(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_task_id FOREIGN KEY (task_id) REFERENCES count_task(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_room_id FOREIGN KEY (room_id) REFERENCES room(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_device_id FOREIGN KEY (device_id) REFERENCES pda_device(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_scanned_by FOREIGN KEY (scanned_by) REFERENCES app_user(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE count_scan ADD CONSTRAINT fk_count_scan_count_item_id FOREIGN KEY (count_item_id) REFERENCES count_item(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_campaign_id FOREIGN KEY (campaign_id) REFERENCES count_campaign(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_room_id FOREIGN KEY (room_id) REFERENCES room(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_category_id FOREIGN KEY (category_id) REFERENCES category(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_reported_by FOREIGN KEY (reported_by) REFERENCES app_user(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_created_asset_id FOREIGN KEY (created_asset_id) REFERENCES asset(id);
ALTER TABLE count_unregistered ADD CONSTRAINT fk_count_unregistered_resolved_by FOREIGN KEY (resolved_by) REFERENCES app_user(id);
ALTER TABLE pda_device ADD CONSTRAINT fk_pda_device_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE pda_device ADD CONSTRAINT fk_pda_device_last_user_id FOREIGN KEY (last_user_id) REFERENCES app_user(id);
ALTER TABLE label_template ADD CONSTRAINT fk_label_template_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE printer ADD CONSTRAINT fk_printer_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE printer ADD CONSTRAINT fk_printer_site_id FOREIGN KEY (site_id) REFERENCES site(id);
ALTER TABLE label_print_job ADD CONSTRAINT fk_label_print_job_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE label_print_job ADD CONSTRAINT fk_label_print_job_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE label_print_job ADD CONSTRAINT fk_label_print_job_template_id FOREIGN KEY (template_id) REFERENCES label_template(id);
ALTER TABLE label_print_job ADD CONSTRAINT fk_label_print_job_printer_id FOREIGN KEY (printer_id) REFERENCES printer(id);
ALTER TABLE label_print_job ADD CONSTRAINT fk_label_print_job_requested_by FOREIGN KEY (requested_by) REFERENCES app_user(id);
ALTER TABLE label_print_job ADD CONSTRAINT fk_label_print_job_rendered_by FOREIGN KEY (rendered_by) REFERENCES app_user(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_asset_request_id FOREIGN KEY (asset_request_id) REFERENCES asset_request(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_purchase_request_id FOREIGN KEY (purchase_request_id) REFERENCES purchase_request(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_count_item_id FOREIGN KEY (count_item_id) REFERENCES count_item(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE sap_posting ADD CONSTRAINT fk_sap_posting_approved_by FOREIGN KEY (approved_by) REFERENCES app_user(id);
ALTER TABLE sap_if_run ADD CONSTRAINT fk_sap_if_run_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE sap_if_message ADD CONSTRAINT fk_sap_if_message_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE sap_if_message ADD CONSTRAINT fk_sap_if_message_run_id FOREIGN KEY (run_id) REFERENCES sap_if_run(id);
ALTER TABLE idempotency_key ADD CONSTRAINT fk_idempotency_key_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE recon_run ADD CONSTRAINT fk_recon_run_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE recon_run ADD CONSTRAINT fk_recon_run_count_campaign_id FOREIGN KEY (count_campaign_id) REFERENCES count_campaign(id);
ALTER TABLE recon_snapshot ADD CONSTRAINT fk_recon_snapshot_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE recon_snapshot ADD CONSTRAINT fk_recon_snapshot_run_id FOREIGN KEY (run_id) REFERENCES recon_run(id);
ALTER TABLE recon_diff ADD CONSTRAINT fk_recon_diff_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE recon_diff ADD CONSTRAINT fk_recon_diff_run_id FOREIGN KEY (run_id) REFERENCES recon_run(id);
ALTER TABLE recon_diff ADD CONSTRAINT fk_recon_diff_asset_id FOREIGN KEY (asset_id) REFERENCES asset(id);
ALTER TABLE recon_diff ADD CONSTRAINT fk_recon_diff_sap_posting_id FOREIGN KEY (sap_posting_id) REFERENCES sap_posting(id);
ALTER TABLE recon_diff ADD CONSTRAINT fk_recon_diff_resolved_by FOREIGN KEY (resolved_by) REFERENCES app_user(id);
ALTER TABLE field_mapping ADD CONSTRAINT fk_field_mapping_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE sap_connection ADD CONSTRAINT fk_sap_connection_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE sap_connection ADD CONSTRAINT fk_sap_connection_company_id FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE sap_run_request ADD CONSTRAINT fk_sap_run_request_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE sap_run_request ADD CONSTRAINT fk_sap_run_request_requested_by FOREIGN KEY (requested_by) REFERENCES app_user(id);
ALTER TABLE sap_run_request ADD CONSTRAINT fk_sap_run_request_sap_if_run_id FOREIGN KEY (sap_if_run_id) REFERENCES sap_if_run(id);
ALTER TABLE code ADD CONSTRAINT fk_code_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE setting ADD CONSTRAINT fk_setting_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE number_sequence ADD CONSTRAINT fk_number_sequence_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE attachment ADD CONSTRAINT fk_attachment_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE notification ADD CONSTRAINT fk_notification_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE notification ADD CONSTRAINT fk_notification_recipient_id FOREIGN KEY (recipient_id) REFERENCES app_user(id);
ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE security_event ADD CONSTRAINT fk_security_event_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);

-- Row level security: 앱은 트랜잭션마다 SET LOCAL app.tenant_id = <테넌트 id> 를 실행한다
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenant_tenant ON tenant USING (id = current_setting('app.tenant_id')::uuid);
ALTER TABLE tenant_domain ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenant_domain_tenant ON tenant_domain USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_app_user_tenant ON app_user USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_user_role_tenant ON user_role USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_company_tenant ON company USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE plant ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_plant_tenant ON plant USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE profit_center ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_profit_center_tenant ON profit_center USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE cost_center ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_cost_center_tenant ON cost_center USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE asset_class ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_class_tenant ON asset_class USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE site ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_site_tenant ON site USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE room ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_room_tenant ON room USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE category ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_category_tenant ON category USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE model ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_model_tenant ON model USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE vendor ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_vendor_tenant ON vendor USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_tenant ON asset USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE asset_value ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_value_tenant ON asset_value USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE asset_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_assignment_tenant ON asset_assignment USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE asset_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_event_tenant ON asset_event USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE discovery_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_discovery_job_tenant ON discovery_job USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE discovery_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_discovery_run_tenant ON discovery_run USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE discovery_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_discovery_item_tenant ON discovery_item USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE config_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_config_item_tenant ON config_item USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ci_relation ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_ci_relation_tenant ON ci_relation USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE ticket_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_ticket_link_tenant ON ticket_link USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE software_product ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_software_product_tenant ON software_product USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE license ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_license_tenant ON license USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE license_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_license_assignment_tenant ON license_assignment USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE software_install ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_software_install_tenant ON software_install USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_contract_tenant ON contract USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE contract_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_contract_asset_tenant ON contract_asset USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE purchase_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_purchase_request_tenant ON purchase_request USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE purchase_request_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_purchase_request_item_tenant ON purchase_request_item USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE po_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_po_item_tenant ON po_item USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE po_item_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_po_item_asset_tenant ON po_item_asset USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE goods_receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_goods_receipt_tenant ON goods_receipt USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE asset_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_asset_request_tenant ON asset_request USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_approval_tenant ON approval USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE count_campaign ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_count_campaign_tenant ON count_campaign USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE count_task ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_count_task_tenant ON count_task USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE count_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_count_item_tenant ON count_item USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE count_scan ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_count_scan_tenant ON count_scan USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE count_unregistered ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_count_unregistered_tenant ON count_unregistered USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE pda_device ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_pda_device_tenant ON pda_device USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE label_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_label_template_tenant ON label_template USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE printer ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_printer_tenant ON printer USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE label_print_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_label_print_job_tenant ON label_print_job USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE sap_posting ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_sap_posting_tenant ON sap_posting USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE sap_if_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_sap_if_run_tenant ON sap_if_run USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE sap_if_message ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_sap_if_message_tenant ON sap_if_message USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_idempotency_key_tenant ON idempotency_key USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE recon_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_recon_run_tenant ON recon_run USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE recon_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_recon_snapshot_tenant ON recon_snapshot USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE recon_diff ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_recon_diff_tenant ON recon_diff USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE field_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_field_mapping_tenant ON field_mapping USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE sap_connection ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_sap_connection_tenant ON sap_connection USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE sap_run_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_sap_run_request_tenant ON sap_run_request USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE code ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_code_tenant ON code USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_setting_tenant ON setting USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE number_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_number_sequence_tenant ON number_sequence USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_attachment_tenant ON attachment USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_notification_tenant ON notification USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_audit_log_tenant ON audit_log USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE security_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_security_event_tenant ON security_event USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Views ------------------------------------------------------------------

-- 최신 SAP 금액(상각영역 01): 자산별 마지막 회계연도·기간 1행
CREATE VIEW v_asset_value_latest WITH (security_invoker = true) AS
SELECT DISTINCT ON (v.asset_id)
       v.tenant_id, v.asset_id, v.fiscal_year, v.period,
       v.acquisition_value, v.accum_depreciation, v.net_book_value,
       v.useful_life_years, v.useful_life_periods
  FROM asset_value v
 WHERE v.dep_area = '01'
 ORDER BY v.asset_id, v.fiscal_year DESC, v.period DESC;

-- 라이프사이클 단계: 상태 + 내용연수 경과로 계산(저장하지 않음)
CREATE VIEW v_asset_stage WITH (security_invoker = true) AS
SELECT a.tenant_id, a.id AS asset_id, a.status,
       coalesce(a.sap_cap_date, a.purchase_date)
         + make_interval(years => coalesce(vl.useful_life_years, c.useful_life_years, ac.default_useful_life_years, 0)) AS useful_life_end,
       CASE
         WHEN a.status = 'ON_ORDER' AND a.po_item_id IS NULL THEN 'PLAN'
         WHEN a.status = 'ON_ORDER' THEN 'PROCURE'
         WHEN a.status = 'IN_STOCK' THEN 'DEPLOY'
         WHEN a.status = 'IN_REPAIR' THEN 'MAINTAIN'
         WHEN a.status IN ('RETIRED', 'DISPOSED') THEN 'RETIRE'
         WHEN a.status = 'IN_USE'
              AND coalesce(vl.useful_life_years, c.useful_life_years, ac.default_useful_life_years) IS NOT NULL
              AND coalesce(a.sap_cap_date, a.purchase_date)
                  + make_interval(years => coalesce(vl.useful_life_years, c.useful_life_years, ac.default_useful_life_years)) < current_date
           THEN 'MAINTAIN'
         ELSE 'OPERATE'
       END AS stage
  FROM asset a
  JOIN category c ON c.id = a.category_id
  LEFT JOIN asset_class ac ON ac.id = a.asset_class_id
  LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id;

-- 라이선스 준수: 사용 > 보유 = UNDER, 사용 < 보유 × 기준(기본 0.8) = OVER
CREATE VIEW v_license_compliance WITH (security_invoker = true) AS
WITH used AS (
  SELECT l.id AS license_id,
         CASE WHEN l.license_model = 'PER_USER'
              THEN (SELECT count(*) FROM license_assignment la WHERE la.license_id = l.id AND la.released_at IS NULL)
              ELSE (SELECT count(DISTINCT si.asset_id) FROM software_install si
                     WHERE si.product_id = l.product_id AND si.tenant_id = l.tenant_id AND NOT si.is_removed)
         END AS used_quantity
    FROM license l
)
SELECT l.tenant_id, l.id AS license_id, l.product_id, l.license_model, l.owned_quantity, u.used_quantity,
       l.unit_cost,
       greatest(l.owned_quantity - u.used_quantity, 0) * coalesce(l.unit_cost, 0) AS unused_amount,
       greatest(u.used_quantity - l.owned_quantity, 0) * coalesce(l.unit_cost, 0) AS shortfall_amount,
       CASE WHEN u.used_quantity > l.owned_quantity THEN 'UNDER'
            WHEN u.used_quantity < l.owned_quantity * coalesce(
                   (SELECT (s.value #>> '{}')::numeric FROM setting s
                     WHERE s.tenant_id = l.tenant_id AND s.key = 'license.over_threshold'), 0.8) THEN 'OVER'
            ELSE 'COMPLIANT' END AS compliance
  FROM license l JOIN used u ON u.license_id = l.id;

-- Security (WBS 2.8) ------------------------------------------------------
-- DB 역할
--   (소유자)        : 마이그레이션 계정. 업무 테이블 소유. 배포 파이프라인만 사용
--   alm_audit_owner : audit_log·audit_row()·보호 함수 소유. 로그인 없음, 파이프라인 계정은 멤버 아님(최초 1회 DBA가 부트스트랩)
--   alm_app         : NestJS 서버. 소유자 아님, BYPASSRLS 없음 → 모든 테이블에 RLS 적용
--   alm_readonly    : 운영 조회·리포트(읽기 전용, RLS 적용)
-- 로그인 사용자(예: alm_app_login, IAM DB 인증)는 인프라(CDK)가 만들고 위 역할을 부여한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alm_app') THEN
    CREATE ROLE alm_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alm_readonly') THEN
    CREATE ROLE alm_readonly NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alm_audit_owner') THEN
    CREATE ROLE alm_audit_owner NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO alm_app, alm_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO alm_readonly;
-- 테넌트·도메인 행은 플랫폼 운영(소유자)만 바꾼다. 앱은 RLS로 자기 테넌트 행만 조회
REVOKE INSERT, UPDATE, DELETE ON tenant, tenant_domain FROM alm_app;
-- 감사 로그는 트리거만 쓴다(앱은 조회만)
REVOKE INSERT ON audit_log FROM alm_app;

-- 감사 트리거 ---------------------------------------------------------------
-- 앱은 트랜잭션마다 SET LOCAL 로 다음 값을 넣는다:
--   app.tenant_id, app.user_id, app.actor_type(USER/SYSTEM/SAP/PDA), app.correlation_id, app.client_ip
-- UPDATE는 바뀐 컬럼만 before/after에 남기고, 바뀐 값이 없으면 기록하지 않는다.
-- 앱 계정(alm_app 멤버)으로 접속했는데 actor_type이 비어 있으면 변경 자체를 거부한다(처리자 누락 방지).
-- 앱이 넣는 처리자 값은 '앱이 주장한 값'이므로 실제 DB 계정(session_user)과 트랜잭션 ID를 함께 남긴다.
-- 형식이 틀린 correlation_id·client_ip는 NULL로 남긴다(업무 트랜잭션을 실패시키지 않음).
CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  skip   text[] := ARRAY['created_at', 'created_by', 'updated_at', 'updated_by', 'version'];
  o      jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n      jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  b      jsonb;
  a      jsonb;
  k      text;
  actor  text := NULLIF(current_setting('app.actor_type', true), '');
  uid    text := NULLIF(current_setting('app.user_id', true), '');
  cid    text := NULLIF(current_setting('app.correlation_id', true), '');
  cip    text := NULLIF(current_setting('app.client_ip', true), '');
  tid    uuid;
  v_uid  uuid;
  v_cid  uuid;
  v_cip  inet;
BEGIN
  -- 슈퍼유저는 모든 역할의 멤버로 판정되므로 pg_has_role 대신 직접 멤버십을 본다
  IF actor IS NULL AND EXISTS (SELECT 1 FROM pg_auth_members m
                                 JOIN pg_roles r ON r.oid = m.roleid
                                 JOIN pg_roles u ON u.oid = m.member
                                WHERE r.rolname = 'alm_app' AND u.rolname = session_user) THEN
    RAISE EXCEPTION 'audit: app.actor_type is not set for application session %', session_user;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    b := '{}'; a := '{}';
    FOR k IN SELECT jsonb_object_keys(n - skip) LOOP
      IF (n -> k) IS DISTINCT FROM (o -> k) THEN
        b := b || jsonb_build_object(k, o -> k);
        a := a || jsonb_build_object(k, n -> k);
      END IF;
    END LOOP;
    IF a = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
  ELSE
    b := o - skip;
    a := n - skip;
  END IF;
  -- 캐스트는 IF로 분기(CASE 안의 캐스트는 상수 접기로 먼저 실행될 수 있음)
  IF pg_input_is_valid(uid, 'uuid') THEN v_uid := uid::uuid; END IF;
  IF pg_input_is_valid(cid, 'uuid') THEN v_cid := cid::uuid; END IF;
  IF pg_input_is_valid(cip, 'inet') THEN v_cip := cip::inet; END IF;
  tid := CASE WHEN TG_TABLE_NAME = 'tenant' THEN (COALESCE(n, o) ->> 'id')::uuid
              ELSE (COALESCE(n, o) ->> 'tenant_id')::uuid END;
  INSERT INTO audit_log (id, tenant_id, table_name, row_id, action, before, after,
                         actor_id, actor_type, correlation_id, ip_address, db_user, tx_id)
  VALUES (gen_random_uuid(), tid, TG_TABLE_NAME, (COALESCE(n, o) ->> 'id')::uuid, TG_OP::audit_action, b, a,
          v_uid, COALESCE(actor, 'SYSTEM'), v_cid, v_cip,
          session_user, txid_current());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION audit_row() FROM PUBLIC;

-- 인증 전 조회 ----------------------------------------------------------------
-- 테넌트를 아직 모르는 단계만 SECURITY DEFINER 함수로 연다. RLS 우회 역할은 두지 않는다.
-- 웹 로그인 화면: 이메일 도메인 → IdP 이름(활성 테넌트만)
CREATE FUNCTION auth_idp_by_domain(p_domain text)
RETURNS varchar LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.idp_provider_name
    FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id
   WHERE d.domain = lower(p_domain) AND d.is_active AND t.is_active
$$;
-- 토큰 확인: username → 테넌트(활성만). username = '<idp_provider_name>_<IdP 사용자 ID>'
CREATE FUNCTION auth_tenant_by_username(p_username text)
RETURNS TABLE (tenant_id uuid, idp_subject text, jit_provision boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, substr(p_username, length(t.idp_provider_name) + 2), t.jit_provision
    FROM tenant t
   WHERE t.is_active AND p_username LIKE t.idp_provider_name || '\_%'
$$;
-- SAP: client_id → 연결(활성 연결·활성 테넌트만)
CREATE FUNCTION auth_sap_client(p_client_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, company_id uuid, system_id varchar, allowed_cidrs jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.id, c.company_id, c.system_id, c.allowed_cidrs
    FROM sap_connection c JOIN tenant t ON t.id = c.tenant_id
   WHERE c.oauth_client_id = p_client_id AND c.is_active AND t.is_active
$$;
REVOKE ALL ON FUNCTION auth_idp_by_domain(text), auth_tenant_by_username(text), auth_sap_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_idp_by_domain(text), auth_tenant_by_username(text), auth_sap_client(text) TO alm_app;

-- 추가만 되는 로그 테이블(앱 계정에서 수정·삭제 회수)
REVOKE UPDATE, DELETE, TRUNCATE ON asset_event FROM alm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON count_scan FROM alm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sap_if_message FROM alm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON recon_snapshot FROM alm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM alm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON security_event FROM alm_app;
REVOKE DELETE, TRUNCATE ON sap_if_run FROM alm_app;

CREATE TRIGGER tr_tenant_audit AFTER INSERT OR UPDATE OR DELETE ON tenant FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_tenant_domain_audit AFTER INSERT OR UPDATE OR DELETE ON tenant_domain FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_app_user_audit AFTER INSERT OR UPDATE OR DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_user_role_audit AFTER INSERT OR UPDATE OR DELETE ON user_role FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_company_audit AFTER INSERT OR UPDATE OR DELETE ON company FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_plant_audit AFTER INSERT OR UPDATE OR DELETE ON plant FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_profit_center_audit AFTER INSERT OR UPDATE OR DELETE ON profit_center FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_cost_center_audit AFTER INSERT OR UPDATE OR DELETE ON cost_center FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_asset_class_audit AFTER INSERT OR UPDATE OR DELETE ON asset_class FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_site_audit AFTER INSERT OR UPDATE OR DELETE ON site FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_room_audit AFTER INSERT OR UPDATE OR DELETE ON room FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_category_audit AFTER INSERT OR UPDATE OR DELETE ON category FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_model_audit AFTER INSERT OR UPDATE OR DELETE ON model FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_vendor_audit AFTER INSERT OR UPDATE OR DELETE ON vendor FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_asset_audit AFTER INSERT OR UPDATE OR DELETE ON asset FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_asset_value_audit AFTER INSERT OR UPDATE OR DELETE ON asset_value FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_asset_assignment_audit AFTER INSERT OR UPDATE OR DELETE ON asset_assignment FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_discovery_job_audit AFTER INSERT OR UPDATE OR DELETE ON discovery_job FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_config_item_audit AFTER INSERT OR UPDATE OR DELETE ON config_item FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_ci_relation_audit AFTER INSERT OR UPDATE OR DELETE ON ci_relation FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_ticket_link_audit AFTER INSERT OR UPDATE OR DELETE ON ticket_link FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_software_product_audit AFTER INSERT OR UPDATE OR DELETE ON software_product FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_license_audit AFTER INSERT OR UPDATE OR DELETE ON license FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_license_assignment_audit AFTER INSERT OR UPDATE OR DELETE ON license_assignment FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_contract_audit AFTER INSERT OR UPDATE OR DELETE ON contract FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_contract_asset_audit AFTER INSERT OR UPDATE OR DELETE ON contract_asset FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_purchase_request_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_request FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_purchase_request_item_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_request_item FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_po_item_audit AFTER INSERT OR UPDATE OR DELETE ON po_item FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_po_item_asset_audit AFTER INSERT OR UPDATE OR DELETE ON po_item_asset FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_goods_receipt_audit AFTER INSERT OR UPDATE OR DELETE ON goods_receipt FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_asset_request_audit AFTER INSERT OR UPDATE OR DELETE ON asset_request FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_approval_audit AFTER INSERT OR UPDATE OR DELETE ON approval FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_count_campaign_audit AFTER INSERT OR UPDATE OR DELETE ON count_campaign FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_count_task_audit AFTER INSERT OR UPDATE OR DELETE ON count_task FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_count_item_audit AFTER INSERT OR UPDATE OR DELETE ON count_item FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_count_unregistered_audit AFTER INSERT OR UPDATE OR DELETE ON count_unregistered FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_pda_device_audit AFTER INSERT OR UPDATE OR DELETE ON pda_device FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_label_template_audit AFTER INSERT OR UPDATE OR DELETE ON label_template FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_printer_audit AFTER INSERT OR UPDATE OR DELETE ON printer FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_sap_posting_audit AFTER INSERT OR UPDATE OR DELETE ON sap_posting FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_recon_run_audit AFTER INSERT OR UPDATE OR DELETE ON recon_run FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_recon_diff_audit AFTER INSERT OR UPDATE OR DELETE ON recon_diff FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_field_mapping_audit AFTER INSERT OR UPDATE OR DELETE ON field_mapping FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_sap_connection_audit AFTER INSERT OR UPDATE OR DELETE ON sap_connection FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_sap_run_request_audit AFTER INSERT OR UPDATE OR DELETE ON sap_run_request FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_code_audit AFTER INSERT OR UPDATE OR DELETE ON code FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_setting_audit AFTER INSERT OR UPDATE OR DELETE ON setting FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER tr_attachment_audit AFTER INSERT OR UPDATE OR DELETE ON attachment FOR EACH ROW EXECUTE FUNCTION audit_row();

-- 감사 보호 ------------------------------------------------------------------
-- 감사 객체는 alm_audit_owner가 소유해 업무 테이블 소유자(파이프라인)도 지우거나 바꾸지 못하게 한다.
ALTER TABLE audit_log OWNER TO alm_audit_owner;
ALTER FUNCTION audit_row() OWNER TO alm_audit_owner;
-- 감사 트리거를 끄거나 지우는 DDL은 거부한다(이벤트 트리거는 rds_superuser가 만들고 소유).
CREATE FUNCTION guard_audit_ddl() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF TG_EVENT = 'sql_drop' THEN
    FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
      IF (r.object_type = 'trigger' AND r.object_identity LIKE 'tr\_%\_audit on %')
         OR (r.object_type IN ('table', 'function') AND r.object_identity IN ('public.audit_log', 'public.audit_row()')) THEN
        RAISE EXCEPTION 'audit: dropping % is not allowed', r.object_identity;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr\_%\_audit' AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'audit: audit triggers must stay enabled';
  END IF;
END $$;
CREATE EVENT TRIGGER et_guard_audit_ddl ON ddl_command_end EXECUTE FUNCTION guard_audit_ddl();
CREATE EVENT TRIGGER et_guard_audit_drop ON sql_drop EXECUTE FUNCTION guard_audit_ddl();

COMMIT;