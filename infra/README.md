# ALM 인프라 (AWS CDK) — WBS 3.1

`10_AWS_아키텍처_정의서` v1.1을 코드로 옮긴 것이다. TypeScript CDK(aws-cdk-lib 2.273), cdk-nag 3(AwsSolutions), vitest.

## 구성

| 대상 | 스택 | 계정 / 리전 | 파일 |
| --- | --- | --- | --- |
| 환경(`-c env=dev\|qa\|prd`) | `Alm-<Env>-Network` | 환경 계정 / us-east-1 | `lib/network-stack.ts` |
| | `Alm-<Env>-Data` | 〃 | `lib/data-stack.ts` |
| | `Alm-<Env>-Auth` | 〃 | `lib/auth-stack.ts` |
| | `Alm-<Env>-App` | 〃 | `lib/app-stack.ts` |
| | `Alm-<Env>-Edge` | 〃 | `lib/edge-stack.ts` |
| | `Alm-<Env>-Observability` | 〃 | `lib/observability-stack.ts` |
| | `Alm-<Env>-Ci` | 〃 | `lib/global-stacks.ts` (`CiStack`) |
| | `Alm-Prd-Dr` (PRD만) | prd / us-east-2 | `lib/global-stacks.ts` (`DrStack`) |
| 계정 공통(`-c env=global`) | `Alm-OrgBaseline` | 관리 계정 | `lib/global-stacks.ts`, `org/scp/*.json` |
| | `Alm-LogArchiveReplica` → `Alm-LogArchive` | log-archive / us-east-2 → us-east-1 | `lib/log-archive-stack.ts` |
| | `Alm-BackupVault` | backup / us-east-1 | `lib/global-stacks.ts` |
| | `Alm-Shared` | alm-shared / us-east-1 | `lib/global-stacks.ts` |

- 환경별 값은 `lib/config.ts` 한 곳에 있다(`ENVS.dev/qa/prd`). 구성은 같고 값만 다르다.
- 스택 사이 값은 CDK 참조를 **weak**(`Fn::GetStackOutput`)로 넘긴다(`cdk.json`). CloudFormation export를 만들지 않으므로 스택을 따로 배포·삭제할 수 있다. 버킷처럼 이름이 정해진 리소스는 이름으로 가져온다.
- 모든 리소스 태그: `Project=ALM`, `Env`, `Owner=BSG`, `CostCenter`.

## 명령

```bash
npm ci
npm run check          # tsc + vitest(29건) + 4개 대상 synth(cdk-nag 포함)
npx cdk synth -c env=dev
npx cdk diff  -c env=prd
npx cdk deploy -c env=dev --all
npx cdk deploy -c env=prd -c imageTag=<태그> --all
```

`-c nag=off`로 cdk-nag를 끌 수 있다(문제 추적용. CI에서는 켠다).

## cdk-nag 예외

`lib/nag.ts`에 `[스택, 규칙, 사유, 환경]` 목록으로 둔다. IAM4·IAM5처럼 세부 ID가 붙는 규칙은 한 번 검사해 나온 세부 ID 중 목록의 규칙에 해당하는 것만 같은 사유로 인정한다. 새 리소스가 목록에 없는 규칙을 어기면 synth와 시험이 실패한다. 결과는 `cdk.out/validation-report.json`.

## 배포 전에 바꿀 값 (`lib/config.ts`)

| 값 | 현재(자리 값) | 바꿀 값 |
| --- | --- | --- |
| `ORG.accounts.*` | 111…~666… | Control Tower로 만든 계정 ID 6개 |
| `ORG.hostedZoneId` | `Z000…` | `bsgglobal.com` Route 53 호스팅 영역 ID |
| `ORG.workloadsOuId`, `securityOuId` | `ou-xxxx-…` | Control Tower OU ID |
| `ORG.ssoInstanceArn` | `ssoins-000…` | IAM Identity Center 인스턴스 ARN |
| `ENVS.*.sapEgressCidrs` | 203.0.113.10/32(예시) | 고객 SAP 출구 IP(BASIS 회신) |
| `ENVS.*.customerEgressCidrs` | 203.0.113.0/24(예시) | 고객사 사무실 출구 IP |
| `ENVS.*.alarmEmail` | shinji@bsgglobal.com | 운영 메일(필요 시 그룹 주소) |
| `ENVS.*.azs` + `cdk.context.json` | us-east-1a·1b | 계정마다 AZ 이름↔ID 매핑이 다르다. 자격 증명으로 `cdk.context.json`의 `availability-zones:*` 항목을 지우고 다시 synth하면 실제 값으로 채워진다 |

## 처음 배포 순서

계정 만들기부터 첫 DEV 배포까지의 단계별 체크리스트는 산출물 `12_AWS_초기_구축_체크리스트.md`에 있다. 요약:

1. Control Tower 랜딩 존·계정 8개·IAM Identity Center (콘솔, 사람이 한다)
2. `lib/config.ts` 자리 값 교체
3. `cdk bootstrap` (계정·리전별)
4. 계정 공통 스택: `cdk deploy -c env=global …`
5. GitHub 환경·변수 설정 후 `DEPLOY_ENABLED=true` → main 푸시로 DEV 자동 배포

## 배포 파이프라인 (WBS 3.2)

| 파일 | 역할 |
| --- | --- |
| `.github/workflows/ci.yml` | PR 검사: 웹(타입·시험·빌드·audit), 생성물 일치·OpenAPI·Prisma, DB 보안 시험(PostgreSQL 16), 인프라(`npm run check`), Semgrep |
| `.github/workflows/deploy.yml` | main → 검사 → 이미지(ARM64, Trivy) → DEV. 태그 `v*` → QA → 승인 → PRD(평일 동부 07~19시 배포 금지) |
| `scripts/deploy.sh` | 환경 배포: migrate(새 이미지로 RunTask, 실패 시 중단) → `cdk deploy -c imageTag` → SPA 동기화·무효화 |
| `bootstrap-image/` | 백엔드(3.4) 전까지 쓰는 자리 이미지: `/api/v1/health` 200, 그 밖의 API 503, worker 대기, migrate·archive·partman 즉시 종료 |

- 이미지 태그는 커밋 SHA 12자리. ECR 태그가 불변이라 같은 이미지가 DEV → QA → PRD로 승격된다. `bootstrap` 태그는 처음 한 번 자동으로 올린다.
- 배포 스크립트가 읽는 스택 출력: App의 `ClusterName`·`MigrateFamily`·`MigrateSecurityGroupId`·`AppSubnetIds`, Edge의 `DistributionId`·`WebBucketName`.
- migrate를 `cdk deploy`보다 먼저 돌린다(환경 첫 배포만 반대). 그래서 인프라 변경과 앱 갱신은 같은 `cdk deploy`에서 함께 반영된다. DB 변경은 확장 → 전환 → 정리 순서로만 한다.
- 작업 정의 환경 변수: `APP_ROLE`, `DB_HOST/PORT/NAME`, `DB_IAM_USER`, `CACHE_ENDPOINT`, `CACHE_USER`, `JOBS_QUEUE_URL`, `FILES_BUCKET`, `EXPORTS_BUCKET`, `COGNITO_*`, `SES_CONFIG_SET`, `MAIL_FROM`, `COGNITO_ADMIN_FUNCTION`. 비밀: `COOKIE_KEY`, `COGNITO_WEB_CLIENT_SECRET`.
- 아직 없는 것: PR의 `cdk diff` 댓글(읽기 전용 역할 필요), 매일 드리프트 점검, 라이선스 검사(3.7).

## 3.3 이후에 이어서 할 것

- `alm-<env>-cognito-admin` Lambda 본문(지금은 501 반환 자리).
- 앱: RDS IAM 토큰 접속, Valkey IAM 인증 토큰(SigV4) 생성, EMF 지표 `ALM/SapOverdue`·`SapPostingFailed`·`SapAuthFailed`·`Requests(TenantId)`.
- DB 로그인 역할(`alm_app_login`, `alm_owner_iam`, `alm_archive_login`)과 `rds_iam` 부여는 migrate가 `db/ddl` 보안 스크립트로 만든다.
- 배포 때 확인: Firehose가 Object Lock 감사 버킷에 쓰는지(실패하면 `<env>/pgaudit-errors/`에 남는다), CloudFront 표준 로그 v2의 계정 간 S3 전송, VPC 오리진 보안 그룹 이름 조회.
