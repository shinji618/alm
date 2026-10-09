import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvConfig, ORG, fqdn, AUDIT_BUCKET } from './config';

export interface ObservabilityProps extends StackProps {
  alb: elbv2.ApplicationLoadBalancer;
  targetGroup: elbv2.ApplicationTargetGroup;
  apiService: ecs.FargateService;
  workerService: ecs.FargateService;
  jobsQueue: sqs.IQueue;
  jobsDlq: sqs.IQueue;
  db: rds.DatabaseInstance;
  certificates: acm.ICertificate[];
  webAclName: string;
}

// RDS PostgreSQL 기본 max_connections ≈ 메모리(바이트) / 9,531,392
const DB_MEMORY_GIB: Record<string, number> = { 't4g.medium': 4, 't4g.large': 8, 'm7g.large': 8, 'm7g.xlarge': 16, 'r7g.large': 16 };

// 10 정의서 9장: 알람(9.3), 대시보드·카나리아(9.4), pgaudit 10년 보관(9.1), 예산
export class ObservabilityStack extends Stack {
  readonly highTopic: sns.Topic;
  readonly normalTopic: sns.Topic;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: ObservabilityProps) {
    super(scope, id, props);
    const env = cfg.name;

    // ---- 알림 주제: 심각(당번 휴대폰 추가 구독) / 일반 ----
    const key = new kms.Key(this, 'AlertsKey', { alias: `alm/${env}/alerts`, enableKeyRotation: true, removalPolicy: RemovalPolicy.DESTROY });
    for (const svc of ['cloudwatch.amazonaws.com', 'events.amazonaws.com', 'budgets.amazonaws.com']) {
      key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal(svc)],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'], resources: ['*'] }));
    }
    const topic = (id: string, name: string) => {
      const t = new sns.Topic(this, id, { topicName: name, masterKey: key, enforceSSL: true });
      t.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
      t.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'], resources: [t.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }));
      return t;
    };
    this.highTopic = topic('High', `alm-${env}-alarms-high`);
    this.normalTopic = topic('Normal', `alm-${env}-alarms`);
    const high = new cwActions.SnsAction(this.highTopic);
    const normal = new cwActions.SnsAction(this.normalTopic);
    // 야간 정지 환경(DEV·QA)은 가용성 알람을 알림 없이 둔다(밤마다 울리므로)
    const availability = cfg.nightlyStop ? undefined : high;
    const alarm = (a: cw.Alarm, action?: cwActions.SnsAction) => { if (action) { a.addAlarmAction(action); a.addOkAction(action); } return a; };
    const m5 = Duration.minutes(5);

    // ---- API(ALB) ----
    const lbM = props.alb.metrics;
    const tgM = props.targetGroup.metrics;
    const requests = lbM.requestCount({ period: m5, statistic: 'Sum' });
    const err5xx = new cw.MathExpression({ label: '5xx %', period: m5,
      expression: '100 * (FILL(t5,0) + FILL(e5,0)) / IF(req > 0, req, 1)',
      usingMetrics: { req: requests, t5: tgM.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: m5, statistic: 'Sum' }),
        e5: lbM.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: m5, statistic: 'Sum' }) } });
    alarm(err5xx.createAlarm(this, 'Api5xx', { alarmName: `alm-${env}-api-5xx`, threshold: 2, evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'ALB 5xx 비율 5분간 2% 초과 (높음)' }), availability);
    const p95 = tgM.targetResponseTime({ period: m5, statistic: 'p95' });
    alarm(p95.createAlarm(this, 'ApiLatency', { alarmName: `alm-${env}-api-p95`, threshold: 2, evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: '대상 응답 p95 5분간 2초 초과 (중간)' }), normal);
    const healthy = tgM.healthyHostCount({ period: Duration.minutes(1), statistic: 'Minimum' });
    alarm(healthy.createAlarm(this, 'ApiHealthy', { alarmName: `alm-${env}-api-healthy`, threshold: 1, evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD, treatMissingData: cw.TreatMissingData.BREACHING,
      alarmDescription: '정상 대상 수 < 1 (높음)' }), availability);

    // ---- ECS ----
    for (const [name, svc] of [['api', props.apiService], ['worker', props.workerService]] as const) {
      for (const [kind, metric] of [['cpu', svc.metricCpuUtilization({ period: m5 })], ['memory', svc.metricMemoryUtilization({ period: m5 })]] as const) {
        alarm(metric.createAlarm(this, `Ecs-${name}-${kind}`, { alarmName: `alm-${env}-ecs-${name}-${kind}`, threshold: 85, evaluationPeriods: 3,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: `ECS ${name} ${kind} 85% 15분 (중간)` }), normal);
      }
    }

    // ---- RDS ----
    const db = props.db;
    alarm(db.metricCPUUtilization({ period: m5 }).createAlarm(this, 'DbCpu', { alarmName: `alm-${env}-db-cpu`, threshold: 80, evaluationPeriods: 3,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'RDS CPU 80% 15분 (중간)' }), normal);
    alarm(db.metricFreeStorageSpace({ period: m5 }).createAlarm(this, 'DbStorage', { alarmName: `alm-${env}-db-storage`,
      threshold: cfg.db.allocatedGb * 0.15 * 1024 ** 3, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: '여유 스토리지 15% 미만(최초 할당 기준) (중간)' }), normal);
    const maxConn = Math.floor(((DB_MEMORY_GIB[cfg.db.instanceClass] ?? 4) * 1024 ** 3) / 9531392);
    alarm(db.metricDatabaseConnections({ period: m5 }).createAlarm(this, 'DbConnections', { alarmName: `alm-${env}-db-connections`,
      threshold: Math.floor(maxConn * 0.8), evaluationPeriods: 2, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: `연결 수 80%(max_connections 약 ${maxConn}) (중간)` }), normal);
    new events.Rule(this, 'DbEvents', {
      ruleName: `alm-${env}-rds-events`, description: 'RDS 장애 조치·재부팅 (높음)',
      eventPattern: { source: ['aws.rds'], detailType: ['RDS DB Instance Event'],
        detail: { SourceIdentifier: [`alm-${env}`], EventCategories: ['failover', 'failure', 'availability'] } },
      targets: [new eventTargets.SnsTopic(this.highTopic)],
    });

    // ---- SQS ----
    alarm(props.jobsDlq.metricApproximateNumberOfMessagesVisible({ period: m5, statistic: 'Maximum' }).createAlarm(this, 'Dlq', {
      alarmName: `alm-${env}-jobs-dlq`, threshold: 1, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'DLQ 메시지 1건 이상 (중간)' }), normal);
    alarm(props.jobsQueue.metricApproximateAgeOfOldestMessage({ period: m5, statistic: 'Maximum' }).createAlarm(this, 'QueueAge', {
      alarmName: `alm-${env}-jobs-age`, threshold: 900, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: '가장 오래된 메시지 15분 초과 (중간)' }), normal);

    // ---- SAP 연계: sap-watch 작업이 연결별 실행 달력을 반영해 ALM/SapOverdue·SapPostingFailed를 낸다(앱 EMF) ----
    const appMetric = (name: string, stat = 'Sum', period = Duration.minutes(15)) =>
      new cw.Metric({ namespace: 'ALM', metricName: name, dimensionsMap: { Env: env }, statistic: stat, period });
    for (const [id, name, desc] of [['SapOverdue', 'SapOverdue', 'SAP 잡 호출 지연(전기 30분·마스터 예정+2시간) (높음)'],
      ['SapPostingFailed', 'SapPostingFailed', 'SAP 전기 실패 건 발생 (높음)']] as const) {
      alarm(appMetric(name).createAlarm(this, id, { alarmName: `alm-${env}-${name.replace(/([A-Z])/g, (c, _, i) => (i ? '-' : '') + c.toLowerCase())}`,
        threshold: 1, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: desc }), high);
    }

    // ---- 보안 ----
    alarm(appMetric('SapAuthFailed', 'Sum', Duration.hours(1)).createAlarm(this, 'SapAuthFailed', { alarmName: `alm-${env}-sap-auth-failed`,
      threshold: 5, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'SAP_AUTH_FAILED 1시간 5회 (높음)' }), high);
    const wafBlocked = new cw.Metric({ namespace: 'AWS/WAFV2', metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: props.webAclName, Rule: 'ALL' }, statistic: 'Sum', period: m5 });
    alarm(wafBlocked.createAlarm(this, 'WafSpike', { alarmName: `alm-${env}-waf-blocked`, threshold: 500, evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'WAF 차단 급증(5분 500건) (높음)' }), high);
    new events.Rule(this, 'GuardDutyHigh', { ruleName: `alm-${env}-guardduty-high`, description: 'GuardDuty 높음 등급 (높음)',
      eventPattern: { source: ['aws.guardduty'], detailType: ['GuardDuty Finding'], detail: { severity: [{ numeric: ['>=', 7] }] } as any },
      targets: [new eventTargets.SnsTopic(this.highTopic)] });
    new events.Rule(this, 'RootLogin', { ruleName: `alm-${env}-root-login`, description: '루트 사용자 로그인 (높음)',
      eventPattern: { detailType: ['AWS Console Sign In via CloudTrail'], detail: { userIdentity: { type: ['Root'] } } },
      targets: [new eventTargets.SnsTopic(this.highTopic)] });

    // ---- 인증서 만료 30일 전 ----
    props.certificates.forEach((c, i) => alarm(c.metricDaysToExpiry({ period: Duration.days(1) }).createAlarm(this, `CertExpiry${i}`, {
      alarmName: `alm-${env}-cert-expiry-${i}`, threshold: 30, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'ACM 인증서 만료 30일 전 (중간)' }), normal));

    // ---- 비용: 월 예산 80%·100% (낮음) ----
    new budgets.CfnBudget(this, 'Budget', {
      budget: { budgetName: `alm-${env}-monthly`, budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: 'USD' } },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'SNS', address: this.normalTopic.topicArn }],
      })),
    });

    // ---- 외형 감시(9.4): 5분마다 /api/v1/health 와 로그인 화면 ----
    const appUrl = `https://${fqdn(cfg.appHost)}`;
    const canaryBucket = new s3.Bucket(this, 'CanaryArtifacts', {
      bucketName: `alm-${env}-canary-${this.account}`, enforceSSL: true, encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    const canary = new synthetics.Canary(this, 'Canary', {
      canaryName: `alm-${env}-health`,
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_9_1,
      // 야간 정지 환경은 평일 업무시간(UTC 11~23시 ≈ 동부 07~19시)만 돈다
      schedule: cfg.nightlyStop ? synthetics.Schedule.cron({ minute: '0/5', hour: '11-23', weekDay: 'MON-FRI' }) : synthetics.Schedule.rate(m5),
      artifactsBucketLocation: { bucket: canaryBucket },
      test: synthetics.Test.custom({ handler: 'index.handler', code: synthetics.Code.fromInline(CANARY_SCRIPT) }),
      environmentVariables: { APP_URL: appUrl },
      successRetentionPeriod: Duration.days(7), failureRetentionPeriod: Duration.days(30),
    });
    alarm(canary.metricSuccessPercent({ period: Duration.minutes(15) }).createAlarm(this, 'CanaryAlarm', {
      alarmName: `alm-${env}-canary`, threshold: 100, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: '카나리아 실패(15분 내) (높음)' }), availability);

    // ---- pgaudit 10년 보관(9.1): RDS 로그 → 구독 필터(AUDIT:) → Firehose → log-archive 감사 버킷 ----
    const fhRole = new iam.Role(this, 'PgauditFirehoseRole', { roleName: `alm-${env}-pgaudit-firehose`,
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', { conditions: { StringEquals: { 'sts:ExternalId': this.account } } }) });
    fhRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetBucketLocation', 's3:ListBucket', 's3:AbortMultipartUpload', 's3:ListBucketMultipartUploads'],
      resources: [`arn:aws:s3:::${AUDIT_BUCKET}`, `arn:aws:s3:::${AUDIT_BUCKET}/${env}/pgaudit/*`] }));
    fhRole.addToPolicy(new iam.PolicyStatement({ actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [`arn:aws:kms:${ORG.region}:${ORG.accounts.logArchive}:key/*`],
      conditions: { 'ForAnyValue:StringLike': { 'kms:ResourceAliases': 'alias/alm/audit' } } }));
    const fhLogs = new logs.LogGroup(this, 'PgauditFirehoseLogs', { logGroupName: `/alm/${env}/firehose-pgaudit`,
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const fhStream = new logs.LogStream(this, 'PgauditFirehoseStream', { logGroup: fhLogs, logStreamName: 'S3Delivery' });
    fhLogs.grantWrite(fhRole);
    const stream = new firehose.CfnDeliveryStream(this, 'PgauditStream', {
      deliveryStreamName: `alm-${env}-pgaudit`, deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
      extendedS3DestinationConfiguration: {
        bucketArn: `arn:aws:s3:::${AUDIT_BUCKET}`, roleArn: fhRole.roleArn,
        prefix: `${env}/pgaudit/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/`, errorOutputPrefix: `${env}/pgaudit-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/`,
        compressionFormat: 'GZIP', bufferingHints: { intervalInSeconds: 300, sizeInMBs: 64 },
        cloudWatchLoggingOptions: { enabled: true, logGroupName: fhLogs.logGroupName, logStreamName: fhStream.logStreamName },
      },
    });
    stream.node.addDependency(fhRole);
    const cwlRole = new iam.Role(this, 'PgauditSubscriptionRole', { assumedBy: new iam.ServicePrincipal(`logs.amazonaws.com`, {
      conditions: { StringLike: { 'aws:SourceArn': `arn:aws:logs:${this.region}:${this.account}:*` } } }) });
    cwlRole.addToPolicy(new iam.PolicyStatement({ actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'], resources: [stream.attrArn] }));
    new logs.CfnSubscriptionFilter(this, 'PgauditFilter', {
      logGroupName: `/aws/rds/instance/alm-${env}/postgresql`, filterPattern: '"AUDIT:"',
      destinationArn: stream.attrArn, roleArn: cwlRole.roleArn,
    }).node.addDependency(cwlRole);

    // ---- 대시보드(9.4) ----
    const dash = new cw.Dashboard(this, 'Dashboard', { dashboardName: `alm-${env}`, defaultInterval: Duration.hours(6) });
    dash.addWidgets(
      new cw.GraphWidget({ title: '요청 수', left: [requests], width: 8 }),
      new cw.GraphWidget({ title: '5xx 비율(%)', left: [err5xx], width: 8 }),
      new cw.GraphWidget({ title: '응답 시간 p95(초)', left: [p95], width: 8 }),
    );
    dash.addWidgets(
      new cw.GraphWidget({ title: 'ECS CPU·메모리(%)', width: 8, left: [props.apiService.metricCpuUtilization(), props.apiService.metricMemoryUtilization(),
        props.workerService.metricCpuUtilization(), props.workerService.metricMemoryUtilization()] }),
      new cw.GraphWidget({ title: 'RDS CPU(%)·연결', width: 8, left: [db.metricCPUUtilization()], right: [db.metricDatabaseConnections()] }),
      new cw.GraphWidget({ title: 'SQS 적체', width: 8, left: [props.jobsQueue.metricApproximateNumberOfMessagesVisible(), props.jobsDlq.metricApproximateNumberOfMessagesVisible()],
        right: [props.jobsQueue.metricApproximateAgeOfOldestMessage()] }),
    );
    dash.addWidgets(
      new cw.GraphWidget({ title: 'SAP 연계', width: 8, left: [appMetric('SapOverdue'), appMetric('SapPostingFailed'), appMetric('SapAuthFailed')] }),
      new cw.GraphWidget({ title: 'WAF 차단', width: 8, left: [wafBlocked] }),
      new cw.GraphWidget({ title: '테넌트별 요청(ALM/Requests)', width: 8, left: [new cw.MathExpression({ label: 'tenant',
        expression: `SEARCH('{ALM,Env,TenantId} MetricName="Requests" Env="${env}"', 'Sum', 300)`, period: m5 })] }),
    );
    dash.addWidgets(new cw.AlarmStatusWidget({ title: '알람 상태', width: 24, alarms: this.node.findAll()
      .filter((c): c is cw.Alarm => c instanceof cw.Alarm) }));
  }
}

const CANARY_SCRIPT = `
const synthetics = require('Synthetics');
exports.handler = async () => {
  const base = process.env.APP_URL;
  const page = await synthetics.getPage();
  for (const [step, path] of [['health', '/api/v1/health'], ['login', '/login']]) {
    await synthetics.executeStep(step, async () => {
      const resp = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || resp.status() !== 200) throw new Error(step + ' ' + (resp && resp.status()));
    });
  }
};
`;
