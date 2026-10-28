// 중앙 ID 서비스 인프라(WBS 3.11)
import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildIdentity } from '../lib/identity/build';
import { ID_ENVS, isPending } from '../lib/identity/config';
import { ENVS } from '../lib/config';
import cdkJson from '../cdk.json';

type Built = ReturnType<typeof buildIdentity>;
const b: Record<string, Built> = {};
const t = (e: string, s: 'dns' | 'data' | 'auth' | 'api' | 'obs' | 'ci') => Template.fromStack(b[e][s]);
beforeAll(() => { for (const e of ['dev', 'prd'] as const) b[e] = buildIdentity(new App({ context: cdkJson.context }), e); });

describe('중앙 ID 서비스', () => {
  it('영역·도메인: API = 영역 최상위, 로그인 = auth.<영역>, ALM과 다른 영역', () => {
    t('dev', 'dns').hasResourceProperties('AWS::Route53::HostedZone', { Name: 'id-dev.pasapps.com.' });
    t('prd', 'dns').hasResourceProperties('AWS::Route53::HostedZone', { Name: 'id.pasapps.com.' });
    t('dev', 'api').hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'id-dev.pasapps.com' });
    t('dev', 'api').hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'auth.id-dev.pasapps.com' });
    for (const e of ['dev', 'qa', 'prd'] as const) expect(ID_ENVS[e].zoneName).not.toBe(ENVS[e].zoneName);
  });

  it('계정: ALM 환경 계정과 겹치지 않음, 계정 생성 전에는 자리 값', () => {
    const alm = Object.values(ENVS).map((e) => e.account);
    for (const e of Object.values(ID_ENVS)) if (!isPending(e)) expect(alm).not.toContain(e.account);
    expect(b.dev.stacks.every((s) => /^\d{12}$/.test(s.account))).toBe(true);
  });

  it('DB: Aurora PG16 Serverless v2, Data API, 암호화, DEV 0 ACU(자동 일시정지)·PRD 0.5 ACU+리더', () => {
    const d = t('dev', 'data');
    d.hasResourceProperties('AWS::RDS::DBCluster', Match.objectLike({ Engine: 'aurora-postgresql', EnableHttpEndpoint: true, StorageEncrypted: true,
      ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 300 }) }));
    d.resourceCountIs('AWS::RDS::DBInstance', 1);
    d.resourceCountIs('AWS::EC2::NatGateway', 0);
    d.resourceCountIs('AWS::EC2::InternetGateway', 0);
    d.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', Match.objectLike({ Parameters: Match.objectLike({ 'rds.force_ssl': '1' }) }));
    const p = t('prd', 'data');
    p.hasResourceProperties('AWS::RDS::DBCluster', Match.objectLike({ DeletionProtection: true,
      ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0.5, MaxCapacity: 8 }) }));
    p.resourceCountIs('AWS::RDS::DBInstance', 2);
  });

  it('API: 함수는 VPC 밖, Data API·비밀만 허용, 기본 엔드포인트 끔, 접근 로그·호출 제한', () => {
    const a = t('dev', 'api');
    a.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({ FunctionName: 'id-dev-api', Runtime: 'nodejs24.x', Architectures: ['arm64'] }));
    expect(JSON.stringify(a.findResources('AWS::Lambda::Function'))).not.toContain('VpcConfig');
    a.hasResourceProperties('AWS::ApiGatewayV2::Api', Match.objectLike({ DisableExecuteApiEndpoint: true }));
    a.hasResourceProperties('AWS::ApiGatewayV2::Stage', Match.objectLike({ AccessLogSettings: Match.anyValue(),
      DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 }) }));
    const policy = JSON.stringify(a.findResources('AWS::IAM::Policy'));
    expect(policy).toContain('rds-data:ExecuteStatement');
    expect(policy).toContain('cognito-idp:CreateIdentityProvider');
    expect(policy).not.toContain('rds:*');
    expect(policy).not.toContain('cognito-idp:*');
    a.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({ Environment: { Variables: Match.objectLike({
      DB_NAME: 'idsvc', AUTH_DOMAIN: 'auth.id-dev.pasapps.com', DB_APP_SECRET_ARN: Match.anyValue(), EVENTS_TOPIC_ARN: Match.anyValue() }) } }));
  });

  it('변경 이벤트(E-08): SNS 주제 id-<env>-events, 제품 계정(alm-dev)의 SQS 구독만 허용', () => {
    const a = t('dev', 'api');
    a.hasResourceProperties('AWS::SNS::Topic', Match.objectLike({ TopicName: 'id-dev-events' }));
    const pol = JSON.stringify(a.findResources('AWS::SNS::TopicPolicy'));
    expect(pol).toContain('236501162716'); expect(pol).toContain('sns:Subscribe'); expect(pol).toContain('"sns:Protocol":"sqs"');
    t('dev', 'data').hasResourceProperties('AWS::SecretsManager::Secret', Match.objectLike({ Name: 'id/dev/db-app' }));
  });

  it('사용자 풀: 새 풀 id-<env>, 자체 가입 없음, 리소스 서버 id-api(read·write·admin)', () => {
    const u = t('dev', 'auth');
    u.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({ UserPoolName: 'id-dev', AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } }));
    u.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', Match.objectLike({ Identifier: 'id-api',
      Scopes: [Match.objectLike({ ScopeName: 'read' }), Match.objectLike({ ScopeName: 'write' }), Match.objectLike({ ScopeName: 'admin' })] }));
    u.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  });

  it('운영: 알람(함수 오류·제한, API 5xx·지연, ACU), 대시보드, 예산, PRD만 외부 상태 확인', () => {
    const o = t('dev', 'obs');
    for (const n of ['FnErrors', 'FnThrottles', 'Api5xx', 'ApiLatencyP95', 'DbAcuHigh'])
      o.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({ AlarmName: `id-dev-${n}` }));
    o.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    o.resourceCountIs('AWS::Budgets::Budget', 1);
    o.resourceCountIs('AWS::Route53::HealthCheck', 0);
    t('prd', 'obs').resourceCountIs('AWS::Route53::HealthCheck', 1);
  });

  it('배포 역할: GitHub OIDC, main·id-dev 환경만', () => {
    t('dev', 'ci').hasResourceProperties('AWS::IAM::Role', Match.objectLike({ RoleName: 'id-deploy-dev' }));
    expect(JSON.stringify(t('dev', 'ci').toJSON())).toContain('environment:id-dev');
  });
});
