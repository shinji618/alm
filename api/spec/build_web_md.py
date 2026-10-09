import gen_api, perm
from spec_api import E, ERRORS

AREAS = [('공통', '앱 셸·전역 검색·첨부·내보내기'), ('대시보드', 'ALM-010'), ('자산', 'ALM-110~112'), ('Discovery', 'ALM-120'),
         ('CMDB', 'ALM-130'), ('라이선스', 'ALM-140'), ('계약', 'ALM-220'), ('구매', 'ALM-210'), ('요청·승인', 'ALM-230'),
         ('실사', 'ALM-240'), ('라벨', 'ALM-250'), ('SAP 연계', 'ALM-310'), ('관리', '사용자·마스터·코드·설정·감사'), ('인증', '로그인·토큰 갱신·로그아웃')]
web = [e for e in E if e['group'] == 'web']
assert sum(1 for e in web if e.get('area') not in dict(AREAS)) == 0
gen_api.SHOWN.clear()
gen_api.SHOWN.update({'Problem', 'FieldError'})

overview = ['| 장 | 영역 | 화면 | 엔드포인트 | 주요 경로 |', '| --- | --- | --- | --- | --- |']
body = []
for i, (area, screens) in enumerate(AREAS):
    sec = i + 4
    eps = [e for e in web if e['area'] == area]
    prefixes = sorted({'/' + e['path'].split('/')[1] for e in eps})
    overview.append(f'| {sec} | {area} | {screens} | {len(eps)} | {", ".join("`"+p+"`" for p in prefixes)} |')
    tbl = ['| # | 메서드 | 경로 | 용도 | 권한 |', '| --- | --- | --- | --- | --- |']
    tbl += [f"| {sec}.{j+1} | {e['method']} | `{e['path']}` | {e['summary']} | {e['auth']} |" for j, e in enumerate(eps)]
    parts = [f'## {sec}. {area} ({screens})', '', '\n'.join(tbl), '']
    parts += [gen_api.md_endpoint(e, f'{sec}.{j+1}') for j, e in enumerate(eps)]
    body.append('\n\n'.join(parts))

errors = ['| 코드 | HTTP·위치 | 이름 | 발생 조건 |', '| --- | --- | --- | --- |'] + [f'| {a} | {b} | {c} | {d} |' for a, b, c, d in ERRORS]
last = 4 + len(AREAS)

ROLE_SHORT = {'SYS_ADMIN': '시스템 관리자', 'ASSET_MANAGER': '자산 관리자', 'DEPT_MANAGER': '부서 관리자', 'ASSET_ACCOUNTANT': '자산회계',
              'COUNTER': '실사 담당', 'EMPLOYEE': '일반 사용자', 'AUDITOR': '감사인'}
SCOPE_TXT = {'ALL': '●', 'CC': 'CC', 'OWN': '본인', 'TASK': '배정', '-': '●'}
matrix = ['| 권한 키 | 내용 | ' + ' | '.join(ROLE_SHORT[r] for r, _, _ in perm.ROLES) + ' |',
          '| --- | --- | ' + ' | '.join('---' for _ in perm.ROLES) + ' |']
for k, (a, d) in perm.PERMS.items():
    if k in ('auth', 'sap.api'): continue
    matrix.append(f'| `{k}` | {d} | ' + ' | '.join(SCOPE_TXT.get(perm.scope_of(r, k), '') or '' for r, _, _ in perm.ROLES) + ' |')
matrix = '\n'.join(matrix)

md = f'''---
title: ALM API 명세서 — 웹 화면
project: 자산관리시스템(ALM)
company: BSG America
wbs: "2.6"
version: 0.4
updated: 2026-10-08
tags: [BSGA, 자산관리시스템, ALM, API]
---

> 목차: [[00_자산관리시스템_산출물_인덱스]] · 공통 규격·PDA·SAP: [[06_API_명세서_PDA_SAP]] · 데이터: [[05_데이터모델_테이블정의서]] · 화면: [[01_기능정의서]] · OpenAPI: `C:\\dev\\alm\\api\\openapi.yaml`

# ALM API 명세서 — 웹 화면

2026-10-08 · 신지승 · v0.4 (WBS 2.6 웹 범위 + 2.8 권한 키·인증 API + 2026-10-09 라벨 출력 Browser Print 방식(A-08). PDA·SAP는 06 문서, 권한·보안 설계는 [[09_권한_보안_설계서]])

## 1. 개요

웹 화면(React SPA)이 쓰는 API {len(web)}개를 {len(AREAS)}개 영역으로 정의한다. 화면 13개(ALM-010~310)의 기능 ID와 관리 기능을 모두 덮고, 데이터는 테이블 정의서의 63개 테이블에 맞췄다. 형식·인증 헤더·응답 코드·오류 본문·멱등성은 [[06_API_명세서_PDA_SAP]] 2장을 그대로 따르며, 이 문서는 웹에만 해당하는 규칙을 더한다. PDA {sum(1 for e in E if e['group']=='pda')}개, SAP {sum(1 for e in E if e['group']=='sap')}개와 합쳐 전체 {len(E)}개가 `openapi.yaml` 하나에 들어 있고, OpenAPI 3.1 검증기와 Redocly lint를 통과했다(리디렉트 전용 /auth/login·/auth/callback의 2xx 응답 없음 경고 2건은 의도된 것으로 제외 처리).

{chr(10).join(overview)}

**확정 사항 반영 (2026-10-08)**: 멀티테넌트 — 모든 요청은 토큰의 테넌트로 RLS가 걸린다. SAP On-premise — SAP이 ALM을 호출하는 현재 구조 유지. 데이터 보존 10년 — 감사 로그·IF 로그 조회 API는 10년 범위를 다룬다.

## 2. 웹 공통 규칙

**인증·세션**

| 항목 | 규칙 |
| --- | --- |
| 로그인 | 로그인 화면에서 이메일 입력 → `GET /auth/login`이 도메인으로 테넌트 IdP를 골라 Cognito로 보냄 → 고객사 SSO(SAML/OIDC) → `GET /auth/callback`. Authorization Code + PKCE |
| 토큰 | 액세스 15분(SPA 메모리에만), 리프레시 8시간(서버가 암호화해 HttpOnly 쿠키 `alm_rt`에 보관, `POST /auth/refresh`로 갱신). 브라우저 저장소에 토큰을 두지 않는다 |
| 테넌트 | 토큰의 `username`(`<IdP 이름>_<IdP 사용자 ID>`) → tenant.idp_provider_name → app_user.idp_subject. 요청 본문·경로로 테넌트를 받지 않는다 |
| 비활성화 | 사용자 비활성·역할 만료는 다음 요청부터 401·403(서버가 사용자 상태를 60초 캐시) |
| CORS | 웹 도메인 1개만 허용. `/auth/*`는 같은 사이트에서만(SameSite) |

**권한·마스킹**

- 권한은 `GET /me`의 `permissions`(예: `asset.write`, `amount.read`, `approval.decide`)로 내려주고, 서버는 API마다 같은 권한과 범위(회사코드·사이트·코스트센터·본인)를 다시 확인한다. 엔드포인트별 권한 키는 아래 표의 '권한' 열과 OpenAPI의 `x-permission`·`x-scope`가 기준이다.
- 범위 밖 단건 조회는 403이 아니라 404로 돌려준다(존재 여부를 알리지 않음).
- 금액(취득가·누계액·NBV·단가·계약 금액)은 `amount.read`가 없으면 `null`로 내려준다. 403이 아니라 null이라 화면 구성은 같다.
- 승인은 요청자 본인이 할 수 없다(직무 분리, ALM-E403).

**목록**

| 항목 | 규칙 |
| --- | --- |
| 페이지 | `page`(1부터), `pageSize`(기본 50, 최대 500). 응답 `{{items, page, pageSize, total}}` |
| 정렬 | `sort=-updatedAt,assetTag` (내림차순은 -) |
| 필터 | 각 엔드포인트의 query 파라미터. 여러 값은 쉼표 구분 (`status=IN_USE,IN_STOCK`) |
| 검색 | `q`는 부분 일치(pg_trgm). 2자 이상 |
| 내보내기 | 같은 필터로 `POST /exports` → 비동기 xlsx/csv |

**변경**

| 항목 | 규칙 |
| --- | --- |
| 생성 | 201 + `Location` 헤더. 중복 제출 방지에 `Idempotency-Key` |
| 수정 | PATCH, 보낸 필드만 변경. 상세 응답의 `version`을 `If-Match`로 보내고 다르면 409 ALM-E310 |
| 동작 | 상태를 바꾸는 일은 `POST /리소스/{{id}}:동작` (예: `:check-out`, `:submit`, `:approve`) |
| 여러 건 | `POST /리소스:resolve` 등은 건별 처리, 일부 실패면 207 + `BulkResult` |
| 삭제 | 업무 데이터는 삭제 API 없음(상태·isActive). 연결·설정 행(CI 관계, 계약 대상 자산)만 DELETE + 감사 로그 |
| SAP 기준 필드 | 자산클래스·취득가·코스트센터는 직접 수정 불가(ALM-E211). 할당·자산 요청을 거쳐 SAP 전기 후 바뀐다 |
| 자동 요청 | 자본화 자산의 ALM 기준 필드(시리얼·룸·자산명) 변경은 바로 반영하고 SAP용 요청을 자동 생성해 응답의 `createdRequests`로 알려준다 |

**화면 흐름 예 — 자산 이관**

```mermaid
sequenceDiagram
  participant U as 자산 관리자
  participant W as 웹 (ALM-111)
  participant A as ALM API
  participant M as 부서 관리자·자산회계
  participant S as SAP 잡
  U->>W: 할당 변경(새 코스트센터)
  W->>A: POST /assets/{{id}}:check-out
  A-->>W: 200 + createdRequests[AR-…] (TRANSFER 또는 CHANGE)
  M->>A: POST /approvals/{{id}}:approve (2단계)
  A->>A: sap_posting READY
  S->>A: POST /sap/postings:claim → BAPI → result
  A-->>W: 요청 POSTED, 자산 코스트센터 갱신
```

**성능 목표**: 목록 2초(자산 5만 건), 상세 500ms, 대시보드 1초(5분 캐시), 내보내기 5만 행 30초.

## 3. 권한 매트릭스

권한 키 × 역할. ● = 테넌트 전체(user_role에 회사코드·사이트가 있으면 그 범위), CC = 담당 코스트센터, 본인 = 내 자산·내 요청, 배정 = 배정된 실사 룸. 기준은 `api/spec/perm.py`이고, 설계 근거와 직무 분리 규칙은 [[09_권한_보안_설계서]]에 있다. 일반 사용자 권한은 모든 활성 사용자에게 자동으로 붙는다.

{matrix}

{chr(10).join(chr(10) + b for b in body)}

## {last}. 오류 코드

PDA·SAP와 같은 목록이다. `HTTP·위치`가 '건별'이면 207 응답의 `results[].code`로 온다.

{chr(10).join(errors)}

## {last+1}. 미결 사항

- [ ] Discovery 에이전트 수신 API(에이전트 → ALM)는 8.1 도구 선정 뒤 정의
- [ ] ITSM 티켓 원본 조회(8.4) — 현재는 연결된 참조만 조회
- [x] 라벨 출력 방식: 서버 직접 출력 대신 PC의 Zebra Browser Print로 출력(A-08, 2026-10-09). API는 `:render`(ZPL 받기)·`:report`(결과 회신)
- [x] 금액 마스킹 대상 역할: 시스템 관리자·자산 관리자·자산회계·감사인 + 승인자는 승인 대상만(09 설계서 결정 S-03 확정)
'''
open('out/07_API_명세서_웹.md', 'w').write(md)
print(len(web), 'web endpoints', md.count('\n'), 'lines')

# ---- api/README.md (수량은 원본에서 계산 — 손으로 고치지 않는다) ----
import collections
cnt = collections.Counter(e['group'] for e in E)
by_area = collections.Counter(e.get('area') for e in E if e['group'] == 'web')
area_rows = '\n'.join(f'| {a} | {by_area[a]} |' for a, _ in AREAS)
readme = f'''# api — ALM API 명세 (WBS 2.6, 권한 2.8)

> 이 파일은 `spec/build_web_md.py`가 만든다. 수량을 손으로 고치지 말고 생성기를 다시 돌린다.

엔드포인트 = HTTP 메서드 + 경로 1개(OpenAPI operation 1개). 전체 **{len(E)}개**: 웹 {cnt['web']} · PDA {cnt['pda']} · SAP {cnt['sap']}.

| 파일 | 내용 |
| --- | --- |
| `openapi.yaml` | OpenAPI 3.1, 엔드포인트 {len(E)}개, 각 작업에 `x-permission`·`x-scope` (생성물) |
| `permissions.json` | 역할·권한 키·범위·작업별 권한 (생성물, 백엔드·프론트 가드용) |
| `spec/spec_api.py` | PDA·SAP 스키마·엔드포인트 정의 (원본) |
| `spec/spec_web.py` | 웹 화면 스키마·엔드포인트 정의 (원본) |
| `spec/perm.py` | 권한 카탈로그 (원본) |
| `spec/gen_api.py` | openapi.yaml·permissions.json·문서 표 생성 |
| `spec/build_md.py` | 산출물 `06_API_명세서_PDA_SAP.md` 조립 |
| `spec/build_web_md.py` | 산출물 `07_API_명세서_웹.md`와 이 README 조립 |

**웹 영역별 엔드포인트**

| 영역 | 개수 |
| --- | --- |
{area_rows}

## 다시 만들기

```bash
cd api/spec
mkdir -p out && python gen_api.py && python build_md.py && python build_web_md.py
cp out/openapi.yaml out/permissions.json out/README.md ../
cp out/.redocly.lint-ignore.yaml ../   # 처음 한 번
```

## 검증

- `npx @redocly/cli@1 lint api/openapi.yaml` — 통과. 리디렉트 전용 `/auth/login`·`/auth/callback`은 2xx 응답이 없어 `operation-2xx-response` 경고 2건을 `.redocly.lint-ignore.yaml`로 제외한다.
- `openapi-spec-validator`로 3.1 스키마 검증.
- CI(3.2)는 원본에서 다시 생성한 결과가 커밋된 파일과 같은지 확인한다.
'''
open('out/README.md', 'w').write(readme)
print('README:', len(E), dict(cnt))
