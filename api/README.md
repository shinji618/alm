# api — ALM API 명세 (WBS 2.6)

| 파일 | 내용 |
| --- | --- |
| `openapi.yaml` | OpenAPI 3.1 — 웹 130 · PDA 11 · SAP 11 엔드포인트 (생성물) |
| `spec/spec_api.py` | PDA·SAP 스키마·엔드포인트 정의 (원본) |
| `spec/spec_web.py` | 웹 화면 스키마·엔드포인트 정의 (원본) |
| `spec/gen_api.py` | openapi.yaml과 문서 표 생성 |
| `spec/build_md.py` | 산출물 `06_API_명세서_PDA_SAP.md` 조립 |
| `spec/build_web_md.py` | 산출물 `07_API_명세서_웹.md` 조립 |

## 다시 만들기

```bash
cd api/spec
mkdir -p out && python gen_api.py && python build_md.py && python build_web_md.py
cp out/openapi.yaml ../openapi.yaml
```

검증: `npx @redocly/cli lint api/openapi.yaml` (경고 0), `pip install openapi-spec-validator`로 3.1 검증.
보기: `npx @redocly/cli preview-docs api/openapi.yaml` 또는 Swagger Editor에 붙여넣기.

