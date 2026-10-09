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
npm run check          # tsc + vitest(27건) + 4개 대상 synth(cdk-nag 포함)
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

1. **Control Tower**: 랜딩 존(us-east-1·us-east-2만 허용), 계정 8개, 조직 CloudTrail 보관 10년으로 변경.
2. **부트스트랩**: 각 계정·리전에서 `cdk bootstrap aws://<계정>/us-east-1` (prd·log-archive는 us-east-2도).
3. **계정 공통** (관리자 자격 증명, 계정별로): `cdk deploy -c env=global Alm-OrgBaseline`, `Alm-LogArchiveReplica Alm-LogArchive`, `Alm-BackupVault`, `Alm-Shared`.
   - 관리 계정에서 AWS Backup **계정 간 백업**을 켠다(조직 설정). GuardDuty·Security Hub 위임 관리자는 audit 계정으로 지정(콘솔/CLI).
   - BackupVault의 Vault Lock은 3일 뒤 준수 모드로 굳는다. 그 전에 값을 확인한다.
4. **이미지**: `alm-shared` ECR에 `alm:bootstrap` 태그 이미지를 올린다(3.2 CI가 만든다). 이미지가 없으면 App 스택의 ECS 서비스가 안정화되지 않아 배포가 실패한다.
5. **환경**: `cdk deploy -c env=dev --all` → QA → PRD(PRD는 `Alm-Prd-Dr`이 먼저 배포된다).
   - Cognito 사용자 지정 도메인(`auth-*`)은 상위 도메인(`bsgglobal.com`)에 A 레코드가 있어야 만들어진다.
   - SNS 메일 구독 확인 메일 2통(심각·일반)을 승인한다. 당번 휴대폰은 `alm-<env>-alarms-high`에 SMS로 추가 구독.
   - PRD는 SES 샌드박스 해제 요청.
6. **GitHub**: 저장소 환경 `dev`·`qa`·`prd`를 만들고 `prd`에 승인자(신지승)를 건다. 배포 역할은 `arn:aws:iam::<계정>:role/alm-deploy-<env>`, 빌드 역할은 `alm-ci-build`(shared).

## 배포 파이프라인과의 약속 (3.2)

- 순서: ① `cdk deploy`(인프라 변경 시) ② migrate 작업: 현재 `alm-<env>-migrate` 작업 정의를 새 이미지로 등록 → `RunTask` → 종료 코드 확인 ③ `cdk deploy -c imageTag=<태그>`로 api·worker 갱신 ④ SPA `s3 sync` + CloudFront `/index.html` 무효화.
- 작업 정의 환경 변수: `APP_ROLE`, `DB_HOST/PORT/NAME`, `DB_IAM_USER`, `CACHE_ENDPOINT`, `CACHE_USER`, `JOBS_QUEUE_URL`, `FILES_BUCKET`, `EXPORTS_BUCKET`, `COGNITO_*`, `SES_CONFIG_SET`, `MAIL_FROM`, `COGNITO_ADMIN_FUNCTION`. 비밀: `COOKIE_KEY`, `COGNITO_WEB_CLIENT_SECRET`.

## 3.3 이후에 이어서 할 것

- `alm-<env>-cognito-admin` Lambda 본문(지금은 501 반환 자리).
- 앱: RDS IAM 토큰 접속, Valkey IAM 인증 토큰(SigV4) 생성, EMF 지표 `ALM/SapOverdue`·`SapPostingFailed`·`SapAuthFailed`·`Requests(TenantId)`.
- DB 로그인 역할(`alm_app_login`, `alm_owner_iam`, `alm_archive_login`)과 `rds_iam` 부여는 migrate가 `db/ddl` 보안 스크립트로 만든다.
- 배포 때 확인: Firehose가 Object Lock 감사 버킷에 쓰는지(실패하면 `<env>/pgaudit-errors/`에 남는다), CloudFront 표준 로그 v2의 계정 간 S3 전송, VPC 오리진 보안 그룹 이름 조회.
