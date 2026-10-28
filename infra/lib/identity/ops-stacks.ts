// 중앙 ID 서비스 운영 스택(WBS 3.11): 알람·대시보드·예산(Observability), GitHub 배포 역할(Ci)
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { ORG } from '../config';
import { IdEnvConfig, idApiDomain, idPrefix } from './config';

export class IdObservabilityStack extends Stack {
  readonly topic: sns.Topic;
  constructor(scope: Construct, id: string, cfg: IdEnvConfig, props: StackProps & { fn: lambda.IFunction; api: apigw.IHttpApi; cluster: rds.IDatabaseCluster }) {
    super(scope, id, props);
    const p = idPrefix(cfg);
    const key = new kms.Key(this, 'AlertsKey', { alias: `id/${cfg.name}/alerts`, enableKeyRotation: true, removalPolicy: RemovalPolicy.DESTROY });
    for (const svc of ['cloudwatch.amazonaws.com', 'budgets.amazonaws.com']) key.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal(svc)], actions: ['kms:Decrypt', 'kms:GenerateDataKey*'], resources: ['*'] }));
    this.topic = new sns.Topic(this, 'Alarms', { topicName: `${p}-alarms`, masterKey: key, enforceSSL: true });
    this.topic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
    this.topic.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'], resources: [this.topic.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }));
    const action = new cwActions.SnsAction(this.topic);
    const alarm = (name: string, metric: cw.IMetric, threshold: number, desc: string, periods = 1,
      op = cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD) => {
      const a = new cw.Alarm(this, name, { alarmName: `${p}-${name}`, metric, threshold, evaluationPeriods: periods, comparisonOperator: op,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: desc });
      a.addAlarmAction(action); a.addOkAction(action);
      return a;
    };
    const five = { period: Duration.minutes(5) };
    const apiDim = { ApiId: props.api.apiId, Stage: '$default' };
    const apiMetric = (metricName: string, statistic = 'Sum') => new cw.Metric({ namespace: 'AWS/ApiGateway', metricName, dimensionsMap: apiDim, statistic, ...five });
    const fnErrors = props.fn.metricErrors({ ...five, statistic: 'Sum' });
    const fnThrottles = props.fn.metricThrottles({ ...five, statistic: 'Sum' });
    const fnDuration = props.fn.metricDuration({ ...five, statistic: 'p95' });
    const api5xx = apiMetric('5xx'), api4xx = apiMetric('4xx'), apiCount = apiMetric('Count'), apiLatency = apiMetric('Latency', 'p95');
    const dbDim = { DBClusterIdentifier: props.cluster.clusterIdentifier };
    const acu = new cw.Metric({ namespace: 'AWS/RDS', metricName: 'ACUUtilization', dimensionsMap: dbDim, statistic: 'Maximum', ...five });
    const capacity = new cw.Metric({ namespace: 'AWS/RDS', metricName: 'ServerlessDatabaseCapacity', dimensionsMap: dbDim, statistic: 'Maximum', ...five });

    alarm('FnErrors', fnErrors, 3, '함수 오류 5분 3건 이상(로그인 완료·관리 API 실패 가능)');
    alarm('FnThrottles', fnThrottles, 1, '함수 동시 실행 제한에 걸림');
    alarm('Api5xx', api5xx, 5, 'API 5xx 5분 5건 이상');
    alarm('ApiLatencyP95', apiLatency, 3000, 'API p95 지연 3초 이상 15분(일시정지 재개가 아닌 지속 지연)', 3);
    alarm('DbAcuHigh', acu, 90, 'Aurora ACU 사용률 90% 이상 15분(maxAcu 상향 검토)', 3);
    if (cfg.name === 'prd') {
      // 외부 상태 확인(/health: DB를 건드리지 않음). PRD만 — DEV·QA는 DB 일시정지를 깨우지 않게 두지 않는다
      const hc = new route53.CfnHealthCheck(this, 'ApiHealthCheck', { healthCheckConfig: { type: 'HTTPS', fullyQualifiedDomainName: idApiDomain(cfg),
        resourcePath: '/health', requestInterval: 30, failureThreshold: 3 }, healthCheckTags: [{ key: 'Name', value: `${p}-api` }] });
      alarm('HealthCheck', new cw.Metric({ namespace: 'AWS/Route53', metricName: 'HealthCheckStatus', dimensionsMap: { HealthCheckId: hc.attrHealthCheckId },
        statistic: 'Minimum', period: Duration.minutes(1) }), 1, '외부 상태 확인 실패(로그인 불가 가능)', 2, cw.ComparisonOperator.LESS_THAN_THRESHOLD);
    }
    new cw.Dashboard(this, 'Dashboard', { dashboardName: p, widgets: [
      [new cw.GraphWidget({ title: 'API 요청·오류', left: [apiCount], right: [api4xx, api5xx], width: 12 }),
       new cw.GraphWidget({ title: 'API p95 지연(ms)', left: [apiLatency], width: 12 })],
      [new cw.GraphWidget({ title: '함수 오류·제한', left: [fnErrors, fnThrottles], width: 12 }),
       new cw.GraphWidget({ title: '함수 p95 실행 시간(ms)', left: [fnDuration], width: 12 })],
      [new cw.GraphWidget({ title: 'Aurora 용량(ACU)·사용률(%)', left: [capacity], right: [acu], width: 24 })],
    ] });
    new budgets.CfnBudget(this, 'Budget', { budget: { budgetName: `${p}-monthly`, budgetType: 'COST', timeUnit: 'MONTHLY',
      budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: 'USD' } },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'SNS', address: this.topic.topicArn }] })) });
  }
}

// GitHub Actions 배포 역할(ALM CiStack과 같은 신뢰 조건). cdk deploy는 부트스트랩 역할을 거친다
export class IdCiStack extends Stack {
  constructor(scope: Construct, id: string, cfg: IdEnvConfig, props: StackProps) {
    super(scope, id, props);
    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const suffixes = cfg.name === 'dev' ? ['ref:refs/heads/main', 'environment:id-dev'] : [`environment:id-${cfg.name}`];
    const role = new iam.Role(this, 'DeployRole', { roleName: `id-deploy-${cfg.name}`, maxSessionDuration: Duration.hours(1),
      description: `GitHub Actions deploy identity (${cfg.name})`,
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': suffixes.flatMap((x) => [`repo:${ORG.githubRepoIds}:${x}`, `repo:${ORG.githubRepo}:${x}`]) } }) });
    const Env = cfg.name[0].toUpperCase() + cfg.name.slice(1);
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CdkBootstrapRoles', actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'ReadStackOutputs', actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/Id-${Env}-*/*`] }));
    // 배포 뒤 DB 스키마 적용(3.12: 함수의 migrate 동작 호출)
    role.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeApi', actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${idPrefix(cfg)}-api`] }));
  }
}
