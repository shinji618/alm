# ALM data model spec — single source for schema.prisma, ddl check, and the table definition doc.
# Column line: name | type | flags | description
#   type: uuid, vc(n), text, int, bigint, num(p,s), bool, date, ts, json, inet, E:EnumName, ->table (uuid FK)
#   flags: NN (not null), =default (now, true, false, 0, 'x', ENUMVAL), UK (single unique)
# mode: full (common cols), log (id, tenant_id, created_at), root (tenant table)

ENUMS = {
 'RoleCode': ('사용자 역할', ['SYS_ADMIN','ASSET_MANAGER','DEPT_MANAGER','ASSET_ACCOUNTANT','COUNTER','EMPLOYEE']),
 'AssetStatus': ('자산 상태', ['ON_ORDER','IN_STOCK','IN_USE','IN_REPAIR','MISSING','RETIRED','DISPOSED']),
 'AssetSource': ('자산 생성 출처', ['MANUAL','DISCOVERY','GOODS_RECEIPT','SAP','PDA_COUNT','IMPORT']),
 'AssetEventType': ('자산 이력 유형', ['CREATED','UPDATED','STATUS_CHANGED','ASSIGNED','RETURNED','TRANSFERRED','REPAIR_IN','REPAIR_OUT','COUNTED','LABEL_PRINTED','SAP_POSTED','SAP_SYNCED','RETIRED','DISPOSED']),
 'CiType': ('CI 유형', ['BUSINESS_SERVICE','APPLICATION','DATABASE','SERVER','VIRTUAL_MACHINE','NETWORK','OT_DEVICE','OTHER']),
 'CiRelationType': ('CI 관계 유형', ['DEPENDS_ON','RUNS_ON','CONNECTED_TO','INSTALLED_ON']),
 'DiscoveryMethod': ('수집 방식', ['AGENT','NETWORK_SCAN','VCENTER']),
 'RunStatus': ('작업 실행 상태', ['QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED']),
 'DiscoveryMatch': ('수집 결과 분류', ['NEW','CONFLICT','UNMANAGED','MATCHED','IGNORED']),
 'DiscoveryResolution': ('수집 결과 처리', ['REGISTERED','UPDATED','QUARANTINED','IGNORED']),
 'LicenseModel': ('라이선스 모델', ['PER_USER','PER_DEVICE','PER_CORE','NETWORK']),
 'ContractType': ('계약 유형', ['MAINTENANCE','LEASE','SERVICE','SUBSCRIPTION']),
 'PurchaseRequestStatus': ('구매요청 상태', ['DRAFT','SUBMITTED','APPROVED','REJECTED','PO_REQUESTED','PO_CREATED','PO_ERROR','CANCELLED']),
 'RequestType': ('자산 요청 유형', ['NEW_ASSET','CHANGE','TRANSFER','RETIRE','SALE']),
 'RequestStatus': ('자산 요청 상태', ['DRAFT','SUBMITTED','MGR_APPROVED','ACCT_APPROVED','POSTED','POST_ERROR','REJECTED','CANCELLED']),
 'RequestSource': ('요청 발생 출처', ['USER','ASSIGNMENT','COUNT_VARIANCE','RECONCILIATION','GOODS_RECEIPT']),
 'RetireType': ('폐기 유형', ['SCRAP','SALE','LOSS']),
 'ApprovalDecision': ('승인 결정', ['PENDING','APPROVED','REJECTED','SKIPPED']),
 'CampaignStatus': ('실사 캠페인 단계', ['SCOPING','COUNTING','REVIEW','POSTING','CLOSED','CANCELLED']),
 'CountTaskStatus': ('룸 실사 작업 상태', ['NOT_STARTED','IN_PROGRESS','COMPLETED']),
 'CountResult': ('실사 대상 판정', ['PENDING','FOUND','MISPLACED','NOT_FOUND']),
 'ScanResult': ('스캔 판정', ['FOUND','MISPLACED','OUT_OF_SCOPE','UNREGISTERED','DUPLICATE','RETIRED_ASSET']),
 'AssetCondition': ('자산 상태(실사)', ['GOOD','DAMAGED','UNUSED']),
 'VarianceAction': ('차이 처리', ['NONE','MASTER_CHANGE','RECOUNT','RETIRE_REQUEST','MARK_MISSING','REPAIR','ACCEPT','REGISTER','NON_ASSET']),
 'LabelLayout': ('라벨 레이아웃', ['QR_CODE128','QR_ONLY','CODE128_ONLY']),
 'PrintSource': ('출력 요청 출처', ['ASSET_DETAIL','GOODS_RECEIPT','PDA_REQUEST','BULK']),
 'PrintStatus': ('출력 상태', ['QUEUED','SENT','PRINTED','FAILED']),
 'PostingType': ('SAP 전기 유형', ['ASSET_CREATE','ASSET_CHANGE','ASSET_TRANSFER','ASSET_RETIRE','COUNT_RESULT','PO_CREATE']),
 'PostingStatus': ('SAP 전기 상태', ['READY','CLAIMED','POSTED','FAILED','CANCELLED']),
 'IfDirection': ('데이터 방향', ['SAP_TO_ALM','ALM_TO_SAP']),
 'IfStatus': ('IF 실행 결과', ['SUCCESS','PARTIAL','FAILED']),
 'ReconDiffType': ('대사 차이 유형', ['SAP_ONLY','ALM_ONLY','COST_CENTER','LOCATION','SERIAL','TAG','RETIRED']),
 'ReconAction': ('대사 조치', ['SAP_TO_ALM','ALM_TO_SAP','REVIEW','IGNORE']),
 'ReconStatus': ('대사 처리 상태', ['OPEN','RESOLVED','IGNORED']),
 'MasterSystem': ('기준 시스템', ['SAP','ALM']),
 'NotificationChannel': ('알림 채널', ['EMAIL','IN_APP']),
 'NotificationStatus': ('알림 상태', ['QUEUED','SENT','FAILED']),
 'AuditAction': ('감사 동작', ['INSERT','UPDATE','DELETE']),
}

DOMAINS = [
 ('org', '조직·마스터'), ('asset', '자산'), ('cmdb', 'Discovery·CMDB'), ('license', '라이선스·계약'),
 ('purchase', '구매'), ('request', '요청·승인'), ('count', '실사'), ('label', '라벨'), ('sap', 'SAP 연동'), ('common', '공통'),
]

T = []  # (domain, name, korean, desc, mode, cols, uniques, indexes, screens)
def t(domain, name, ko, desc, cols, uniques=(), indexes=(), mode='full', screens=''):
    T.append(dict(domain=domain, name=name, ko=ko, desc=desc, mode=mode,
                  cols=[c.strip() for c in cols.strip().split('\n') if c.strip()],
                  uniques=list(uniques), indexes=list(indexes), screens=screens))

# ---------------- org ----------------
t('org','tenant','테넌트','서비스 고객사. 단일 고객이면 1행', '''
code | vc(20) | NN UK | 테넌트 코드
name | vc(100) | NN | 고객사 이름
sap_system_id | vc(10) | | SAP 시스템 ID-클라이언트 (예: PRD-100)
time_zone | vc(40) | NN ='America/New_York' | 화면 표시 시간대
is_active | bool | NN =true | 사용 여부
''', mode='root', screens='-')
t('org','app_user','사용자','SSO 로그인 사용자', '''
email | vc(254) | NN | 이메일(로그인 ID)
display_name | vc(100) | NN | 이름
idp_subject | vc(200) | | Entra ID 사용자 식별자(oid)
employee_no | vc(20) | | 사번
department | vc(100) | | 부서명
cost_center_id | ->cost_center | | 소속 코스트센터
locale | vc(5) | NN ='en' | 화면 언어 en/ko
last_login_at | ts | | 마지막 로그인
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','email'),('tenant_id','idp_subject')], screens='공통')
t('org','user_role','사용자 역할','역할 부여와 범위(회사코드·사이트). 범위가 비면 전체', '''
user_id | ->app_user | NN | 사용자
role | E:RoleCode | NN | 역할
company_id | ->company | | 회사코드 범위
site_id | ->site | | 사이트 범위
''', uniques=[('user_id','role','company_id','site_id')], screens='공통')
t('org','company','회사코드','SAP 회사코드 (IF-MD-01 COMPANY)', '''
company_code | vc(4) | NN | BUKRS
name | vc(25) | NN | BUTXT
currency | vc(5) | NN ='USD' | WAERS
sap_synced_at | ts | | 마지막 SAP 수신
is_active | bool | NN =true | 수신 목록에 없으면 false
''', uniques=[('tenant_id','company_code')], screens='ALM-310')
t('org','plant','플랜트','SAP 플랜트 (IF-MD-01 PLANT)', '''
company_id | ->company | NN | 회사코드
plant_code | vc(4) | NN | WERKS
name | vc(30) | NN | NAME1
address | vc(200) | | 주소
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','plant_code')], screens='ALM-310')
t('org','profit_center','손익센터','SAP 손익센터 (IF-MD-01 PROFIT_CENTER)', '''
controlling_area | vc(4) | NN | KOKRS
profit_center_code | vc(10) | NN | PRCTR
name | vc(20) | NN | KTEXT
segment | vc(10) | | SEGMENT. 이관 시 ABUMN 판단에 사용
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','controlling_area','profit_center_code')], screens='ALM-310')
t('org','cost_center','코스트센터','SAP 코스트센터 (IF-MD-01 COST_CENTER). 기준일 현재 유효한 1행만 보관', '''
controlling_area | vc(4) | NN | KOKRS
cost_center_code | vc(10) | NN | KOSTL
name | vc(20) | NN | KTEXT
company_id | ->company | NN | BUKRS
profit_center_id | ->profit_center | | PRCTR. 이관 판단(AS02/ABUMN)
responsible | vc(20) | | VERAK 책임자
valid_from | date | | DATAB
valid_to | date | | DATBI
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','controlling_area','cost_center_code')], screens='ALM-111, 230')
t('org','asset_class','자산클래스','SAP 자산클래스 (IF-MD-01 ASSET_CLASS)', '''
class_code | vc(8) | NN | ANLKL
name | vc(50) | NN | TXK50
is_low_value | bool | NN =false | 저가자산 여부
is_capitalized | bool | NN =true | 자본화 대상. true면 등록 시 SAP 생성 요청
default_useful_life_years | int | | 내용연수 기본값(년)
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','class_code')], screens='ALM-112')
t('org','site','사이트','ALM 사이트(건물·거점). SAP 위치(T499S)와 연결', '''
site_code | vc(10) | NN | 사이트 코드 (예: ATL1)
name | vc(60) | NN | 이름
plant_id | ->plant | | SAP 플랜트
sap_location | vc(10) | | T499S STAND
address | vc(200) | | 주소
time_zone | vc(40) | | 시간대(비면 테넌트 기본)
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','site_code')], screens='전체')
t('org','room','룸','실사·위치의 최소 단위. room_code를 SAP STORT에 전송', '''
site_id | ->site | NN | 사이트
room_code | vc(10) | NN | 룸 코드 (예: ATL1-2F-IT) = SAP STORT
name | vc(60) | NN | 이름
floor | vc(10) | | 층
sap_room_no | vc(8) | | SAP RAUMNR 8자 약어(ZALM_MAP)
barcode | vc(30) | NN | 룸 바코드 값. 기본 = room_code
is_storage | bool | NN =false | IT 창고 여부(반납 시 기본 위치)
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','room_code'),('tenant_id','barcode')], screens='ALM-111, 240, PDA-03')
t('org','category','카테고리','자산 분류(노트북, 서버 등). 계층 구조', '''
category_code | vc(20) | NN | 코드
name | vc(60) | NN | 이름
parent_id | ->category | | 상위 카테고리
default_asset_class_id | ->asset_class | | 등록 시 기본 자산클래스
useful_life_years | int | | 내용연수 경과 판정 기준(년)
is_ci | bool | NN =false | 등록 시 CMDB CI 자동 생성
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','category_code')], screens='ALM-110, 112')
t('org','model','모델','제조사·모델 마스터', '''
category_id | ->category | NN | 카테고리
manufacturer | vc(60) | NN | 제조사
model_name | vc(100) | NN | 모델명
part_no | vc(40) | | 제조사 부품번호
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','manufacturer','model_name')], screens='ALM-112')
t('org','vendor','공급사','공급사. SAP 공급사 번호와 연결', '''
vendor_no | vc(10) | | LIFNR. SAP에 없는 공급사는 비움
name | vc(80) | NN | 이름
email | vc(254) | | 대표 이메일
phone | vc(30) | | 전화
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','vendor_no')], screens='ALM-210, 220')

# ---------------- asset ----------------
t('asset','asset','자산','자산 대장. 하드웨어·설비·집기 1건 = 1행', '''
asset_tag | vc(25) | NN | 자산태그 AT-nnnnnn = SAP INVNR, 라벨 바코드 값
description | vc(50) | NN | 자산명 = SAP TXT50
category_id | ->category | NN | 카테고리
model_id | ->model | | 모델
serial_no | vc(40) | | 시리얼. SAP SERNR(18자) 초과 시 전송 검증 오류
status | E:AssetStatus | NN =IN_STOCK | 상태 7종
status_before_missing | E:AssetStatus | | Missing 전 상태. 다음 스캔 시 복원
source | E:AssetSource | NN | 생성 출처
company_id | ->company | NN | 회사코드
site_id | ->site | | 사이트
room_id | ->room | | 룸
cost_center_id | ->cost_center | | 코스트센터. 자본화 자산은 SAP 기준
assigned_user_id | ->app_user | | 사용자(할당)
assigned_at | ts | | 할당 일시
due_back_date | date | | 반납 예정일
asset_class_id | ->asset_class | | 자산클래스
is_capitalized | bool | NN =false | SAP 자본화 자산 여부
sap_asset_no | vc(12) | | ANLN1
sap_sub_no | vc(4) | | ANLN2
sap_cap_date | date | | AKTIV 취득일
sap_deact_date | date | | DEAKT 비활성일
last_count_date | date | | IVDAT 마지막 실사일. ALM 기준
last_count_note | vc(15) | | INVZU 실사 비고
hostname | vc(63) | | 호스트명
ip_address | inet | | IP
mac_address | vc(17) | | MAC
bios_asset_tag | vc(40) | | BIOS 자산태그
os_name | vc(60) | | OS
purchase_date | date | | 구매일(비자본화 자산 참고용)
purchase_cost | num(15,2) | | 구매가(비자본화 자산 참고용). 회계 금액은 asset_value
warranty_end_date | date | | 제조사 보증 종료일
po_item_id | ->po_item | | 구매오더 항목
goods_receipt_id | ->goods_receipt | | 입고 문서(입고로 생성된 경우)
is_gr_cancelled | bool | NN =false | 입고 취소(102) 표시
parent_asset_id | ->asset | | 상위 자산(구성품)
last_seen_at | ts | | Discovery 마지막 확인
sap_synced_at | ts | | 마지막 SAP 수신
notes | text | | 메모
''', uniques=[('tenant_id','asset_tag'),('tenant_id','company_id','sap_asset_no','sap_sub_no')],
  indexes=[('tenant_id','status'),('tenant_id','serial_no'),('tenant_id','room_id'),('tenant_id','cost_center_id'),('tenant_id','assigned_user_id'),('tenant_id','hostname'),('tenant_id','mac_address')],
  screens='ALM-110, 111, 112')
t('asset','asset_value','자산 금액','SAP 기간별 누적 금액 (IF-AA-02). 최신 값은 뷰 v_asset_value_latest', '''
asset_id | ->asset | NN | 자산
fiscal_year | int | NN | GJAHR
period | int | NN | 기간 1~16
dep_area | vc(2) | NN ='01' | AFABE 상각영역
acquisition_value | num(15,2) | NN | 취득가(APC) 누계
accum_depreciation | num(15,2) | NN | 감가상각누계액(음수)
net_book_value | num(15,2) | NN | 장부가액(NBV)
useful_life_years | int | | NDJAR
useful_life_periods | int | | NDPER
dep_key | vc(4) | | AFASL
is_closed | bool | NN =false | 마감값(isClosing 수신). true면 이후 일반 수신으로 덮어쓰지 않음
received_at | ts | NN | 수신 일시
''', uniques=[('asset_id','fiscal_year','period','dep_area')], screens='ALM-010, 111')
t('asset','asset_assignment','자산 할당','Check-out·반납 이력. 반납 전 행이 현재 할당', '''
asset_id | ->asset | NN | 자산
user_id | ->app_user | | 사용자
cost_center_id | ->cost_center | | 코스트센터
room_id | ->room | | 룸
checked_out_at | ts | NN | 할당 일시
due_back_date | date | | 반납 예정일
returned_at | ts | | 반납 일시
note | vc(200) | | 메모
''', indexes=[('asset_id','checked_out_at')], screens='ALM-111')
t('asset','asset_event','자산 이력','자산의 업무 이력(History 탭). 변경 전후값 포함', '''
asset_id | ->asset | NN | 자산
event_type | E:AssetEventType | NN | 이력 유형
occurred_at | ts | NN =now | 발생 일시
actor_id | ->app_user | | 처리자(비면 시스템)
channel | vc(20) | NN | UI / API / SAP / PDA / DISCOVERY
changes | json | | 필드별 {before, after}
reason | vc(200) | | 사유
asset_request_id | ->asset_request | | 관련 자산 요청
count_campaign_id | ->count_campaign | | 관련 실사 캠페인
sap_document_no | vc(10) | | SAP 전표번호 BELNR
sap_fiscal_year | int | | GJAHR
''', indexes=[('asset_id','occurred_at')], mode='log', screens='ALM-111')

# ---------------- cmdb ----------------
t('cmdb','discovery_job','수집 작업','Discovery 스캔 작업 설정', '''
name | vc(100) | NN | 작업명
method | E:DiscoveryMethod | NN | 에이전트 / 네트워크 스캔 / vCenter
targets | json | NN | IP 대역, vCenter URL 목록
schedule_cron | vc(50) | | 실행 주기(cron). 비면 수동
credential_ref | vc(200) | | AWS Secrets Manager ARN. 자격증명은 저장하지 않음
site_id | ->site | | 대상 사이트
last_run_at | ts | | 마지막 실행
is_active | bool | NN =true | 사용 여부
''', screens='ALM-120')
t('cmdb','discovery_run','수집 실행','수집 작업 1회 실행. 에이전트 상시 보고는 일 단위 1행', '''
job_id | ->discovery_job | | 수집 작업(에이전트 보고는 비움)
status | E:RunStatus | NN =QUEUED | 상태
started_at | ts | | 시작
finished_at | ts | | 종료
found_count | int | NN =0 | 수집 건수
new_count | int | NN =0 | 신규
conflict_count | int | NN =0 | 충돌
error_message | text | | 오류
''', indexes=[('tenant_id','started_at')], screens='ALM-120')
t('cmdb','discovery_item','수집 결과','장비 1대의 수집 결과와 대사 큐 처리', '''
run_id | ->discovery_run | NN | 수집 실행
collected_at | ts | NN | 수집 일시
hostname | vc(63) | | 호스트명
serial_no | vc(40) | | 시리얼
manufacturer | vc(60) | | 제조사
model | vc(100) | | 모델
bios_asset_tag | vc(40) | | BIOS 자산태그
mac_address | vc(17) | | MAC
ip_address | inet | | IP
os_name | vc(60) | | OS
raw | json | NN | 수집 원본
match_status | E:DiscoveryMatch | NN | New / Conflict / Unmanaged / Matched / Ignored
match_rule | vc(30) | | 매칭 규칙 SERIAL_MFR, BIOS_TAG, MAC, HOSTNAME_MODEL
matched_asset_id | ->asset | | 매칭된 자산
conflict_fields | json | | 충돌 필드 {field: {alm, discovered}}
resolution | E:DiscoveryResolution | | 처리 결과
resolved_by | ->app_user | | 처리자
resolved_at | ts | | 처리 일시
''', indexes=[('tenant_id','match_status')], screens='ALM-120')
t('cmdb','config_item','CI','CMDB 구성항목. 하드웨어 CI는 자산과 1:1', '''
ci_type | E:CiType | NN | CI 유형
name | vc(100) | NN | 이름
asset_id | ->asset | UK | 하드웨어 CI면 자산
owner_user_id | ->app_user | | 담당자
description | text | | 설명
is_active | bool | NN =true | 사용 여부
''', indexes=[('tenant_id','ci_type')], screens='ALM-130')
t('cmdb','ci_relation','CI 관계','source가 target에 대해 갖는 관계 (예: 앱 runs on 서버)', '''
source_ci_id | ->config_item | NN | 출발 CI
target_ci_id | ->config_item | NN | 도착 CI
relation_type | E:CiRelationType | NN | 관계 유형
''', uniques=[('source_ci_id','target_ci_id','relation_type')], indexes=[('target_ci_id',)], screens='ALM-130')
t('cmdb','ticket_link','티켓 연결','ITSM 인시던트·변경 참조', '''
config_item_id | ->config_item | NN | CI
itsm_system | vc(20) | NN | ITSM 시스템
ticket_no | vc(30) | NN | 티켓 번호
ticket_type | vc(20) | NN | INCIDENT / CHANGE
title | vc(200) | | 제목
ticket_status | vc(20) | | 상태
opened_at | ts | | 접수 일시
''', uniques=[('config_item_id','itsm_system','ticket_no')], screens='ALM-111, 130')

# ---------------- license ----------------
t('license','software_product','소프트웨어 제품','라이선스 관리 대상 제품과 설치명 매칭 규칙', '''
publisher | vc(80) | NN | 게시자
name | vc(120) | NN | 제품명
is_commercial | bool | NN =true | 상용 여부(비인가 설치 판정)
match_pattern | vc(200) | | 설치 목록 이름 매칭 정규식
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','publisher','name')], screens='ALM-140')
t('license','license','라이선스','보유 라이선스. 사용 수량·준수 판정은 뷰 v_license_compliance', '''
product_id | ->software_product | NN | 제품
license_model | E:LicenseModel | NN | 사용자 / 장치 / 코어 / 네트워크
owned_quantity | int | NN | 보유 수량
unit_cost | num(15,2) | | 단가(USD, 연간)
renewal_date | date | | 갱신일
contract_id | ->contract | | 연결 계약
po_no | vc(10) | | 구매 PO
notes | text | | 메모
''', indexes=[('tenant_id','product_id')], screens='ALM-140')
t('license','license_assignment','라이선스 할당','사용자형 라이선스의 좌석 할당. 장치형은 software_install로 계산', '''
license_id | ->license | NN | 라이선스
user_id | ->app_user | | 사용자
asset_id | ->asset | | 장치
assigned_at | ts | NN | 할당 일시
released_at | ts | | 회수 일시
''', indexes=[('license_id','released_at')], screens='ALM-140')
t('license','software_install','설치 소프트웨어','에이전트가 수집한 자산별 설치 목록', '''
asset_id | ->asset | NN | 자산
product_id | ->software_product | | 매칭된 제품(비면 미분류)
raw_name | vc(200) | NN | 설치 목록 원본 이름
product_version | vc(50) | NN ='' | 버전
install_date | date | | 설치일
first_seen_at | ts | NN | 최초 수집
last_seen_at | ts | NN | 최근 수집
is_removed | bool | NN =false | 최근 수집에서 사라짐
''', uniques=[('asset_id','raw_name','product_version')], indexes=[('tenant_id','product_id')], screens='ALM-140')
t('license','contract','계약','유지보수·리스·서비스·구독 계약', '''
contract_no | vc(30) | NN | 계약번호
contract_type | E:ContractType | NN | 계약 유형
title | vc(120) | NN | 계약명
vendor_id | ->vendor | | 공급사
start_date | date | NN | 시작일
end_date | date | | 종료일
amount | num(15,2) | | 계약 금액(USD)
is_auto_renew | bool | NN =false | 자동갱신
owner_user_id | ->app_user | | 담당자(만료 알림 수신)
notes | text | | 메모
''', uniques=[('tenant_id','contract_no')], indexes=[('tenant_id','end_date')], screens='ALM-220')
t('license','contract_asset','계약 대상 자산','계약과 자산 N:M', '''
contract_id | ->contract | NN | 계약
asset_id | ->asset | NN | 자산
''', uniques=[('contract_id','asset_id')], indexes=[('asset_id',)], screens='ALM-111, 220')

# ---------------- purchase ----------------
t('purchase','purchase_request','구매요청','구매요청 헤더. 승인 후 SAP PO 생성(IF-MM-02)', '''
pr_no | vc(12) | NN | 요청번호 PR-nnnnn = SAP postingId
title | vc(120) | NN | 제목
requester_id | ->app_user | NN | 요청자
company_id | ->company | NN | 회사코드
cost_center_id | ->cost_center | NN | 코스트센터
status | E:PurchaseRequestStatus | NN =DRAFT | 상태
estimated_amount | num(15,2) | | 예상금액(USD)
needed_by | date | | 필요일
reason | text | | 사유
source | vc(20) | NN ='USER' | USER / LICENSE_SHORTAGE / CONTRACT_RENEWAL
license_id | ->license | | 라이선스 부족분 구매
contract_id | ->contract | | 갱신 대상 계약
vendor_id | ->vendor | | 공급사
purchasing_org | vc(4) | | EKORG
purchasing_group | vc(3) | | EKGRP
sap_po_no | vc(10) | | 생성된 PO 번호
''', uniques=[('tenant_id','pr_no')], indexes=[('tenant_id','status')], screens='ALM-210')
t('purchase','purchase_request_item','구매요청 품목','구매요청 품목', '''
request_id | ->purchase_request | NN | 구매요청
line_no | int | NN | 항목 번호
description | vc(40) | NN | 품목명 = EKPO TXZ01
category_id | ->category | | 카테고리
model_id | ->model | | 모델
asset_class_id | ->asset_class | | 자산클래스
quantity | int | NN | 수량
unit_price | num(15,2) | | 단가(USD)
sap_asset_no | vc(12) | | 지정 자산번호(IF-AA-03 선처리)
sap_sub_no | vc(4) | | 보조번호
''', uniques=[('request_id','line_no')], screens='ALM-210')
t('purchase','po_item','구매오더 항목','SAP 자산 PO 항목 (IF-MM-01, 계정지정 A)', '''
po_no | vc(10) | NN | EBELN
item_no | vc(5) | NN | EBELP
company_id | ->company | NN | 회사코드
vendor_id | ->vendor | | 공급사
vendor_name | vc(80) | | 공급사명(수신 원본)
description | vc(40) | NN | TXZ01
quantity | num(13,3) | NN | MENGE
unit_price | num(15,2) | | NETPR
cost_center_id | ->cost_center | | EKKN KOSTL
purchase_request_id | ->purchase_request | | ALM 구매요청에서 생성된 경우
gr_quantity | num(13,3) | NN =0 | 누적 입고 수량
is_deleted | bool | NN =false | LOEKZ. 입고 대기 취소
sap_synced_at | ts | | 마지막 수신
''', uniques=[('tenant_id','po_no','item_no')], screens='ALM-210')
t('purchase','po_item_asset','PO 지정 자산','PO 항목에 지정된 SAP 자산번호(EKKN). 항목당 여러 개', '''
po_item_id | ->po_item | NN | PO 항목
sap_asset_no | vc(12) | NN | ANLN1
sap_sub_no | vc(4) | NN | ANLN2
asset_id | ->asset | | 연결된 ALM 자산
''', uniques=[('po_item_id','sap_asset_no','sap_sub_no')], screens='ALM-210')
t('purchase','goods_receipt','입고','SAP 입고 문서 항목 (IF-MM-03). 101 수신 시 자산 생성', '''
po_item_id | ->po_item | NN | PO 항목
material_doc | vc(10) | NN | MBLNR
doc_year | int | NN | MJAHR
doc_item | vc(4) | NN | ZEILE
movement_type | vc(3) | NN | BWART 101 입고 / 102 취소
quantity | num(13,3) | NN | MENGE
posting_date | date | NN | BUDAT
assets_created_at | ts | | 자산 생성 완료 일시
''', uniques=[('tenant_id','material_doc','doc_year','doc_item')], screens='ALM-210')

# ---------------- request ----------------
t('request','asset_request','자산 요청','신규·변경·이관·폐기·매각 요청. 부서 관리자·자산회계 승인 후 SAP 전기', '''
request_no | vc(12) | NN | 요청번호 AR-nnnnn = SAP postingId, BKTXT
request_type | E:RequestType | NN | 요청 유형
status | E:RequestStatus | NN =SUBMITTED | 상태
source | E:RequestSource | NN =USER | 발생 출처
asset_id | ->asset | | 대상 자산(신규는 ALM 자산 생성 후 연결)
requester_id | ->app_user | NN | 요청자
submitted_at | ts | | 제출 일시
reason | vc(200) | | 사유
current_step | int | NN =1 | 현재 승인 단계 1 부서 관리자, 2 자산회계
asset_class_id | ->asset_class | | 신규: 자산클래스
acquisition_value | num(15,2) | | 신규: 예상 취득가
po_item_id | ->po_item | | 신규: 참조 PO
target_cost_center_id | ->cost_center | | 신규·이관: 코스트센터
target_room_id | ->room | | 변경: 새 룸
is_profit_center_change | bool | NN =false | 손익센터·세그먼트 변경 → ABUMN
changes | json | | 변경: {field: {before, after}}
effective_date | date | | 이관일·폐기일·가치일(BZDAT)
retire_type | E:RetireType | | 폐기 유형
sale_amount | num(15,2) | | 매각금액(SALE 필수)
buyer | vc(80) | | 매입처
count_item_id | ->count_item | | 실사 차이에서 생성
recon_diff_id | ->recon_diff | | 대사 차이에서 생성
completed_at | ts | | 전기 완료·반려 일시
''', uniques=[('tenant_id','request_no')], indexes=[('tenant_id','status'),('asset_id',)], screens='ALM-230')
t('request','approval','승인','자산 요청·구매요청의 단계별 승인. 둘 중 하나만 채움', '''
asset_request_id | ->asset_request | | 자산 요청
purchase_request_id | ->purchase_request | | 구매요청
step_no | int | NN | 단계 1 부서 관리자, 2 자산회계(최종)
approver_role | E:RoleCode | NN | 승인 역할
approver_id | ->app_user | | 승인자(결정 시 기록)
decision | E:ApprovalDecision | NN =PENDING | 결정
comment | vc(500) | | 의견
decided_at | ts | | 결정 일시
''', uniques=[('asset_request_id','step_no'),('purchase_request_id','step_no')], indexes=[('tenant_id','approver_role','decision')], screens='ALM-230, 210')

# ---------------- count ----------------
t('count','count_campaign','실사 캠페인','실물 실사 캠페인', '''
campaign_code | vc(6) | NN | 코드 (예: PI26Q4) = INVZU 접두어
name | vc(100) | NN | 이름
company_id | ->company | NN | 회사코드
key_date | date | NN | 기준일(SAP 키 데이트)
due_date | date | NN | 기한
status | E:CampaignStatus | NN =SCOPING | 단계
scope | json | NN | 범위 조건(사이트·룸·자산클래스)
scope_frozen_at | ts | | 범위 확정 일시(count_item 생성)
closed_at | ts | | 종료 일시
owner_id | ->app_user | NN | 담당 자산 관리자
''', uniques=[('tenant_id','campaign_code')], screens='ALM-240')
t('count','count_task','룸 실사 작업','캠페인 × 룸. 실사 담당자 배정 단위', '''
campaign_id | ->count_campaign | NN | 캠페인
room_id | ->room | NN | 룸
assignee_id | ->app_user | | 실사 담당자
status | E:CountTaskStatus | NN =NOT_STARTED | 상태
expected_count | int | NN =0 | 대상 자산 수
started_at | ts | | 시작
completed_at | ts | | 룸 완료(PDA-07)
''', uniques=[('campaign_id','room_id')], indexes=[('assignee_id','status')], screens='ALM-240, PDA-02')
t('count','count_item','실사 대상','캠페인 범위 확정 시 자산별 1행. 판정·차이 처리 결과', '''
campaign_id | ->count_campaign | NN | 캠페인
asset_id | ->asset | NN | 자산
task_id | ->count_task | NN | 등록 룸의 작업
expected_room_id | ->room | NN | 등록 룸(확정 시점)
result | E:CountResult | NN =PENDING | 판정
found_room_id | ->room | | 발견 룸
condition | E:AssetCondition | | 정상 / 파손 / 미사용
is_user_confirmed | bool | NN =false | 사용자 확인
note | vc(200) | | 메모
counted_by | ->app_user | | 실사자
counted_at | ts | | 실사 일시
needs_relabel | bool | NN =false | 라벨 재출력 요청
variance_action | E:VarianceAction | | 차이 처리
resolved_by | ->app_user | | 처리자
resolved_at | ts | | 처리 일시
''', uniques=[('campaign_id','asset_id')], indexes=[('task_id',),('campaign_id','result')], screens='ALM-240, PDA-05')
t('count','count_scan','스캔 기록','PDA 스캔 원본. 재전송 중복은 client_scan_id로 막음', '''
campaign_id | ->count_campaign | NN | 캠페인
task_id | ->count_task | | 룸 작업
room_id | ->room | NN | 스캔 위치 룸
client_scan_id | uuid | NN | PDA가 만든 UUID(멱등성)
device_id | ->pda_device | | 기기
scanned_by | ->app_user | NN | 실사자
barcode | vc(40) | NN | 읽은 값
input_method | vc(10) | NN | TRIGGER / CAMERA / MANUAL
result | E:ScanResult | NN | 판정
asset_id | ->asset | | 자산
count_item_id | ->count_item | | 실사 대상
condition | E:AssetCondition | | 상태 입력
note | vc(200) | | 메모
scanned_at | ts | NN | 기기 스캔 시각
received_at | ts | NN =now | 서버 수신 시각
''', uniques=[('tenant_id','client_scan_id')], indexes=[('campaign_id','scanned_at'),('count_item_id',)], mode='log', screens='PDA-04, 08')
t('count','count_unregistered','미등록 자산','실사 중 발견한 대장 미등록 자산. 사진은 attachment', '''
campaign_id | ->count_campaign | NN | 캠페인
temp_no | vc(12) | NN | 임시번호 UNREG-nnnn
room_id | ->room | NN | 발견 룸
category_id | ->category | | 카테고리
description | vc(100) | NN | 설명
serial_no | vc(40) | | 시리얼
scanned_barcode | vc(40) | | 읽은 값(있으면)
client_scan_id | uuid | NN | PDA UUID(멱등성)
reported_by | ->app_user | NN | 보고자
reported_at | ts | NN | 보고 일시
resolution | E:VarianceAction | | REGISTER / NON_ASSET
created_asset_id | ->asset | | 등록된 자산
resolved_by | ->app_user | | 처리자
resolved_at | ts | | 처리 일시
''', uniques=[('campaign_id','temp_no'),('tenant_id','client_scan_id')], screens='ALM-240, PDA-06')
t('count','pda_device','PDA 기기','실사 기기와 마지막 동기화', '''
device_serial | vc(40) | NN | 기기 시리얼
model | vc(40) | | 모델 (예: TC58)
app_version | vc(20) | | 앱 버전
last_user_id | ->app_user | | 마지막 사용자
last_sync_at | ts | | 마지막 동기화
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','device_serial')], screens='PDA-01')

# ---------------- label ----------------
t('label','label_template','라벨 템플릿','ZPL 라벨 템플릿', '''
template_code | vc(20) | NN | 코드
name | vc(60) | NN | 이름
layout | E:LabelLayout | NN | QR+Code128 / QR / Code128
width_in | num(4,2) | NN =2 | 폭(인치)
height_in | num(4,2) | NN =1 | 높이(인치)
dpi | int | NN =203 | 해상도
zpl | text | NN | ZPL 본문(치환 변수 포함)
is_default | bool | NN =false | 기본 템플릿
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','template_code')], screens='ALM-250')
t('label','printer','라벨 프린터','네트워크 라벨 프린터', '''
name | vc(60) | NN | 이름
site_id | ->site | | 사이트
host | vc(100) | NN | IP 또는 호스트
port | int | NN =9100 | 포트
dpi | int | NN =203 | 해상도
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','name')], screens='ALM-250')
t('label','label_print_job','라벨 출력','출력 대기열과 출력 이력', '''
asset_id | ->asset | NN | 자산
template_id | ->label_template | NN | 템플릿
printer_id | ->printer | | 프린터(출력 시 지정)
source | E:PrintSource | NN | 요청 출처
status | E:PrintStatus | NN =QUEUED | 상태
copies | int | NN =1 | 매수
requested_by | ->app_user | | 요청자
requested_at | ts | NN =now | 요청 일시
printed_at | ts | | 출력 일시
error_message | vc(500) | | 오류
''', indexes=[('tenant_id','status'),('asset_id',)], screens='ALM-250')

# ---------------- sap ----------------
t('sap','sap_posting','SAP 전기 큐','승인 완료 건의 전기 대기열 (IF-AA-03~07, IF-MM-02). claim 시 15분 잠금', '''
posting_id | vc(12) | NN | 요청번호(멱등성 키). 실사 결과는 캠페인코드-nnnnn
posting_type | E:PostingType | NN | 전기 유형
status | E:PostingStatus | NN =READY | 상태
company_id | ->company | NN | 회사코드
asset_request_id | ->asset_request | | 자산 요청
purchase_request_id | ->purchase_request | | 구매요청
count_item_id | ->count_item | | 실사 결과
asset_id | ->asset | | 대상 자산
posting_date | date | | 전기일
value_date | date | | 가치일 BZDAT
payload | json | NN | 전송 봉투 payload
approved_by | ->app_user | | 최종 승인자
approved_at | ts | | 최종 승인 일시
claim_batch_id | vc(40) | | 가져간 SAP 배치 ID
claimed_at | ts | | 가져간 일시
lease_until | ts | | 잠금 만료
attempt_count | int | NN =0 | 시도 횟수
result_at | ts | | 결과 수신
sap_document_no | vc(10) | | BELNR
sap_fiscal_year | int | | GJAHR
sap_asset_no | vc(12) | | 생성·이관된 자산번호
sap_sub_no | vc(4) | | 보조번호
sap_po_no | vc(10) | | 생성된 PO 번호
messages | json | | BAPI RETURN 메시지
''', uniques=[('tenant_id','posting_id')], indexes=[('tenant_id','status','lease_until')], screens='ALM-230, 310')
t('sap','sap_if_run','IF 실행 로그','SAP 호출 1회(배치 1건) 로그. 10년 보관', '''
interface_id | vc(10) | NN | IF ID (예: IF-AA-01)
direction | E:IfDirection | NN | 데이터 방향
batch_id | vc(40) | NN | 배치 ID
correlation_id | uuid | | X-Correlation-Id
sap_system | vc(10) | | X-SAP-System
http_status | int | | 응답 코드
record_count | int | NN =0 | 건수
success_count | int | NN =0 | 성공
error_count | int | NN =0 | 오류
status | E:IfStatus | NN | 결과
started_at | ts | NN | 시작
finished_at | ts | | 종료
''', indexes=[('tenant_id','interface_id','started_at')], mode='log', screens='ALM-310')
t('sap','sap_if_message','IF 건별 결과','IF 실행의 건별 결과. 오류 건은 원본 레코드 보관', '''
run_id | ->sap_if_run | NN | IF 실행
record_key | vc(40) | NN | 레코드 키 (예: 1000/000300001234/0000)
result | vc(10) | NN | OK / ERROR
error_code | vc(12) | | ALM 오류 코드 (예: ALM-E104)
message | vc(500) | | 메시지
payload | json | | 원본 레코드(오류 건만)
''', indexes=[('run_id',),('tenant_id','record_key')], mode='log', screens='ALM-310')
t('sap','idempotency_key','멱등성 키','Idempotency-Key 24시간 보관. 같은 키 재요청은 저장된 응답 반환', '''
endpoint | vc(80) | NN | API 경로
key | vc(80) | NN | Idempotency-Key
request_hash | vc(64) | NN | 요청 본문 SHA-256
response_status | int | | 응답 코드
response_body | json | | 응답 본문
expires_at | ts | NN | 만료(생성 + 24시간)
''', uniques=[('tenant_id','endpoint','key')], indexes=[('expires_at',)], mode='log', screens='-')
t('sap','recon_run','대사 실행','IF-RC-01 스냅샷 1회와 대사 결과 요약', '''
run_type | vc(10) | NN | WEEKLY / CAMPAIGN
batch_id | vc(40) | NN | SAP 배치 ID
count_campaign_id | ->count_campaign | | 실사 종료 대사
status | E:RunStatus | NN =RUNNING | 상태
snapshot_at | ts | NN | 스냅샷 시각
sap_count | int | NN =0 | SAP 자산 수
alm_count | int | NN =0 | ALM 자본화 자산 수
diff_count | int | NN =0 | 차이 수
''', uniques=[('tenant_id','batch_id')], screens='ALM-310')
t('sap','recon_snapshot','대사 스냅샷','SAP 자본화 자산 스냅샷 원본(분할 수신)', '''
run_id | ->recon_run | NN | 대사 실행
company_code | vc(4) | NN | BUKRS
sap_asset_no | vc(12) | NN | ANLN1
sap_sub_no | vc(4) | NN | ANLN2
inventory_no | vc(25) | | INVNR
serial_no | vc(18) | | SERNR
cost_center_code | vc(10) | | KOSTL
location | vc(10) | | STORT
room_no | vc(8) | | RAUMNR
deact_date | date | | DEAKT
''', uniques=[('run_id','company_code','sap_asset_no','sap_sub_no')], mode='log', screens='ALM-310')
t('sap','recon_diff','대사 차이','차이 1건과 조치', '''
run_id | ->recon_run | NN | 대사 실행
diff_type | E:ReconDiffType | NN | 차이 유형
asset_id | ->asset | | ALM 자산
sap_asset_no | vc(12) | | ANLN1
sap_sub_no | vc(4) | | ANLN2
alm_value | vc(100) | | ALM 값
sap_value | vc(100) | | SAP 값
action | E:ReconAction | NN | 조치(기본값은 규칙으로 제안)
status | E:ReconStatus | NN =OPEN | 처리 상태
sap_posting_id | ->sap_posting | | ALM 값 전송 시 전기 건
resolved_by | ->app_user | | 처리자
resolved_at | ts | | 처리 일시
''', indexes=[('run_id','status')], screens='ALM-310')
t('sap','field_mapping','필드 매핑','ALM 필드 ↔ SAP 필드와 기준 시스템(F-310-06)', '''
alm_field | vc(60) | NN | ALM 테이블.컬럼
sap_table | vc(30) | | SAP 테이블
sap_field | vc(30) | | SAP 필드
master_system | E:MasterSystem | NN | 기준 시스템
interface_ids | vc(100) | | 사용 IF
description | vc(200) | | 설명
''', uniques=[('tenant_id','alm_field')], screens='ALM-310')
t('sap','sap_connection','SAP 연결','SAP 시스템과 API 클라이언트. 비밀은 Secrets Manager', '''
system_id | vc(10) | NN | 시스템 ID-클라이언트 (예: PRD-100)
company_id | ->company | NN | 회사코드
oauth_client_id | vc(100) | NN | OAuth 클라이언트 ID
last_call_at | ts | | 마지막 호출
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','system_id','company_id'),('oauth_client_id',)], screens='ALM-310')

t('sap','sap_run_request','SAP 실행 요청','화면의 수동 실행 요청(F-310-04). SAP 잡이 GET /sap/run-requests로 가져가 실행', '''
interface_id | vc(10) | NN | 실행할 수신 IF (IF-MD-01, IF-AA-01, IF-AA-02, IF-MM-01, IF-RC-01)
params | json | | 실행 조건 (IF-RC-01: runType, campaignCode / IF-AA-02: isClosing)
status | vc(10) | NN ='PENDING' | PENDING / PICKED / DONE / CANCELLED
requested_by | ->app_user | NN | 요청자
requested_at | ts | NN =now | 요청 일시
picked_at | ts | | SAP이 가져간 일시
sap_if_run_id | ->sap_if_run | | 실행 결과 로그
done_at | ts | | 완료 일시
''', indexes=[('tenant_id','status')], screens='ALM-310')

# ---------------- common ----------------
t('common','code','공통 코드','고객이 바꾸는 코드값(폐기 사유, 실사 비고 등)', '''
code_group | vc(30) | NN | 코드 그룹
code | vc(30) | NN | 코드
label_en | vc(100) | NN | 영문 이름
label_ko | vc(100) | | 한글 이름
sort_order | int | NN =0 | 정렬 순서
attributes | json | | 추가 속성
is_active | bool | NN =true | 사용 여부
''', uniques=[('tenant_id','code_group','code')], screens='공통')
t('common','setting','설정','테넌트 설정값 (예: 라이선스 과잉 기준 80%, 자본화 기준금액)', '''
key | vc(60) | NN | 설정 키
value | json | NN | 값
description | vc(200) | | 설명
''', uniques=[('tenant_id','key')], screens='공통')
t('common','number_sequence','채번','업무 번호 채번(AT-, AR-, PR-, UNREG-). 행 잠금으로 증가', '''
seq_name | vc(30) | NN | ASSET_TAG / ASSET_REQUEST / PURCHASE_REQUEST / UNREG
prefix | vc(10) | NN | 접두어 (예: AT-)
next_value | bigint | NN =1 | 다음 번호
padding | int | NN =6 | 자릿수
''', uniques=[('tenant_id','seq_name')], screens='-')
t('common','attachment','첨부','사진·문서. 파일은 S3, 메타만 저장', '''
owner_type | vc(30) | NN | 대상 테이블 (asset, count_item, count_unregistered, asset_request, contract)
owner_id | uuid | | 대상 행 id. PDA 사진은 업로드 직후 비어 있음
kind | vc(20) | NN ='DOCUMENT' | PHOTO / DOCUMENT
file_name | vc(200) | NN | 파일명
content_type | vc(100) | NN | MIME
size_bytes | bigint | NN | 크기
s3_key | vc(500) | NN | S3 객체 키
sha256 | vc(64) | | 해시
linked_at | ts | | 대상 연결 일시. 비어 있으면 업로드 대기(24시간 뒤 정리)
''', indexes=[('tenant_id','owner_type','owner_id')], screens='공통')
t('common','notification','알림','이메일·화면 알림 발송 기록', '''
channel | E:NotificationChannel | NN | 채널
recipient_id | ->app_user | | 수신자
recipient_email | vc(254) | | 수신 이메일
template | vc(40) | NN | 템플릿 (예: CONTRACT_EXPIRY_90)
subject_type | vc(30) | | 대상 테이블
subject_id | uuid | | 대상 행 id
title | vc(200) | NN | 제목
status | E:NotificationStatus | NN =QUEUED | 상태
sent_at | ts | | 발송 일시
error_message | vc(500) | | 오류
dedupe_key | vc(120) | | 중복 발송 방지 키
''', uniques=[('tenant_id','dedupe_key')], indexes=[('recipient_id','status')], screens='공통')
t('common','audit_log','감사 로그','모든 테이블의 생성·변경 전후값. 10년 보관, 월 파티션', '''
table_name | vc(63) | NN | 테이블
row_id | uuid | NN | 행 id
action | E:AuditAction | NN | 동작
before | json | | 변경 전
after | json | | 변경 후
actor_id | uuid | | 사용자 id(FK 없음, 사용자 삭제 대비)
actor_type | vc(10) | NN | USER / SYSTEM / SAP / PDA
correlation_id | uuid | | 요청 추적 ID
ip_address | inet | | 접속 IP
occurred_at | ts | NN =now | 발생 일시
''', indexes=[('tenant_id','table_name','row_id'),('tenant_id','occurred_at')], mode='log', screens='공통')
