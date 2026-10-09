# api — ALM API 명세 (WBS 2.6, 권한 2.8)

> 이 파일은 `spec/build_web_md.py`가 만든다. 수량을 손으로 고치지 말고 생성기를 다시 돌린다.

엔드포인트 = HTTP 메서드 + 경로 1개(OpenAPI operation 1개). 전체 **160개**: 웹 138 · PDA 11 · SAP 11.

| 파일 | 내용 |
| --- | --- |
| `openapi.yaml` | OpenAPI 3.1, 엔드포인트 160개, 각 작업에 `x-permission`·`x-scope` (생성물) |
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
| 공통 | 10 |
| 대시보드 | 1 |
| 자산 | 14 |
| Discovery | 7 |
| CMDB | 7 |
| 라이선스 | 12 |
| 계약 | 8 |
| 구매 | 8 |
| 요청·승인 | 10 |
| 실사 | 15 |
| 라벨 | 12 |
| SAP 연계 | 16 |
| 관리 | 14 |
| 인증 | 4 |

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
