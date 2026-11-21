import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput, Fn, Tags, TimeZone, SecretValue } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import { AUDIT_BUCKET, ORG } from './config';
import { ALB_PRIORITY, OWNER_DB_USER, PRODUCT, PRODUCT_HEADER, SuiteEnvConfig, paramName, suitePrefix } from './suite-config';

const CONTAINER_PORT = 3000;

// 공유 플랫폼 위의 ALM(통합 WBS 5.4). 플랫폼이 가진 것(네트워크·RDS·Valkey·클러스터·ALB·CloudFront·WAF·발신 도메인·야간 정지)은 SSM 파라미터로 참조하고,
// ALM 것만 만든다: api·worker 서비스, migrate·partman·audit-archive 태스크, ALB 규칙(제품 헤더), 파일 버킷, 큐, 일정, 비밀, 로그, 제품 알람.
// 웹 인증은 플랫폼 통행증(SUITE_AUTH=1). PDA·SAP·Portal 채널은 토큰 그대로다(모두 새 중앙 ID 풀 — SAP은 2026-11-16부터).
// 감사 보관(audit-archive)은 전용 환경과 같은 보관 버킷·같은 <env>/ 접두사를 쓴다. 온라인 13개월이 지난 파티션만 올리므로 전용 환경을 내리기(5.8) 전에는 올릴 것이 없다.
export class SuiteAlmStack extends Stack {
  constructor(scope: Construct, id: string, cfg: SuiteEnvConfig, props: StackProps) {
    super(scope, id, props);
    const sp = suitePrefix(cfg.name), p = `${sp}-${PRODUCT}`;
    const P = (key: string) => ssm.StringParameter.valueForStringParameter(this, paramName(cfg.name, key));
    const appOrigin = `https://${cfg.appDomain}`;
    const removal = RemovalPolicy.DESTROY;   // 지금은 dev만. 다른 환경을 더할 때 정한다

    // ---- 플랫폼 자원 참조 ----
    const subnetIds = ssm.StringListParameter.valueForTypedListParameter(this, paramName(cfg.name, 'app-subnet-ids'), ssm.ParameterValueType.AWS_EC2_SUBNET_ID);
    const appSubnetIds = cfg.azs.map((_, i) => Fn.select(i, subnetIds));
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', { vpcId: P('vpc-id'), availabilityZones: cfg.azs, privateSubnetIds: appSubnetIds });
    const subnets = { subnets: appSubnetIds.map((sid, i) => ec2.Subnet.fromSubnetAttributes(this, `AppSubnet${i}`, { subnetId: sid, availabilityZone: cfg.azs[i] })) };
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', { clusterName: sp, vpc, securityGroups: [] });
    const albSgId = P('alb-security-group-id'), dbSgId = P('db-security-group-id'), cacheSgId = P('cache-security-group-id');
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'Listener', { listenerArn: P('alb-listener-arn'),
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, 'AlbSg', albSgId, { mutable: false }) });
    const dataKey = kms.Key.fromKeyArn(this, 'DataKey', P('data-key-arn'));   // 로그 그룹(/suite/<env>/…) 암호화

    // ---- 버킷·큐 ----
    const filesBucket = new s3.Bucket(this, 'Files', { bucketName: `${p}-files-${this.account}`, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: s3.Bucket.fromBucketName(this, 'AccessLogs', P('access-logs-bucket')), serverAccessLogsPrefix: `${PRODUCT}-files/`,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(7) }],
      // 화면이 미리 서명된 주소로 바로 올리고 받는다
      cors: [{ allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT], allowedOrigins: [appOrigin], allowedHeaders: ['*'], exposedHeaders: ['ETag'], maxAge: 3000 }],
      removalPolicy: removal, autoDeleteObjects: false });
    const queue = (id: string, name: string, dlq?: sqs.Queue, visibility?: Duration) => new sqs.Queue(this, id, { queueName: `${p}-${name}`, encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true, ...(dlq ? { deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } } : { retentionPeriod: Duration.days(14) }), ...(visibility ? { visibilityTimeout: visibility } : {}) });
    const jobsDlq = queue('JobsDlq', 'jobs-dlq');
    const jobsQueue = queue('Jobs', 'jobs', jobsDlq, Duration.minutes(5));
    // 중앙 ID 변경 이벤트(SNS, 같은 계정) → 이 큐(원문 전달) → worker가 사용자·역할 미러 갱신
    const identityEvents = queue('IdentityEvents', 'identity-events', jobsDlq);
    sns.Topic.fromTopicArn(this, 'IdentityTopic', P('id-events-topic-arn')).addSubscription(new subs.SqsSubscription(identityEvents, { rawMessageDelivery: true }));

    // ---- 시스템 메일: 발신 도메인은 플랫폼 것(app 영역), 구성 세트·반송 이벤트는 ALM 것 ----
    const sesEvents = queue('SesEvents', 'ses-events', jobsDlq);
    const sesKey = new kms.Key(this, 'SesEventsKey', { alias: `suite/${cfg.name}/${PRODUCT}/ses-events`, enableKeyRotation: true, removalPolicy: removal });
    sesKey.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'], resources: ['*'], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }));
    const sesTopic = new sns.Topic(this, 'SesTopic', { topicName: `${p}-ses-events`, masterKey: sesKey, enforceSSL: true });
    sesTopic.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
      actions: ['sns:Publish'], resources: [sesTopic.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }));
    sesTopic.addSubscription(new subs.SqsSubscription(sesEvents, { rawMessageDelivery: true }));
    const configSet = new ses.ConfigurationSet(this, 'ConfigSet', { configurationSetName: p, reputationMetrics: true, suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS });
    configSet.addEventDestination('Bounces', { destination: ses.EventDestination.snsTopic(sesTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT] });

    // ---- 비밀: 새 중앙 ID의 ALM 클라이언트(값은 배포 뒤에 넣는다 — README '공유 플랫폼 배포'). 전용 환경의 alm/<env>/central-id와 다른 이름 ----
    const centralId = new secrets.Secret(this, 'CentralId', { secretName: `${PRODUCT}/${cfg.name}/suite-central-id`, description: 'Central ID clients for ALM on suite (alm-backend, alm-pda)',
      secretObjectValue: Object.fromEntries(['pdaClientId', 'backendClientId', 'backendClientSecret'].map((k) => [k, SecretValue.unsafePlainText('PENDING')])) });

    const repo = ecr.Repository.fromRepositoryAttributes(this, 'Repo', { repositoryName: ORG.ecrRepositoryName,
      repositoryArn: `arn:aws:ecr:${ORG.region}:${ORG.accounts.shared}:repository/${ORG.ecrRepositoryName}` });
    const image = ecs.ContainerImage.fromEcrRepository(repo, cfg.imageTag);

    // ---- 보안 그룹: ALB → api, 작업 → 공유 RDS·Valkey(규칙은 이 스택이 플랫폼 보안 그룹에 더한다) ----
    const sg = (id: string, description: string) => new ec2.SecurityGroup(this, id, { vpc, description });
    const apiSg = sg('ApiSg', 'ALM api tasks (suite)'), workerSg = sg('WorkerSg', 'ALM worker tasks (suite)');
    const migrateSg = sg('MigrateSg', 'ALM migrate task (suite)'), archiveSg = sg('ArchiveSg', 'ALM partman task (suite)');
    new ec2.CfnSecurityGroupEgress(this, 'AlbToApi', { groupId: albSgId, ipProtocol: 'tcp', fromPort: CONTAINER_PORT, toPort: CONTAINER_PORT,
      destinationSecurityGroupId: apiSg.securityGroupId, description: 'suite ALB to alm api' });
    for (const [g, n] of [[apiSg, 'Api'], [workerSg, 'Worker'], [migrateSg, 'Migrate'], [archiveSg, 'Archive']] as const)
      new ec2.CfnSecurityGroupIngress(this, `DbFrom${n}`, { groupId: dbSgId, ipProtocol: 'tcp', fromPort: 5432, toPort: 5432,
        sourceSecurityGroupId: g.securityGroupId, description: `postgres from alm ${n.toLowerCase()}` });
    for (const [g, n] of [[apiSg, 'Api'], [workerSg, 'Worker']] as const)
      new ec2.CfnSecurityGroupIngress(this, `CacheFrom${n}`, { groupId: cacheSgId, ipProtocol: 'tcp', fromPort: 6379, toPort: 6379,
        sourceSecurityGroupId: g.securityGroupId, description: `valkey from alm ${n.toLowerCase()}` });

    const cacheUser = `${sp}-${PRODUCT}`;
    const commonEnv: Record<string, string> = {
      NODE_ENV: 'production', ALM_ENV: cfg.name, AWS_REGION: this.region,
      DB_HOST: P('db-host'), DB_PORT: P('db-port'), DB_NAME: PRODUCT,
      SUITE_MODE: '1',   // DB 소유자가 RDS 마스터가 아니다(확장·이벤트 트리거는 플랫폼이 만든다)
      // 웹 인증: 플랫폼 통행증. 공개 키는 중앙 ID에서 직접 읽는다(CloudFront·WAF를 거치지 않는다)
      SUITE_AUTH: '1', SUITE_ORIGIN: appOrigin, SUITE_JWKS_URL: `${cfg.idApiUrl}/auth/jwks.json`,
      // PDA·Portal·SAP 토큰 모두 새 중앙 ID 풀(SAP은 중앙 ID의 SAP 연결이 주는 alm/sap.api)
      COGNITO_USER_POOL_ID: P('id-user-pool-id'), COGNITO_DOMAIN: P('id-auth-domain'), CENTRAL_ID_URL: P('id-api-url'), CENTRAL_ID_TOKEN_URL: P('id-token-url'),
      APP_ORIGIN: `${appOrigin}/${PRODUCT}`,   // 메일 링크·화면 주소
      JOBS_QUEUE_URL: jobsQueue.queueUrl, FILES_BUCKET: filesBucket.bucketName,
      CACHE_ENDPOINT: P('cache-endpoint'), CACHE_NAME: P('cache-name'), CACHE_USER: cacheUser, CACHE_KEY_PREFIX: `${PRODUCT}:`,   // 공유 Valkey: 자기 접두어 키만 쓸 수 있다
      SES_CONFIG_SET: configSet.configurationSetName, MAIL_FROM: `no-reply@${cfg.appDomain}`,
      ...(cfg.portal.clientIds ? { PORTAL_CLIENT_IDS: cfg.portal.clientIds, PORTAL_FEED_SCOPE: cfg.portal.feedScope } : {}),
      PORTAL_API_URL: `${appOrigin}/api`, PORTAL_TOKEN_URL: P('id-token-url'), PORTAL_NOTIFY_SCOPE: cfg.portal.notifyScope,
    };
    const dbUserArn = (u: string) => `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${P('db-resource-id')}/${u}`;
    const cacheConnect = new iam.PolicyStatement({ actions: ['elasticache:Connect'],
      resources: [P('cache-arn'), `arn:aws:elasticache:${this.region}:${this.account}:user:${cacheUser}`] });
    const lg = (n: string) => new logs.LogGroup(this, `${n}Logs`, { logGroupName: `/suite/${cfg.name}/${PRODUCT}/${n}`, retention: cfg.logRetentionDays as logs.RetentionDays,
      encryptionKey: dataKey, removalPolicy: removal });
    const makeTask = (name: string, cpu: number, memoryMiB: number, command: string[], dbUser: string) => {
      const td = new ecs.FargateTaskDefinition(this, `${name}Task`, { family: `${p}-${name}`, cpu, memoryLimitMiB: memoryMiB,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
      td.addVolume({ name: 'tmp' });
      const c = td.addContainer('app', { image, command, readonlyRootFilesystem: true, user: '1000',
        environment: { ...commonEnv, APP_ROLE: name, DB_IAM_USER: dbUser }, logging: ecs.LogDrivers.awsLogs({ logGroup: lg(name), streamPrefix: name }),
        portMappings: name === 'api' ? [{ containerPort: CONTAINER_PORT }] : undefined, stopTimeout: Duration.seconds(35) });
      c.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });
      td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbUserArn(dbUser)] }));
      return { td, c };
    };
    const centralSecrets = (c: ecs.ContainerDefinition, o: { pda?: boolean; notify?: boolean } = {}) => {
      if (o.pda) c.addSecret('COGNITO_PDA_CLIENT_ID', ecs.Secret.fromSecretsManager(centralId, 'pdaClientId'));
      c.addSecret('CENTRAL_ID_CLIENT_ID', ecs.Secret.fromSecretsManager(centralId, 'backendClientId'));
      c.addSecret('CENTRAL_ID_CLIENT_SECRET', ecs.Secret.fromSecretsManager(centralId, 'backendClientSecret'));
      if (o.notify) {   // ALM → Portal 알림: 같은 alm-backend 클라이언트
        c.addSecret('PORTAL_NOTIFY_CLIENT_ID', ecs.Secret.fromSecretsManager(centralId, 'backendClientId'));
        c.addSecret('PORTAL_NOTIFY_CLIENT_SECRET', ecs.Secret.fromSecretsManager(centralId, 'backendClientSecret'));
      }
    };

    // api: 통행증 모드 — 쿠키 키·웹 클라이언트 비밀이 없다
    const api = makeTask('api', cfg.api.cpu, cfg.api.memoryMiB, ['node', 'dist/main', 'api'], 'alm_app_login');
    centralSecrets(api.c, { pda: true, notify: true });
    filesBucket.grantReadWrite(api.td.taskRole);
    jobsQueue.grantSendMessages(api.td.taskRole);
    api.td.addToTaskRolePolicy(cacheConnect);

    // worker: 작업 큐·메일 발송·중앙 변경 이벤트·SES 반송 이벤트
    const worker = makeTask('worker', cfg.worker.cpu, cfg.worker.memoryMiB, ['node', 'dist/main', 'worker'], 'alm_app_login');
    centralSecrets(worker.c, { notify: true });
    worker.c.addEnvironment('SES_EVENTS_QUEUE_URL', sesEvents.queueUrl);
    worker.c.addEnvironment('IDENTITY_EVENTS_QUEUE_URL', identityEvents.queueUrl);
    for (const q of [jobsQueue, sesEvents, identityEvents]) q.grantConsumeMessages(worker.td.taskRole);
    filesBucket.grantRead(worker.td.taskRole);
    // 발신 identity만 주면 SES 시험 모드(sandbox)에서 수신자 쪽 identity(예: pasapps.com) 권한이 없어 거부된다 — 기존 ALM 스택과 같이 계정의 identity 전체
    worker.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`,
      `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configSet.configurationSetName}`] }));
    worker.td.addToTaskRolePolicy(cacheConnect);

    // migrate(배포 때 1회 RunTask): ALM DB 소유자(alm_owner)로 IAM 인증 접속 — 마스터 비밀이 없다. 같은 작업 정의로 seed·identity-migrate도 실행
    const migrate = makeTask('migrate', 512, 1024, ['sh', 'scripts/migrate.sh'], OWNER_DB_USER);
    centralSecrets(migrate.c);

    // partman(감사 파티션 관리): 보관 계정이 log_partition_maintain()으로
    const partman = makeTask('partman', 256, 512, ['node', 'dist/main', 'partman'], 'alm_archive_login');
    // audit-archive(월 1회): 보관 계정이 온라인 13개월이 지난 감사 파티션을 log-archive 계정의 감사 버킷(Object Lock 10년)에 올리고 지운다 — 전용 환경과 같은 권한
    const archive = makeTask('audit-archive', 512, 1024, ['node', 'dist/main', 'audit-archive'], 'alm_archive_login');
    archive.c.addEnvironment('AUDIT_BUCKET', AUDIT_BUCKET);
    archive.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
      resources: [`arn:aws:s3:::${AUDIT_BUCKET}`, `arn:aws:s3:::${AUDIT_BUCKET}/${cfg.name}/*`] }));
    archive.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [`arn:aws:kms:${ORG.region}:${ORG.accounts.logArchive}:alias/alm/audit`, `arn:aws:kms:${ORG.region}:${ORG.accounts.logArchive}:key/*`],
      conditions: { 'ForAnyValue:StringLike': { 'kms:ResourceAliases': 'alias/alm/audit' } } }));

    const service = (id: string, name: string, td: ecs.FargateTaskDefinition, desired: number, g: ec2.ISecurityGroup, grace?: Duration) => new ecs.FargateService(this, id, {
      serviceName: `${PRODUCT}-${name}`, cluster, taskDefinition: td, desiredCount: desired, securityGroups: [g], vpcSubnets: subnets, assignPublicIp: false,
      minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: { enable: true, rollback: true }, enableExecuteCommand: cfg.execCommand,
      ...(grace ? { healthCheckGracePeriod: grace } : {}) });
    const apiService = service('ApiService', 'api', api.td, cfg.api.desired, apiSg, Duration.seconds(60));
    const workerService = service('WorkerService', 'worker', worker.td, cfg.worker.desired, workerSg);

    // 공유 ALB 규칙: CloudFront가 붙인 제품 헤더가 alm이고 경로가 /api/* 인 요청만(플랫폼이 /alm 을 떼고 넘긴다. SAP 연동 주소의 /alm/v1/* 도 /api/v1/sap/* 로 온다)
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTg', { vpc, port: CONTAINER_PORT, protocol: elbv2.ApplicationProtocol.HTTP, targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/api/v1/health/live', interval: Duration.seconds(30), healthyThresholdCount: 2, unhealthyThresholdCount: 3 }, deregistrationDelay: Duration.seconds(30) });
    apiService.attachToApplicationTargetGroup(targetGroup);
    new elbv2.ApplicationListenerRule(this, 'ApiRule', { listener, priority: ALB_PRIORITY, targetGroups: [targetGroup],
      conditions: [elbv2.ListenerCondition.httpHeader(PRODUCT_HEADER, [PRODUCT]), elbv2.ListenerCondition.pathPatterns(['/api/*'])] });

    // ---- 예약 작업(전용 환경과 같은 시각, 동부) ----
    const group = new scheduler.ScheduleGroup(this, 'Schedules', { scheduleGroupName: p, removalPolicy: removal });
    const tz = TimeZone.AMERICA_NEW_YORK;
    const job = (id: string, cron: string, type: string) => new scheduler.Schedule(this, id, { schedule: scheduler.ScheduleExpression.cron({ ...parseCron(cron), timeZone: tz }),
      scheduleGroup: group, description: type,
      target: new schedTargets.SqsSendMessage(jobsQueue, { input: scheduler.ScheduleTargetInput.fromObject({ type, source: 'scheduler' }) }) });
    job('ExpiryAlerts', '0 6 * * ? *', 'expiry-alerts');
    job('SapWatch', '0/15 * * * ? *', 'sap-watch');
    job('IdempotencyCleanup', '5 * * * ? *', 'idempotency-cleanup');
    job('DiscoveryCleanup', '0 2 * * ? *', 'discovery-cleanup');
    job('NotificationCleanup', '0 4 1 * ? *', 'notification-cleanup');
    // 야간 정지 환경은 DB가 켜져 있는 시간에(평일 07:30)
    const runTask = (id: string, cron: string, td: ecs.FargateTaskDefinition) => new scheduler.Schedule(this, id, { schedule: scheduler.ScheduleExpression.cron({ ...parseCron(cron), timeZone: tz }),
      scheduleGroup: group, target: new schedTargets.EcsRunFargateTask(cluster, { taskDefinition: td, securityGroups: [archiveSg], vpcSubnets: subnets }) });
    runTask('PartitionMaintenance', cfg.nightlyStop ? '30 7 ? * MON-FRI *' : '30 2 * * ? *', partman.td);
    runTask('AuditArchive', cfg.nightlyStop ? '0 8 ? * MON#1 *' : '0 3 1 * ? *', archive.td);   // 첫 월요일 08시 / 매월 1일 03시

    // ---- 자동 확장: 야간 정지가 없는 환경에서만(플랫폼 야간 정지가 서비스 수를 0으로 내리므로 함께 쓰면 서로 되돌린다) ----
    if (!cfg.nightlyStop && cfg.api.max > cfg.api.desired)
      apiService.autoScaleTaskCount({ minCapacity: cfg.api.desired, maxCapacity: cfg.api.max }).scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });
    if (!cfg.nightlyStop && cfg.worker.max > cfg.worker.desired)
      workerService.autoScaleTaskCount({ minCapacity: cfg.worker.desired, maxCapacity: cfg.worker.max }).scaleOnMetric('QueueAge', {
        metric: jobsQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
        scalingSteps: [{ upper: 60, change: 0 }, { lower: 60, change: +1 }, { lower: 300, change: +2 }] });

    // ---- 제품 알람 → 플랫폼 알람 주제(공용 ALB·RDS·Valkey·CloudFront 알람은 플랫폼에 있다) ----
    const alertAction = new cwActions.SnsAction(sns.Topic.fromTopicArn(this, 'AlarmTopic', P('alarm-topic-arn')));
    const m5 = Duration.minutes(5);
    const alarm = (id: string, name: string, metric: cw.IMetric, threshold: number, desc: string,
      o: { periods?: number; op?: cw.ComparisonOperator; missing?: cw.TreatMissingData; notify?: boolean } = {}) => {
      const a = new cw.Alarm(this, id, { alarmName: `${p}-${name}`, metric, threshold, evaluationPeriods: o.periods ?? 1,
        comparisonOperator: o.op ?? cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: o.missing ?? cw.TreatMissingData.NOT_BREACHING, alarmDescription: desc });
      if (o.notify !== false) { a.addAlarmAction(alertAction); a.addOkAction(alertAction); }
      return a;
    };
    // 대상 그룹 지표(공용 ALB 차원 + 이 제품의 대상 그룹)
    const tgMetric = (metricName: string, statistic: string, period = m5) => new cw.Metric({ namespace: 'AWS/ApplicationELB', metricName, statistic, period,
      dimensionsMap: { LoadBalancer: P('alb-full-name'), TargetGroup: targetGroup.targetGroupFullName } });
    alarm('Api5xx', 'api-5xx', new cw.MathExpression({ label: '5xx %', period: m5, expression: '100 * FILL(t5,0) / IF(req > 0, req, 1)',
      usingMetrics: { req: tgMetric('RequestCount', 'Sum'), t5: tgMetric('HTTPCode_Target_5XX_Count', 'Sum') } }), 2, 'ALM API 5xx 비율 5분간 2% 이상');
    alarm('ApiLatency', 'api-p95', tgMetric('TargetResponseTime', 'p95'), 2, 'ALM API 응답 p95 5분간 2초 이상');
    // 야간 정지 환경은 밤마다 정상 대상이 0이 된다 → 알림 없이 상태만 둔다
    alarm('ApiHealthy', 'api-healthy', tgMetric('HealthyHostCount', 'Minimum', Duration.minutes(1)), 1, 'ALM API 정상 대상 수 1 미만 3분',
      { periods: 3, op: cw.ComparisonOperator.LESS_THAN_THRESHOLD, missing: cw.TreatMissingData.BREACHING, notify: !cfg.nightlyStop });
    for (const [name, svc] of [['api', apiService], ['worker', workerService]] as const)
      for (const [kind, metric] of [['cpu', svc.metricCpuUtilization({ period: m5 })], ['memory', svc.metricMemoryUtilization({ period: m5 })]] as const)
        alarm(`Ecs-${name}-${kind}`, `ecs-${name}-${kind}`, metric, 85, `ALM ${name} ${kind} 85% 이상 15분`, { periods: 3 });
    alarm('Dlq', 'jobs-dlq', jobsDlq.metricApproximateNumberOfMessagesVisible({ period: m5, statistic: 'Maximum' }), 1, 'ALM 작업 DLQ 메시지 1건 이상');
    alarm('QueueAge', 'jobs-age', jobsQueue.metricApproximateAgeOfOldestMessage({ period: m5, statistic: 'Maximum' }), 900, 'ALM 작업 큐 가장 오래된 메시지 15분 이상');
    // SAP 연계(앱 지표, 네임스페이스 ALM·차원 Env — 전용 환경과 같은 이름이다. 전용 환경을 내린 뒤에는 이쪽만 남는다)
    const appMetric = (metricName: string, period = Duration.minutes(15)) => new cw.Metric({ namespace: 'ALM', metricName, dimensionsMap: { Env: cfg.name }, statistic: 'Sum', period });
    alarm('SapOverdue', 'sap-overdue', appMetric('SapOverdue'), 1, 'SAP 잡 호출 지연(전기 30분·마스터 예정+2시간)');
    alarm('SapPostingFailed', 'sap-posting-failed', appMetric('SapPostingFailed'), 1, 'SAP 전기 실패 건 발생');
    alarm('SapAuthFailed', 'sap-auth-failed', appMetric('SapAuthFailed', Duration.hours(1)), 5, 'SAP 인증 실패 1시간 5회 이상');

    Tags.of(this).add('Project', 'Suite'); Tags.of(this).add('Env', cfg.name); Tags.of(this).add('Owner', 'BSG');
    Tags.of(this).add('CostCenter', ORG.costCenter); Tags.of(this).add('Product', PRODUCT);

    // 배포 스크립트(scripts/suite-deploy.sh)가 읽는 값
    new CfnOutput(this, 'ClusterName', { value: sp });
    new CfnOutput(this, 'ApiServiceName', { value: apiService.serviceName });
    new CfnOutput(this, 'WorkerServiceName', { value: workerService.serviceName });
    new CfnOutput(this, 'MigrateFamily', { value: migrate.td.family });
    new CfnOutput(this, 'MigrateSecurityGroupId', { value: migrateSg.securityGroupId });
    new CfnOutput(this, 'AppSubnetIds', { value: Fn.join(',', appSubnetIds) });
    new CfnOutput(this, 'FilesBucketName', { value: filesBucket.bucketName });
    new CfnOutput(this, 'CentralIdSecretName', { value: centralId.secretName });
  }
}

// "m h dom mon dow year" → ScheduleExpression.cron 옵션
function parseCron(expr: string) {
  const [minute, hour, day, month, weekDay, year] = expr.split(' ');
  const o: Record<string, string> = { minute, hour, month, year };
  if (day !== '?') o.day = day;
  if (weekDay !== '?') o.weekDay = weekDay;
  return o;
}
