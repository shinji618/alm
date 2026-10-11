# apps/api — ALM 백엔드 (WBS 3.4)

NestJS 11 · Node 24 · PostgreSQL 16(RDS, IAM 인증). 이미지 1개를 역할별로 실행한다.

| 역할 | 명령 | 하는 일 |
| --- | --- | --- |
| api | `node dist/main api` | REST `/api/v1` (BFF 로그인, `/me`, 관리 `/admin/*`, 상태 확인) |
| worker | `node dist/main worker` | 작업 큐(SQS) 소비. 처리기가 없는 예약 작업은 기록 후 삭제 |
| migrate | `sh scripts/migrate.sh` | 부트스트랩(DB 역할·IAM 로그인·pgaudit) + `migrations/*.sql` 적용 |
| seed | `node dist/main seed '<JSON>'` | 테넌트·도메인·사용자 등록(`infra/scripts/db-seed.sh`) |
| audit-archive · partman | `node dist/main <역할>` | 3.4 2차(지금은 정상 종료만) |

## 설계 문서와 다른 점

- **마이그레이션은 Prisma migrate가 아니라 번호 붙은 SQL 파일**(`migrations/0001_init.sql` = `db/ddl.sql` 사본). ARM 이미지에 Prisma CLI·엔진을 넣지 않기 위해서다. 적용한 파일은 고치지 않고 새 번호로 추가한다(체크섬 검사).
- **migrate는 RDS 마스터(alm_owner)로 접속**한다. 로그인 계정 생성·이벤트 트리거에 rds_superuser가 필요하다. 마스터 비밀은 migrate 작업 정의에만 있다.
- PG16에서는 마스터가 자기 자신의 멤버십을 줄 수 없어 `alm_owner_iam`은 소유자 권한이 없다(partman용, 2차에서 정리).

## 관리 API(3.4 2차-1)

`/admin/users`(목록·등록·수정), `/admin/users/{id}/roles`(역할 전체 교체), `/admin/sod-conflicts`, `/admin/codes`, `/admin/settings`.
규칙: H-03 자기 역할·자기 비활성 금지(403 E403), H-04 마지막 관리자(409 E319), H-05 감사인 단독·유효 종료일 1년 이내, H-10 미연결 사용자 이메일 변경 시 역할 삭제, 직무 충돌(SOD-01~04)은 저장하고 `X-SoD-Warning` 헤더로 알림. 설정은 아는 키만 받는다(`src/admin/config.ts` SETTINGS).

## 로그인 흐름(09 6.4)

`/auth/login?email=` → 이메일 도메인으로 테넌트 IdP → Cognito(PKCE, 쿠키 `alm_pkce`) → 고객 IdP → `/auth/callback` → 사용자 판정 → 리프레시 토큰을 AES-GCM 쿠키 `alm_rt`(8시간, Strict)에 저장 → SPA가 `POST /auth/refresh`(헤더 `X-ALM-CSRF: 1`)로 액세스 토큰(15분)을 받아 Bearer로 호출.

DEV·QA 확인용: 로그인 뒤 `/api/v1/auth/session`을 열면 사용자·역할·권한이 보인다(운영은 404).

## 시험

```bash
npm ci
npm test                                     # 단위 시험
TEST_PG_HOST=localhost PGPASSWORD=… npm test  # + DB·HTTP 통합 시험(빈 PostgreSQL 16, 슈퍼유저)
```

`test/a-rds.test.ts`는 RDS 마스터와 같은 조건(슈퍼유저 아님, CREATEROLE)에서 부트스트랩·0001을 적용해 본다. 새 클러스터에서만 돈다.
