import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SUITE_ENVS, suiteStackName } from '../lib/suite-config';
import { SuiteAlmStack } from '../lib/suite-alm-stack';
import { applySuppressions } from '../lib/nag';
import cdkJson from '../cdk.json';
import cdkContext from '../cdk.context.json';

// 공유 플랫폼(suite) 위의 ALM 스택(통합 WBS 5.4). 전용 환경 스택(infra.test.ts)과 따로 검사한다.
const build = (over: Partial<(typeof SUITE_ENVS)['dev']> = {}) => {
  const app = new App({ context: { ...cdkJson.context, ...cdkContext } });
  const cfg = { ...SUITE_ENVS.dev, ...over };
  const stack = new SuiteAlmStack(app, suiteStackName('dev'), cfg, { env: { account: cfg.account, region: 'us-east-1' } });
  return { app, stack, t: Template.fromStack(stack).toJSON() as any };
};
let t: any;
const resources = (type: string, tpl = t) => Object.entries<any>(tpl.Resources).filter(([, r]) => r.Type === type).map(([id, r]) => ({ id, ...r }));
const container = (family: string, tpl = t) => resources('AWS::ECS::TaskDefinition', tpl).find((d) => d.Properties.Family === family)!.Properties.ContainerDefinitions[0];
const env = (family: string, tpl = t) => Object.fromEntries(container(family, tpl).Environment.map((e: any) => [e.Name, e.Value]));
const secretNames = (family: string) => (container(family).Secrets ?? []).map((x: any) => x.Name).sort();
const ssmParams = () => Object.values<any>(t.Parameters ?? {}).map((p) => p.Default).filter((d) => typeof d === 'string' && d.startsWith('/suite/'));

beforeAll(() => { t = build().t; });

describe('ALM on suite (dev)', () => {
  it('플랫폼 자원은 만들지 않고 SSM 파라미터로 참조한다: VPC·RDS·Valkey·클러스터·ALB·CloudFront·사용자 풀·발신 도메인 없음', () => {
    for (const type of ['AWS::EC2::VPC', 'AWS::RDS::DBInstance', 'AWS::ElastiCache::ServerlessCache', 'AWS::ElastiCache::User', 'AWS::ECS::Cluster',
      'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::Listener', 'AWS::CloudFront::Distribution', 'AWS::Route53::HostedZone',
      'AWS::SES::EmailIdentity', 'AWS::WAFv2::WebACL', 'AWS::Cognito::UserPool', 'AWS::Lambda::Function']) expect(resources(type), type).toEqual([]);
    expect(ssmParams().sort()).toEqual(['access-logs-bucket', 'alb-listener-arn', 'alb-security-group-id', 'app-subnet-ids', 'cache-arn', 'cache-endpoint', 'cache-name',
      'cache-security-group-id', 'data-key-arn', 'db-host', 'db-port', 'db-resource-id', 'db-security-group-id', 'id-api-url', 'id-auth-domain', 'id-events-topic-arn',
      'id-token-url', 'id-user-pool-id', 'mail-identity-arn', 'vpc-id'].map((k) => `/suite/dev/${k}`));
  });

  it('이름 규칙: 서비스 alm-*, 태스크 정의 suite-dev-alm-*, 로그 /suite/dev/alm/*(플랫폼 키로 암호화), 버킷·큐·비밀·일정 그룹. 전용 환경 이름과 겹치지 않는다', () => {
    expect(resources('AWS::ECS::Service').map((s) => s.Properties.ServiceName).sort()).toEqual(['alm-api', 'alm-worker']);
    for (const s of resources('AWS::ECS::Service')) expect(s.Properties.Cluster).toBe('suite-dev');
    expect(resources('AWS::ECS::TaskDefinition').map((d) => d.Properties.Family).sort()).toEqual(['suite-dev-alm-api', 'suite-dev-alm-migrate', 'suite-dev-alm-partman', 'suite-dev-alm-worker']);
    const logGroups = resources('AWS::Logs::LogGroup');
    expect(logGroups.map((l) => l.Properties.LogGroupName).sort()).toEqual(['/suite/dev/alm/api', '/suite/dev/alm/migrate', '/suite/dev/alm/partman', '/suite/dev/alm/worker']);
    for (const l of logGroups) expect(l.Properties.KmsKeyId, l.Properties.LogGroupName).toBeTruthy();
    expect(resources('AWS::S3::Bucket').map((x) => x.Properties.BucketName)).toEqual(['suite-dev-alm-files-236501162716']);
    expect(resources('AWS::SQS::Queue').map((q) => q.Properties.QueueName).sort()).toEqual(['suite-dev-alm-identity-events', 'suite-dev-alm-jobs', 'suite-dev-alm-jobs-dlq', 'suite-dev-alm-ses-events']);
    expect(resources('AWS::SecretsManager::Secret').map((x) => x.Properties.Name)).toEqual(['alm/dev/suite-central-id']);   // 전용 환경의 alm/dev/central-id와 다른 이름(같은 계정)
    expect(resources('AWS::Scheduler::ScheduleGroup').map((x) => x.Properties.Name)).toEqual(['suite-dev-alm']);
    expect(resources('AWS::SES::ConfigurationSet').map((x) => x.Properties.Name)).toEqual(['suite-dev-alm']);
    // 같은 계정의 전용 환경(alm-dev-*, /alm/dev/*)과 이름이 겹치면 배포가 실패한다
    const names = JSON.stringify([resources('AWS::SQS::Queue'), resources('AWS::Logs::LogGroup'), resources('AWS::ECS::TaskDefinition'), resources('AWS::SNS::Topic')].flat()
      .map((r) => r.Properties.QueueName ?? r.Properties.LogGroupName ?? r.Properties.Family ?? r.Properties.TopicName));
    expect(names).not.toMatch(/"alm-dev-|"\/alm\/dev\//);
  });

  it('웹 인증은 플랫폼 통행증: SUITE_AUTH=1, 발급자 = app 주소, 공개 키는 중앙 ID에서 직접. 쿠키 키·웹 클라이언트 비밀이 없다', () => {
    const e = env('suite-dev-alm-api');
    expect([e.SUITE_AUTH, e.SUITE_ORIGIN, e.SUITE_JWKS_URL]).toEqual(['1', 'https://app-dev.pasapps.com', 'https://id.app-dev.pasapps.com/auth/jwks.json']);
    expect([e.APP_ORIGIN, e.MAIL_FROM, e.DB_NAME, e.ALM_ENV]).toEqual(['https://app-dev.pasapps.com/alm', 'no-reply@app-dev.pasapps.com', 'alm', 'dev']);
    expect(secretNames('suite-dev-alm-api')).toEqual(['CENTRAL_ID_CLIENT_ID', 'CENTRAL_ID_CLIENT_SECRET', 'COGNITO_PDA_CLIENT_ID', 'PORTAL_NOTIFY_CLIENT_ID', 'PORTAL_NOTIFY_CLIENT_SECRET']);
    for (const f of ['suite-dev-alm-api', 'suite-dev-alm-worker', 'suite-dev-alm-migrate', 'suite-dev-alm-partman']) {
      expect(JSON.stringify(container(f).Environment), f).not.toMatch(/COOKIE_KEY|CLIENT_SECRET|DB_MASTER|PASSWORD/);
      expect(secretNames(f).filter((n: string) => /COOKIE|WEB_CLIENT|DB_MASTER/.test(n)), f).toEqual([]);
    }
  });

  it('DB: 모든 작업이 IAM 인증. migrate는 소유자(alm_owner)·공유 플랫폼 모드, 마스터 비밀 없음. 작업마다 자기 계정에만 접속 권한', () => {
    expect(['api', 'worker', 'migrate', 'partman'].map((n) => env(`suite-dev-alm-${n}`).DB_IAM_USER)).toEqual(['alm_app_login', 'alm_app_login', 'alm_owner', 'alm_archive_login']);
    expect(env('suite-dev-alm-migrate').SUITE_MODE).toBe('1');
    expect(container('suite-dev-alm-migrate').Command).toEqual(['sh', 'scripts/migrate.sh']);
    const connect = resources('AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement.filter((s: any) => s.Action === 'rds-db:connect').map((s: any) => JSON.stringify(s.Resource)));
    expect(connect.length).toBe(4);
    expect(connect.filter((r) => r.includes('/alm_owner')).length).toBe(1);
    expect(JSON.stringify(connect)).not.toMatch(/suite_owner|portal_|dbuser:\*/);
    // 보안 그룹 규칙: RDS ← api·worker·migrate·partman, Valkey ← api·worker(플랫폼 보안 그룹에 더한다)
    const ingress = resources('AWS::EC2::SecurityGroupIngress').map((r) => r.Properties.FromPort).sort();
    expect(ingress).toEqual([3000, 5432, 5432, 5432, 5432, 6379, 6379]);   // 3000 = ALB → api(대상 그룹 연결)
  });

  it('공유 Valkey: 자기 사용자(suite-dev-alm)·자기 접두어(alm:)만', () => {
    const e = env('suite-dev-alm-api');
    expect([e.CACHE_USER, e.CACHE_KEY_PREFIX]).toEqual(['suite-dev-alm', 'alm:']);
    const s = JSON.stringify(resources('AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement.filter((x: any) => x.Action === 'elasticache:Connect')));
    expect(s).toContain(':user:suite-dev-alm'); expect(s).not.toContain(':user:*');
  });

  it('공유 ALB 규칙: 제품 헤더 X-Suite-Product=alm 이고 /api/* 인 요청만, 우선순위 200(ALM 대역)', () => {
    const rules = resources('AWS::ElasticLoadBalancingV2::ListenerRule');
    expect(rules.length).toBe(1);
    expect(rules[0].Properties.Priority).toBe(200);
    const cond = JSON.stringify(rules[0].Properties.Conditions);
    expect(cond).toContain('X-Suite-Product'); expect(cond).toContain('"alm"'); expect(cond).toContain('/api/*');
    expect(resources('AWS::ElasticLoadBalancingV2::TargetGroup')[0].Properties.HealthCheckPath).toBe('/api/v1/health/live');
  });

  it('일정: 작업 큐 5건 + 파티션 관리(DB가 켜진 평일 07:30 ET). 감사 보관은 아직 옮기지 않았다', () => {
    const s = resources('AWS::Scheduler::Schedule');
    expect(s.length).toBe(6);
    expect(s.map((x) => x.Properties.ScheduleExpressionTimezone)).toEqual(Array(6).fill('America/New_York'));
    const partman = s.find((x) => JSON.stringify(x.Properties.Target).includes('EcsParameters'))!;
    expect(partman.Properties.ScheduleExpression).toBe('cron(30 7 ? * MON-FRI *)');
    expect(resources('AWS::ECS::TaskDefinition').map((d) => d.Properties.Family)).not.toContain('suite-dev-alm-audit-archive');
  });

  it('Portal 연동·SAP: 설정이 있을 때만 켠다. DEV는 새 중앙 ID의 portal-backend, SAP은 전용 환경의 ALM 풀', () => {
    const e = env('suite-dev-alm-api');
    expect([e.PORTAL_CLIENT_IDS, e.PORTAL_FEED_SCOPE, e.PORTAL_API_URL, e.PORTAL_NOTIFY_SCOPE]).toEqual(['25qk2s95tebtjhdrrtelg7r1mi', 'portal/feed', 'https://app-dev.pasapps.com/api', 'portal/notify']);
    expect([e.COGNITO_SAP_USER_POOL_ID, e.COGNITO_SAP_DOMAIN, e.COGNITO_ADMIN_FUNCTION]).toEqual(['us-east-1_2iCIGqVTT', 'auth.alm-dev.pasapps.com', 'alm-dev-cognito-admin']);
    // SAP 관리 함수 호출 권한은 그 함수 하나
    const invoke = JSON.stringify(resources('AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement.filter((x: any) => x.Action === 'lambda:InvokeFunction')));
    expect(invoke).toContain(':function:alm-dev-cognito-admin'); expect(invoke).not.toContain(':function:*');
    const off = build({ portal: { clientIds: '', feedScope: 'portal/feed', notifyScope: 'portal/notify' }, sap: undefined }).t;
    const e2 = env('suite-dev-alm-api', off);
    expect([e2.PORTAL_CLIENT_IDS, e2.PORTAL_FEED_SCOPE, e2.COGNITO_SAP_USER_POOL_ID, e2.COGNITO_ADMIN_FUNCTION]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('태그: Project=Suite, Product=alm(플랫폼의 제품별 예산)', () => {
    const tags = Object.fromEntries(resources('AWS::ECS::Service')[0].Properties.Tags.map((x: any) => [x.Key, x.Value]));
    expect(tags).toMatchObject({ Project: 'Suite', Product: 'alm', Env: 'dev' });
  });

  it('cdk-nag: 예외 목록(nag.ts)에 적은 규칙 밖의 위반이 없다', () => {
    const { app, stack } = build();
    applySuppressions(app, [stack], 'dev');
    const report = new AwsSolutionsChecks(app).validateScope(app);
    const open = report.violations.filter((v) => v.ruleName.startsWith('AwsSolutions-')).flatMap((v) => v.violatingResources.map((r: any) => `${v.ruleName} ${r.constructPath ?? ''}`));
    expect(open.filter((x) => !/AwsSolutions-(SMG4|ECS2|IAM5|IAM4|L1)/.test(x))).toEqual([]);
  });
});
