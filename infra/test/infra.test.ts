import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildEnv, buildGlobal } from '../lib/build';
import { applySuppressions } from '../lib/nag';
import cdkJson from '../cdk.json';
import cdkContext from '../cdk.context.json';

// CLI와 같은 기능 플래그·조회 캐시로 합성한다
const newApp = () => new App({ context: { ...cdkJson.context, ...cdkContext } });

type Built = ReturnType<typeof buildEnv>;
const envs: Record<string, Built> = {};
const tpl = (e: string, s: keyof Omit<Built, 'cfg' | 'stacks'>) => Template.fromStack(envs[e][s] as any);

beforeAll(() => {
  for (const e of ['dev', 'prd'] as const) envs[e] = buildEnv(newApp(), e);
});

describe('Network', () => {
  it('2개 AZ × 퍼블릭·앱·데이터 서브넷', () => {
    tpl('dev', 'network').resourceCountIs('AWS::EC2::Subnet', 6);
  });
  it('인터페이스 엔드포인트·흐름 로그는 PRD만', () => {
    tpl('dev', 'network').resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    tpl('prd', 'network').resourceCountIs('AWS::EC2::VPCEndpoint', 8);
    tpl('dev', 'network').resourceCountIs('AWS::EC2::FlowLog', 0);
    tpl('prd', 'network').hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
  });
});

describe('Data', () => {
  it('RDS PostgreSQL 16, IAM 인증, 암호화, TLS 강제, pgaudit', () => {
    const t = tpl('prd', 'data');
    t.hasResourceProperties('AWS::RDS::DBInstance', Match.objectLike({ Engine: 'postgres', EngineVersion: Match.stringLikeRegexp('^16\\.'),
      EnableIAMDatabaseAuthentication: true, StorageEncrypted: true, MultiAZ: true, DeletionProtection: true,
      AutomaticBackupReplicationRegion: 'us-east-2' }));
    t.hasResourceProperties('AWS::RDS::DBParameterGroup', { Parameters: Match.objectLike({ 'rds.force_ssl': '1',
      shared_preload_libraries: 'pg_stat_statements,pgaudit' }) });
    tpl('dev', 'data').hasResourceProperties('AWS::RDS::DBInstance', Match.objectLike({ MultiAZ: false }));
  });
  it('files 버킷: KMS·버전 관리·퍼블릭 차단', () => {
    tpl('dev', 'data').hasResourceProperties('AWS::S3::Bucket', Match.objectLike({ BucketName: 'alm-dev-files-444444444444',
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) })] } }));
  });
  it('PRD만 AWS Backup 계획', () => {
    tpl('prd', 'data').resourceCountIs('AWS::Backup::BackupPlan', 1);
    tpl('dev', 'data').resourceCountIs('AWS::Backup::BackupPlan', 0);
  });
});

describe('Auth (09 6장)', () => {
  it('웹 클라이언트 15분/8시간, 비밀 있음', () => {
    tpl('dev', 'auth').hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'alm-web', GenerateSecret: true,
      AccessTokenValidity: 15, RefreshTokenValidity: 480, CallbackURLs: ['https://alm-dev.bsgglobal.com/api/v1/auth/callback'] }));
  });
  it('PDA 클라이언트 60분/24시간, 비밀 없음', () => {
    tpl('dev', 'auth').hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'alm-pda', GenerateSecret: false,
      AccessTokenValidity: 60, RefreshTokenValidity: 1440 }));
  });
  it('자가 가입 없음, Lite', () => {
    tpl('dev', 'auth').hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({ AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, UserPoolTier: 'LITE' }));
  });
});

describe('App (10 6장)', () => {
  it('작업 정의 5개: ARM64, 읽기 전용 루트, 비루트 사용자', () => {
    const t = tpl('prd', 'app');
    t.resourceCountIs('AWS::ECS::TaskDefinition', 5);
    t.allResourcesProperties('AWS::ECS::TaskDefinition', Match.objectLike({ RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [Match.objectLike({ ReadonlyRootFilesystem: true, User: '1000' })] }));
  });
  it('ALB는 내부 전용, HTTPS만', () => {
    const t = tpl('prd', 'app');
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', Match.objectLike({ Scheme: 'internal' }));
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', Match.objectLike({ Port: 443, Protocol: 'HTTPS' }));
  });
  it('Valkey Serverless: default 사용자 끔, 앱 사용자 IAM 인증', () => {
    const t = tpl('dev', 'app');
    t.hasResourceProperties('AWS::ElastiCache::ServerlessCache', Match.objectLike({ Engine: 'valkey' }));
    t.hasResourceProperties('AWS::ElastiCache::User', Match.objectLike({ UserName: 'default', AccessString: 'off -@all' }));
    t.hasResourceProperties('AWS::ElastiCache::User', Match.objectLike({ UserName: 'alm-dev-app', AuthenticationMode: { Type: 'iam' } }));
  });
  it('예약 작업은 동부 시간대, 야간 정지는 DEV·QA만', () => {
    const dev = tpl('dev', 'app');
    dev.allResourcesProperties('AWS::Scheduler::Schedule', Match.objectLike({ ScheduleExpressionTimezone: 'America/New_York' }));
    const count = (t: Template) => Object.keys(t.findResources('AWS::Scheduler::Schedule')).length;
    expect(count(dev) - count(tpl('prd', 'app'))).toBe(6);
  });
  it('작업 역할은 자기 DB 사용자로만 rds-db:connect', () => {
    const json = JSON.stringify(tpl('prd', 'app').toJSON());
    for (const u of ['alm_app_login', 'alm_owner_iam', 'alm_archive_login']) expect(json).toContain(`/${u}`);
    expect(json).not.toMatch(/dbuser:[^"]*\/\*"/);
  });
});

describe('Edge (10 5장)', () => {
  it('WAF: SAP 허용 목록 차단이 가장 먼저, 관리형 규칙 5개, 호출 제한 2개', () => {
    const t = tpl('prd', 'edge');
    const acl = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0] as any;
    const rules = acl.Properties.Rules as any[];
    expect(rules[0].Name).toBe('sap-allowlist-block');
    expect(rules.filter((r) => r.Statement.ManagedRuleGroupStatement)).toHaveLength(5);
    expect(rules.filter((r) => r.Statement.RateBasedStatement)).toHaveLength(2);
    t.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', Match.objectLike({ RedactedFields: Match.arrayWith([{ SingleHeader: { Name: 'authorization' } }]) }));
  });
  it('CloudFront: /api/* 는 VPC 오리진, CSP에 Browser Print 로컬 주소', () => {
    const t = tpl('prd', 'edge');
    t.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('http://localhost:9100');
    t.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Aliases: ['alm.bsgglobal.com'],
      CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' })]) }) });
  });
});

describe('Observability (10 9장)', () => {
  it('9.3 알람이 모두 있다', () => {
    const names = Object.values(tpl('prd', 'obs').findResources('AWS::CloudWatch::Alarm')).map((a: any) => a.Properties.AlarmName as string);
    for (const n of ['api-5xx', 'api-p95', 'api-healthy', 'db-cpu', 'db-storage', 'db-connections', 'jobs-dlq', 'jobs-age',
      'sap-overdue', 'sap-posting-failed', 'sap-auth-failed', 'waf-blocked', 'canary', 'cert-expiry-0', 'cert-expiry-1']) {
      expect(names).toContain(`alm-prd-${n}`);
    }
  });
  it('야간 정지 환경은 가용성 알람에 알림이 없다', () => {
    const healthy = (e: string) => (Object.values(tpl(e, 'obs').findResources('AWS::CloudWatch::Alarm'))
      .find((a: any) => a.Properties.AlarmName === `alm-${e}-api-healthy`) as any).Properties.AlarmActions;
    expect(healthy('dev')).toBeUndefined();
    expect(healthy('prd')).toHaveLength(1);
  });
  it('pgaudit → Firehose → 감사 버킷 <env>/pgaudit/', () => {
    const t = tpl('prd', 'obs');
    t.hasResourceProperties('AWS::Logs::SubscriptionFilter', Match.objectLike({ LogGroupName: '/aws/rds/instance/alm-prd/postgresql', FilterPattern: '"AUDIT:"' }));
    t.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', Match.objectLike({ ExtendedS3DestinationConfiguration: Match.objectLike({
      BucketARN: 'arn:aws:s3:::alm-audit-archive-111111111111', Prefix: Match.stringLikeRegexp('^prd/pgaudit/') }) }));
  });
  it('월 예산 80%·100%', () => {
    tpl('prd', 'obs').hasResourceProperties('AWS::Budgets::Budget', Match.objectLike({ Budget: Match.objectLike({ BudgetLimit: { Amount: 900, Unit: 'USD' } }) }));
  });
});

describe('계정 공통', () => {
  const g = buildGlobal(newApp());
  it('감사 보관: Object Lock 준수 모드 10년, us-east-2 복제', () => {
    const t = Template.fromStack(g.logArchive);
    t.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({ BucketName: 'alm-audit-archive-111111111111',
      ObjectLockEnabled: true, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 3653 } } },
      ReplicationConfiguration: Match.objectLike({ Rules: [Match.objectLike({ Destination: Match.objectLike({ Bucket: 'arn:aws:s3:::alm-audit-archive-replica-111111111111' }) })] }) }));
  });
  it('ECR: 태그 불변, 푸시 시 검사', () => {
    Template.fromStack(g.shared).hasResourceProperties('AWS::ECR::Repository', Match.objectLike({ ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true } }));
  });
  it('backup 볼트: Vault Lock 최소 35일', () => {
    Template.fromStack(g.vault).hasResourceProperties('AWS::Backup::BackupVault', Match.objectLike({ LockConfiguration: Match.objectLike({ MinRetentionDays: 35 }) }));
  });
  it('추가 SCP 3개를 Workloads·Security OU에', () => {
    Template.fromStack(g.org).resourceCountIs('AWS::Organizations::Policy', 3);
  });
});

describe('cdk-nag (AwsSolutions)', () => {
  for (const e of ['dev', 'qa', 'prd', 'global']) {
    it(`${e}: 사유 없는 위반 0건`, () => {
      const app = newApp();
      const b = e === 'global' ? buildGlobal(app) : buildEnv(app, e as any);
      applySuppressions(app, b.stacks, e === 'global' ? undefined : e);
      const r = new AwsSolutionsChecks(app).validateScope(app);
      const left = r.violations.flatMap((v) => v.violatingResources.map((x: any) => `${v.ruleName} ${x.constructPath ?? x.resourceLogicalId}`));
      expect(left).toEqual([]);
    });
  }
});
