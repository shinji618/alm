# ALM web screen API (WBS 2.6 remainder). Registers schemas/endpoints into spec_api.
from spec_api import schema, ep, S, E

def lst(item, desc):
    schema(item + 'List', desc, f'''
items | [{item}] | Y | 행
page | int | Y | 페이지(1부터)
pageSize | int | Y | 페이지 크기
total | int | Y | 전체 건수
''')

def W(area, method, path, op, summary, roles, req, resp, codes, tables, ref, rules, idem='-', params=None, ok='200'):
    ep('web', method, path, op, summary, roles, req, resp, codes, tables, ref, rules, idem=idem, params=params, ok=ok)
    E[-1]['area'] = area

PG = [('page','query','int','N','페이지(기본 1)'),('pageSize','query','int','N','페이지 크기(기본 50, 최대 500)'),
      ('sort','query','string','N','정렬. 필드명, 내림차순은 - (예: -updatedAt,assetTag)')]
ID = lambda n='id', d='id': (n,'path','uuid','Y',d)
ALL = '전체'
AM = 'ASSET_MANAGER, SYS_ADMIN'
AC = 'ASSET_ACCOUNTANT, SYS_ADMIN'
SA = 'SYS_ADMIN'

# ---------------- common ----------------
schema('Me', '로그인 사용자', '''
userId | uuid | Y | app_user.id
displayName | string | Y | 이름
email | string | Y | 이메일
locale | enum(en,ko) | Y | 화면 언어
tenantCode | string | Y | 테넌트
roles | [RoleScope] | Y | 역할과 범위
permissions | [string] | Y | 화면·기능 권한 키 (예: asset.write, amount.read)
navCounts | object | Y | 메뉴 배지 수 {requests, counts, sap}
''')
schema('RoleScope', '역할과 범위', '''
role | enum(SYS_ADMIN,ASSET_MANAGER,DEPT_MANAGER,ASSET_ACCOUNTANT,COUNTER,EMPLOYEE) | Y | 역할
companyCode | string(4) | N | 회사코드 범위(비면 전체)
siteCode | string(10) | N | 사이트 범위(비면 전체)
''')
schema('MePatch', '내 설정 변경', '''
locale | enum(en,ko) | N | 화면 언어
''')
schema('LookupItem', '드롭다운 항목', '''
id | uuid | Y | id
code | string | Y | 코드
label | string | Y | 이름(사용자 언어)
parentId | uuid | N | 상위(룸 → 사이트, 모델 → 카테고리)
extra | object | N | 추가 값(코스트센터의 손익센터 등)
''')
schema('Lookups', '드롭다운 값 묶음. 요청한 type만 채움', '''
companies | [LookupItem] | N | 회사코드
sites | [LookupItem] | N | 사이트
rooms | [LookupItem] | N | 룸
costCenters | [LookupItem] | N | 코스트센터(활성)
assetClasses | [LookupItem] | N | 자산클래스
categories | [LookupItem] | N | 카테고리
models | [LookupItem] | N | 모델
vendors | [LookupItem] | N | 공급사
users | [LookupItem] | N | 사용자(q로 검색, 최대 50)
codes | object | N | 공통 코드 {그룹: [LookupItem]}
''')
schema('SearchHit', '전역 검색 결과', '''
kind | enum(ASSET,REQUEST,CONTRACT,LICENSE,CI) | Y | 대상 종류
id | uuid | Y | id
title | string | Y | 표시 이름 (예: AT-000123 · Latitude 7440)
subtitle | string | N | 보조 정보(시리얼, 사용자, 상태)
url | string | Y | 화면 경로 (예: /assets/{id})
''')
schema('SearchResult', '전역 검색', '''
items | [SearchHit] | Y | 종류별 최대 5건
''')
schema('NotificationItem', '화면 알림', '''
id | uuid | Y | id
template | string | Y | 알림 종류
title | string | Y | 제목
url | string | N | 이동 경로
createdAt | datetime | Y | 생성
readAt | datetime | N | 읽은 일시
''')
lst('NotificationItem', '알림 목록')
schema('AttachmentPresign', '파일 업로드 URL 요청', '''
ownerType | enum(asset,asset_request,contract,count_item,count_unregistered) | Y | 대상 종류
ownerId | uuid | Y | 대상 id
fileName | string(200) | Y | 파일명
contentType | string(100) | Y | MIME (이미지, PDF, Office)
sizeBytes | int | Y | 크기(최대 25 MB)
sha256 | string(64) | Y | 해시
kind | enum(PHOTO,DOCUMENT) | Y | 종류
''')
schema('Attachment', '첨부', '''
id | uuid | Y | id
fileName | string | Y | 파일명
contentType | string | Y | MIME
sizeBytes | int | Y | 크기
kind | enum(PHOTO,DOCUMENT) | Y | 종류
uploadedBy | string | Y | 올린 사람
createdAt | datetime | Y | 올린 일시
''')
schema('AttachmentList', '첨부 목록', '''
items | [Attachment] | Y | 첨부
''')
schema('DownloadUrl', '다운로드 URL', '''
url | string | Y | S3 presigned GET URL(5분)
expiresAt | datetime | Y | 만료
''')
schema('ExportRequest', '엑셀·CSV 내보내기 요청', '''
resource | enum(assets,licenses,contracts,asset-requests,count-items,recon-diffs,sap-runs) | Y | 대상 목록
filters | object | Y | 목록 API와 같은 필터
format | enum(xlsx,csv) | Y | 형식
columns | [string] | N | 열(비면 화면 기본 열)
''')
schema('ExportJob', '내보내기 작업', '''
id | uuid | Y | 작업 id
status | enum(QUEUED,RUNNING,DONE,FAILED) | Y | 상태
rowCount | int | N | 행 수
downloadUrl | string | N | DONE이면 URL(10분)
error | string | N | 실패 사유
''')

W('공통','GET','/me','getMe','로그인 사용자·권한','로그인 사용자',None,'Me','200, 401','app_user, user_role','앱 셸',
  ['permissions로 메뉴·버튼을 감춘다. 서버는 같은 권한을 API마다 다시 확인한다.', 'navCounts = 승인 대기, 진행 중 실사 차이, SAP 오류 수.'])
W('공통','PATCH','/me','patchMe','내 설정 변경','로그인 사용자','MePatch','Me','200, 400','app_user','앱 셸',['locale을 바꾸면 이후 응답의 이름·메시지가 그 언어로 온다.'])
W('공통','GET','/lookups','getLookups','드롭다운 값','로그인 사용자',None,'Lookups','200','company, site, room, cost_center, asset_class, category, model, vendor, app_user, code','전체',
  ['types에 적은 것만 돌려준다. 응답은 5분 캐시(ETag).', '사용자 범위(회사코드·사이트) 밖의 값은 빼고 돌려준다.'],
  params=[('types','query','string','Y','쉼표 구분 (예: sites,rooms,costCenters)'),('q','query','string','N','users 검색어'),('siteId','query','uuid','N','rooms 필터')])
W('공통','GET','/search','search','전역 검색(Top bar)','로그인 사용자',None,'SearchResult','200','asset, asset_request, contract, license, config_item','앱 셸',
  ['자산은 태그·시리얼·호스트명·IP·사용자 이름 부분 일치, 나머지는 번호·이름.', 'Enter 키는 /assets?q= 로 이동(자산 목록 검색).'],
  params=[('q','query','string','Y','검색어(2자 이상)')])
W('공통','GET','/notifications','listNotifications','화면 알림','로그인 사용자',None,'NotificationItemList','200','notification','앱 셸',[ '최근 90일.'],
  params=[('unread','query','bool','N','안 읽은 것만')] + PG[:2])
W('공통','POST','/notifications/{id}:read','readNotification','알림 읽음','로그인 사용자',None,'NotificationItem','200, 404','notification','앱 셸',['멱등.'],params=[ID()])
W('공통','POST','/attachments:presign','presignAttachment','파일 업로드 URL','대상 화면의 쓰기 권한','AttachmentPresign','PresignResponse','200, 400, 403, 413','attachment','ALM-111, 220, 230, 240',
  ['대상이 있으므로 owner_id·linked_at을 발급 때 채운다(PDA와 다름).', '최대 25 MB. 실행 파일 형식은 거부.'])
W('공통','GET','/attachments/{id}:download','downloadAttachment','파일 다운로드 URL','대상 화면의 조회 권한',None,'DownloadUrl','200, 403, 404','attachment','공통',[ 'S3 presigned GET 5분.'],params=[ID()])
W('공통','POST','/exports','createExport','엑셀·CSV 내보내기','목록 조회 권한','ExportRequest','ExportJob','202, 400, 403','-','ALM-110, 140, 220, 230, 240, 310',
  ['비동기. 5만 행까지 30초 안 목표. 금액 열은 amount.read 권한이 있을 때만 포함.'], ok='202')
W('공통','GET','/exports/{id}','getExport','내보내기 상태','요청자',None,'ExportJob','200, 404','-','공통',['파일은 24시간 뒤 삭제.'],params=[ID()])

# ---------------- dashboard ----------------
schema('Kpi', 'KPI 1개', '''
key | enum(activeAssets,nbv,warrantyExpiring,licenseCompliance,countVariance,sapErrors) | Y | KPI
value | number | Y | 값
unit | enum(count,usd,percent) | Y | 단위
secondary | number | N | 보조 값(예: NBV 옆 APC)
link | string | Y | 클릭 시 이동 경로(필터 포함)
''')
schema('StageCount', '라이프사이클 단계별 수', '''
stage | enum(PLAN,PROCURE,DEPLOY,OPERATE,MAINTAIN,RETIRE) | Y | 단계
count | int | Y | 자산 수
''')
schema('CategoryRow', '카테고리별 현황', '''
categoryId | uuid | Y | 카테고리
name | string | Y | 이름
total | int | Y | 자산 수
inUse | int | Y | 사용
inStock | int | Y | 재고
pastUsefulLife | int | Y | 내용연수 경과
nbv | number | N | 장부가액(amount.read 권한)
''')
schema('RenewalRow', '갱신 예정', '''
kind | enum(CONTRACT,WARRANTY,LICENSE) | Y | 종류
id | uuid | Y | id
name | string | Y | 이름
endDate | date | Y | 만료일
daysLeft | int | Y | 남은 일수
amount | number | N | 금액
''')
schema('ActionItem', '조치 필요 항목', '''
kind | enum(SCAN_FAILED,LICENSE_SHORTAGE,UNMANAGED_DEVICE,APPROVAL_PENDING,POSTING_ERROR) | Y | 종류
count | int | Y | 건수
link | string | Y | 이동 경로
''')
schema('Dashboard', '대시보드 한 번에', '''
asOf | datetime | Y | 집계 시각(최대 5분 캐시)
kpis | [Kpi] | Y | KPI 6종
stages | [StageCount] | Y | 단계 6개
categories | [CategoryRow] | Y | 카테고리별
renewals | [RenewalRow] | Y | 120일 이내 만료
actions | [ActionItem] | Y | 조치 필요
''')
W('대시보드','GET','/dashboard','getDashboard','대시보드 위젯 전체','로그인 사용자(범위 내)',None,'Dashboard','200','v_asset_stage, v_asset_value_latest, v_license_compliance, contract, count_item, sap_posting','ALM-010',
  ['위젯을 한 번에 돌려준다. 5분 캐시, refresh=true면 다시 계산.', '금액(nbv, APC)은 amount.read 권한이 없으면 null.', '갱신 예정의 색 기준(30일 빨강, 60일 주황)은 화면이 daysLeft로 정한다.'],
  params=[('siteId','query','uuid','N','사이트 필터'),('refresh','query','bool','N','캐시 무시')])

# ---------------- assets ----------------
schema('AssetSummary', '자산 목록 행', '''
id | uuid | Y | id
assetTag | string(25) | Y | 자산태그
description | string(50) | Y | 자산명
categoryName | string | Y | 카테고리
modelName | string | N | 모델
serialNo | string(40) | N | 시리얼
status | enum(ON_ORDER,IN_STOCK,IN_USE,IN_REPAIR,MISSING,RETIRED,DISPOSED) | Y | 상태
stage | enum(PLAN,PROCURE,DEPLOY,OPERATE,MAINTAIN,RETIRE) | Y | 단계
siteCode | string | N | 사이트
roomCode | string | N | 룸
assignedUserName | string | N | 사용자
costCenterCode | string | N | 코스트센터
sapAssetNo | string | N | SAP 자산번호 ANLN1-ANLN2
warrantyEndDate | date | N | 보증 종료
nbv | number | N | 장부가액(권한 없으면 null)
updatedAt | datetime | Y | 변경 일시
''')
lst('AssetSummary', '자산 목록')
schema('AssetFinancial', 'Financial & SAP 탭(amount.read 권한 없으면 금액 null)', '''
isCapitalized | bool | Y | 자본화 자산
companyCode | string(4) | Y | 회사코드
sapAssetNo | string(12) | N | ANLN1
sapSubNo | string(4) | N | ANLN2
assetClass | string(8) | N | 자산클래스
capDate | date | N | 취득일
acquisitionValue | number | N | 취득가(APC)
accumDepreciation | number | N | 감가상각누계액
netBookValue | number | N | 장부가액
usefulLifeYears | int | N | 내용연수
valueAsOf | string | N | 금액 기준 회계연도·기간 (예: 2026/009)
tcoEstimate | number | N | TCO 추정(구매가 + 계약 금액 배분)
sapSyncedAt | datetime | N | 마지막 SAP 수신
''')
schema('AssetDetail', '자산 상세(General 탭 + 요약)', '''
id | uuid | Y | id
version | int | Y | 낙관적 잠금 값(수정 시 If-Match)
assetTag | string(25) | Y | 자산태그
description | string(50) | Y | 자산명
categoryId | uuid | Y | 카테고리
modelId | uuid | N | 모델
serialNo | string(40) | N | 시리얼
status | enum(ON_ORDER,IN_STOCK,IN_USE,IN_REPAIR,MISSING,RETIRED,DISPOSED) | Y | 상태
stage | enum(PLAN,PROCURE,DEPLOY,OPERATE,MAINTAIN,RETIRE) | Y | 단계
source | string | Y | 생성 출처
siteId | uuid | N | 사이트
roomId | uuid | N | 룸
costCenterId | uuid | N | 코스트센터
assignedUserId | uuid | N | 사용자
assignedAt | datetime | N | 할당 일시
dueBackDate | date | N | 반납 예정일
hostname | string(63) | N | 호스트명
ipAddress | string | N | IP
macAddress | string(17) | N | MAC
osName | string(60) | N | OS
warrantyEndDate | date | N | 보증 종료
lastCountDate | date | N | 마지막 실사일
lastSeenAt | datetime | N | Discovery 마지막 확인
notes | string | N | 메모
financial | AssetFinancial | Y | Financial & SAP
openRequests | [RequestRef] | Y | 진행 중인 요청
editableFields | [string] | Y | 이 사용자가 지금 고칠 수 있는 필드
''')
schema('RequestRef', '요청 참조', '''
id | uuid | Y | id
requestNo | string | Y | AR-nnnnn
requestType | string | Y | 유형
status | string | Y | 상태
''')
schema('AssetCreate', '자산 등록(ALM-112)', '''
categoryId | uuid | Y | 카테고리
modelId | uuid | Y | 모델
description | string(50) | Y | 자산명
serialNo | string(40) | N | 시리얼
companyId | uuid | Y | 회사코드
roomId | uuid | Y | 위치(룸)
costCenterId | uuid | Y | 코스트센터
assetClassId | uuid | N | 자산클래스(비면 카테고리 기본값)
status | enum(ON_ORDER,IN_STOCK,IN_USE) | N | 기본 IN_STOCK
assignedUserId | uuid | N | IN_USE면 필수
purchaseDate | date | N | 구매일
purchaseCost | number | N | 구매가(예상 취득가로도 사용)
warrantyEndDate | date | N | 보증 종료
hostname | string(63) | N | 호스트명
notes | string | N | 메모
printLabel | bool | N | 등록 후 라벨 출력 대기열에 추가(기본 true)
''')
schema('AssetCreated', '자산 등록 결과', '''
asset | AssetDetail | Y | 등록된 자산
createdRequest | RequestRef | N | 자본화 클래스면 생성된 신규 자산 요청(AS01)
labelJobId | uuid | N | 라벨 출력 작업
''')
schema('AssetPatch', '자산 수정. 보낸 필드만 바꿈', '''
description | string(50) | N | 자산명(자본화 자산은 변경 요청 자동 생성)
modelId | uuid | N | 모델
serialNo | string(40) | N | 시리얼(자본화 자산은 SAP 전송)
roomId | uuid | N | 룸(자본화 자산은 STORT 변경 요청 자동 생성)
hostname | string(63) | N | 호스트명
ipAddress | string | N | IP
macAddress | string(17) | N | MAC
warrantyEndDate | date | N | 보증 종료
dueBackDate | date | N | 반납 예정일
notes | string | N | 메모
''')
schema('AssetChangeResult', '변경 결과', '''
asset | AssetDetail | Y | 변경 후 자산
createdRequests | [RequestRef] | Y | 자동 생성된 요청(SAP 반영이 필요한 변경)
''')
schema('CheckOut', '할당(F-111-04)', '''
userId | uuid | Y | 사용자
costCenterId | uuid | N | 코스트센터(비면 사용자 소속)
roomId | uuid | Y | 위치
dueBackDate | date | N | 반납 예정일
note | string(200) | N | 메모
''')
schema('CheckIn', '반납(F-111-05)', '''
roomId | uuid | N | 반납 위치(비면 사이트의 IT 창고 룸)
condition | enum(GOOD,DAMAGED,UNUSED) | N | 상태
note | string(200) | N | 메모
''')
schema('RepairMove', '수리 입고·출고', '''
direction | enum(IN,OUT) | Y | IN 수리 입고 → IN_REPAIR, OUT 수리 완료 → 이전 상태
vendorId | uuid | N | 수리 업체
ticketNo | string(30) | N | 관련 티켓
note | string(200) | N | 메모
''')
schema('AssetEventItem', 'History 탭 행', '''
id | uuid | Y | id
eventType | string | Y | 이력 유형
occurredAt | datetime | Y | 일시
actorName | string | N | 처리자(비면 시스템)
channel | string | Y | UI / API / SAP / PDA / DISCOVERY
changes | object | N | {field: {before, after}}
reason | string | N | 사유
requestNo | string | N | 관련 요청
sapDocumentNo | string | N | SAP 전표
''')
lst('AssetEventItem', '자산 이력')
schema('AssetValueRow', '기간별 SAP 금액', '''
fiscalYear | int | Y | 회계연도
period | int | Y | 기간
acquisitionValue | number | Y | APC
accumDepreciation | number | Y | 누계액
netBookValue | number | Y | NBV
''')
schema('AssetValueList', '기간별 금액', '''
items | [AssetValueRow] | Y | 최근 순
''')
schema('AssignmentRow', '할당 이력', '''
userName | string | N | 사용자
costCenterCode | string | N | 코스트센터
roomCode | string | N | 룸
checkedOutAt | datetime | Y | 할당
dueBackDate | date | N | 반납 예정
returnedAt | datetime | N | 반납
''')
schema('AssignmentList', '할당 이력', '''
items | [AssignmentRow] | Y | 최근 순
''')
schema('SoftwareRow', '설치 소프트웨어', '''
rawName | string | Y | 설치명
productName | string | N | 매칭 제품
version | string | N | 버전
isLicensed | bool | Y | 라이선스 보유 제품
lastSeenAt | datetime | Y | 최근 수집
''')
schema('SoftwareList', '설치 소프트웨어', '''
items | [SoftwareRow] | Y | 행
''')
schema('TicketRow', '연결 티켓', '''
itsmSystem | string | Y | ITSM
ticketNo | string | Y | 번호
ticketType | string | Y | INCIDENT / CHANGE
title | string | N | 제목
status | string | N | 상태
openedAt | datetime | N | 접수
ciName | string | Y | 연결 CI
''')
schema('TicketList', '티켓', '''
items | [TicketRow] | Y | 행
''')
AF = [('q','query','string','N','태그·시리얼·호스트명·IP·사용자 부분 일치'),('categoryId','query','uuid','N','카테고리(하위 포함)'),
      ('siteId','query','uuid','N','사이트'),('roomId','query','uuid','N','룸'),('status','query','string','N','상태, 쉼표 구분'),
      ('stage','query','string','N','단계, 쉼표 구분'),('costCenterId','query','uuid','N','코스트센터'),('assignedUserId','query','uuid','N','사용자'),
      ('quick','query','enum(WARRANTY_90,PAST_USEFUL_LIFE,NON_SAP,UNCOUNTED_1Y)','N','빠른 필터')] + PG
W('자산','GET','/assets','listAssets','자산 목록','로그인 사용자(범위 내)',None,'AssetSummaryList','200, 400','asset, v_asset_stage, v_asset_value_latest','ALM-110',
  ['EMPLOYEE는 본인 할당 자산만. 그 외 역할은 회사코드·사이트 범위.', '5만 건에서 2초 이내(인덱스: status, room, cost_center, 사용자, 태그·시리얼 trigram).', '기본 정렬 -updatedAt.'], params=AF)
W('자산','POST','/assets','createAsset','자산 등록','ASSET_MANAGER','AssetCreate','AssetCreated','201, 400, 403, 422','asset, number_sequence, asset_request, label_print_job, asset_event','ALM-112',
  ['자산태그는 AT-nnnnnn 자동 채번.', '자산클래스가 자본화 대상이면 신규 자산 요청(NEW_ASSET)을 자동 생성하고 승인 단계로 보낸다.', 'IN_USE면 asset_assignment 행도 만든다.'], idem='Idempotency-Key', ok='201')
W('자산','GET','/assets/{id}','getAsset','자산 상세','로그인 사용자(범위 내)',None,'AssetDetail','200, 403, 404','asset, v_asset_stage, v_asset_value_latest, asset_request','ALM-111',[ '응답 ETag = version.'],params=[ID()])
W('자산','PATCH','/assets/{id}','patchAsset','자산 수정','ASSET_MANAGER','AssetPatch','AssetChangeResult','200, 400, 403, 409, 422','asset, asset_event, asset_request','ALM-111',
  ['If-Match: version 필수. 다르면 409 ALM-E310(다른 사람이 먼저 수정).', 'SAP 기준 필드(자산클래스, 취득가, 코스트센터)는 여기서 못 바꾼다(422 ALM-E211). 코스트센터는 할당 또는 이관 요청으로.', '자본화 자산의 시리얼·룸·자산명 변경은 ALM에 바로 반영하고 ASSET_CHANGE 요청을 자동 생성해 SAP에 보낸다.'],
  params=[ID(),('If-Match','header','string','Y','version 값')])
W('자산','POST','/assets/{id}:check-out','checkOutAsset','할당','ASSET_MANAGER','CheckOut','AssetChangeResult','200, 400, 403, 409','asset, asset_assignment, asset_event, asset_request','ALM-111',
  ['상태 IN_USE. 코스트센터가 바뀌고 자본화 자산이면 이관 요청을 자동 생성한다(손익센터·세그먼트가 같으면 CHANGE, 다르면 TRANSFER).', '코스트센터 값은 SAP 전기가 끝난 뒤에 바뀐다.'], idem='Idempotency-Key', params=[ID()])
W('자산','POST','/assets/{id}:check-in','checkInAsset','반납','ASSET_MANAGER','CheckIn','AssetChangeResult','200, 400, 403, 409','asset, asset_assignment, asset_event','ALM-111',
  ['상태 IN_STOCK, 할당 종료. 위치가 비면 사이트의 IT 창고 룸(is_storage).'], idem='Idempotency-Key', params=[ID()])
W('자산','POST','/assets/{id}:repair','moveRepair','수리 입고·출고','ASSET_MANAGER','RepairMove','AssetChangeResult','200, 400, 403, 409','asset, asset_event','ALM-111',
  ['IN: IN_REPAIR. OUT: 수리 전 상태로 되돌림.'], idem='Idempotency-Key', params=[ID()])
W('자산','GET','/assets/{id}/history','listAssetHistory','자산 이력','로그인 사용자(범위 내)',None,'AssetEventItemList','200, 404','asset_event','ALM-111',[ '최근 순. 금액 변경은 amount.read 권한이 있을 때만 값 표시.'],params=[ID()]+PG[:2])
W('자산','GET','/assets/{id}/values','listAssetValues','기간별 SAP 금액','amount.read',None,'AssetValueList','200, 403, 404','asset_value','ALM-111',[ '상각영역 01, 최근 24기간.'],params=[ID()])
W('자산','GET','/assets/{id}/assignments','listAssetAssignments','할당 이력','로그인 사용자(범위 내)',None,'AssignmentList','200, 404','asset_assignment','ALM-111',[ '최근 순.'],params=[ID()])
W('자산','GET','/assets/{id}/contracts','listAssetContracts','연결 계약','로그인 사용자(범위 내)',None,'ContractSummaryList','200, 404','contract_asset, contract','ALM-111',[ '보증은 자산 속성(warrantyEndDate)으로 따로 보여준다.'],params=[ID()])
W('자산','GET','/assets/{id}/software','listAssetSoftware','설치 소프트웨어','로그인 사용자(범위 내)',None,'SoftwareList','200, 404','software_install, software_product','ALM-111',[ 'is_removed 제외.'],params=[ID()])
W('자산','GET','/assets/{id}/tickets','listAssetTickets','연결 티켓','로그인 사용자(범위 내)',None,'TicketList','200, 404','ticket_link, config_item','ALM-111',[ '자산의 CI와 그 상위 CI의 티켓.'],params=[ID()])
W('자산','GET','/assets/{id}/attachments','listAssetAttachments','첨부','로그인 사용자(범위 내)',None,'AttachmentList','200, 404','attachment','ALM-111',[ '실사 사진(count_item)도 함께.'],params=[ID()])

# ---------------- discovery ----------------
schema('DiscoveryJob', '수집 작업', '''
id | uuid | Y | id
name | string(100) | Y | 이름
method | enum(AGENT,NETWORK_SCAN,VCENTER) | Y | 방식
targets | object | Y | IP 대역·vCenter URL
scheduleCron | string(50) | N | 주기
credentialRef | string(200) | N | Secrets Manager ARN
siteId | uuid | N | 사이트
isActive | bool | Y | 사용
lastRunAt | datetime | N | 마지막 실행
lastRunStatus | string | N | 마지막 결과
''')
lst('DiscoveryJob', '수집 작업 목록')
schema('DiscoveryJobInput', '수집 작업 저장', '''
name | string(100) | Y | 이름
method | enum(AGENT,NETWORK_SCAN,VCENTER) | Y | 방식
targets | object | Y | 대상
scheduleCron | string(50) | N | 주기
credentialRef | string(200) | N | Secrets Manager ARN(비밀번호는 받지 않음)
siteId | uuid | N | 사이트
isActive | bool | N | 사용
''')
schema('DiscoveryRun', '수집 실행', '''
id | uuid | Y | id
jobName | string | N | 작업
status | string | Y | 상태
startedAt | datetime | N | 시작
finishedAt | datetime | N | 종료
foundCount | int | Y | 수집
newCount | int | Y | 신규
conflictCount | int | Y | 충돌
''')
lst('DiscoveryRun', '수집 실행 목록')
schema('DiscoveryItemRow', '대사 큐 행', '''
id | uuid | Y | id
collectedAt | datetime | Y | 수집 일시
hostname | string | N | 호스트명
serialNo | string | N | 시리얼
manufacturer | string | N | 제조사
model | string | N | 모델
ipAddress | string | N | IP
macAddress | string | N | MAC
matchStatus | enum(NEW,CONFLICT,UNMANAGED,MATCHED,IGNORED) | Y | 분류
matchRule | string | N | 매칭 규칙
matchedAssetTag | string | N | 매칭 자산
conflictFields | object | N | {field: {alm, discovered}}
''')
lst('DiscoveryItemRow', '대사 큐')
schema('DiscoveryResolve', '대사 큐 처리(여러 건)', '''
items | [DiscoveryResolveItem] | Y | 최대 200건
''')
schema('DiscoveryResolveItem', '대사 큐 처리 1건', '''
id | uuid | Y | discovery_item.id
action | enum(REGISTER,UPDATE,QUARANTINE,IGNORE) | Y | 등록 / ALM 갱신 / 격리+티켓 / 무시
assetId | uuid | N | UPDATE 대상(비면 매칭 자산)
fields | [string] | N | UPDATE할 필드(비면 충돌 필드 전부)
asset | AssetCreate | N | REGISTER 값(비면 수집값으로 채움)
''')
schema('BulkResult', '여러 건 처리 결과', '''
results | [BulkItemResult] | Y | 건별
''')
schema('BulkItemResult', '건별 결과', '''
id | uuid | Y | 대상 id
status | enum(OK,ERROR) | Y | 결과
code | string | N | 오류 코드
message | string | N | 메시지
createdId | uuid | N | 생성된 자산·요청 id
''')
DQ = [('matchStatus','query','string','N','분류, 쉼표 구분(기본 NEW,CONFLICT,UNMANAGED)'),('runId','query','uuid','N','수집 실행'),('q','query','string','N','호스트명·시리얼·IP')] + PG
W('Discovery','GET','/discovery/jobs','listDiscoveryJobs','수집 작업 목록',AM,None,'DiscoveryJobList','200','discovery_job, discovery_run','ALM-120',[ '마지막 실행 결과 포함.'],params=PG)
W('Discovery','POST','/discovery/jobs','createDiscoveryJob','수집 작업 등록',AM,'DiscoveryJobInput','DiscoveryJob','201, 400','discovery_job','ALM-120',[ '자격증명은 Secrets Manager에 따로 넣고 ARN만 받는다.'],idem='Idempotency-Key',ok='201')
W('Discovery','PATCH','/discovery/jobs/{id}','patchDiscoveryJob','수집 작업 수정',AM,'DiscoveryJobInput','DiscoveryJob','200, 400, 404','discovery_job','ALM-120',[ '주기를 바꾸면 EventBridge 스케줄을 다시 만든다.'],params=[ID()])
W('Discovery','POST','/discovery/jobs/{id}:run','runDiscoveryJob','수동 실행',AM,None,'DiscoveryRun','202, 404, 409','discovery_run','ALM-120',[ '이미 실행 중이면 409 ALM-E311.'],params=[ID()],ok='202')
W('Discovery','GET','/discovery/runs','listDiscoveryRuns','수집 실행 이력',AM,None,'DiscoveryRunList','200','discovery_run','ALM-120',[ '최근 순.'],params=[('jobId','query','uuid','N','작업')]+PG)
W('Discovery','GET','/discovery/items','listDiscoveryItems','대사 큐',AM,None,'DiscoveryItemRowList','200','discovery_item','ALM-120',[ '탭별 건수는 응답 헤더 X-Counts(JSON).'],params=DQ)
W('Discovery','POST','/discovery/items:resolve','resolveDiscoveryItems','대사 큐 처리',AM,'DiscoveryResolve','BulkResult','200, 207, 400','discovery_item, asset, asset_event, ticket_link','ALM-120',
  ['REGISTER: 수집값으로 자산 등록(POST /assets와 같은 규칙). UPDATE: 지정 필드를 수집값으로 갱신. QUARANTINE: 미관리 장비 격리 표시 + ITSM 티켓 요청. IGNORE: 같은 장비는 30일간 다시 올리지 않음.'], idem='Idempotency-Key')

# ---------------- cmdb ----------------
schema('CiRow', 'CI', '''
id | uuid | Y | id
ciType | enum(BUSINESS_SERVICE,APPLICATION,DATABASE,SERVER,VIRTUAL_MACHINE,NETWORK,OT_DEVICE,OTHER) | Y | 유형
name | string(100) | Y | 이름
assetId | uuid | N | 자산
assetTag | string | N | 자산태그
ownerName | string | N | 담당
openTickets | int | Y | 열린 티켓 수
''')
lst('CiRow', 'CI 목록')
schema('CiInput', 'CI 저장', '''
ciType | enum(BUSINESS_SERVICE,APPLICATION,DATABASE,SERVER,VIRTUAL_MACHINE,NETWORK,OT_DEVICE,OTHER) | Y | 유형
name | string(100) | Y | 이름
assetId | uuid | N | 하드웨어 CI면 자산
ownerUserId | uuid | N | 담당
description | string | N | 설명
isActive | bool | N | 사용
''')
schema('CiGraph', '관계도·영향 분석', '''
rootId | uuid | Y | 시작 CI
nodes | [CiRow] | Y | CI
edges | [CiEdge] | Y | 관계
impacted | [uuid] | Y | direction=up일 때 영향받는 상위 CI·서비스
''')
schema('CiEdge', '관계', '''
id | uuid | Y | ci_relation.id
sourceId | uuid | Y | 출발 CI
targetId | uuid | Y | 도착 CI
relationType | enum(DEPENDS_ON,RUNS_ON,CONNECTED_TO,INSTALLED_ON) | Y | 관계 유형
''')
schema('CiRelationInput', '관계 추가', '''
sourceId | uuid | Y | 출발 CI
targetId | uuid | Y | 도착 CI
relationType | enum(DEPENDS_ON,RUNS_ON,CONNECTED_TO,INSTALLED_ON) | Y | 관계 유형
''')
W('CMDB','GET','/cmdb/cis','listCis','CI 목록','로그인 사용자(IT 운영)',None,'CiRowList','200','config_item, ticket_link','ALM-130',[ '서비스부터 보려면 ciType=BUSINESS_SERVICE.'],
  params=[('ciType','query','string','N','유형, 쉼표 구분'),('q','query','string','N','이름·자산태그')]+PG)
W('CMDB','POST','/cmdb/cis','createCi','CI 등록',AM,'CiInput','CiRow','201, 400, 409','config_item','ALM-130',[ '자산당 CI 1개(409 ALM-E312).'],idem='Idempotency-Key',ok='201')
W('CMDB','PATCH','/cmdb/cis/{id}','patchCi','CI 수정',AM,'CiInput','CiRow','200, 400, 404','config_item','ALM-130',[ '-'],params=[ID()])
W('CMDB','GET','/cmdb/cis/{id}/graph','getCiGraph','관계도·영향 분석','로그인 사용자(IT 운영)',None,'CiGraph','200, 404','config_item, ci_relation','ALM-130',
  ['재귀 CTE로 depth까지 탐색(최대 5, 노드 500개).', 'direction=up이면 이 CI에 의존하는 상위 CI·서비스를 impacted로 표시(F-130-02).'],
  params=[ID(),('depth','query','int','N','깊이(기본 3)'),('direction','query','enum(up,down,both)','N','방향(기본 both)')])
W('CMDB','POST','/cmdb/relations','createCiRelation','관계 추가',AM,'CiRelationInput','CiEdge','201, 400, 409','ci_relation','ALM-130',[ '순환(A→B→A)은 409 ALM-E313.'],ok='201')
W('CMDB','DELETE','/cmdb/relations/{id}','deleteCiRelation','관계 삭제',AM,None,None,'204, 404','ci_relation, audit_log','ALM-130',[ '설정 데이터라 물리 삭제하고 audit_log에 전값을 남긴다(예외).'],params=[ID()],ok='204')
W('CMDB','GET','/tickets','listTickets','티켓 조회','로그인 사용자',None,'TicketList','200','ticket_link','ALM-130',[ 'ITSM 원본 조회는 8.4에서 연동. 여기서는 연결된 참조만.'],params=[('ciId','query','uuid','N','CI'),('assetId','query','uuid','N','자산')])

# ---------------- licenses ----------------
schema('SoftwareProduct', '소프트웨어 제품', '''
id | uuid | Y | id
publisher | string(80) | Y | 게시자
name | string(120) | Y | 제품명
isCommercial | bool | Y | 상용
matchPattern | string(200) | N | 설치명 매칭 정규식
installCount | int | Y | 설치 장치 수
''')
lst('SoftwareProduct', '제품 목록')
schema('SoftwareProductInput', '제품 저장', '''
publisher | string(80) | Y | 게시자
name | string(120) | Y | 제품명
isCommercial | bool | Y | 상용
matchPattern | string(200) | N | 정규식(저장 시 미분류 설치 목록에 다시 적용)
''')
schema('LicenseRow', '라이선스(준수 판정 포함)', '''
id | uuid | Y | id
productId | uuid | Y | 제품
productName | string | Y | 제품명
licenseModel | enum(PER_USER,PER_DEVICE,PER_CORE,NETWORK) | Y | 모델
ownedQuantity | int | Y | 보유
usedQuantity | int | Y | 사용
compliance | enum(COMPLIANT,UNDER,OVER) | Y | 판정
unitCost | number | N | 단가(연간)
annualCost | number | N | 연간 비용
unusedAmount | number | N | 미사용 금액
shortfallAmount | number | N | 부족분 노출 금액
renewalDate | date | N | 갱신일
contractNo | string | N | 계약
''')
lst('LicenseRow', '라이선스 목록')
schema('LicenseInput', '라이선스 저장', '''
productId | uuid | Y | 제품
licenseModel | enum(PER_USER,PER_DEVICE,PER_CORE,NETWORK) | Y | 모델
ownedQuantity | int | Y | 보유 수량
unitCost | number | N | 단가
renewalDate | date | N | 갱신일
contractId | uuid | N | 계약
poNo | string(10) | N | PO
notes | string | N | 메모
''')
schema('LicenseUsage', '라이선스 사용 내역', '''
assignments | [LicenseSeat] | Y | 사용자 할당(PER_USER)
installs | [LicenseInstall] | Y | 설치 장치(그 외)
''')
schema('LicenseSeat', '좌석', '''
id | uuid | Y | license_assignment.id
userName | string | N | 사용자
assetTag | string | N | 장치
assignedAt | datetime | Y | 할당
lastUsedAt | datetime | N | 최근 사용(수집 시)
''')
schema('LicenseInstall', '설치', '''
assetId | uuid | Y | 자산
assetTag | string | Y | 태그
assignedUserName | string | N | 사용자
version | string | N | 버전
lastSeenAt | datetime | Y | 최근 수집
''')
schema('SeatAssign', '좌석 할당', '''
userId | uuid | N | 사용자
assetId | uuid | N | 장치(둘 중 하나)
''')
schema('ReclaimRequest', '미사용 좌석 회수', '''
keepBufferPercent | int | N | 여유분(기본 5)
unusedDays | int | N | 이 기간 사용 없음(기본 90)
dryRun | bool | N | true면 대상만 계산(기본 true)
''')
schema('ReclaimResult', '회수 결과', '''
candidates | [LicenseSeat] | Y | 회수 대상
releasedCount | int | Y | 실제 회수(dryRun=false)
''')
schema('PurchaseFromLicense', '라이선스 추가 구매요청', '''
quantity | int | N | 수량(비면 부족분)
neededBy | date | N | 필요일
reason | string | N | 사유
''')
schema('UnauthorizedRow', '비인가 설치', '''
productName | string | Y | 제품
assetTag | string | Y | 자산
assignedUserName | string | N | 사용자
installDate | date | N | 설치일
lastSeenAt | datetime | Y | 최근 수집
''')
lst('UnauthorizedRow', '비인가 설치 목록')
W('라이선스','GET','/software-products','listSoftwareProducts','제품 목록',AM,None,'SoftwareProductList','200','software_product, software_install','ALM-140',[ '-'],params=[('q','query','string','N','이름')]+PG)
W('라이선스','POST','/software-products','createSoftwareProduct','제품 등록',AM,'SoftwareProductInput','SoftwareProduct','201, 400, 409','software_product','ALM-140',[ '같은 게시자·이름은 409.'],idem='Idempotency-Key',ok='201')
W('라이선스','PATCH','/software-products/{id}','patchSoftwareProduct','제품 수정',AM,'SoftwareProductInput','SoftwareProduct','200, 400, 404','software_product, software_install','ALM-140',[ 'matchPattern을 바꾸면 설치 목록 매칭을 비동기로 다시 한다.'],params=[ID()])
W('라이선스','GET','/licenses','listLicenses','라이선스 목록',AM,None,'LicenseRowList','200','license, v_license_compliance','ALM-140',[ '금액 열은 amount.read 권한.'],
  params=[('compliance','query','string','N','UNDER, OVER, COMPLIANT'),('q','query','string','N','제품명')]+PG)
W('라이선스','POST','/licenses','createLicense','라이선스 등록',AM,'LicenseInput','LicenseRow','201, 400','license','ALM-140',[ '-'],idem='Idempotency-Key',ok='201')
W('라이선스','PATCH','/licenses/{id}','patchLicense','라이선스 수정',AM,'LicenseInput','LicenseRow','200, 400, 404','license','ALM-140',[ '-'],params=[ID()])
W('라이선스','GET','/licenses/{id}/usage','getLicenseUsage','사용 내역',AM,None,'LicenseUsage','200, 404','license_assignment, software_install','ALM-140',[ '-'],params=[ID()])
W('라이선스','POST','/licenses/{id}/seats','assignSeat','좌석 할당',AM,'SeatAssign','LicenseSeat','201, 400, 409','license_assignment','ALM-140',[ '보유 수량을 넘어도 할당은 허용하고 UNDER로 표시(실제 사용 반영).'],params=[ID()],ok='201')
W('라이선스','POST','/licenses/{id}/seats/{seatId}:release','releaseSeat','좌석 회수',AM,None,'LicenseSeat','200, 404','license_assignment','ALM-140',[ '멱등.'],params=[ID(),('seatId','path','uuid','Y','좌석')])
W('라이선스','POST','/licenses/{id}:reclaim','reclaimSeats','미사용 좌석 회수',AM,'ReclaimRequest','ReclaimResult','200, 404','license_assignment','ALM-140',[ 'F-140-04: 여유분 5%를 남기고 회수. 기본은 dryRun으로 대상만 보여준다.'],params=[ID()])
W('라이선스','POST','/licenses/{id}:request-purchase','requestLicensePurchase','추가 구매요청 생성',AM,'PurchaseFromLicense','PurchaseRequestDetail','201, 404','purchase_request','ALM-140',[ 'source=LICENSE_SHORTAGE로 DRAFT 구매요청을 만든다.'],params=[ID()],ok='201')
W('라이선스','GET','/software/unauthorized','listUnauthorized','비인가 설치',AM,None,'UnauthorizedRowList','200','software_install, software_product, license','ALM-140',[ '상용 제품인데 라이선스가 없는 설치(F-140-05).'],params=PG)

# ---------------- contracts ----------------
schema('ContractSummary', '계약 목록 행', '''
id | uuid | Y | id
contractNo | string | Y | 번호
contractType | enum(MAINTENANCE,LEASE,SERVICE,SUBSCRIPTION) | Y | 유형
title | string | Y | 계약명
vendorName | string | N | 공급사
startDate | date | Y | 시작
endDate | date | N | 종료
daysLeft | int | N | 남은 일수
amount | number | N | 금액
assetCount | int | Y | 대상 자산 수
isAutoRenew | bool | Y | 자동갱신
ownerName | string | N | 담당
''')
lst('ContractSummary', '계약 목록')
schema('ContractInput', '계약 저장', '''
contractNo | string(30) | Y | 번호
contractType | enum(MAINTENANCE,LEASE,SERVICE,SUBSCRIPTION) | Y | 유형
title | string(120) | Y | 계약명
vendorId | uuid | N | 공급사
startDate | date | Y | 시작
endDate | date | N | 종료
amount | number | N | 금액
isAutoRenew | bool | N | 자동갱신
ownerUserId | uuid | N | 담당(만료 알림)
notes | string | N | 메모
''')
schema('ContractDetail', '계약 상세', '''
id | uuid | Y | id
version | int | Y | 낙관적 잠금
contract | ContractInput | Y | 계약 값
assets | [AssetSummary] | Y | 대상 자산
licenses | [LicenseRow] | Y | 연결 라이선스
attachments | [Attachment] | Y | 계약서
''')
schema('AssetIds', '자산 id 목록', '''
assetIds | [uuid] | Y | 최대 500
''')
schema('RenewalMonth', '월별 만료', '''
month | string | Y | YYYY-MM
count | int | Y | 계약 수
amount | number | Y | 만료 금액
''')
schema('RenewalCalendar', '갱신 캘린더', '''
months | [RenewalMonth] | Y | 12개월
''')
schema('ContractRenew', '갱신 구매요청', '''
neededBy | date | N | 필요일(비면 종료일 30일 전)
estimatedAmount | number | N | 예상 금액(비면 현재 금액)
''')
W('계약','GET','/contracts','listContracts','계약 목록','ASSET_MANAGER, ASSET_ACCOUNTANT',None,'ContractSummaryList','200','contract, contract_asset','ALM-220',[ '-'],
  params=[('contractType','query','string','N','유형'),('vendorId','query','uuid','N','공급사'),('expiringWithinDays','query','int','N','만료 n일 이내'),('q','query','string','N','번호·이름')]+PG)
W('계약','POST','/contracts','createContract',  '계약 등록',AM,'ContractInput','ContractDetail','201, 400, 409','contract','ALM-220',[ '번호 중복 409.'],idem='Idempotency-Key',ok='201')
W('계약','GET','/contracts/{id}','getContract','계약 상세','ASSET_MANAGER, ASSET_ACCOUNTANT',None,'ContractDetail','200, 404','contract, contract_asset, license, attachment','ALM-220',[ '-'],params=[ID()])
W('계약','PATCH','/contracts/{id}','patchContract','계약 수정',AM,'ContractInput','ContractDetail','200, 400, 404, 409','contract','ALM-220',[ 'If-Match: version.'],params=[ID(),('If-Match','header','string','Y','version')])
W('계약','POST','/contracts/{id}/assets','addContractAssets','대상 자산 추가',AM,'AssetIds','ContractDetail','200, 400, 404','contract_asset','ALM-220',[ '이미 있는 자산은 무시(멱등).'],params=[ID()])
W('계약','DELETE','/contracts/{id}/assets/{assetId}','removeContractAsset','대상 자산 제외',AM,None,None,'204, 404','contract_asset, audit_log','ALM-220',[ '연결 행은 물리 삭제, audit_log에 기록.'],params=[ID(),('assetId','path','uuid','Y','자산')],ok='204')
W('계약','GET','/contracts/renewal-calendar','getRenewalCalendar','갱신 캘린더','ASSET_MANAGER, ASSET_ACCOUNTANT',None,'RenewalCalendar','200','contract','ALM-220',[ '향후 12개월 월별 만료 금액(F-220-03).'],params=[('months','query','int','N','개월 수(기본 12)')])
W('계약','POST','/contracts/{id}:renew','renewContract','갱신 구매요청 생성',AM,'ContractRenew','PurchaseRequestDetail','201, 404, 409','purchase_request','ALM-220',[ '종료 90일 이내만(409 ALM-E314). source=CONTRACT_RENEWAL.'],params=[ID()],ok='201')

# ---------------- purchase ----------------
schema('PurchaseRequestSummary', '구매요청 목록 행', '''
id | uuid | Y | id
prNo | string | Y | PR-nnnnn
title | string | Y | 제목
requesterName | string | Y | 요청자
costCenterCode | string | Y | 코스트센터
status | enum(DRAFT,SUBMITTED,APPROVED,REJECTED,PO_REQUESTED,PO_CREATED,PO_ERROR,CANCELLED) | Y | 상태
estimatedAmount | number | N | 예상금액
sapPoNo | string | N | PO
updatedAt | datetime | Y | 변경
''')
lst('PurchaseRequestSummary', '구매요청 목록')
schema('PurchaseRequestInput', '구매요청 저장(DRAFT)', '''
title | string(120) | Y | 제목
companyId | uuid | Y | 회사코드
costCenterId | uuid | Y | 코스트센터
vendorId | uuid | N | 공급사
neededBy | date | N | 필요일
reason | string | N | 사유
purchasingOrg | string(4) | N | EKORG(제출 시 필수)
purchasingGroup | string(3) | N | EKGRP(제출 시 필수)
items | [PurchaseItemInput] | Y | 품목(1개 이상)
''')
schema('PurchaseItemInput', '구매요청 품목', '''
description | string(40) | Y | 품목명
categoryId | uuid | N | 카테고리
modelId | uuid | N | 모델
assetClassId | uuid | N | 자산클래스
quantity | int | Y | 수량
unitPrice | number | N | 단가
''')
schema('PurchaseRequestDetail', '구매요청 상세', '''
id | uuid | Y | id
version | int | Y | 낙관적 잠금
prNo | string | Y | 번호
status | string | Y | 상태
request | PurchaseRequestInput | Y | 값
approvals | [ApprovalStep] | Y | 승인 단계
posting | PostingSummary | N | SAP PO 생성 전기
''')
schema('ApprovalStep', '승인 단계', '''
id | uuid | Y | approval.id
stepNo | int | Y | 단계
approverRole | string | Y | 승인 역할
approverName | string | N | 승인자
decision | enum(PENDING,APPROVED,REJECTED,SKIPPED) | Y | 결정
comment | string | N | 의견
decidedAt | datetime | N | 결정 일시
''')
schema('PoItemRow', 'SAP 자산 PO 항목(입고 대기)', '''
id | uuid | Y | po_item.id
poNo | string | Y | PO
itemNo | string | Y | 항목
vendorName | string | N | 공급사
description | string | Y | 품목
quantity | number | Y | 수량
grQuantity | number | Y | 입고 수량
openQuantity | number | Y | 미입고
costCenterCode | string | N | 코스트센터
prNo | string | N | ALM 구매요청
isDeleted | bool | Y | 삭제 표시
''')
lst('PoItemRow', 'PO 항목 목록')
schema('GoodsReceiptRow', '입고 문서', '''
materialDoc | string | Y | MBLNR
docYear | int | Y | MJAHR
movementType | string | Y | 101 / 102
quantity | number | Y | 수량
postingDate | date | Y | 전기일
assetTags | [string] | Y | 생성된 자산태그
''')
schema('PoItemDetail', 'PO 항목 상세', '''
item | PoItemRow | Y | 항목
receipts | [GoodsReceiptRow] | Y | 입고 이력
assets | [AssetSummary] | Y | 연결 자산
''')
W('구매','GET','/purchase-requests','listPurchaseRequests','구매요청 목록','로그인 사용자',None,'PurchaseRequestSummaryList','200','purchase_request','ALM-210',[ 'EMPLOYEE는 본인 요청, DEPT_MANAGER는 소속 코스트센터, 그 외 범위 전체.'],
  params=[('status','query','string','N','상태'),('mine','query','bool','N','내 요청만'),('q','query','string','N','번호·제목')]+PG)
W('구매','POST','/purchase-requests','createPurchaseRequest','구매요청 작성','로그인 사용자','PurchaseRequestInput','PurchaseRequestDetail','201, 400','purchase_request, purchase_request_item, number_sequence','ALM-210',[ 'DRAFT로 저장. 번호는 PR-nnnnn.'],idem='Idempotency-Key',ok='201')
W('구매','GET','/purchase-requests/{id}','getPurchaseRequest','구매요청 상세','요청자·승인자·ASSET_MANAGER',None,'PurchaseRequestDetail','200, 403, 404','purchase_request, approval, sap_posting','ALM-210',[ '-'],params=[ID()])
W('구매','PATCH','/purchase-requests/{id}','patchPurchaseRequest','구매요청 수정','요청자','PurchaseRequestInput','PurchaseRequestDetail','200, 400, 409','purchase_request, purchase_request_item','ALM-210',[ 'DRAFT·REJECTED만. 품목은 전체 교체. If-Match: version.'],params=[ID(),('If-Match','header','string','Y','version')])
W('구매','POST','/purchase-requests/{id}:submit','submitPurchaseRequest','제출','요청자',None,'PurchaseRequestDetail','200, 409, 422','purchase_request, approval','ALM-210',[ '승인 단계 생성: 1 부서 관리자. 승인되면 PO_CREATE 전기 건 생성(IF-MM-02).', '자산클래스가 있는데 자산번호가 없는 품목은 ASSET_CREATE를 먼저 전기한다.'],params=[ID()],idem='Idempotency-Key')
W('구매','POST','/purchase-requests/{id}:cancel','cancelPurchaseRequest','취소','요청자, ASSET_MANAGER',None,'PurchaseRequestDetail','200, 409','purchase_request','ALM-210',[ 'PO_REQUESTED 이후는 취소 불가(409).'],params=[ID()])
W('구매','GET','/purchase-orders','listPoItems','PO 항목·입고 대기','ASSET_MANAGER, ASSET_ACCOUNTANT',None,'PoItemRowList','200','po_item, goods_receipt','ALM-210',[ 'openOnly=true면 미입고 수량이 있는 항목.'],params=[('openOnly','query','bool','N','입고 대기만'),('q','query','string','N','PO·품목')]+PG)
W('구매','GET','/purchase-orders/{id}','getPoItem','PO 항목 상세','ASSET_MANAGER, ASSET_ACCOUNTANT',None,'PoItemDetail','200, 404','po_item, goods_receipt, asset','ALM-210',[ '입고는 SAP MIGO 결과만 반영(ALM에서 입고 처리 안 함).'],params=[ID()])

# ---------------- requests & approvals ----------------
schema('AssetRequestSummary', '자산 요청 목록 행', '''
id | uuid | Y | id
requestNo | string | Y | AR-nnnnn
requestType | enum(NEW_ASSET,CHANGE,TRANSFER,RETIRE,SALE) | Y | 유형
status | enum(DRAFT,SUBMITTED,MGR_APPROVED,ACCT_APPROVED,POSTED,POST_ERROR,REJECTED,CANCELLED) | Y | 상태
source | string | Y | 출처
assetTag | string | N | 자산
requesterName | string | Y | 요청자
currentStep | int | Y | 현재 단계
awaitingRole | string | N | 대기 중인 승인 역할
submittedAt | datetime | N | 제출
''')
lst('AssetRequestSummary', '자산 요청 목록')
schema('AssetRequestInput', '자산 요청 작성. 유형별 필수 값은 처리 규칙 참고', '''
requestType | enum(NEW_ASSET,CHANGE,TRANSFER,RETIRE,SALE) | Y | 유형
assetId | uuid | N | 대상 자산(NEW_ASSET 제외 필수)
reason | string(200) | Y | 사유
assetClassId | uuid | N | NEW_ASSET
acquisitionValue | number | N | NEW_ASSET 예상 취득가
poItemId | uuid | N | NEW_ASSET 참조 PO
targetCostCenterId | uuid | N | NEW_ASSET·TRANSFER
targetRoomId | uuid | N | CHANGE
changes | object | N | CHANGE {field: after}
effectiveDate | date | N | 이관일·폐기일·가치일
retireType | enum(SCRAP,SALE,LOSS) | N | RETIRE
saleAmount | number | N | SALE 필수
buyer | string(80) | N | SALE
submit | bool | N | true면 저장과 함께 제출
''')
schema('AssetRequestDetail', '자산 요청 상세', '''
id | uuid | Y | id
version | int | Y | 낙관적 잠금
requestNo | string | Y | 번호
status | string | Y | 상태
request | AssetRequestInput | Y | 값
isProfitCenterChange | bool | Y | 손익센터 변경(→ABUMN)
asset | AssetSummary | N | 대상 자산
approvals | [ApprovalStep] | Y | 승인 단계
posting | PostingSummary | N | SAP 전기
attachments | [Attachment] | Y | 첨부
''')
schema('PostingSummary', 'SAP 전기 요약', '''
id | uuid | Y | sap_posting.id
postingId | string | Y | postingId
postingType | string | Y | 유형
status | enum(READY,CLAIMED,POSTED,FAILED,CANCELLED) | Y | 상태
attemptCount | int | Y | 시도
sapDocumentNo | string | N | 전표
resultAt | datetime | N | 결과 수신
messages | [BapiMessage] | Y | SAP 메시지
''')
schema('ApprovalInboxRow', '승인함 행', '''
approvalId | uuid | Y | approval.id
kind | enum(ASSET_REQUEST,PURCHASE_REQUEST) | Y | 종류
targetId | uuid | Y | 요청 id
targetNo | string | Y | AR-/PR- 번호
summary | string | Y | 요약 (예: 이관 · AT-000123 → 1000-4310)
requesterName | string | Y | 요청자
stepNo | int | Y | 단계
waitingSince | datetime | Y | 대기 시작
amount | number | N | 관련 금액(권한)
''')
lst('ApprovalInboxRow', '승인함')
schema('ApprovalDecisionInput', '승인·반려', '''
comment | string(500) | N | 의견(반려는 필수)
''')
RQ = [('type','query','string','N','유형'),('status','query','string','N','상태'),('mine','query','bool','N','내 요청'),('assetId','query','uuid','N','자산'),('q','query','string','N','번호·자산태그')]+PG
W('요청·승인','GET','/asset-requests','listAssetRequests','자산 요청 목록','로그인 사용자(범위)',None,'AssetRequestSummaryList','200','asset_request, approval','ALM-230',[ 'EMPLOYEE는 본인 요청.'],params=RQ)
W('요청·승인','POST','/asset-requests','createAssetRequest','자산 요청 작성','로그인 사용자','AssetRequestInput','AssetRequestDetail','201, 400, 409, 422','asset_request, approval, number_sequence','ALM-230',
  ['유형별 필수: NEW_ASSET(자산클래스, 코스트센터, 취득가) · CHANGE(changes 또는 룸) · TRANSFER(코스트센터, 이관일) · RETIRE(폐기 유형, 폐기일) · SALE(매각금액, 매입처).',
   '같은 자산에 진행 중인 요청이 있으면 409 ALM-E315.', 'TRANSFER는 코스트센터의 손익센터·세그먼트를 비교해 is_profit_center_change를 서버가 정한다.', 'Retired·Disposed는 이 요청으로만 바뀐다.'],
  idem='Idempotency-Key', ok='201')
W('요청·승인','GET','/asset-requests/{id}','getAssetRequest','자산 요청 상세','요청자·승인자·ASSET_MANAGER·ASSET_ACCOUNTANT',None,'AssetRequestDetail','200, 403, 404','asset_request, approval, sap_posting, attachment','ALM-230',[ '-'],params=[ID()])
W('요청·승인','PATCH','/asset-requests/{id}','patchAssetRequest','자산 요청 수정','요청자(DRAFT), ASSET_ACCOUNTANT(POST_ERROR)','AssetRequestInput','AssetRequestDetail','200, 400, 403, 409','asset_request, sap_posting','ALM-230',
  ['DRAFT는 요청자가, POST_ERROR는 자산회계가 값을 고친다. POST_ERROR 수정 후에는 /integration/sap/postings/{id}:retry로 재전기.', 'If-Match: version.'],
  params=[ID(),('If-Match','header','string','Y','version')])
W('요청·승인','POST','/asset-requests/{id}:submit','submitAssetRequest','제출','요청자',None,'AssetRequestDetail','200, 409, 422','asset_request, approval','ALM-230',[ '승인 단계 2개 생성: 1 부서 관리자(대상 코스트센터 책임), 2 자산회계.'],params=[ID()],idem='Idempotency-Key')
W('요청·승인','POST','/asset-requests/{id}:cancel','cancelAssetRequest','취소','요청자, ASSET_MANAGER',None,'AssetRequestDetail','200, 409','asset_request','ALM-230',[ 'ACCT_APPROVED 이후(전기 대기)는 sap_posting이 CLAIMED가 아닐 때만 취소.'],params=[ID()])
W('요청·승인','GET','/approvals/inbox','listApprovalInbox','내 승인함','DEPT_MANAGER, ASSET_ACCOUNTANT, ASSET_MANAGER',None,'ApprovalInboxRowList','200','approval, asset_request, purchase_request','ALM-230, 210',
  ['내 역할·범위에 맞는 PENDING 단계 중 앞 단계가 끝난 것만.'],params=[('kind','query','enum(ASSET_REQUEST,PURCHASE_REQUEST)','N','종류')]+PG)
W('요청·승인','POST','/approvals/{id}:approve','approve','승인','해당 단계 역할','ApprovalDecisionInput','ApprovalStep','200, 403, 409','approval, asset_request, purchase_request, sap_posting, notification','ALM-230, 210',
  ['마지막 단계(자산회계) 승인 시 sap_posting(READY)을 만들고 요청을 ACCT_APPROVED로.', '요청자 본인은 승인할 수 없다(403 ALM-E403, 직무 분리).', '이미 결정된 단계면 409.'],params=[ID()],idem='Idempotency-Key')
W('요청·승인','POST','/approvals/{id}:reject','reject','반려','해당 단계 역할','ApprovalDecisionInput','ApprovalStep','200, 400, 403, 409','approval, asset_request, purchase_request, notification','ALM-230, 210',[ 'comment 필수. 요청은 REJECTED, 자산은 바뀌지 않음. 요청자에게 알림.'],params=[ID()],idem='Idempotency-Key')

# ---------------- counts ----------------
schema('CampaignSummary', '실사 캠페인 목록 행', '''
id | uuid | Y | id
campaignCode | string | Y | 코드
name | string | Y | 이름
status | enum(SCOPING,COUNTING,REVIEW,POSTING,CLOSED,CANCELLED) | Y | 단계
keyDate | date | Y | 기준일
dueDate | date | Y | 기한
totalItems | int | Y | 대상
countedItems | int | Y | 실사 완료
varianceItems | int | Y | 차이
''')
lst('CampaignSummary', '캠페인 목록')
schema('CampaignInput', '캠페인 저장(SCOPING)', '''
campaignCode | string(6) | Y | 코드(PI26Q4 형식)
name | string(100) | Y | 이름
companyId | uuid | Y | 회사코드
keyDate | date | Y | 기준일
dueDate | date | Y | 기한
scope | CampaignScope | Y | 범위
''')
schema('CampaignScope', '범위 조건', '''
siteIds | [uuid] | Y | 사이트
roomIds | [uuid] | N | 룸(비면 사이트 전체)
assetClassIds | [uuid] | N | 자산클래스(비면 전체)
includeNonCapitalized | bool | N | 비자본화 자산 포함(기본 true)
''')
schema('CampaignDetail', '캠페인 상세', '''
id | uuid | Y | id
version | int | Y | 낙관적 잠금
campaign | CampaignInput | Y | 값
status | string | Y | 단계
progress | CampaignProgress | Y | 진행 현황
''')
schema('CampaignProgress', '진행 현황(F-240-03)', '''
total | int | Y | 대상
found | int | Y | 제자리 발견
misplaced | int | Y | 다른 위치 발견
pending | int | Y | 미실사
notFound | int | Y | 미발견(종료 후)
unregistered | int | Y | 미등록
rooms | [RoomProgress] | Y | 룸별
''')
schema('RoomProgress', '룸별 진행', '''
taskId | uuid | Y | 작업
roomCode | string | Y | 룸
assigneeName | string | N | 담당
status | string | Y | 상태
expected | int | Y | 대상
found | int | Y | 확인
pending | int | Y | 미확인
''')
schema('ScopePreview', '범위 미리보기', '''
total | int | Y | 대상 자산 수
rooms | [RoomProgress] | Y | 룸별 대상 수(found·pending 0)
warnings | [string] | Y | 예: 룸 없는 자산 12건 제외
''')
schema('TaskAssign', '룸 담당 배정', '''
assigneeId | uuid | Y | 실사 담당자(COUNTER 역할)
''')
schema('CountItemRow', '실사 대상 행', '''
id | uuid | Y | count_item.id
assetTag | string | Y | 태그
description | string | Y | 자산명
expectedRoomCode | string | Y | 등록 룸
foundRoomCode | string | N | 발견 룸
result | enum(PENDING,FOUND,MISPLACED,NOT_FOUND) | Y | 판정
condition | string | N | 상태
countedByName | string | N | 실사자
countedAt | datetime | N | 일시
varianceAction | string | N | 차이 처리
requestNo | string | N | 생성된 요청
photoCount | int | Y | 사진 수
''')
lst('CountItemRow', '실사 대상 목록')
schema('VarianceResolve', '차이 처리(여러 건)', '''
items | [VarianceResolveItem] | Y | 최대 500건
''')
schema('VarianceResolveItem', '차이 처리 1건(F-240-05)', '''
id | uuid | Y | count_item.id
action | enum(MASTER_CHANGE,RECOUNT,RETIRE_REQUEST,MARK_MISSING,REPAIR,ACCEPT) | Y | 처리
retireType | enum(SCRAP,LOSS) | N | RETIRE_REQUEST
note | string(200) | N | 메모
''')
schema('UnregisteredRow', '미등록 자산', '''
id | uuid | Y | id
tempNo | string | Y | UNREG-nnnn
roomCode | string | Y | 발견 룸
description | string | Y | 설명
categoryName | string | N | 카테고리
serialNo | string | N | 시리얼
reportedByName | string | Y | 보고자
reportedAt | datetime | Y | 일시
photoCount | int | Y | 사진
resolution | string | N | 처리
createdAssetTag | string | N | 등록된 자산
''')
lst('UnregisteredRow', '미등록 자산 목록')
schema('UnregisteredResolve', '미등록 처리', '''
action | enum(REGISTER,NON_ASSET) | Y | 신규 등록 / 비자산
asset | AssetCreate | N | REGISTER 값(비면 보고값으로 채움)
note | string(200) | N | 메모
''')
CI = [ID()]
W('실사','GET','/count-campaigns','listCampaigns',  '캠페인 목록',AM,None,'CampaignSummaryList','200','count_campaign, count_item','ALM-240',[ '-'],params=[('status','query','string','N','단계')]+PG)
W('실사','POST','/count-campaigns','createCampaign','캠페인 생성',AM,'CampaignInput','CampaignDetail','201, 400, 409','count_campaign','ALM-240',[ 'SCOPING으로 시작. 코드 중복 409.'],idem='Idempotency-Key',ok='201')
W('실사','GET','/count-campaigns/{id}','getCampaign','캠페인 상세·진행',AM,None,'CampaignDetail','200, 404','count_campaign, count_task, count_item, count_unregistered','ALM-240',[ '진행 현황은 30초 캐시.'],params=CI)
W('실사','PATCH','/count-campaigns/{id}','patchCampaign','캠페인 수정',AM,'CampaignInput','CampaignDetail','200, 400, 409','count_campaign','ALM-240',[ 'SCOPING에서만 범위 변경. 이후는 이름·기한만.'],params=[ID(),('If-Match','header','string','Y','version')])
W('실사','POST','/count-campaigns/{id}:preview-scope','previewScope','범위 미리보기',AM,None,'ScopePreview','200, 409','asset, room','ALM-240',[ '저장하지 않고 룸별 대상 수만 계산.'],params=CI)
W('실사','POST','/count-campaigns/{id}:start','startCampaign','범위 확정·실사 시작',AM,None,'CampaignDetail','200, 409, 422','count_campaign, count_task, count_item','ALM-240',
  ['범위의 자산마다 count_item, 룸마다 count_task를 한 트랜잭션으로 만들고 COUNTING으로.', '담당이 없는 룸이 있으면 422 ALM-E316(먼저 배정).', 'RETIRED·DISPOSED 자산은 제외.'],params=CI,idem='Idempotency-Key')
W('실사','GET','/count-campaigns/{id}/tasks','listCampaignTasks','룸 작업 목록',AM,None,'CampaignProgress','200, 404','count_task','ALM-240',[ 'SCOPING 단계에서는 미리보기의 룸 목록으로 배정한다.'],params=CI)
W('실사','PATCH','/count-tasks/{id}','assignCountTask','룸 담당 배정',AM,'TaskAssign','RoomProgress','200, 400, 404','count_task','ALM-240',[ 'COUNTER 역할이 아니면 400.'],params=CI)
W('실사','GET','/count-campaigns/{id}/items','listCountItems','실사 대상·차이',AM,None,'CountItemRowList','200, 404','count_item, asset, room','ALM-240',[ 'variance=true면 MISPLACED·NOT_FOUND·파손만.'],
  params=CI+[('result','query','string','N','판정'),('roomId','query','uuid','N','룸'),('variance','query','bool','N','차이만'),('q','query','string','N','태그')]+PG)
W('실사','POST','/count-campaigns/{id}:close-counting','closeCounting','실사 종료',AM,None,'CampaignDetail','200, 409','count_campaign, count_item, asset','ALM-240',
  ['PENDING을 NOT_FOUND로 확정하고 REVIEW로(F-240-04). 이후 PDA 스캔은 거부(ALM-E204).'],params=CI,idem='Idempotency-Key')
W('실사','POST','/count-items:resolve','resolveVariances',  '차이 처리',AM,'VarianceResolve','BulkResult','200, 207, 400','count_item, asset_request, asset, label_print_job','ALM-240',
  ['MASTER_CHANGE: 발견 룸으로 CHANGE 요청 생성. RECOUNT: PENDING으로 되돌림(REVIEW 중 재실사). RETIRE_REQUEST: RETIRE 요청 생성. MARK_MISSING: 자산 MISSING. REPAIR: 수리 입고. ACCEPT: 차이 수용.'], idem='Idempotency-Key')
W('실사','GET','/count-campaigns/{id}/unregistered','listUnregistered','미등록 자산',AM,None,'UnregisteredRowList','200, 404','count_unregistered, attachment','ALM-240',[ '-'],params=CI+PG)
W('실사','POST','/count-unregistered/{id}:resolve','resolveUnregistered','미등록 처리',AM,'UnregisteredResolve','BulkItemResult','200, 400, 409','count_unregistered, asset','ALM-240',[ 'REGISTER는 POST /assets와 같은 규칙(자본화면 NEW_ASSET 요청).'],params=CI,idem='Idempotency-Key')
W('실사','POST','/count-campaigns/{id}:post-results','postCountResults','실사 결과 전기',AC,None,'CampaignDetail','202, 409','count_campaign, sap_posting','ALM-240',
  ['처리 안 된 차이가 있으면 409 ALM-E317.', '실사한 자본화 자산마다 COUNT_RESULT 전기 건(IVDAT=기준일, INVZU=코드-결과) 생성 후 POSTING으로.'],params=CI,ok='202',idem='Idempotency-Key')
W('실사','POST','/count-campaigns/{id}:close','closeCampaign','캠페인 종료',AM,None,'CampaignDetail','200, 409','count_campaign, recon_run','ALM-240',[ '전기 건이 모두 POSTED여야 CLOSED. SAP 대사(CAMPAIGN) 요청을 함께 등록.'],params=CI)

# ---------------- labels ----------------
schema('LabelTemplate', '라벨 템플릿', '''
id | uuid | Y | id
templateCode | string(20) | Y | 코드
name | string(60) | Y | 이름
layout | enum(QR_CODE128,QR_ONLY,CODE128_ONLY) | Y | 레이아웃
widthIn | number | Y | 폭
heightIn | number | Y | 높이
dpi | int | Y | 해상도
zpl | string | Y | ZPL(변수: {assetTag} {description} {sapAssetNo} {roomCode} {companyName})
isDefault | bool | Y | 기본
''')
schema('LabelTemplateList', '템플릿 목록', '''
items | [LabelTemplate] | Y | 템플릿
''')
schema('Printer', '프린터', '''
id | uuid | Y | id
name | string(60) | Y | 이름
siteId | uuid | N | 사이트
host | string(100) | Y | 주소
port | int | Y | 포트
dpi | int | Y | 해상도
isActive | bool | Y | 사용
''')
schema('PrinterList', '프린터 목록', '''
items | [Printer] | Y | 프린터
''')
schema('LabelJobRow', '출력 대기열·이력 행', '''
id | uuid | Y | id
assetTag | string | Y | 자산
templateName | string | Y | 템플릿
source | enum(ASSET_DETAIL,GOODS_RECEIPT,PDA_REQUEST,BULK) | Y | 출처
status | enum(QUEUED,SENT,PRINTED,FAILED) | Y | 상태
copies | int | Y | 매수
requestedByName | string | N | 요청자
requestedAt | datetime | Y | 요청
printedAt | datetime | N | 출력
error | string | N | 오류
''')
lst('LabelJobRow', '출력 목록')
schema('LabelJobCreate', '출력 대기열 추가', '''
assetIds | [uuid] | Y | 자산(최대 500)
templateId | uuid | N | 템플릿(비면 기본)
copies | int | N | 매수(기본 1)
''')
schema('LabelPrint', '출력 실행', '''
jobIds | [uuid] | Y | 대기열 작업
printerId | uuid | Y | 프린터
''')
schema('ZplPreview', 'ZPL 미리보기', '''
zpl | string | Y | 치환된 ZPL
''')
W('라벨','GET','/label-templates','listLabelTemplates','템플릿 목록',AM,None,'LabelTemplateList','200','label_template','ALM-250',[ '-'])
W('라벨','POST','/label-templates','createLabelTemplate','템플릿 등록',SA,'LabelTemplate','LabelTemplate','201, 400','label_template','ALM-250',[ 'ZPL 문법은 저장 시 기본 검사(^XA…^XZ).'],ok='201')
W('라벨','PATCH','/label-templates/{id}','patchLabelTemplate','템플릿 수정',SA,'LabelTemplate','LabelTemplate','200, 400, 404','label_template','ALM-250',[ '-'],params=CI)
W('라벨','GET','/printers','listPrinters','프린터 목록',AM,None,'PrinterList','200','printer','ALM-250',[ '-'],params=[('siteId','query','uuid','N','사이트')])
W('라벨','POST','/printers','createPrinter','프린터 등록',SA,'Printer','Printer','201, 400','printer','ALM-250',[ '-'],ok='201')
W('라벨','PATCH','/printers/{id}','patchPrinter','프린터 수정',SA,'Printer','Printer','200, 400, 404','printer','ALM-250',[ '-'],params=CI)
W('라벨','POST','/printers/{id}:test','testPrinter','시험 출력',AM,None,'LabelJobRow','200, 404, 502','printer','ALM-250',[ '9100 포트 연결 실패면 502 ALM-E501.'],params=CI)
W('라벨','GET','/label-jobs','listLabelJobs','출력 대기열·이력',AM,None,'LabelJobRowList','200','label_print_job','ALM-250',[ '기본 status=QUEUED.'],params=[('status','query','string','N','상태'),('source','query','string','N','출처')]+PG)
W('라벨','POST','/label-jobs','createLabelJobs','대기열 추가',AM,'LabelJobCreate','LabelJobRowList','201, 400','label_print_job','ALM-250',[ '자산 목록의 선택 자산(F-110-03)·재출력에서 호출.'],idem='Idempotency-Key',ok='201')
W('라벨','POST','/label-jobs:print','printLabelJobs','출력 실행',AM,'LabelPrint','BulkResult','200, 207, 400, 502','label_print_job, asset_event','ALM-250',
  ['서버가 네트워크 프린터 9100 포트로 ZPL을 보낸다(같은 VPC 또는 사이트 VPN 필요).', '성공 건은 PRINTED와 asset_event(LABEL_PRINTED).'],idem='Idempotency-Key')
W('라벨','GET','/label-jobs/{id}/zpl','previewZpl','ZPL 미리보기',AM,None,'ZplPreview','200, 404','label_print_job, label_template, asset','ALM-250',[ '화면은 Labelary 같은 외부 렌더러를 쓰지 않고 자체 미리보기로 표시.'],params=CI)

# ---------------- SAP integration (web) ----------------
schema('IfStatusRow', '인터페이스별 상태(F-310-01)', '''
interfaceId | string | Y | IF ID
name | string | Y | 이름
direction | enum(SAP_TO_ALM,ALM_TO_SAP) | Y | 방향
lastRunAt | datetime | N | 마지막 실행
lastStatus | enum(SUCCESS,PARTIAL,FAILED) | N | 결과
lastRecordCount | int | N | 건수
isOverdue | bool | Y | 예정 주기 2회 이상 미실행
''')
schema('SapStatus', '연결 상태', '''
systemId | string | Y | 시스템 (예: PRD-100)
companyCodes | [string] | Y | 회사코드
lastCallAt | datetime | N | 마지막 호출
interfaces | [IfStatusRow] | Y | IF 12개
postingQueue | object | Y | 상태별 건수 {READY, CLAIMED, FAILED}
''')
schema('IfRunRow', 'IF 실행 로그 행(F-310-02)', '''
id | uuid | Y | id
interfaceId | string | Y | IF
direction | string | Y | 방향
batchId | string | Y | 배치
status | string | Y | 결과
recordCount | int | Y | 건수
errorCount | int | Y | 오류
startedAt | datetime | Y | 시작
finishedAt | datetime | N | 종료
correlationId | string | N | 추적 ID
''')
lst('IfRunRow', 'IF 실행 로그')
schema('IfMessageRow', 'IF 건별 결과', '''
recordKey | string | Y | 키
result | string | Y | OK / ERROR
errorCode | string | N | 코드
message | string | N | 메시지
payload | object | N | 원본(오류 건)
''')
lst('IfMessageRow', 'IF 건별 결과')
schema('PostingRow', '전기 큐 행', '''
id | uuid | Y | id
postingId | string | Y | 요청번호
postingType | string | Y | 유형
status | string | Y | 상태
assetTag | string | N | 자산
attemptCount | int | Y | 시도
approvedAt | datetime | N | 최종 승인
leaseUntil | datetime | N | 잠금 만료
sapDocumentNo | string | N | 전표
lastMessage | string | N | 마지막 SAP 메시지
''')
lst('PostingRow', '전기 큐')
schema('PostingDetail', '전기 상세', '''
summary | PostingSummary | Y | 요약
payload | object | Y | SAP에 보낸 봉투
requestNo | string | N | 연결 요청
''')
schema('RunRequestInput', 'SAP 수동 실행 요청(F-310-04)', '''
interfaceId | enum(IF-MD-01,IF-AA-01,IF-AA-02,IF-MM-01,IF-RC-01) | Y | 실행할 수신 IF
''')
schema('RunRequest', 'SAP 실행 요청', '''
id | uuid | Y | id
interfaceId | string | Y | IF
status | enum(PENDING,PICKED,DONE) | Y | PENDING → SAP 잡이 가져가면 PICKED → 실행 로그 생기면 DONE
requestedAt | datetime | Y | 요청
pickedAt | datetime | N | SAP이 가져간 일시
''')
schema('RunRequestList', 'SAP 실행 요청 목록(SAP이 호출)', '''
items | [RunRequest] | Y | PENDING이던 요청(이번 호출로 PICKED)
''')
schema('ReconRunRow', '대사 실행', '''
id | uuid | Y | id
runType | string | Y | WEEKLY / CAMPAIGN
snapshotAt | datetime | Y | 스냅샷
status | string | Y | 상태
sapCount | int | Y | SAP 자산
almCount | int | Y | ALM 자본화 자산
diffCount | int | Y | 차이
openDiffs | int | Y | 미처리
''')
lst('ReconRunRow', '대사 실행 목록')
schema('ReconDiffRow', '대사 차이(F-310-05)', '''
id | uuid | Y | id
diffType | enum(SAP_ONLY,ALM_ONLY,COST_CENTER,LOCATION,SERIAL,TAG,RETIRED) | Y | 유형
assetTag | string | N | ALM 자산
sapAssetNo | string | N | SAP 자산
almValue | string | N | ALM 값
sapValue | string | N | SAP 값
suggestedAction | enum(SAP_TO_ALM,ALM_TO_SAP,REVIEW,IGNORE) | Y | 규칙 제안
status | enum(OPEN,RESOLVED,IGNORED) | Y | 상태
''')
lst('ReconDiffRow', '대사 차이 목록')
schema('ReconResolve', '대사 차이 처리', '''
items | [ReconResolveItem] | Y | 최대 500건
''')
schema('ReconResolveItem', '차이 처리 1건', '''
id | uuid | Y | recon_diff.id
action | enum(SAP_TO_ALM,ALM_TO_SAP,IGNORE) | Y | SAP 값 반영 / ALM 값 전송(IF-AA-04) / 무시
note | string(200) | N | 메모
''')
schema('FieldMappingRow', '필드 매핑', '''
id | uuid | Y | id
almField | string | Y | ALM 테이블.컬럼
sapTable | string | N | SAP 테이블
sapField | string | N | SAP 필드
masterSystem | enum(SAP,ALM) | Y | 기준 시스템
interfaceIds | string | N | IF
description | string | N | 설명
''')
schema('FieldMappingList', '필드 매핑', '''
items | [FieldMappingRow] | Y | 행
''')
schema('FieldMappingPatch', '필드 매핑 수정', '''
description | string(200) | N | 설명(기준 시스템은 설계 결정이라 화면에서 못 바꿈)
''')
schema('SapConnectionRow', 'SAP 연결', '''
id | uuid | Y | id
systemId | string | Y | 시스템
companyCode | string | Y | 회사코드
oauthClientId | string | Y | 클라이언트 ID
lastCallAt | datetime | N | 마지막 호출
isActive | bool | Y | 사용
''')
schema('SapConnectionList', 'SAP 연결 목록', '''
items | [SapConnectionRow] | Y | 행
''')
schema('SapConnectionInput', 'SAP 연결 등록', '''
systemId | string(10) | Y | 시스템 ID-클라이언트
companyId | uuid | Y | 회사코드
''')
schema('SapClientSecret', '발급된 클라이언트 비밀(한 번만 표시)', '''
connection | SapConnectionRow | Y | 연결
clientSecret | string | Y | 비밀. 다시 조회할 수 없음 → SAP STRUST/SSF에 저장
''')
IR = [('interfaceId','query','string','N','IF'),('status','query','string','N','결과'),('from','query','date','N','시작일'),('to','query','date','N','종료일')]+PG
W('SAP 연계','GET','/integration/sap/status','getSapStatus','연결·IF 상태',AC+', ASSET_MANAGER',None,'SapStatus','200','sap_connection, sap_if_run, sap_posting','ALM-310',[ '잡 미실행 2회 연속이면 isOverdue(대시보드 알림과 같은 기준).'])
W('SAP 연계','GET','/integration/sap/runs','listSapRuns','IF 실행 로그',AC,None,'IfRunRowList','200','sap_if_run','ALM-310',[ '10년 보관분 조회. 기본 최근 30일.'],params=IR)
W('SAP 연계','GET','/integration/sap/runs/{id}/messages','listSapRunMessages','IF 건별 결과',AC,None,'IfMessageRowList','200, 404','sap_if_message','ALM-310',[ '-'],params=CI+[('result','query','string','N','OK, ERROR')]+PG)
W('SAP 연계','GET','/integration/sap/postings','listPostings','전기 큐',AC,None,'PostingRowList','200','sap_posting','ALM-310',[ '기본 FAILED·READY·CLAIMED.'],params=[('status','query','string','N','상태'),('type','query','string','N','유형'),('q','query','string','N','요청번호·자산태그')]+PG)
W('SAP 연계','GET','/integration/sap/postings/{id}','getPosting','전기 상세',AC,None,'PostingDetail','200, 404','sap_posting','ALM-310',[ '-'],params=CI)
W('SAP 연계','POST','/integration/sap/postings/{id}:retry','retryPosting','재전기',AC,None,'PostingSummary','200, 409','sap_posting, asset_request','ALM-310',
  ['FAILED만. 연결 요청의 현재 값으로 payload를 다시 만들고 READY, attempt는 0부터(F-310-03).', '같은 postingId를 쓰므로 SAP BKTXT 확인으로 중복 전기가 막힌다.'],params=CI,idem='Idempotency-Key')
W('SAP 연계','POST','/integration/sap/postings/{id}:cancel','cancelPosting','전기 취소',AC,None,'PostingSummary','200, 409','sap_posting, asset_request','ALM-310',[ 'READY·FAILED만. 연결 요청은 CANCELLED.'],params=CI)
W('SAP 연계','POST','/integration/sap/run-requests','createRunRequest','SAP 수동 실행 요청',AC,'RunRequestInput','RunRequest','201, 409','sap_run_request','ALM-310',
  ['ALM은 SAP을 직접 호출하지 않는다. 요청을 남기면 15분 주기 SAP 잡이 GET /sap/run-requests로 가져가 해당 수신 잡을 바로 실행한다.', '같은 IF의 PENDING이 있으면 409.'],ok='201')
W('SAP 연계','GET','/integration/sap/reconciliation/runs','listReconRuns','대사 실행 목록',AC,None,'ReconRunRowList','200','recon_run, recon_diff','ALM-310',[ '-'],params=PG)
W('SAP 연계','GET','/integration/sap/reconciliation/runs/{id}/diffs','listReconDiffs','대사 차이',AC,None,'ReconDiffRowList','200, 404','recon_diff, asset','ALM-310',[ '-'],params=CI+[('diffType','query','string','N','유형'),('status','query','string','N','기본 OPEN')]+PG)
W('SAP 연계','POST','/integration/sap/reconciliation/diffs:resolve','resolveReconDiffs','대사 차이 처리',AC,'ReconResolve','BulkResult','200, 207, 400','recon_diff, asset, sap_posting, asset_event','ALM-310',
  ['SAP_TO_ALM: ALM 값을 SAP 값으로 바꾸고 asset_event. ALM_TO_SAP: ASSET_CHANGE 전기 건 생성. SAP_ONLY는 ALM 자산 생성 + 실사 필요 표시.'],idem='Idempotency-Key')
W('SAP 연계','GET','/integration/sap/field-mappings','listFieldMappings','필드 매핑',AC+', ASSET_MANAGER',None,'FieldMappingList','200','field_mapping','ALM-310',[ '-'])
W('SAP 연계','PATCH','/integration/sap/field-mappings/{id}','patchFieldMapping','필드 매핑 설명 수정',SA,'FieldMappingPatch','FieldMappingRow','200, 404','field_mapping','ALM-310',[ '-'],params=CI)
W('SAP 연계','GET','/integration/sap/connections','listSapConnections','SAP 연결 목록',SA,None,'SapConnectionList','200','sap_connection','ALM-310',[ '-'])
W('SAP 연계','POST','/integration/sap/connections','createSapConnection','SAP 연결 등록·비밀 발급',SA,'SapConnectionInput','SapClientSecret','201, 400, 409','sap_connection','ALM-310',[ 'Cognito 앱 클라이언트를 만들고 비밀을 한 번만 돌려준다.'],ok='201')
W('SAP 연계','POST','/integration/sap/connections/{id}:rotate-secret','rotateSapSecret','비밀 교체',SA,None,'SapClientSecret','200, 404','sap_connection','ALM-310',[ '이전 비밀은 24시간 더 유효(SAP STRUST 교체 시간).'],params=CI)

# SAP machine endpoint for manual run requests
ep('sap','GET','/sap/run-requests','sapGetRunRequests','수동 실행 요청 가져오기','SAP',None,'RunRequestList','200, 401','sap_run_request','F-310-04',
   ['15분 주기 전기 잡이 처음에 호출한다. PENDING 요청을 PICKED로 바꿔 돌려주고, SAP은 해당 수신 잡(IF-MD-01, AA-01·02, MM-01, RC-01)을 바로 실행한다.'])

# ---------------- admin ----------------
schema('UserRow', '사용자', '''
id | uuid | Y | id
email | string | Y | 이메일
displayName | string | Y | 이름
department | string | N | 부서
costCenterCode | string | N | 코스트센터
roles | [RoleScope] | Y | 역할
isActive | bool | Y | 사용
lastLoginAt | datetime | N | 마지막 로그인
''')
lst('UserRow', '사용자 목록')
schema('UserInput', '사용자 등록·수정', '''
email | string(254) | Y | 이메일(SSO 계정)
displayName | string(100) | Y | 이름
employeeNo | string(20) | N | 사번
department | string(100) | N | 부서
costCenterId | uuid | N | 코스트센터
isActive | bool | N | 사용
''')
schema('RoleAssign', '역할 전체 교체', '''
roles | [RoleScope] | Y | 역할과 범위
''')
schema('MasterRecord', 'ALM 관리 마스터 1건. type별 필드는 테이블 정의서 4장', '''
id | uuid | N | id(수정 시)
version | int | N | 낙관적 잠금(수정 시)
values | object | Y | 컬럼 값 (예: rooms → siteId, roomCode, name, floor, sapRoomNo, barcode, isStorage)
isActive | bool | N | 사용
''')
schema('MasterRecordList', '마스터 목록', '''
items | [MasterRecord] | Y | 행
page | int | Y | 페이지
pageSize | int | Y | 크기
total | int | Y | 전체
''')
schema('CodeGroup', '공통 코드 그룹', '''
group | string(30) | Y | 그룹
codes | [CodeEntry] | Y | 코드(전체 교체)
''')
schema('CodeEntry', '공통 코드', '''
code | string(30) | Y | 코드
labelEn | string(100) | Y | 영문
labelKo | string(100) | N | 한글
sortOrder | int | N | 순서
isActive | bool | N | 사용
''')
schema('CodeGroupList', '공통 코드', '''
items | [CodeGroup] | Y | 그룹
''')
schema('SettingRow', '설정', '''
key | string(60) | Y | 키 (예: license.over_threshold, asset.capitalization_threshold, sap.posting_blackout)
value | object | Y | 값
description | string | N | 설명
''')
schema('SettingList', '설정 목록', '''
items | [SettingRow] | Y | 행
''')
schema('AuditRow', '감사 로그', '''
id | uuid | Y | id
occurredAt | datetime | Y | 일시
tableName | string | Y | 테이블
rowId | uuid | Y | 행
action | string | Y | INSERT / UPDATE / DELETE
actorName | string | N | 처리자
actorType | string | Y | USER / SYSTEM / SAP / PDA
changes | object | N | 변경 필드 전후값
correlationId | string | N | 추적 ID
''')
lst('AuditRow', '감사 로그')
MT = ('type','path','enum(sites,rooms,categories,models,vendors,printers)','Y','마스터 종류')
W('관리','GET','/admin/users','listUsers','사용자 목록',SA,None,'UserRowList','200','app_user, user_role','관리',[ '-'],params=[('q','query','string','N','이름·이메일'),('role','query','string','N','역할')]+PG)
W('관리','POST','/admin/users','createUser','사용자 등록',SA,'UserInput','UserRow','201, 400, 409','app_user','관리',[ 'SSO 첫 로그인 때 idp_subject를 연결한다. 이메일 중복 409.'],ok='201')
W('관리','PATCH','/admin/users/{id}','patchUser','사용자 수정',SA,'UserInput','UserRow','200, 400, 404','app_user','관리',[ 'isActive=false면 다음 요청부터 401.'],params=CI)
W('관리','PUT','/admin/users/{id}/roles','putUserRoles','역할·범위 지정',SA,'RoleAssign','UserRow','200, 400, 404','user_role, audit_log','관리',[ '전체 교체. 자기 자신의 SYS_ADMIN은 뺄 수 없다(409).'],params=CI)
W('관리','GET','/admin/masters/{type}','listMasters','ALM 관리 마스터 목록',SA+', ASSET_MANAGER',None,'MasterRecordList','200, 400','site, room, category, model, vendor, printer','관리',[ 'SAP 마스터(회사코드, 코스트센터 등)는 IF-MD-01로만 바뀌므로 /lookups로 조회.'],params=[MT,('q','query','string','N','검색')]+PG)
W('관리','POST','/admin/masters/{type}','createMaster','마스터 등록',SA,'MasterRecord','MasterRecord','201, 400, 409','site, room, category, model, vendor, printer','관리',[ '룸 바코드 미입력 시 roomCode로.'],params=[MT],ok='201')
W('관리','PATCH','/admin/masters/{type}/{id}','patchMaster','마스터 수정',SA,'MasterRecord','MasterRecord','200, 400, 404, 409','site, room, category, model, vendor, printer','관리',[ '삭제 대신 isActive=false. 사용 중인 룸 비활성은 409 ALM-E318.'],params=[MT,ID()])
W('관리','GET','/admin/codes','listCodes','공통 코드',SA,None,'CodeGroupList','200','code','관리',[ '-'])
W('관리','PUT','/admin/codes/{group}','putCodeGroup','코드 그룹 저장',SA,'CodeGroup','CodeGroup','200, 400','code','관리',[ '그룹 전체 교체. 쓰이는 코드는 지우지 않고 isActive=false.'],params=[('group','path','string(30)','Y','그룹')])
W('관리','GET','/admin/settings','listSettings',  '설정',SA,None,'SettingList','200','setting','관리',[ '-'])
W('관리','PUT','/admin/settings/{key}','putSetting','설정 저장',SA,'SettingRow','SettingRow','200, 400','setting, audit_log','관리',[ '키별 값 형식 검사.'],params=[('key','path','string(60)','Y','키')])
W('관리','GET','/admin/audit-logs','listAuditLogs','감사 로그 조회','SYS_ADMIN, ASSET_ACCOUNTANT',None,'AuditRowList','200','audit_log','관리',[ '10년 보관. 13개월 지난 기간은 보관 저장소에서 비동기 조회(내보내기로 안내).'],
  params=[('tableName','query','string','N','테이블'),('rowId','query','uuid','N','행'),('actorId','query','uuid','N','처리자'),('from','query','date','N','시작'),('to','query','date','N','종료')]+PG)
