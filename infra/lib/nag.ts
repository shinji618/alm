import { App, Stack, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

// cdk-nag(AwsSolutions) 예외 목록. 10 정의서 11장 "예외는 코드에 사유와 함께 적는다".
// [대상 스택 접미사('*'=전체), 규칙, 사유, 적용 환경(생략=전체)]
type Rule = [string, string, string, string[]?];
const NON_PRD = ['dev', 'qa'];
const RULES: Rule[] = [
  // ---- 공통: CDK가 만드는 보조 Lambda ----
  ['*', 'AwsSolutions-IAM4', 'AWS 서비스 역할용 관리형 정책만 쓴다: Lambda 기본 실행(로그 쓰기), RDS 향상된 모니터링, AWS Backup 서비스 역할. 사람용 관리형 정책 부여는 OrgBaseline 권한 세트뿐'],
  ['*', 'AwsSolutions-L1', 'CDK 내장 보조 Lambda 런타임은 CDK 버전이 정한다. 직접 만든 함수는 NODEJS_24_X'],

  // ---- Network ----
  ['Network', 'AwsSolutions-VPC7', 'DEV·QA는 흐름 로그를 끈다(10 정의서 9.1: PRD만 거부 트래픽 90일). 비용 절감', NON_PRD],

  ['Network', 'AwsSolutions-EC23', 'VPC 인터페이스 엔드포인트 보안 그룹: CDK 기본값으로 VPC CIDR에서 443만 허용(인터넷 개방 아님). 규칙이 CIDR 토큰을 해석하지 못해 경고'],

  // ---- Data ----
  ['Data', 'AwsSolutions-RDS3', 'DEV·QA는 단일 AZ(10 정의서 7.1, A-10 비용). PRD는 다중 AZ', NON_PRD],
  ['Data', 'AwsSolutions-RDS10', 'DEV는 삭제 보호를 끈다(환경 재생성). QA·PRD는 켬', ['dev']],
  ['Data', 'AwsSolutions-RDS11', '기본 포트 5432 유지. 데이터 서브넷 격리 + 보안 그룹(작업별) + IAM 인증 + TLS 강제로 보호(09 8장)'],
  ['Data', 'AwsSolutions-IAM5', 'CDK 로그 보존 Lambda의 logs:* 권한(대상 로그 그룹 이름이 배포 때 정해짐)'],

  // ---- Auth ----
  ['Auth', 'AwsSolutions-COG2', '사용자는 고객사 IdP(SAML/OIDC) 페더레이션으로만 로그인하고 MFA는 고객 IdP 정책을 따른다(09 6.2, S-11)'],
  ['Auth', 'AwsSolutions-COG8', 'Cognito Lite 요금제(S-11). 위협 방지는 IdP·WAF·앱 호출 제한으로 대신한다'],
  ['Auth', 'AwsSolutions-SMG4', '웹 클라이언트 비밀은 Cognito가 발급하고 alm-cognito-admin으로 분기마다 교체, 쿠키 키도 분기 교체 런북(09 6.4). Secrets Manager 자동 교체 Lambda 대상 아님'],
  ['Auth', 'AwsSolutions-IAM5', 'UserPoolDomain CloudFront 이름 조회 사용자 지정 리소스(DescribeUserPoolDomain은 리소스 수준 권한 없음)'],

  // ---- App ----
  ['App', 'AwsSolutions-ECS2', '환경 변수는 비밀이 아닌 구성값(엔드포인트·이름·ID)만. 비밀(쿠키 키·클라이언트 비밀)은 Secrets Manager secrets로 주입'],
  ['App', 'AwsSolutions-IAM5', [
    'ecr:GetAuthorizationToken·ssmmessages(ECS Exec, DEV만)·logs는 리소스 수준 권한이 없다.',
    'S3 객체 권한(files·exports·감사 보관 <env>/ 접두사)은 객체 키 와일드카드가 필요하다.',
    'KMS 와일드카드 액션은 CDK grant 표준 묶음(GenerateDataKey*, ReEncrypt*). 감사 키는 별칭 조건(alias/alm/audit)으로 제한.',
    'SES identity/*: 발신 도메인 identity, 구성 세트는 이름으로 지정. Lambda 호출 :* 는 버전·별칭',
  ].join(' ')],

  // ---- Edge ----
  ['Edge', 'AwsSolutions-CFR1', '사용자는 미국 고객사지만 출장·해외 법인 접근을 막지 않는다. 지역 제한 대신 WAF IP 평판·익명 IP 규칙 사용(10 정의서 5.2)'],
  ['Edge', 'AwsSolutions-CFR3', 'CloudFront 표준 로그 v2(CloudWatch Logs 전송 → log-archive S3)로 기록한다. 규칙은 구 방식(Logging 속성)만 검사'],
  ['Edge', 'AwsSolutions-S1', '웹 정적 파일 버킷은 CloudFront OAC로만 읽고, 접근 기록은 CloudFront 로그가 대신한다'],
  ['Edge', 'AwsSolutions-IAM5', 'VPC 오리진 보안 그룹 조회(ec2:DescribeSecurityGroups는 리소스 수준 권한 없음)'],

  // ---- Observability ----
  ['Observability', 'AwsSolutions-S1', '카나리아 결과(스크린샷·HAR) 30일 임시 버킷. 접근 기록 불필요'],
  ['Observability', 'AwsSolutions-IAM5', '카나리아 표준 역할(cwsyn-* 로그 그룹, 결과 버킷 객체, cloudwatch:PutMetricData)과 pgaudit Firehose의 감사 버킷 <env>/pgaudit/ 접두사·감사 키(별칭 조건)'],

  // ---- Ci ----
  ['Ci', 'AwsSolutions-IAM5', [
    'cdk 부트스트랩 역할(cdk-hnb659fds-*) 위임, App 스택 작업 역할 PassRole(ecs-tasks 조건),',
    'migrate 작업 정의 등록·실행(ECS 작업 정의 ARN은 리비전마다 바뀜), migrate 로그 그룹, 웹 버킷 객체 동기화, CloudFront 무효화(배포 ID는 Edge가 정함)',
  ].join(' ')],

  // ---- 계정 공통 ----
  ['LogArchive', 'AwsSolutions-IAM5', 'S3 복제 역할의 원본·대상 객체 와일드카드(CDK 복제 규칙 표준)'],
  ['LogArchiveReplica', 'AwsSolutions-S1', '복제 대상 버킷(쓰기는 S3 복제만). 접근 기록은 원본 버킷과 CloudTrail 데이터 이벤트로 남긴다'],
  ['Shared', 'AwsSolutions-IAM5', 'ecr:GetAuthorizationToken은 리소스 수준 권한이 없다'],
  ['OrgBaseline', 'AwsSolutions-IAM4', 'Identity Center 권한 세트에 AWS 관리형 정책(AdministratorAccess·ReadOnlyAccess 등)을 붙인다(10 정의서 3.1)'],
];

const matches = (stack: Stack, env: string | undefined, ruleId: string) => RULES.find(([target, id, , envs]) =>
  (target === '*' || stack.stackName.endsWith(`-${target}`)) && (!envs || (env !== undefined && envs.includes(env)))
  && (ruleId === id || ruleId.startsWith(`${id}[`)));

// cdk-nag 3은 인정(acknowledge) ID를 정확히 비교한다. IAM4·IAM5처럼 세부 ID([Action::…])가 붙는 규칙은
// 먼저 한 번 검사해 나온 세부 ID 중 위 목록의 규칙에 해당하는 것만 같은 사유로 인정한다
export function applySuppressions(app: App, stacks: Stack[], env?: string) {
  const report = new AwsSolutionsChecks(app).validateScope(app);
  const done = new Set<string>();
  for (const v of report.violations) {
    for (const res of v.violatingResources) {
      const stack = stacks.find((s) => res.templatePath?.endsWith(`${s.artifactId}.template.json`) || (res as any).constructPath?.startsWith(`${s.node.path}/`));
      if (!stack) continue;
      const rule = matches(stack, env, v.ruleName);
      const key = `${stack.node.path}|${v.ruleName}`;
      if (rule && !done.has(key)) { Validations.of(stack).acknowledge({ id: v.ruleName, reason: rule[2] }); done.add(key); }
    }
  }
}
