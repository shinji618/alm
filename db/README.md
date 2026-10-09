# db — ALM 데이터 모델 (WBS 2.5)

| 파일 | 내용 |
| --- | --- |
| `spec/spec.py` | 테이블·컬럼·enum 정의. **설계 단계의 원본** |
| `spec/gen.py`, `spec/views.sql` | 생성기, 뷰 SQL |
| `schema.prisma` | Prisma 7 스키마 (생성물) |
| `ddl.sql` | PostgreSQL 16 DDL: enum · 테이블 · FK · RLS · 뷰 (생성물) |

테이블 정의서: https://claude.ai/code/artifact/ed0afc90-94f0-44ea-a979-a70734e66b9e

## 바꾸는 방법

1. `spec/spec.py` 수정
2. `cd db/spec && python gen.py` → `schema.prisma`, `ddl.sql` 재생성
3. 테이블 정의서의 해당 표 갱신 (`spec/out/doc_tables.json`)

백엔드(apps/api) 착수 시 `schema.prisma`를 apps/api/prisma 로 옮기고 그때부터 그 파일을 원본으로 한다.
Prisma가 만들지 못하는 RLS·뷰·CHECK·파티션은 `prisma migrate dev --create-only` 로 만든 마이그레이션 SQL에 `ddl.sql`의 해당 부분을 붙인다.

## 보안 시험

`spec/run_security_test.sh`: 빈 DB에 `ddl.sql`을 적용하고 `spec/test_security.sql` 결과를 `spec/test_security.expected`와 비교한다. CI(PostgreSQL 16)에서 PR마다 돈다.

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=… db/spec/run_security_test.sh      # 비교
UPDATE_EXPECTED=1 PGHOST=… db/spec/run_security_test.sh                         # 의도한 변경이면 기대 결과 갱신
```
