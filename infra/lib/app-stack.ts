import { Stack, StackProps, Duration, RemovalPolicy, TimeZone } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { EnvConfig, ORG, fqdn, AUDIT_BUCKET, logBucketName } from './config';

export interface AppProps extends StackProps {
  vpc: ec2.IVpc;
  dataKey: kms.IKey;
  db: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  userPool: cognito.IUserPool;
  webClient: cognito.IUserPoolClient;
  pdaClient: cognito.IUserPoolClient;
  webClientSecret: secrets.ISecret;
  cookieKeySecret: secrets.ISecret;
  secretsKey: kms.IKey;
}

const CONTAINER_PORT = 3000;

// 10 정의서 6장: 이미지 1개(api·worker·migrate·audit-archive), 내부 ALB, SQS·Scheduler, Valkey, SES
export class AppStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly appCertificate: acm.Certificate;
  readonly cluster: ecs.Cluster;
  readonly apiService: ecs.FargateService;
  readonly workerService: ecs.FargateService;
  readonly jobsQueue: sqs.Queue;
  readonly jobsDlq: sqs.Queue;
  readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: AppProps) {
    super(scope, id, props);
    const env = cfg.name;
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: ORG.hostedZoneId, zoneName: ORG.domain });
    const appDomain = fqdn(cfg.appHost);
    // Data 스택 버킷은 정해진 이름으로 가져온다(스택 간 참조를 줄이고 IAM 정책 ARN을 고정 문자열로)
    const filesBucket = s3.Bucket.fromBucketAttributes(this, 'FilesRef', { bucketName: `alm-${env}-files-${this.account}`, encryptionKey: props.dataKey });
    const exportsBucket = s3.Bucket.fromBucketAttributes(this, 'ExportsRef', { bucketName: `alm-${env}-exports-${this.account}`, encryptionKey: props.dataKey });

    // ---- 이미지(alm-shared 계정 ECR, 다이제스트 승격) ----
    const repo = ecr.Repository.fromRepositoryAttributes(this, 'Repo', {
      repositoryName: ORG.ecrRepositoryName,
      repositoryArn: `arn:aws:ecr:${ORG.region}:${ORG.accounts.shared}:repository/${ORG.ecrRepositoryName}`,
    });
    const image = ecs.ContainerImage.fromEcrRepository(repo, cfg.imageTag);

    // ---- 큐 ----
    this.jobsDlq = new sqs.Queue(this, 'JobsDlq', { queueName: `alm-${env}-jobs-dlq`, retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true });
    this.jobsQueue = new sqs.Queue(this, 'Jobs', { queueName: `alm-${env}-jobs`, visibilityTimeout: Duration.minutes(5),
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, deadLetterQueue: { queue: this.jobsDlq, maxReceiveCount: 5 } });
    const sesEvents = new sqs.Queue(this, 'SesEvents', { queueName: `alm-${env}-ses-events`, encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true, deadLetterQueue: { queue: this.jobsDlq, maxReceiveCount: 5 } });

    // ---- SES (8.2) ----
    const mailDomain = `mail.${ORG.domain}`;
    new ses.EmailIdentity(this, 'MailIdentity', {
      identity: ses.Identity.publicHostedZone(route53.HostedZone.fromHostedZoneAttributes(this, 'MailZone', { hostedZoneId: ORG.hostedZoneId, zoneName: ORG.domain })),
      mailFromDomain: `bounce.${ORG.domain}`,
    });
    const sesTopic = new sns.Topic(this, 'SesTopic', { topicName: `alm-${env}-ses-events`, masterKey: props.dataKey, enforceSSL: true });
    sesTopic.addSubscription(new subs.SqsSubscription(sesEvents, { rawMessageDelivery: true }));
    const configSet = new ses.ConfigurationSet(this, 'ConfigSet', { configurationSetName: `alm-${env}`, reputationMetrics: true });
    configSet.addEventDestination('Bounces', { destination: ses.EventDestination.snsTopic(sesTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT] });

    // ---- 보안 그룹 ----
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', { vpc: props.vpc, description: 'ALM internal ALB (CloudFront VPC origin only)', allowAllOutbound: false });
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', { vpc: props.vpc, description: 'ALM api tasks' });
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', { vpc: props.vpc, description: 'ALM worker tasks' });
    const migrateSg = new ec2.SecurityGroup(this, 'MigrateSg', { vpc: props.vpc, description: 'ALM migrate task' });
    const archiveSg = new ec2.SecurityGroup(this, 'ArchiveSg', { vpc: props.vpc, description: 'ALM audit-archive task' });
    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc: props.vpc, description: 'ALM Valkey', allowAllOutbound: false });
    this.albSecurityGroup.addEgressRule(apiSg, ec2.Port.tcp(CONTAINER_PORT), 'ALB to api');
    apiSg.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(CONTAINER_PORT), 'from ALB');
    for (const [sg, n] of [[apiSg, 'api'], [workerSg, 'worker'], [migrateSg, 'migrate'], [archiveSg, 'audit-archive']] as const) {
      // RDS 보안 그룹은 Data 스택 소유 → 순환 참조를 피하려고 이 스택에 규칙 리소스를 만든다
      new ec2.CfnSecurityGroupIngress(this, `DbFrom${n}`, { groupId: props.dbSecurityGroup.securityGroupId, ipProtocol: 'tcp',
        fromPort: 5432, toPort: 5432, sourceSecurityGroupId: sg.securityGroupId, description: `postgres from ${n}` });
    }
    cacheSg.addIngressRule(apiSg, ec2.Port.tcp(6379), 'valkey from api');
    cacheSg.addIngressRule(workerSg, ec2.Port.tcp(6379), 'valkey from worker');

    // ---- Valkey(6.4): 호출 제한 카운터·사용자 상태 캐시. TLS + IAM 인증 사용자 ----
    const cacheName = `alm-${env}`;
    const defaultUser = new elasticache.CfnUser(this, 'CacheDefaultUser', { engine: 'valkey', userId: `alm-${env}-default`, userName: 'default',
      accessString: 'off -@all', noPasswordRequired: true });
    const appUserId = `alm-${env}-app`;
    const appUser = new elasticache.CfnUser(this, 'CacheAppUser', { engine: 'valkey', userId: appUserId, userName: appUserId,
      accessString: 'on ~* +@all -@dangerous', authenticationMode: { Type: 'iam' } });
    const userGroup = new elasticache.CfnUserGroup(this, 'CacheUsers', { engine: 'valkey', userGroupId: `alm-${env}`, userIds: [defaultUser.userId, appUser.userId] });
    userGroup.addResourceDependency(defaultUser); userGroup.addResourceDependency(appUser);
    const cache = new elasticache.CfnServerlessCache(this, 'Cache', {
      serverlessCacheName: cacheName, engine: 'valkey', majorEngineVersion: '8',
      securityGroupIds: [cacheSg.securityGroupId], subnetIds: props.vpc.selectSubnets({ subnetGroupName: 'app' }).subnetIds,
      kmsKeyId: props.dataKey.keyArn, userGroupId: userGroup.userGroupId,
      cacheUsageLimits: { dataStorage: { maximum: 5, unit: 'GB' }, ecpuPerSecond: { maximum: 5000 } },
    });
    cache.addResourceDependency(userGroup);

    // ---- Cognito 관리 Lambda(6.2): SAP 클라이언트 생성·비밀 교체, IdP 등록. 본문은 3.3에서 구현 ----
    const cognitoAdmin = new lambda.Function(this, 'CognitoAdmin', {
      functionName: `alm-${env}-cognito-admin`, runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', timeout: Duration.seconds(30),
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 501, body: 'implemented in WBS 3.3' });"),
      environment: { USER_POOL_ID: props.userPool.userPoolId },
    });
    cognitoAdmin.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:CreateUserPoolClient', 'cognito-idp:UpdateUserPoolClient', 'cognito-idp:DeleteUserPoolClient',
        'cognito-idp:DescribeUserPoolClient', 'cognito-idp:AddUserPoolClientSecret', 'cognito-idp:DeleteUserPoolClientSecret',
        'cognito-idp:ListUserPoolClientSecrets', 'cognito-idp:CreateIdentityProvider', 'cognito-idp:UpdateIdentityProvider',
        'cognito-idp:DescribeIdentityProvider', 'cognito-idp:DeleteIdentityProvider'],
      resources: [props.userPool.userPoolArn],
    }));

    // ---- ECS ----
    this.cluster = new ecs.Cluster(this, 'Cluster', { clusterName: `alm-${env}`, vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED });

    const commonEnv: Record<string, string> = {
      NODE_ENV: 'production', ALM_ENV: env, AWS_REGION: this.region,
      DB_HOST: props.db.dbInstanceEndpointAddress, DB_PORT: props.db.dbInstanceEndpointPort, DB_NAME: 'alm',
      COGNITO_USER_POOL_ID: props.userPool.userPoolId, COGNITO_WEB_CLIENT_ID: props.webClient.userPoolClientId,
      COGNITO_PDA_CLIENT_ID: props.pdaClient.userPoolClientId, COGNITO_DOMAIN: fqdn(cfg.authHost),
      APP_ORIGIN: `https://${appDomain}`, JOBS_QUEUE_URL: this.jobsQueue.queueUrl,
      FILES_BUCKET: filesBucket.bucketName, EXPORTS_BUCKET: exportsBucket.bucketName,
      CACHE_ENDPOINT: cache.attrEndpointAddress, CACHE_USER: appUserId, SES_CONFIG_SET: configSet.configurationSetName,
      MAIL_FROM: `no-reply@${mailDomain}`, COGNITO_ADMIN_FUNCTION: cognitoAdmin.functionName,
    };
    const dbUserArn = (user: string) => `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${props.db.instanceResourceId}/${user}`;
    const cacheConnect = new iam.PolicyStatement({ actions: ['elasticache:Connect'],
      resources: [cache.attrArn, `arn:aws:elasticache:${this.region}:${this.account}:user:${appUserId}`] });

    const makeTask = (name: string, cpu: number, memoryMiB: number, command: string[], dbUser: string, logGroup: logs.LogGroup) => {
      const td = new ecs.FargateTaskDefinition(this, `${name}Task`, { family: `alm-${env}-${name}`, cpu, memoryLimitMiB: memoryMiB,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
      td.addVolume({ name: 'tmp' });
      const c = td.addContainer('app', {
        image, command, readonlyRootFilesystem: true, user: '1000',
        environment: { ...commonEnv, APP_ROLE: name, DB_IAM_USER: dbUser },
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }),
        portMappings: name === 'api' ? [{ containerPort: CONTAINER_PORT }] : undefined,
        stopTimeout: Duration.seconds(35),
      });
      c.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });
      td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbUserArn(dbUser)] }));
      return { td, c };
    };
    const lg = (n: string) => new logs.LogGroup(this, `${n}Logs`, { logGroupName: `/alm/${env}/${n}`, retention: cfg.logRetentionDays as logs.RetentionDays,
      encryptionKey: props.dataKey, removalPolicy: env === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY });

    // api
    const api = makeTask('api', cfg.api.cpu, cfg.api.memoryMiB, ['node', 'dist/main', 'api'], 'alm_app_login', lg('api'));
    api.c.addSecret('COOKIE_KEY', ecs.Secret.fromSecretsManager(props.cookieKeySecret));
    api.c.addSecret('COGNITO_WEB_CLIENT_SECRET', ecs.Secret.fromSecretsManager(props.webClientSecret, 'clientSecret'));
    api.td.obtainExecutionRole().addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [props.secretsKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } } }));
    filesBucket.grantReadWrite(api.td.taskRole);
    exportsBucket.grantRead(api.td.taskRole);
    this.jobsQueue.grantSendMessages(api.td.taskRole);
    cognitoAdmin.grantInvoke(api.td.taskRole);
    api.td.addToTaskRolePolicy(cacheConnect);

    // worker
    const worker = makeTask('worker', cfg.worker.cpu, cfg.worker.memoryMiB, ['node', 'dist/main', 'worker'], 'alm_app_login', lg('worker'));
    this.jobsQueue.grantConsumeMessages(worker.td.taskRole);
    sesEvents.grantConsumeMessages(worker.td.taskRole);
    filesBucket.grantRead(worker.td.taskRole);
    exportsBucket.grantReadWrite(worker.td.taskRole);
    worker.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`, `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configSet.configurationSetName}`] }));
    worker.td.addToTaskRolePolicy(cacheConnect);

    // migrate(배포 때 1회 RunTask) — 소유자 로그인. 시작 스크립트가 IAM 토큰으로 URL을 만든다
    makeTask('migrate', 512, 1024, ['sh', 'scripts/migrate.sh'], 'alm_owner_iam', lg('migrate'));

    // audit-archive(월 1회 Scheduler RunTask) — 보관 계정 로그인, log-archive 감사 버킷 쓰기
    const archive = makeTask('audit-archive', 512, 1024, ['node', 'dist/main', 'audit-archive'], 'alm_archive_login', lg('audit-archive'));
    archive.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
      resources: [`arn:aws:s3:::${AUDIT_BUCKET}`, `arn:aws:s3:::${AUDIT_BUCKET}/${env}/*`] }));
    archive.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [`arn:aws:kms:${ORG.region}:${ORG.accounts.logArchive}:alias/alm/audit`, `arn:aws:kms:${ORG.region}:${ORG.accounts.logArchive}:key/*`],
      conditions: { 'ForAnyValue:StringLike': { 'kms:ResourceAliases': 'alias/alm/audit' } } }));

    const appSubnets = { subnetGroupName: 'app' };
    this.apiService = new ecs.FargateService(this, 'ApiService', {
      serviceName: 'api', cluster: this.cluster, taskDefinition: api.td, desiredCount: cfg.api.desired,
      securityGroups: [apiSg], vpcSubnets: appSubnets, assignPublicIp: false,
      minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: cfg.execCommand, healthCheckGracePeriod: Duration.seconds(60),
    });
    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      serviceName: 'worker', cluster: this.cluster, taskDefinition: worker.td, desiredCount: cfg.worker.desired,
      securityGroups: [workerSg], vpcSubnets: appSubnets, assignPublicIp: false,
      minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: cfg.execCommand,
    });

    // ---- 내부 ALB(VPC 오리진) ----
    this.appCertificate = new acm.Certificate(this, 'AppCert', { domainName: appDomain, validation: acm.CertificateValidation.fromDns(zone) });
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { loadBalancerName: `alm-${env}`, vpc: props.vpc, internetFacing: false,
      vpcSubnets: appSubnets, securityGroup: this.albSecurityGroup, dropInvalidHeaderFields: true, idleTimeout: Duration.seconds(60) });
    this.alb.logAccessLogs(s3.Bucket.fromBucketName(this, 'AlbLogs', logBucketName(env)), 'alb');
    const listener = this.alb.addListener('Https', { port: 443, protocol: elbv2.ApplicationProtocol.HTTPS, certificates: [this.appCertificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, open: false, defaultAction: elbv2.ListenerAction.fixedResponse(404) });
    this.targetGroup = listener.addTargets('Api', {
      port: CONTAINER_PORT, protocol: elbv2.ApplicationProtocol.HTTP, targets: [this.apiService],
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])], priority: 10,
      healthCheck: { path: '/api/v1/health/live', interval: Duration.seconds(30), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      deregistrationDelay: Duration.seconds(30),
    });

    // ---- 확장(6.1) ----
    const apiScale = this.apiService.autoScaleTaskCount({ minCapacity: cfg.api.desired, maxCapacity: cfg.api.max });
    apiScale.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });
    apiScale.scaleOnRequestCount('Requests', { requestsPerTarget: 1000, targetGroup: this.targetGroup });
    const workerScale = this.workerService.autoScaleTaskCount({ minCapacity: cfg.worker.desired, maxCapacity: cfg.worker.max });
    workerScale.scaleOnMetric('QueueAge', { metric: this.jobsQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
      scalingSteps: [{ upper: 60, change: 0 }, { lower: 60, change: +1 }, { lower: 300, change: +2 }], adjustmentType: undefined });

    // ---- 예약 작업(6.3) ----
    const group = new scheduler.ScheduleGroup(this, 'Schedules', { scheduleGroupName: `alm-${env}` });
    const tz = 'America/New_York';
    const tzObj = TimeZone.AMERICA_NEW_YORK;
    const cronTz = (id: string, cron: string, type: string) => new scheduler.Schedule(this, id, {
      schedule: scheduler.ScheduleExpression.cron({ ...parseCron(cron), timeZone: tzObj }),
      scheduleGroup: group, description: type,
      target: new schedTargets.SqsSendMessage(this.jobsQueue, { input: scheduler.ScheduleTargetInput.fromObject({ type, source: 'scheduler' }) }),
    });
    cronTz('ExpiryAlerts', '0 6 * * ? *', 'expiry-alerts');
    cronTz('SapWatch', '0/15 * * * ? *', 'sap-watch');
    cronTz('IdempotencyCleanup', '5 * * * ? *', 'idempotency-cleanup');
    cronTz('DiscoveryCleanup', '0 2 * * ? *', 'discovery-cleanup');
    cronTz('NotificationCleanup', '0 4 1 * ? *', 'notification-cleanup');
    const runTask = (id: string, cron: string, td: ecs.FargateTaskDefinition, sg: ec2.ISecurityGroup) => new scheduler.Schedule(this, id, {
      schedule: scheduler.ScheduleExpression.cron({ ...parseCron(cron), timeZone: tzObj }),
      scheduleGroup: group,
      target: new schedTargets.EcsRunFargateTask(this.cluster, { taskDefinition: td, securityGroups: [sg], vpcSubnets: appSubnets }),
    });
    runTask('AuditArchive', '0 3 1 * ? *', archive.td, archiveSg);
    // 파티션 관리: 업무 로그 테이블은 소유자, audit_log는 보관 계정으로 각각 run_maintenance
    const partman = makeTask('partman', 256, 512, ['node', 'dist/main', 'partman'], 'alm_archive_login', lg('partman'));
    partman.td.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: [dbUserArn('alm_owner_iam')] }));
    runTask('PartitionMaintenance', '30 2 * * ? *', partman.td, archiveSg);

    // DEV·QA 야간 정지(A-10): ECS desired 0 / 복구. RDS 정지·시작은 Scheduler 범용 대상(SDK 호출)
    if (cfg.nightlyStop) {
      const nightly = new iam.Role(this, 'NightlyRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
      nightly.addToPolicy(new iam.PolicyStatement({ actions: ['ecs:UpdateService'], resources: [this.apiService.serviceArn, this.workerService.serviceArn] }));
      nightly.addToPolicy(new iam.PolicyStatement({ actions: ['rds:StopDBInstance', 'rds:StartDBInstance'], resources: [props.db.instanceArn] }));
      const sdk = (id: string, cron: string, service: string, action: string, input: object) => new scheduler.CfnSchedule(this, id, {
        groupName: group.scheduleGroupName, flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: `cron(${cron})`, scheduleExpressionTimezone: tz,
        target: { arn: `arn:aws:scheduler:::aws-sdk:${service}:${action}`, roleArn: nightly.roleArn, input: JSON.stringify(input) },
      });
      for (const [svcId, svc, desired] of [['Api', 'api', cfg.api.desired], ['Worker', 'worker', cfg.worker.desired]] as const) {
        sdk(`Stop${svcId}`, '0 20 ? * MON-FRI *', 'ecs', 'updateService', { Cluster: this.cluster.clusterName, Service: svc, DesiredCount: 0 });
        sdk(`Start${svcId}`, '0 7 ? * MON-FRI *', 'ecs', 'updateService', { Cluster: this.cluster.clusterName, Service: svc, DesiredCount: desired });
      }
      sdk('StopDb', '5 20 ? * MON-FRI *', 'rds', 'stopDBInstance', { DbInstanceIdentifier: `alm-${env}` });
      sdk('StartDb', '40 6 ? * MON-FRI *', 'rds', 'startDBInstance', { DbInstanceIdentifier: `alm-${env}` });
    }

    // 9.3 알람에서 쓰는 지표
    new cw.Metric({ namespace: 'ALM', metricName: 'SapOverdue', dimensionsMap: { Env: env } });
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
