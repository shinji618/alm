# apps/api — ALM 백엔드 (WBS 3.4)

NestJS 11 · Node 24 · PostgreSQL 16(RDS, IAM 인증). 이미지 1개를 역할별로 실행한다.

| 역할 | 명령 | 하는 일 |
| --- | --- | --- |
| api | `node dist/main api` | REST `/api/v1` (BFF 로그인, `/me`, 관리 `/admin/*`, 상태 확인) |
| worker | `node dist/main worker` | 작업 큐(SQS) 소비. 처리기가 없는 예약 작업은 기록 후 삭제 |
| migrate | `sh scripts/migrate.sh` | 부트스트랩(DB 역할·IAM 로그인·pgaudit) + `migrations/*.sql` 적용 |
| seed | `node dist/main seed '<JSON>'` | 테넌트·도메인·사용자 등록(`infra/scripts/db-seed.sh`) |
| partman | `node dist/main partman` | 감사 파티션 관리: `log_partition_maintain(3)` — 이번 달 ~ 3개월 뒤 월 파티션, 기본 파티션에 쌓인 행 이동 |
| audit-archive | `node dist/main audit-archive [--dry-run]` | 13개월이 지난 감사 파티션 → S3 감사 버킷(NDJSON.gz) → 내려받아 체크섬·행 수 확인 → `log_partition_drop` |

## 설계 문서와 다른 점

- **마이그레이션은 Prisma migrate가 아니라 번호 붙은 SQL 파일**(`migrations/0001_init.sql` = `db/ddl.sql` 사본). ARM 이미지에 Prisma CLI·엔진을 넣지 않기 위해서다. 적용한 파일은 고치지 않고 새 번호로 추가한다(체크섬 검사).
- **migrate는 RDS 마스터(alm_owner)로 접속**한다. 로그인 계정 생성·이벤트 트리거에 rds_superuser가 필요하다. 마스터 비밀은 migrate 작업 정의에만 있다.
- `alm_owner_iam`(소유자 IAM 로그인)은 없앴다(2차-3). PG16에서는 마스터가 자기 멤버십을 줄 수 없어 소유자 권한을 가질 수 없었다. 파티션 관리는 보관 계정이 함수로 한다. migrate가 남은 역할을 지운다.
- **pg_partman 대신 SQL 함수 두 개**(`log_partition_maintain`·`log_partition_drop`, `alm_audit_owner` 소유 SECURITY DEFINER). pg_partman의 run_maintenance는 부모 표 소유자 권한이 있어야 해 업무 표(소유자)와 감사 표(감사 소유)를 한 계정으로 돌릴 수 없고, 로컬·CI에서 시험하기 어렵다.
- **보관 형식은 Parquet 대신 NDJSON + gzip**(한 줄 = `row_to_json` 한 행). 의존성 없이 같은 내용이면 같은 바이트가 나와 체크섬으로 다시 올리기·확인을 판단한다. Athena JSON SerDe로 조회한다.

## 관리 API(3.4 2차-1)

`/admin/users`(목록·등록·수정), `/admin/users/{id}/roles`(역할 전체 교체), `/admin/sod-conflicts`, `/admin/codes`, `/admin/settings`.
규칙: H-03 자기 역할·자기 비활성 금지(403 E403), H-04 마지막 관리자(409 E319), H-05 감사인 단독·유효 종료일 1년 이내, H-10 미연결 사용자 이메일 변경 시 역할 삭제, 직무 충돌(SOD-01~04)은 저장하고 `X-SoD-Warning` 헤더로 알림. 설정은 아는 키만 받는다(`src/admin/config.ts` SETTINGS).

## PDA·SAP 채널(3.4 2차-2)

| 채널 | 경로 | 인증 |
| --- | --- | --- |
| 웹 | 그 밖의 `/api/v1/*` | `alm-web` 토큰만(다른 클라이언트는 403 E407) |
| PDA | `/api/v1/pda/*` | `alm-pda` 토큰 + `X-Device-Id` 필수. 미등록·비활성 기기 403 E406 + DEVICE_BLOCKED. 웹 로그인 전 첫 PDA 로그인은 Cognito userInfo 이메일로 미리 등록된 사용자에 연결 |
| SAP | `POST /api/v1/oauth/token` | client_credentials(Basic 또는 본문). `auth_sap_client`로 연결 확인 → 허용 IP → Cognito에 그대로 요청(비밀 저장 안 함). 실패 SAP_AUTH_FAILED, 클라이언트당 분당 10회 |
| SAP | `/api/v1/sap/*` | 범위 `alm-api/sap.api` + 등록된 연결의 client_id. 허용 IP·`X-SAP-System`·`X-Company-Code` 확인 |

호출 제한 카운터는 작업(프로세스)마다 따로 센다. 여러 작업이 공유하는 카운터(Valkey)는 2차-4.

## 감사 기록 보관(3.4 2차-3, 09 8.3)

| 항목 | 내용 |
| --- | --- |
| 대상 | `audit_log`·`security_event` — `occurred_at` 월 범위 파티션(`<표>_pYYYYMM`, UTC), 기본키 `(id, occurred_at)`, 범위 밖 행은 `<표>_default` |
| 소유 | 둘 다 `alm_audit_owner`(파티션 포함). 파이프라인(마스터)은 평소 감사 기록을 지우거나 파티션을 떼지 못한다. `DROP TABLE security_event`도 이벤트 트리거가 막는다 |
| 권한 | 앱은 부모 표로만(감사 조회, 보안 이벤트 조회·추가). 파티션에는 권한 없음(직접 읽으면 RLS가 걸리지 않으므로) |
| 관리 | `partman` 매일(DEV·QA는 평일 07:30, 정지 시간 피함) + migrate가 배포마다 확인 |
| 보관 | `audit-archive` 매월 1일 03:00(DEV·QA는 첫 월요일 08:00). 이번 달 포함 14개월보다 오래된 파티션만. S3 키 `<env>/audit/<표>/year=YYYY/month=MM/<파티션>.ndjson.gz` + `.manifest.json`(행 수·SHA-256·기간). 버킷 기본 보존 Object Lock 준수 모드 10년 |
| 안전장치 | 같은 체크섬이면 다시 올리지 않음 → 내려받아 SHA-256·행 수 비교 → `log_partition_drop`이 잠금 후 건수를 다시 세어 다르면 거부, 14개월 안 파티션은 거부 |
| 전환 | `migrations/0002_audit_partitions.sql`: 기존 표를 옆으로 옮기고 같은 정의의 파티션 표를 만든 뒤 행을 옮긴다. 결과 스키마는 `db/ddl.sql`(새 DB)과 같다(pg_dump 비교) |

## 로그인 흐름(09 6.4)

`/auth/login?email=` → 이메일 도메인으로 테넌트 IdP → Cognito(PKCE, 쿠키 `alm_pkce`) → 고객 IdP → `/auth/callback` → 사용자 판정 → 리프레시 토큰을 AES-GCM 쿠키 `alm_rt`(8시간, Strict)에 저장 → SPA가 `POST /auth/refresh`(헤더 `X-ALM-CSRF: 1`)로 액세스 토큰(15분)을 받아 Bearer로 호출.

DEV·QA 확인용: 로그인 뒤 `/api/v1/auth/session`을 열면 사용자·역할·권한이 보인다(운영은 404).

## 시험

```bash
npm ci
npm test                                     # 단위 시험
TEST_PG_HOST=localhost PGPASSWORD=… npm test  # + DB·HTTP 통합 시험(빈 PostgreSQL 16, 슈퍼유저)
```

`test/a-rds.test.ts`는 RDS 마스터와 같은 조건(슈퍼유저 아님, CREATEROLE)에서 부트스트랩·0001 → 행 넣기 → 0002를 적용해 본다(기존 행 보존·소유권·alm_owner_iam 정리). 새 클러스터에서만 돈다. `test/archive.test.ts`는 보관 계정으로 파티션 관리·S3 보관(메모리 S3)·삭제 거부 조건을 본다.
