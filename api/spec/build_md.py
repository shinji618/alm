import json
from spec_api import E
import spec_web  # noqa: registers /sap/run-requests too
P = json.load(open('out/md_parts.json'))
npda = sum(1 for e in E if e['group'] == 'pda'); nsap = sum(1 for e in E if e['group'] == 'sap')

md = f'''---
title: ALM API 명세서 — PDA · SAP
project: 자산관리시스템(ALM)
company: BSG America
wbs: "2.6"
version: 0.3
updated: 2026-10-08
tags: [BSGA, 자산관리시스템, ALM, API]
---

> 목차: [[00_자산관리시스템_산출물_인덱스]] · 관련: [[08_SAP_인터페이스_명세서_v1.0]] (SAP 쪽 확정본) · [[05_데이터모델_테이블정의서]] · OpenAPI: `C:\\dev\\alm\\api\\openapi.yaml`

# ALM API 명세서 — PDA · SAP

2026-10-08 · 신지승 · v0.3 (WBS 2.6 중 PDA·SAP 범위, 2.8 권한·인증 반영)

## 1. 개요

PDA 실사 앱용 API {npda}개와 SAP 배치 잡용 API {nsap}개를 정의한다. 두 API는 같은 서버(NestJS, `/api/v1`)에 있고, 인증 방식과 경로 접두어(`/pda`, `/sap`)로 나뉜다. 엔드포인트·필드는 기능 정의서의 PDA-01~08, SAP 인터페이스 명세서 v1.0의 IF 13개, 데이터 모델(테이블 63개)에 맞췄다. 웹 화면용 API는 [[07_API_명세서_웹]]에 있다. SAP는 On-premise로 확정(2026-10-08)되어 SAP 배치 잡이 ALM을 호출하는 구조를 그대로 쓴다.

| 산출물 | 위치 | 내용 |
| --- | --- | --- |
| 이 문서 | `산출물/06_API_명세서_PDA_SAP.md` | 규격·처리 규칙·필드 정의 |
| OpenAPI 3.1 | `C:\\dev\\alm\\api\\openapi.yaml` | 코드 생성·Swagger UI·계약 테스트용. OpenAPI 검증기와 Redocly lint 통과(경고 0) |
| 생성기 | `C:\\dev\\alm\\api\\spec\\` | 한 정의에서 openapi.yaml과 이 문서의 표를 만든다 |

## 2. 공통 규격

**형식**

| 항목 | 규칙 |
| --- | --- |
| 기본 경로 | `https://alm.<도메인>/api/v1` (TLS 1.2 이상) |
| 본문 | JSON, UTF-8. 필드 이름 camelCase. `/oauth/token`만 form-urlencoded |
| 일시 | ISO 8601 UTC (`2026-10-08T14:05:00Z`). 날짜는 `YYYY-MM-DD` |
| 금액 | JSON number, 소수 2자리, USD. 서버는 numeric(15,2)로 저장 |
| ID | ALM 행 id는 UUID. SAP 키는 SAP 값 그대로(앞자리 0 유지 문자열) |
| 압축 | 응답 1 KB 이상은 gzip. PDA 작업목록은 항상 gzip |
| 버전 | 경로 `/v1`. 필드 추가는 호환 변경으로 보고, 필드 삭제·의미 변경 때만 `/v2` |

**인증**

| 호출자 | 방식 | 토큰 | 테넌트·권한 결정 |
| --- | --- | --- | --- |
| PDA 앱 | Cognito 관리형 로그인 + 고객사 SSO, Authorization Code + PKCE(AppAuth, 비밀 없는 앱 클라이언트) | 액세스 60분, 리프레시 24시간(오프라인 허용 시간, Android Keystore 암호화 보관) | 토큰 `username` → tenant.idp_provider_name → app_user. 유효한 COUNTER 역할 + 활성 기기(pda_device) + 배정된 룸 |
| SAP 배치 | OAuth 2.0 Client Credentials (`POST /oauth/token`, scope `sap.api`). SAP 연결마다 Cognito 앱 클라이언트 1개 | 60분 | client_id → sap_connection → tenant, 회사코드 |

토큰의 앱 클라이언트가 호출한 API 그룹(웹·PDA·SAP)과 맞는지 먼저 확인한다(다르면 403 ALM-E407). 그 뒤 서버는 트랜잭션마다 `SET LOCAL app.tenant_id`(+ user_id·actor_type·correlation_id·client_ip)를 실행하므로, 모든 조회·저장에 행 단위 보안(RLS)이 적용되고 감사 트리거가 처리자를 기록한다. 엔드포인트별 권한 키(`count.scan`, `sap.api`)와 역할 정의는 [[09_권한_보안_설계서]].

**헤더**

| 헤더 | 방향 | 값 |
| --- | --- | --- |
| Authorization | 요청 | `Bearer <토큰>` |
| X-Correlation-Id | 요청·응답 | UUID. 없으면 서버가 만들어 응답에 넣음. 로그·SAP ZALM_IF_LOG를 잇는 키 |
| Idempotency-Key | 요청 | 변경 요청에 필수(엔드포인트 표의 '멱등성' 참고). 24시간 보관 |
| X-SAP-System | 요청(SAP) | 시스템 ID-클라이언트 (예: PRD-100) |
| X-App-Version | 요청(PDA) | 앱 버전. 최소 버전보다 낮으면 `/pda/me`가 업데이트를 안내 |
| X-Device-Id | 요청(PDA) | 기기 시리얼(MDM이 앱 설정으로 넣은 값). 모든 PDA API에 필수. 등록 안 된·비활성 기기면 403 ALM-E406 |
| ETag / If-None-Match | 응답·요청 | PDA 작업목록 캐시. 같으면 304 |
| Retry-After | 응답 | 429·503일 때 재시도까지 초 |

**응답 코드**

| 코드 | 의미 | 호출자 조치 |
| --- | --- | --- |
| 200 | 성공 | - |
| 202 | 접수, 비동기 처리 | 결과는 화면·로그에서 확인 |
| 207 | 배치 일부 성공 | 건별 결과의 ERROR·REJECTED만 다시 처리 |
| 304 | 변경 없음 | 로컬 데이터 유지 |
| 400 | 형식 오류 | 수정 후 재전송(재시도 무의미) |
| 401 | 토큰 없음·만료 | 토큰 재발급 후 1회 재시도 |
| 403 | 권한 없음 | 관리자 확인 |
| 404 | 대상 없음 | - |
| 409 | 충돌(중복·순서·상태) | `code` 확인 |
| 410 | 동기화 토큰 만료 | 전체 다시 받기 |
| 413 | 크기 초과 | 나눠서 전송 |
| 429 | 호출 제한 | Retry-After 뒤 재시도 |
| 5xx | 서버 오류 | SAP: 1·2·4분 간격 3회. PDA: 대기열에서 자동 재시도 |

**오류 본문** (`application/problem+json`)

{P['problem']}

**멱등성**: 같은 `Idempotency-Key`로 같은 본문이 다시 오면 저장된 응답을 그대로 돌려준다. 같은 키에 본문이 다르면 409 ALM-E301. PDA 스캔·미등록은 건마다 `clientScanId`가 멱등성 키여서, 배치를 통째로 다시 보내도 중복 반영되지 않는다.

**호출 제한·크기**

| 대상 | 제한 |
| --- | --- |
| PDA | 사용자당 분당 120회, 요청 본문 2 MB(사진 제외) |
| SAP | 클라이언트당 분당 300회, 요청 본문 10 MB |
| 사진 | 1장 5 MB, JPEG·PNG, S3 직접 업로드 |

## 3. PDA API

### 3.1 동기화 흐름

PDA는 작업목록을 미리 받아 두고 판정을 기기에서 한다. 서버는 받은 스캔을 다시 판정하고, 결과가 다르면 서버 판정이 기준이다.

```mermaid
sequenceDiagram
  participant P as PDA 앱
  participant C as Cognito·SSO
  participant A as ALM API
  participant S as S3
  P->>C: 로그인 (Authorization Code + PKCE)
  C-->>P: 토큰 (액세스 60분, 리프레시 24시간)
  P->>A: GET /pda/me · PUT /pda/devices/{{serial}}
  P->>A: GET /pda/tasks
  P->>A: GET worklist · tag-index · rooms · codes
  Note over P: 오프라인 실사 — 판정·저장은 기기(Room DB)
  P->>A: POST /pda/attachments:presign
  P->>S: PUT 사진 (presigned URL)
  P->>A: POST /pda/unregistered:batch
  P->>A: POST /pda/scans:batch (최대 200건)
  A-->>P: 건별 결과 · 서버 판정 · 룸 진행
  P->>A: PATCH /pda/tasks/{{id}} (COMPLETE)
```

**전송 대기열 규칙 (PDA-08)**

1. 보내는 순서는 사진 → 미등록 자산 → 스캔 → 룸 완료. 사진이 올라가야 그 사진을 쓰는 건을 보낸다.
2. 통신이 돌아오면 자동 전송하고, 실패하면 5초·30초·2분·10분 간격으로 재시도한다.
3. 400·건별 REJECTED는 재시도하지 않고 오류 목록에 남겨 실사 담당자가 확인한다.
4. 401이면 리프레시 토큰으로 갱신하고, 24시간이 지나 갱신도 실패하면 재로그인 전까지 기기 저장만 한다.
5. 작업목록은 앱 시작·캠페인 선택·전송 완료 때 `since`로 델타를 받는다.

**기기 판정 규칙** (기능 정의서 7.3과 같음, 서버도 같은 규칙으로 다시 판정)

| 판정 | 조건 | 기기 피드백 |
| --- | --- | --- |
| FOUND | 작업목록에 있음, 등록 룸 = 현재 룸 | 초록, 단음 1회 |
| MISPLACED | 작업목록에 있음, 등록 룸 ≠ 현재 룸 | 주황, 단음 2회 |
| OUT_OF_SCOPE | 태그 색인에 있음, RETIRED·DISPOSED 아님 | 주황, 기록만 |
| UNREGISTERED | 작업목록·태그 색인 모두 없음 | 파랑, PDA-06으로 이동 |
| DUPLICATE | 이 기기에서 이미 확인한 자산 | 회색, 마지막 스캔으로 갱신 |
| RETIRED_ASSET | RETIRED·DISPOSED 상태 | 빨강, 확인 필요 표시 |

### 3.2 엔드포인트 목록

{P['pda_table'].replace('| 3.', '| 3.')}

{P['pda_body']}

## 4. SAP API

### 4.1 호출 순서

모든 호출은 SAP 배치 잡(SM36)이 시작한다. 시각은 미국 중부(CT) 기준 초안이다.

| 시각·주기 | 잡 | 호출 |
| --- | --- | --- |
| 매일 05:30 | 마스터 송신 | `/oauth/token` → `/sap/master-data` (PROFIT_CENTER → COST_CENTER → 나머지) |
| 매일 06:00 | 자산 송신 | `/sap/assets:upsert` → `/sap/asset-values` |
| 매일 06:15 | 구매오더 송신 | `/sap/purchase-orders` |
| 15분마다 | 전기 처리 | `/sap/postings:claim` → BAPI → `/sap/postings/{{id}}/result` (건마다) |
| 15분마다 | 입고 송신 | `/sap/goods-receipts` |
| 15분마다(전기 잡 시작 시) | 수동 실행 요청 확인 | `/sap/run-requests` → 요청된 수신 잡 즉시 실행 |
| 주 1회(월 07:00), 실사 종료 시 | 대사 추출 | `/sap/reconciliation` (분할, 마지막 isLast=true) |

**SAP 잡의 재시도**: 통신·5xx는 1·2·4분 간격 3회, 그래도 실패하면 다음 주기에 다시 실행하고 운영 메일을 보낸다. 207의 ERROR 건은 SAP에서 다시 보내지 않는다(ALM이 자동 재처리하거나 화면에서 처리).

### 4.2 엔드포인트 목록

{P['sap_table'].replace('| 4.', '| 4.')}

{P['sap_body']}

### 4.14 유형별 레코드

{P['sap_extra']}

## 5. 오류 코드

`HTTP·위치`가 '건별'인 코드는 HTTP 상태가 아니라 207 응답의 건별 결과(`results[].code`)로 돌아온다.

{P['errors']}

## 6. 미결 사항

- [x] SAP 배포 형태 — On-premise 확정(2026-10-08). SAP이 ALM을 호출하는 현재 구조 유지
- [ ] 금액 JSON 타입 — number(현재)와 문자열 중 SAP ABAP JSON 직렬화(/ui2/cl_json) 방식에 맞춰 확정
- [ ] 태그 색인 크기 — 자산 5만 건이면 약 2 MB(gzip 전). 사이트 단위로 줄일지 파일럿에서 확인
- [x] 웹 화면 API — [[07_API_명세서_웹]]에 정의
- [ ] 매각 고객번호(`customer`) 사용 여부 — SAP 인터페이스 명세서 미결 사항과 함께 결정
'''
open('out/06_API_명세서_PDA_SAP.md', 'w').write(md)
print(len(md), md.count('\n'))
