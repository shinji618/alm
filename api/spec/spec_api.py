# ALM API spec (WBS 2.6 — PDA, SAP). Single source for openapi.yaml and the Markdown spec tables.
# Field line: name | type | req | description
#   type: string, string(n), int, number, bool, date, datetime, uuid, enum(A,B), [Type] array, Type (schema ref), object

S = {}  # schema name -> (description, [fields])
def schema(name, desc, fields):
    S[name] = (desc, [tuple(x.strip() for x in l.split('|')) for l in fields.strip().split('\n') if l.strip()])

# ---------------- common ----------------
schema('Problem', '오류 응답 (RFC 9457 application/problem+json)', '''
type | string | Y | 오류 유형 URI (예: https://alm.bsg/errors/validation)
title | string | Y | 요약
status | int | Y | HTTP 상태
code | string | Y | ALM 오류 코드 (예: ALM-E104)
detail | string | N | 상세 설명
correlationId | uuid | Y | X-Correlation-Id 값
errors | [FieldError] | N | 필드별 오류
''')
schema('FieldError', '필드 오류', '''
field | string | Y | JSON 경로 (예: records[3].costCenter)
code | string | Y | ALM 오류 코드
message | string | Y | 메시지
''')
schema('ItemResult', '배치 건별 결과', '''
key | string | Y | 레코드 키 (예: 1000/000300001234/0000)
status | enum(OK,ERROR,SKIPPED) | Y | OK 반영, ERROR 오류, SKIPPED 변경 없음
code | string | N | 오류 코드
message | string | N | 메시지
''')
schema('BatchResult', '배치 수신 응답. 일부 오류면 HTTP 207', '''
batchId | string | Y | 요청의 batchId
received | int | Y | 받은 건수
succeeded | int | Y | 반영 건수
failed | int | Y | 오류 건수
results | [ItemResult] | Y | 건별 결과(오류·SKIPPED만 담고, 성공 건은 생략 가능)
''')

# ---------------- PDA ----------------
schema('PdaMe', '로그인 사용자와 앱 설정', '''
userId | uuid | Y | app_user.id
displayName | string | Y | 이름
email | string | Y | 이메일
locale | enum(en,ko) | Y | 화면 언어
roles | [string] | Y | 역할 코드 (COUNTER 필수)
tenantCode | string | Y | 테넌트 코드
serverTime | datetime | Y | 서버 시각(기기 시계 보정용)
minAppVersion | string | Y | 최소 앱 버전. 낮으면 업데이트 안내
offlineHours | int | Y | 오프라인 허용 시간(기본 24)
''')
schema('DeviceRegister', '기기 등록 요청', '''
deviceSerial | string(40) | Y | 기기 시리얼
model | string(40) | N | 모델 (예: TC58)
appVersion | string(20) | Y | 앱 버전
''')
schema('Device', '기기 등록 결과', '''
deviceId | uuid | Y | pda_device.id
lastSyncAt | datetime | N | 마지막 동기화
''')
schema('PdaTask', '내 룸 실사 작업', '''
taskId | uuid | Y | count_task.id
campaignId | uuid | Y | 캠페인
campaignCode | string(6) | Y | 캠페인 코드 (예: PI26Q4)
campaignName | string | Y | 캠페인 이름
keyDate | date | Y | 기준일
dueDate | date | Y | 기한
roomId | uuid | Y | 룸
roomCode | string(10) | Y | 룸 코드
roomName | string | Y | 룸 이름
siteCode | string(10) | Y | 사이트
status | enum(NOT_STARTED,IN_PROGRESS,COMPLETED) | Y | 작업 상태
expectedCount | int | Y | 대상 자산 수
foundCount | int | Y | 확인(FOUND) 수
pendingCount | int | Y | 미확인 수
updatedAt | datetime | Y | 변경 일시
''')
schema('PdaTaskList', '내 작업 목록', '''
items | [PdaTask] | Y | 작업
''')
schema('WorklistItem', '작업목록의 실사 대상 1건', '''
countItemId | uuid | Y | count_item.id
assetId | uuid | Y | 자산
assetTag | string(25) | Y | 자산태그(바코드 값)
description | string(50) | Y | 자산명
categoryName | string | Y | 카테고리
model | string | N | 모델
serialNo | string(40) | N | 시리얼
assetStatus | enum(ON_ORDER,IN_STOCK,IN_USE,IN_REPAIR,MISSING,RETIRED,DISPOSED) | Y | 자산 상태
expectedRoomId | uuid | Y | 등록 룸
expectedRoomCode | string(10) | Y | 등록 룸 코드
assignedUserName | string | N | 사용자(PDA-05 사용자 확인)
result | enum(PENDING,FOUND,MISPLACED,NOT_FOUND) | Y | 서버 기준 판정
countedAt | datetime | N | 실사 일시
updatedAt | datetime | Y | 변경 일시(델타 기준)
''')
schema('WorklistPage', '작업목록 페이지. syncToken으로 다음 델타를 받음', '''
campaignId | uuid | Y | 캠페인
items | [WorklistItem] | Y | 대상(최대 limit건)
removed | [uuid] | Y | 범위에서 빠진 countItemId(델타일 때)
nextCursor | string | N | 다음 페이지 커서. 없으면 마지막
syncToken | string | Y | 마지막 페이지에서 저장. 다음 호출의 since로 사용
''')
schema('TagIndexItem', '범위 밖 자산태그(오프라인 판정용)', '''
assetTag | string(25) | Y | 자산태그
assetStatus | enum(ON_ORDER,IN_STOCK,IN_USE,IN_REPAIR,MISSING,RETIRED,DISPOSED) | Y | 자산 상태
siteCode | string(10) | N | 사이트
''')
schema('TagIndexPage', '범위 밖 태그 색인 페이지', '''
items | [TagIndexItem] | Y | 태그
nextCursor | string | N | 다음 페이지 커서
syncToken | string | Y | 다음 델타의 since
''')
schema('PdaRoom', '룸', '''
roomId | uuid | Y | 룸
roomCode | string(10) | Y | 룸 코드
name | string | Y | 이름
floor | string | N | 층
siteCode | string(10) | Y | 사이트
barcode | string(30) | Y | 룸 바코드 값
''')
schema('PdaRoomList', '룸 목록', '''
items | [PdaRoom] | Y | 룸
''')
schema('PdaCodes', 'PDA 코드값', '''
categories | [CodeItem] | Y | 미등록 자산 카테고리
conditions | [CodeItem] | Y | 자산 상태(GOOD, DAMAGED, UNUSED)
''')
schema('CodeItem', '코드', '''
id | string | Y | 코드 또는 id
label | string | Y | 이름(사용자 언어)
''')
schema('TaskUpdate', '룸 작업 시작·완료', '''
action | enum(START,COMPLETE) | Y | 시작 또는 완료(PDA-07)
at | datetime | Y | 기기 시각
force | bool | N | 미확인 자산이 남아도 완료(기본 false)
''')
schema('ScanIn', '스캔 1건', '''
clientScanId | uuid | Y | PDA가 만든 UUID. 멱등성 키
campaignId | uuid | Y | 캠페인
taskId | uuid | Y | 현재 룸 작업
roomId | uuid | Y | 현재 룸(PDA-03에서 선택)
barcode | string(40) | Y | 읽은 값
inputMethod | enum(TRIGGER,CAMERA,MANUAL) | Y | 입력 방법
deviceResult | enum(FOUND,MISPLACED,OUT_OF_SCOPE,UNREGISTERED,DUPLICATE,RETIRED_ASSET) | Y | 기기 판정(참고값)
condition | enum(GOOD,DAMAGED,UNUSED) | N | 상태 입력(PDA-05)
isUserConfirmed | bool | N | 사용자 확인
needsRelabel | bool | N | 라벨 재출력 요청 → label_print_job 생성
note | string(200) | N | 메모
attachmentIds | [uuid] | N | 사진(미리 업로드한 첨부)
scannedAt | datetime | Y | 기기 스캔 시각
''')
schema('ScanBatch', '스캔 일괄 전송(최대 200건)', '''
deviceId | uuid | Y | 기기
scans | [ScanIn] | Y | 스캔(scannedAt 순)
''')
schema('ScanResultItem', '스캔 건별 처리 결과', '''
clientScanId | uuid | Y | 요청의 clientScanId
status | enum(ACCEPTED,DUPLICATE,REJECTED) | Y | ACCEPTED 반영, DUPLICATE 이미 받음(최초 결과 반환), REJECTED 오류
serverResult | enum(FOUND,MISPLACED,OUT_OF_SCOPE,UNREGISTERED,DUPLICATE,RETIRED_ASSET) | N | 서버 판정
countItemId | uuid | N | 실사 대상
assetId | uuid | N | 자산
code | string | N | 오류 코드(REJECTED)
message | string | N | 메시지
''')
schema('TaskProgress', '룸 진행', '''
taskId | uuid | Y | 작업
foundCount | int | Y | 확인 수
pendingCount | int | Y | 미확인 수
''')
schema('ScanBatchResult', '스캔 일괄 결과', '''
results | [ScanResultItem] | Y | 건별 결과(요청 순서)
tasks | [TaskProgress] | Y | 영향받은 룸 진행
''')
schema('UnregisteredIn', '미등록 자산 1건(PDA-06)', '''
clientScanId | uuid | Y | PDA UUID. 멱등성 키
campaignId | uuid | Y | 캠페인
roomId | uuid | Y | 발견 룸
provisionalNo | string(20) | Y | 기기 임시번호(화면 표시용, 예: TC58A-0007)
categoryId | uuid | N | 카테고리
description | string(100) | Y | 설명
serialNo | string(40) | N | 시리얼
scannedBarcode | string(40) | N | 읽은 값(있으면)
attachmentIds | [uuid] | Y | 사진 1장 이상(필수)
reportedAt | datetime | Y | 기기 시각
''')
schema('UnregisteredBatch', '미등록 자산 일괄 전송(최대 50건)', '''
deviceId | uuid | Y | 기기
items | [UnregisteredIn] | Y | 미등록 자산
''')
schema('UnregisteredResultItem', '미등록 건별 결과', '''
clientScanId | uuid | Y | 요청의 clientScanId
status | enum(ACCEPTED,DUPLICATE,REJECTED) | Y | 처리 결과
tempNo | string(12) | N | 서버 채번 UNREG-nnnn (캠페인 내 유일)
code | string | N | 오류 코드
message | string | N | 메시지
''')
schema('UnregisteredBatchResult', '미등록 일괄 결과', '''
results | [UnregisteredResultItem] | Y | 건별 결과
''')
schema('PresignRequest', '사진 업로드 URL 요청', '''
fileName | string(200) | Y | 파일명
contentType | enum(image/jpeg,image/png) | Y | MIME
sizeBytes | int | Y | 크기(최대 5 MB)
sha256 | string(64) | Y | 파일 해시(업로드 후 검증)
ownerType | enum(count_item,count_unregistered) | Y | 연결 대상 종류
''')
schema('PresignResponse', '사진 업로드 URL', '''
attachmentId | uuid | Y | attachment.id. 스캔·미등록 전송에 사용
uploadUrl | string | Y | S3 presigned PUT URL
headers | object | Y | PUT 시 함께 보낼 헤더(Content-Type, x-amz-checksum-sha256)
expiresAt | datetime | Y | URL 만료(발급 + 15분)
''')

# ---------------- SAP ----------------
schema('TokenResponse', 'OAuth 2.0 토큰', '''
access_token | string | Y | Bearer 토큰(JWT)
token_type | enum(Bearer) | Y | Bearer
expires_in | int | Y | 유효 초(3600)
scope | string | Y | sap.api
''')
schema('SapPing', '연결 확인', '''
status | enum(UP) | Y | 상태
serverTime | datetime | Y | 서버 시각
tenantCode | string | Y | 클라이언트가 속한 테넌트
companyCodes | [string] | Y | 허용 회사코드
''')
schema('MasterDataRequest', 'IF-MD-01 조직·코드 마스터(유형별 전체 전송, 분할 가능)', '''
batchId | string(40) | Y | 배치 ID (예: MD01-20261004-0530)
type | enum(COMPANY,PLANT,COST_CENTER,PROFIT_CENTER,ASSET_CLASS,LOCATION) | Y | 마스터 유형
chunkNo | int | Y | 분할 번호(1부터)
isLast | bool | N | 마지막 분할이면 true(없으면 false). true 수신 시 이번 배치에 없던 코드를 비활성 처리
records | [object] | Y | 유형별 레코드(아래 MdCompany 등), 최대 5,000건
''')
schema('MdCompany', 'COMPANY 레코드 → company', '''
companyCode | string(4) | Y | BUKRS
name | string(25) | Y | BUTXT
currency | string(5) | Y | WAERS
''')
schema('MdPlant', 'PLANT 레코드 → plant', '''
plantCode | string(4) | Y | WERKS
companyCode | string(4) | Y | BUKRS
name | string(30) | Y | NAME1
address | string(200) | N | 주소
''')
schema('MdCostCenter', 'COST_CENTER 레코드 → cost_center', '''
controllingArea | string(4) | Y | KOKRS
costCenter | string(10) | Y | KOSTL
name | string(20) | Y | KTEXT
companyCode | string(4) | Y | BUKRS
profitCenter | string(10) | N | PRCTR
responsible | string(20) | N | VERAK
validFrom | date | N | DATAB
validTo | date | N | DATBI
''')
schema('MdProfitCenter', 'PROFIT_CENTER 레코드 → profit_center', '''
controllingArea | string(4) | Y | KOKRS
profitCenter | string(10) | Y | PRCTR
name | string(20) | Y | KTEXT
segment | string(10) | N | SEGMENT
''')
schema('MdAssetClass', 'ASSET_CLASS 레코드 → asset_class', '''
assetClass | string(8) | Y | ANLKL
name | string(50) | Y | TXK50
isLowValue | bool | N | 저가자산 여부(없으면 false)
usefulLifeYears | int | N | 내용연수 기본값
''')
schema('MdLocation', 'LOCATION 레코드 → site.sap_location 확인용', '''
plantCode | string(4) | Y | WERKS
location | string(10) | Y | STAND
name | string(40) | Y | KTEXT
''')
schema('SapAsset', 'IF-AA-01 자산 마스터 1건 → asset(SAP 기준 필드만 갱신)', '''
companyCode | string(4) | Y | ANLA-BUKRS
assetNo | string(12) | Y | ANLA-ANLN1
subNo | string(4) | Y | ANLA-ANLN2
assetClass | string(8) | Y | ANLA-ANLKL
description | string(50) | Y | ANLA-TXT50
serialNo | string(18) | N | ANLA-SERNR (ALM 기준, 참고만)
inventoryNo | string(25) | N | ANLA-INVNR = 자산태그. ALM 자산 매칭 키
capDate | date | N | ANLA-AKTIV
deactDate | date | N | ANLA-DEAKT. 값이 있으면 ALM을 RETIRED로 대사
lastCountDate | date | N | ANLA-IVDAT
inventoryNote | string(15) | N | ANLA-INVZU
costCenter | string(10) | Y | ANLZ-KOSTL
profitCenter | string(10) | N | ANLZ-PRCTR
plant | string(4) | N | ANLZ-WERKS
location | string(10) | N | ANLZ-STORT = ALM 룸 코드
room | string(8) | N | ANLZ-RAUMNR
changedAt | datetime | Y | 변경 시각(델타 기준)
''')
schema('AssetUpsertRequest', 'IF-AA-01 요청', '''
batchId | string(40) | Y | 배치 ID
isFull | bool | N | 최초 전체 전송이면 true
records | [SapAsset] | Y | 최대 1,000건
''')
schema('SapAssetValue', 'IF-AA-02 기간 금액 1건 → asset_value', '''
companyCode | string(4) | Y | BUKRS
assetNo | string(12) | Y | ANLN1
subNo | string(4) | Y | ANLN2
fiscalYear | int | Y | GJAHR
period | int | Y | 기간 1~16
depArea | string(2) | Y | AFABE (01)
acquisitionValue | number | Y | 취득가 누계(USD, 소수 2자리)
accumDepreciation | number | Y | 감가상각누계액(음수, 0이어도 생략하지 않음)
netBookValue | number | Y | 장부가액
usefulLifeYears | int | N | NDJAR
usefulLifePeriods | int | N | NDPER
depKey | string(4) | N | AFASL
''')
schema('AssetValuesRequest', 'IF-AA-02 요청', '''
batchId | string(40) | Y | 배치 ID
isClosing | bool | N | 마감 후 실행이면 true → 이 레코드의 (회계연도, 기간)을 마감값으로 잠금
records | [SapAssetValue] | Y | 최대 1,000건
''')
schema('ClaimRequest', '전기 대상 가져오기', '''
batchId | string(40) | Y | SAP 잡 실행 ID (예: POST-20261004-0915)
maxItems | int | N | 최대 건수(기본 50, 최대 200)
types | [enum(ASSET_CREATE,ASSET_CHANGE,ASSET_TRANSFER,ASSET_RETIRE,COUNT_RESULT,PO_CREATE)] | N | 가져올 유형(비면 전체)
''')
schema('AssetRef', '자산 키', '''
assetNo | string(12) | N | ANLN1 (신규는 빈 값)
subNo | string(4) | N | ANLN2
inventoryNo | string(25) | N | INVNR = 자산태그 (ASSET_CREATE·COUNT_RESULT는 필수)
''')
schema('PostingEnvelope', '전기 1건(공통 봉투)', '''
postingId | string(12) | Y | ALM 요청번호. BKTXT에 기재, 멱등성 키
type | enum(ASSET_CREATE,ASSET_CHANGE,ASSET_TRANSFER,ASSET_RETIRE,COUNT_RESULT,PO_CREATE) | Y | 전기 유형
companyCode | string(4) | Y | 회사코드
postingDate | date | Y | 전기일
valueDate | date | N | 가치일 BZDAT
asset | AssetRef | N | 대상 자산(PO_CREATE는 없음)
payload | object | Y | 유형별 필드(4.13의 6종)
approvedBy | string | Y | 최종 승인자(이메일)
approvedAt | datetime | Y | 최종 승인 일시
attempt | int | Y | 시도 횟수(1부터)
leaseUntil | datetime | Y | 잠금 만료. 만료까지 결과가 없으면 다시 대상
''')
schema('ClaimResponse', '전기 대상 응답', '''
batchId | string | Y | 요청의 batchId
leaseSeconds | int | Y | 잠금 시간(900)
items | [PostingEnvelope] | Y | 전기 대상(postingId 순)
''')
schema('AssetCreatePayload', 'ASSET_CREATE (IF-AA-03, BAPI_FIXEDASSET_CREATE1)', '''
assetClass | string(8) | Y | ANLKL
description | string(50) | Y | TXT50
costCenter | string(10) | Y | KOSTL
capDate | date | N | AKTIV(빈 값 가능)
serialNo | string(18) | N | SERNR
inventoryNo | string(25) | Y | INVNR
location | string(10) | N | STORT = 룸 코드
room | string(8) | N | RAUMNR 약어
poNo | string(10) | N | 참조 PO
poItem | string(5) | N | 참조 PO 항목
''')
schema('AssetChangePayload', 'ASSET_CHANGE (IF-AA-04, BAPI_FIXEDASSET_CHANGE)', '''
fields | object | Y | 변경 필드만: description, serialNo, inventoryNo, location, room, costCenter
costCenterValidFrom | date | N | 코스트센터 변경 시 시간종속 유효시작일
''')
schema('AssetTransferPayload', 'ASSET_TRANSFER (IF-AA-05, ABUMN)', '''
newCostCenter | string(10) | Y | 새 코스트센터
newProfitCenter | string(10) | Y | 새 손익센터
transactionType | string(3) | N | 참고용. SAP은 ZALM_MAP(TRANSFER_TT) 값을 쓴다
percent | number | Y | 이관 비율(100)
createNewSubNo | bool | Y | 신규 보조번호 생성 여부
''')
schema('AssetRetirePayload', 'ASSET_RETIRE (IF-AA-06, BAPI_ASSET_RETIREMENT_POST)', '''
retireType | enum(SCRAP,SALE,LOSS) | Y | ABAVN 폐기 / ABAON 매각 / 분실(폐기 처리)
transactionType | string(3) | N | 참고용. SAP은 ZALM_MAP(retireType → 거래유형) 값을 쓴다
saleAmount | number | N | 매각금액(SALE 필수)
customer | string(10) | N | 매각 고객번호(사용 시)
isPartial | bool | N | v1은 전체 폐기만 지원. 항상 false(true면 SAP이 FAILED)
reason | string(50) | N | 사유
''')
schema('CountResultPayload', 'COUNT_RESULT (IF-AA-07, BAPI_FIXEDASSET_CHANGE)', '''
lastCountDate | date | Y | IVDAT
inventoryNote | string(15) | Y | INVZU (예: PI26Q4-OK)
''')
schema('PoCreatePayload', 'PO_CREATE (IF-MM-02, BAPI_PO_CREATE1)', '''
purchasingOrg | string(4) | Y | EKORG
purchasingGroup | string(3) | Y | EKGRP
vendor | string(10) | Y | LIFNR
costCenter | string(10) | Y | KOSTL
items | [PoCreateItem] | Y | 품목
''')
schema('PoCreateItem', 'PO 품목', '''
itemNo | string(5) | Y | EBELP (10, 20 …)
description | string(40) | Y | TXZ01
quantity | number | Y | MENGE
unitPrice | number | Y | NETPR(USD)
assetNo | string(12) | Y | 계정지정 A 자산번호(없으면 IF-AA-03 선처리)
subNo | string(4) | Y | 보조번호
''')
schema('BapiMessage', 'BAPI RETURN 메시지', '''
type | enum(S,I,W,E,A) | Y | 메시지 유형
id | string(20) | Y | 메시지 클래스
number | string(3) | Y | 메시지 번호
text | string(220) | Y | 메시지
''')
schema('SapDocument', 'SAP 전표', '''
belnr | string(10) | Y | 전표번호
gjahr | string(4) | Y | 회계연도
''')
schema('PostingResult', '전기 결과 회신', '''
postingId | string(12) | Y | 경로의 id와 같아야 함
status | enum(POSTED,FAILED) | Y | 결과
sapDocument | SapDocument | N | 전표(이관·폐기)
asset | AssetRef | N | 생성·이관된 자산번호
poNo | string(10) | N | 생성된 PO 번호(PO_CREATE)
messages | [BapiMessage] | N | FAILED면 E·A 메시지 전부(필수), POSTED면 생략 가능
''')
schema('PostingAck', '결과 회신 응답', '''
postingId | string | Y | 요청번호
status | enum(POSTED,FAILED) | Y | 저장된 결과(중복 회신이면 최초 결과)
requestStatus | string | Y | 연결된 ALM 요청 상태(POSTED, POST_ERROR 등)
''')
schema('SapPoItem', 'IF-MM-01 자산 PO 항목 → po_item, po_item_asset', '''
poNo | string(10) | Y | EBELN
item | string(5) | Y | EBELP
companyCode | string(4) | Y | BUKRS
vendor | string(10) | N | LIFNR
vendorName | string(80) | N | 공급사명
description | string(40) | Y | TXZ01
quantity | number | Y | MENGE
unitPrice | number | N | NETPR
costCenter | string(10) | N | EKKN-KOSTL
assets | [AssetRef] | N | EKKN 자산번호(항목당 여러 개)
deletionFlag | bool | N | LOEKZ. true면 입고 대기 취소(없으면 false)
almRequestNo | string(12) | N | ALM에서 생성한 PO면 PR 번호
''')
schema('PurchaseOrdersRequest', 'IF-MM-01 요청', '''
batchId | string(40) | Y | 배치 ID
records | [SapPoItem] | Y | 최대 1,000건
''')
schema('SapGoodsReceipt', 'IF-MM-03 입고 1건 → goods_receipt, 101이면 asset 생성', '''
materialDoc | string(10) | Y | MBLNR
docYear | string(4) | Y | MJAHR
docItem | string(4) | Y | ZEILE
poNo | string(10) | Y | EBELN
poItem | string(5) | Y | EBELP
movementType | enum(101,102,122) | Y | 101 입고 / 102 취소 / 122 공급사 반품
quantity | number | Y | MENGE
postingDate | date | Y | BUDAT
''')
schema('GoodsReceiptsRequest', 'IF-MM-03 요청', '''
batchId | string(40) | Y | 배치 ID
records | [SapGoodsReceipt] | Y | 최대 1,000건
''')
schema('ReconRecord', 'IF-RC-01 스냅샷 1건 → recon_snapshot', '''
companyCode | string(4) | Y | BUKRS
assetNo | string(12) | Y | ANLN1
subNo | string(4) | Y | ANLN2
inventoryNo | string(25) | N | INVNR
serialNo | string(18) | N | SERNR
costCenter | string(10) | N | KOSTL
location | string(10) | N | STORT
room | string(8) | N | RAUMNR
deactDate | date | N | DEAKT
''')
schema('ReconRequest', 'IF-RC-01 요청(분할 전송)', '''
batchId | string(40) | Y | 배치 ID(모든 분할이 같은 값)
runType | enum(WEEKLY,CAMPAIGN) | Y | 주간 / 실사 종료
campaignCode | string(6) | N | CAMPAIGN이면 필수
snapshotAt | datetime | Y | 스냅샷 시각
chunkNo | int | Y | 분할 번호(1부터)
isLast | bool | N | 마지막 분할이면 true → 차이 계산 시작(없으면 false)
records | [ReconRecord] | Y | 최대 5,000건
''')
schema('ReconResponse', 'IF-RC-01 응답', '''
batchId | string | Y | 배치 ID
runId | uuid | Y | recon_run.id
received | int | Y | 이번 분할 건수
status | enum(RECEIVING,PROCESSING) | Y | 마지막 분할이면 PROCESSING(차이는 비동기 계산)
''')

# ---------------- endpoints ----------------
# (group, method, path, opId, summary, auth, idem, request schema or None, response 2xx schema, statuses, tables, refs, rules)
E = []
def ep(group, method, path, op, summary, auth, req, resp, codes, tables, ref, rules, idem='-', params=None, ok='200'):
    E.append(dict(group=group, method=method, path=path, op=op, summary=summary, auth=auth, req=req, resp=resp,
                  codes=codes, tables=tables, ref=ref, rules=rules, idem=idem, params=params or [], ok=ok))

P = 'pda'
ep(P,'GET','/pda/me','pdaGetMe','로그인 사용자·앱 설정','PDA',None,'PdaMe','200, 401, 403','app_user, user_role','PDA-01',
   ['COUNTER 역할이 없으면 403 ALM-E401.', '앱은 serverTime으로 기기 시계 차이를 기록하고 scannedAt 보정에 쓴다.'])
ep(P,'PUT','/pda/devices/{deviceSerial}','pdaRegisterDevice','기기 등록·갱신','PDA','DeviceRegister','Device','200, 400, 401','pda_device','PDA-01',
   ['같은 시리얼이면 갱신(멱등). last_user_id·app_version·last_sync_at 기록.'],
   params=[('deviceSerial','path','string(40)','Y','기기 시리얼')])
ep(P,'GET','/pda/tasks','pdaListTasks','내 실사 작업 목록','PDA',None,'PdaTaskList','200, 401','count_task, count_campaign, room','PDA-02',
   ['assignee = 로그인 사용자이고 캠페인 단계가 COUNTING인 작업만.'],
   params=[('status','query','enum(NOT_STARTED,IN_PROGRESS,COMPLETED)','N','상태 필터')])
ep(P,'GET','/pda/campaigns/{campaignId}/worklist','pdaGetWorklist','작업목록 다운로드(전체·델타)','PDA',None,'WorklistPage','200, 304, 401, 403, 410','count_item, asset, room','PDA-01',
   ['내게 배정된 룸의 count_item만 내려준다. 기기 저장 한도 1만 건.',
    'since 없이 호출하면 전체, since=syncToken이면 그 뒤 바뀐 행과 removed만.',
    'syncToken이 7일보다 오래되면 410 ALM-E309 → 전체 다시 받기.',
    '응답은 gzip. If-None-Match(ETag)가 같으면 304.'],
   params=[('campaignId','path','uuid','Y','캠페인'),('since','query','string','N','이전 syncToken'),
           ('cursor','query','string','N','페이지 커서'),('limit','query','int','N','페이지 크기(기본 2,000, 최대 5,000)')])
ep(P,'GET','/pda/campaigns/{campaignId}/tag-index','pdaGetTagIndex','범위 밖 태그 색인','PDA',None,'TagIndexPage','200, 401, 403','asset','PDA-04',
   ['작업목록에 없는 태그를 오프라인에서 OUT_OF_SCOPE·RETIRED_ASSET·UNREGISTERED로 가르기 위한 색인.',
    '같은 테넌트의 다른 자산 태그와 상태만(개인정보 없음). 델타·페이지 규칙은 worklist와 같다.'],
   params=[('campaignId','path','uuid','Y','캠페인'),('since','query','string','N','이전 syncToken'),('cursor','query','string','N','페이지 커서')])
ep(P,'GET','/pda/rooms','pdaListRooms','룸 목록','PDA',None,'PdaRoomList','200, 401','room, site','PDA-03',
   ['캠페인 범위의 사이트에 있는 활성 룸 전체(다른 룸에서 발견한 자산 기록용).'],
   params=[('campaignId','query','uuid','Y','캠페인')])
ep(P,'GET','/pda/codes','pdaGetCodes','코드값','PDA',None,'PdaCodes','200, 401','category, code','PDA-05·06',[ '사용자 locale로 이름을 내려준다.'])
ep(P,'PATCH','/pda/tasks/{taskId}','pdaUpdateTask','룸 작업 시작·완료','PDA','TaskUpdate','PdaTask','200, 400, 401, 403, 409','count_task','PDA-07',
   ['COMPLETE이고 미확인 자산이 남았는데 force가 아니면 409 ALM-E305(남은 수 반환).',
    '완료한 룸에 스캔이 더 들어오면 작업을 IN_PROGRESS로 되돌린다.'],
   params=[('taskId','path','uuid','Y','작업')], idem='Idempotency-Key')
ep(P,'POST','/pda/attachments:presign','pdaPresignPhoto','사진 업로드 URL 발급','PDA','PresignRequest','PresignResponse','200, 400, 401, 413','attachment','PDA-05·06',
   ['발급 시 attachment 행을 owner 없이 만들고(linked_at 비움), 스캔·미등록 전송에서 연결될 때 owner_id·linked_at을 채운다.',
    '24시간 안에 연결되지 않은 첨부 행과 S3 객체는 정리 배치가 지운다.',
    '최대 5 MB, JPEG·PNG. 기기에서 긴 변 1,600px로 줄여 올린다.'], ok='200')
ep(P,'POST','/pda/scans:batch','pdaPostScans','스캔 일괄 전송','PDA','ScanBatch','ScanBatchResult','200, 207, 400, 401, 403','count_scan, count_item, count_task, asset, label_print_job','PDA-04·05·08',
   ['건별로 처리하고 실패해도 다음 건을 계속한다. 하나라도 REJECTED면 207.',
    '같은 clientScanId는 DUPLICATE로 최초 결과를 돌려준다(재전송 안전).',
    '서버가 판정을 다시 한다. 기기 판정과 다르면 serverResult가 기준.',
    '같은 자산을 여러 번 스캔하면 scannedAt이 가장 늦은 스캔이 count_item에 남는다.',
    'MISSING 자산을 스캔하면 status_before_missing으로 복원하고 asset_event를 남긴다.'], idem='clientScanId(건별)')
ep(P,'POST','/pda/unregistered:batch','pdaPostUnregistered','미등록 자산 일괄 전송','PDA','UnregisteredBatch','UnregisteredBatchResult','200, 207, 400, 401','count_unregistered, attachment, number_sequence','PDA-06',
   ['tempNo(UNREG-nnnn)는 서버가 캠페인 안에서 채번한다. 기기는 provisionalNo를 tempNo로 바꿔 표시.',
    '사진이 없으면 REJECTED ALM-E110.'], idem='clientScanId(건별)')

Q = 'sap'
ep(Q,'POST','/oauth/token','sapToken','토큰 발급(Client Credentials)','없음(client_id/secret)',None,'TokenResponse','200, 400, 401','sap_connection','공통',
   ['요청은 application/x-www-form-urlencoded: grant_type=client_credentials, scope=sap.api. 클라이언트 인증은 HTTP Basic(client_secret_basic, 권장 — SAP SM59 로그온 정보에 저장) 또는 본문의 client_id·client_secret(client_secret_post).',
    '내부적으로 Cognito 앱 클라이언트 토큰을 발급한다. 토큰의 client_id로 sap_connection → 테넌트·회사코드를 정한다.'])
ep(Q,'GET','/sap/ping','sapPing','연결 확인','SAP',None,'SapPing','200, 401','sap_connection','SM59 테스트',
   ['SM59 연결 테스트·배치 시작 전 확인용. 부하 없음.'])
ep(Q,'POST','/sap/master-data','sapPostMasterData','조직·코드 마스터 수신','SAP','MasterDataRequest','BatchResult','200, 207, 400, 401, 409','company, plant, cost_center, profit_center, asset_class','IF-MD-01',
   ['유형별로 분할 전송하고 isLast=true에서 이번 배치에 없던 코드를 is_active=false로 바꾼다(삭제 안 함).',
    '순서: COMPANY → PLANT → PROFIT_CENTER → COST_CENTER → ASSET_CLASS → LOCATION(참조 순). chunkNo는 유형마다 1부터, 409 ALM-E303이면 그 유형을 새 batchId로 처음부터 다시 보낸다.'], idem='Idempotency-Key = batchId-type-chunkNo')
ep(Q,'POST','/sap/assets:upsert','sapUpsertAssets','자산 마스터 델타 수신','SAP','AssetUpsertRequest','BatchResult','200, 207, 400, 401','asset, asset_event','IF-AA-01',
   ['매칭: ① companyCode+assetNo+subNo ② inventoryNo(자산태그). 둘 다 없으면 ALM 자산을 새로 만들고 실사 필요로 표시.',
    'SAP 기준 필드(자산클래스, 자산명, 취득일, 비활성일, 코스트센터·손익센터, IVDAT)만 갱신한다. 시리얼·룸·태그는 ALM 기준이라 덮지 않는다.',
    '코스트센터·자산클래스가 ALM에 없으면 ERROR ALM-E104/E105. 다음 IF-MD-01 수신 후 자동 재처리(최대 3일).',
    '값이 같으면 SKIPPED, 바뀌면 asset_event(SAP_SYNCED)에 전후값.'], idem='Idempotency-Key = batchId-일련번호')
ep(Q,'POST','/sap/asset-values','sapPostAssetValues','자산 금액 수신','SAP','AssetValuesRequest','BatchResult','200, 207, 400, 401','asset_value','IF-AA-02',
   ['(자산, 회계연도, 기간, 상각영역) 단위 업서트. 자산이 없으면 ERROR ALM-E201.', 'isClosing=true로 받은 기간은 마감값으로 잠그고, 이후 같은 기간에 isClosing 없이 오는 값은 SKIPPED(매일 실행이 다음 기간 취득을 섞어 덮어쓰지 않게).'], idem='Idempotency-Key = batchId-일련번호')
ep(Q,'POST','/sap/postings:claim','sapClaimPostings','전기 대상 가져오기(15분 잠금)','SAP','ClaimRequest','ClaimResponse','200, 400, 401','sap_posting','IF-AA-03~07, IF-MM-02',
   ['READY 또는 잠금이 지난 CLAIMED 건을 postingId 순으로 FOR UPDATE SKIP LOCKED로 잡고 CLAIMED·leaseUntil=now+15분·attempt+1.',
    '대상이 없으면 items=[] (200).',
    '월말 마감 기간 설정(setting: sap.posting_blackout)이면 빈 목록을 돌려준다.',
    'attempt가 5를 넘으면 FAILED ALM-E306으로 바꾸고 자산회계에게 알린다.'], idem='Idempotency-Key = batchId (같은 batchId 재호출은 같은 목록)')
ep(Q,'POST','/sap/postings/{postingId}/result','sapPostResult','전기 결과 회신','SAP','PostingResult','PostingAck','200, 400, 401, 404, 409','sap_posting, asset_request, purchase_request, count_item, asset, asset_event','IF-AA-03~07, IF-MM-02',
   ['POSTED: 결과값(자산번호·전표·PO번호)을 asset·요청에 반영하고 asset_event(SAP_POSTED).',
    'FAILED: 요청을 POST_ERROR로, 메시지를 저장. 자산회계가 ALM-310에서 고쳐 재처리하면 READY로 돌아간다.',
    '이미 결과가 있는 건에 다른 결과가 오면 409 ALM-E302, 같은 결과면 200(멱등).',
    '잠금이 지난 뒤 온 결과도 받는다(SAP은 BKTXT로 중복 전기를 막음).', '재시도 초과(ALM-E306)로 FAILED가 된 건에 POSTED가 오면 받아들여 POSTED로 바꾼다(SAP 기준). 같은 결과의 재회신은 200.'],
   params=[('postingId','path','string(12)','Y','요청번호')], idem='Idempotency-Key = postingId-attempt')
ep(Q,'POST','/sap/purchase-orders','sapPostPurchaseOrders','자산 PO 항목 수신','SAP','PurchaseOrdersRequest','BatchResult','200, 207, 400, 401','po_item, po_item_asset, purchase_request','IF-MM-01',
   ['(poNo, item) 업서트. deletionFlag=true면 is_deleted=true, 입고 대기 취소.',
    'almRequestNo가 있으면 purchase_request.sap_po_no와 연결.'], idem='Idempotency-Key = batchId-일련번호')
ep(Q,'POST','/sap/goods-receipts','sapPostGoodsReceipts','입고 수신','SAP','GoodsReceiptsRequest','BatchResult','200, 207, 400, 401','goods_receipt, asset, label_print_job','IF-MM-03',
   ['101: 수량만큼 자산을 IN_STOCK으로 만들고 태그 채번, PO 지정 자산번호 연결, 라벨 출력 대기열 추가.', '같은 문서 행(materialDoc, docYear, docItem)이 다시 오면 아무것도 만들지 않고 SKIPPED(SAP 겹침 송신 대비).',
    '102·122: 자산을 지우지 않고 is_gr_cancelled=true, 자산 관리자에게 알림.',
    'PO 항목이 아직 없으면 ERROR ALM-E202(다음 IF-MM-01 후 자동 재처리).'], idem='Idempotency-Key = batchId-일련번호')
ep(Q,'POST','/sap/reconciliation','sapPostReconciliation','대사 스냅샷 수신(분할)','SAP','ReconRequest','ReconResponse','200, 202, 400, 401, 409','recon_run, recon_snapshot, recon_diff','IF-RC-01',
   ['첫 분할에 recon_run을 만들고, isLast=true에서 202와 함께 차이 계산을 비동기로 시작.',
    '차이 규칙은 SAP 인터페이스 명세서 v1.0 5.7(SAP_ONLY, ALM_ONLY, COST_CENTER, LOCATION, SERIAL, TAG, RETIRED). ALM 쪽 비교 대상은 같은 회사코드의 자산 중 RETIRED·DISPOSED는 비활성 12개월 이내만.'], idem='Idempotency-Key = batchId-chunkNo')

ERRORS = [
 ('ALM-E100','400','형식 오류','JSON 형식·타입·길이 위반'),
 ('ALM-E101','400','필수 값 누락','필수 필드 없음'),
 ('ALM-E104','건별','코스트센터 없음','ALM에 없는 코스트센터(IF-MD-01 미수신)'),
 ('ALM-E105','건별','자산클래스 없음','ALM에 없는 자산클래스'),
 ('ALM-E106','400','건수 초과','배치 최대 건수 초과'),
 ('ALM-E110','건별','사진 필수','미등록 자산에 사진 없음'),
 ('ALM-E111','건별','첨부 미완료','attachmentId가 없거나 업로드·검증이 안 됨'),
 ('ALM-E201','건별','자산 없음','키에 맞는 자산 없음'),
 ('ALM-E202','건별','PO 없음','입고의 PO 항목 미수신'),
 ('ALM-E203','건별','범위 밖','캠페인·룸이 사용자 배정 범위 밖'),
 ('ALM-E204','건별','캠페인 단계 아님','COUNTING 단계가 아닌 캠페인에 스캔'),
 ('ALM-E211','422','SAP 기준 필드','SAP이 기준인 필드(자산클래스, 취득가, 코스트센터)를 ALM에서 직접 변경'),
 ('ALM-E301','409','중복 요청','같은 Idempotency-Key, 다른 본문'),
 ('ALM-E302','409','결과 충돌','이미 다른 결과가 회신된 전기 건'),
 ('ALM-E303','409','분할 순서 오류','chunkNo 누락·중복'),
 ('ALM-E305','409','미확인 자산 남음','룸 완료 시 미확인 자산 존재(force 필요)'),
 ('ALM-E306','409','재시도 초과','전기 시도 5회 초과'),
 ('ALM-E309','410','동기화 토큰 만료','since가 7일 초과 → 전체 다시 받기'),
 ('ALM-E310','409','수정 충돌','If-Match version이 현재 값과 다름(다른 사람이 먼저 수정)'),
 ('ALM-E311','409','이미 실행 중','같은 수집 작업이 실행 중'),
 ('ALM-E312','409','CI 중복','자산당 CI 1개'),
 ('ALM-E313','409','순환 관계','CI 관계가 순환'),
 ('ALM-E314','409','갱신 기간 아님','종료 90일 이내 계약만 갱신 요청'),
 ('ALM-E315','409','진행 중 요청','같은 자산에 진행 중인 자산 요청 있음'),
 ('ALM-E316','422','담당 미배정','실사 시작 전 담당이 없는 룸'),
 ('ALM-E317','409','미처리 차이','처리 안 된 실사 차이가 남음'),
 ('ALM-E318','409','사용 중 마스터','자산이 있는 룸·카테고리 등을 비활성화'),
 ('ALM-E401','403','권한 없음','역할·회사코드·사이트 권한 없음'),
 ('ALM-E403','403','직무 분리','요청자 본인이 승인'),
 ('ALM-E402','401','토큰 만료·무효','토큰 다시 발급'),
 ('ALM-E429','429','호출 제한','잠시 뒤 재시도(Retry-After)'),
 ('ALM-E500','500','서버 오류','correlationId로 문의'),
 ('ALM-E501','502','프린터 연결 실패','라벨 프린터 9100 포트 연결 실패'),
]
