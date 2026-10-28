// 중앙 ID 서비스 스택(WBS 3.11). 순서: Dns → Data → Auth → Api → Observability, Ci는 독립
import { Stack, StackProps, CfnOutput, Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as path from 'path';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { ORG } from '../config';
import { IdEnvConfig, idApiDomain, idAuthDomain, idPrefix, ID_SCOPES } from './config';

const removal = (cfg: IdEnvConfig) => (cfg.name === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

// ---- 환경 영역 id[-dev|-qa].pasapps.com. 관리 계정 pasapps.com이 NS로 위임(scripts/identity-setup-dns.sh) ----
export class IdDnsStack extends Stack {
  readonly zone: route53.PublicHostedZone;
  constructor(scope: Construct, id: string, cfg: IdEnvConfig, props: StackProps) {
    super(scope, id, props);
    this.zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: cfg.zoneName, comment: `Identity ${cfg.name} (delegated from ${ORG.domain})` });
    this.zone.applyRemovalPolicy(removal(cfg));
    new CfnOutput(this, 'ZoneId', { value: this.zone.hostedZoneId });
    new CfnOutput(this, 'NameServers', { value: Fn.join(',', this.zone.hostedZoneNameServers!) });
  }
}

// ---- DB: Aurora PostgreSQL 16 Serverless v2, Data API. 격리 서브넷(NAT 없음) — Lambda는 VPC 밖에서 Data API(HTTPS)로만 접근 ----
export class IdDataStack extends Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly key: kms.Key;
  readonly appSecret: secrets.Secret;
  readonly dbName = 'idsvc';   // 'identity'는 Aurora PostgreSQL 예약어라 쓸 수 없다
  // 계정 조회 없이 합성(Aurora 클러스터가 스택 AZ 목록을 읽는다). 계정마다 AZ 이름↔ID 매핑이 다르니 배포 전 확인
  get availabilityZones() { return ['us-east-1a', 'us-east-1b']; }
  constructor(scope: Construct, id: string, cfg: IdEnvConfig, props: StackProps) {
    super(scope, id, props);
    const p = idPrefix(cfg);
    this.key = new kms.Key(this, 'DataKey', { alias: `id/${cfg.name}/data`, enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
      description: `Identity ${cfg.name} Aurora·secrets·logs` });
    this.key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], resources: ['*'],
      conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*` } } }));
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: p, ipAddresses: ec2.IpAddresses.cidr(cfg.vpcCidr), availabilityZones: ['us-east-1a', 'us-east-1b'], natGateways: 0,   // 계정 조회 없이 합성(ALM과 같음)
      subnetConfiguration: [{ name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      restrictDefaultSecurityGroup: true,
    });
    vpc.addFlowLog('FlowLog', { trafficType: ec2.FlowLogTrafficType.REJECT, destination: ec2.FlowLogDestination.toCloudWatchLogs(
      new logs.LogGroup(this, 'FlowLogs', { retention: cfg.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY, encryptionKey: this.key })) });
    // 접속 경로가 Data API뿐이라 인바운드 규칙이 없다
    const sg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Identity Aurora (Data API only, no inbound)', allowAllOutbound: false });
    const params = new rds.ParameterGroup(this, 'Params', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_11 }),
      parameters: { 'rds.force_ssl': '1', log_min_duration_statement: '1000', log_connections: '1', log_disconnections: '1' },
    });
    const instance = { autoMinorVersionUpgrade: true, enablePerformanceInsights: cfg.name === 'prd',
      ...(cfg.name === 'prd' ? { performanceInsightEncryptionKey: this.key } : {}) };
    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: p, defaultDatabaseName: this.dbName,
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_11 }),
      parameterGroup: params, vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, securityGroups: [sg],
      writer: rds.ClusterInstance.serverlessV2('Writer', instance),
      readers: Array.from({ length: cfg.db.readers }, (_, i) => rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, { ...instance, scaleWithWriter: true })),
      serverlessV2MinCapacity: cfg.db.minAcu, serverlessV2MaxCapacity: cfg.db.maxAcu,
      ...(cfg.db.minAcu === 0 ? { serverlessV2AutoPauseDuration: Duration.minutes(5) } : {}),
      enableDataApi: true, iamAuthentication: true,
      credentials: rds.Credentials.fromGeneratedSecret('id_master', { secretName: `id/${cfg.name}/db-master`, encryptionKey: this.key }),
      storageEncrypted: true, storageEncryptionKey: this.key,
      backup: { retention: Duration.days(cfg.db.backupDays), preferredWindow: '07:00-08:00' },   // 02:00~03:00 ET
      preferredMaintenanceWindow: 'sun:08:30-sun:09:30',
      cloudwatchLogsExports: ['postgresql'], cloudwatchLogsRetention: cfg.logRetentionDays,
      deletionProtection: cfg.db.deletionProtection, copyTagsToSnapshot: true,
      removalPolicy: cfg.name === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.SNAPSHOT,
    });
    // 앱 계정(id_app, RLS 적용 대상). 역할과 비밀번호는 마이그레이션이 만든다(함수 migrate 동작이 이 값으로 맞춤)
    this.appSecret = new secrets.Secret(this, 'AppSecret', { secretName: `id/${cfg.name}/db-app`, encryptionKey: this.key,
      generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'id_app' }), generateStringKey: 'password',
        passwordLength: 40, excludePunctuation: true, includeSpace: false } });
    new CfnOutput(this, 'ClusterArn', { value: this.cluster.clusterArn });
    new CfnOutput(this, 'MasterSecretArn', { value: this.cluster.secret!.secretArn });
  }
}

// ---- 사용자 풀(새 풀, E-09). 고객사 IdP·제품 앱 클라이언트는 3.12의 관리 API(cognito-admin 이식)가 만든다 ----
export class IdAuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly authCertificate: acm.Certificate;
  readonly resourceServerId = 'id-api';
  constructor(scope: Construct, id: string, cfg: IdEnvConfig, props: StackProps & { zone: route53.IHostedZone }) {
    super(scope, id, props);
    this.userPool = new cognito.UserPool(this, 'Pool', {
      userPoolName: idPrefix(cfg),
      featurePlan: cognito.FeaturePlan.LITE,               // ALM과 같음(S-11). 멀티 뱅크 보안 요건은 E-10에서 풀 분리·플랜 결정
      selfSignUpEnabled: false, signInAliases: { email: true }, accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,                                // 고객사 IdP 정책. 제품별 MFA 요구는 6.6(멀티 뱅크) 때
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      deletionProtection: cfg.name === 'prd', removalPolicy: removal(cfg),
    });
    this.userPool.addResourceServer('Api', { identifier: this.resourceServerId, userPoolResourceServerName: 'Identity API',
      scopes: Object.entries(ID_SCOPES).map(([scopeName, scopeDescription]) => new cognito.ResourceServerScope({ scopeName, scopeDescription })) });
    // 사용자 지정 로그인 도메인은 상위 이름(영역 최상위)의 A 레코드가 먼저 있어야 한다 → Api 스택이 API 별칭 다음에 만든다
    this.authCertificate = new acm.Certificate(this, 'AuthCertificate', { domainName: idAuthDomain(cfg), validation: acm.CertificateValidation.fromDns(props.zone) });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
  }
}

// ---- API: HTTP API + Lambda(services/identity, 3.12). 변경 이벤트 주제(SNS) ----
export class IdApiStack extends Stack {
  readonly fn: lambda.Function;
  readonly api: apigw.HttpApi;
  readonly events: sns.Topic;
  constructor(scope: Construct, id: string, cfg: IdEnvConfig, props: StackProps & {
    zone: route53.IHostedZone; cluster: rds.DatabaseCluster; dbName: string; key: kms.IKey; appSecret: secrets.ISecret;
    userPool: cognito.IUserPool; authCertificate: acm.ICertificate; }) {
    super(scope, id, props);
    const p = idPrefix(cfg);
    const key = kms.Key.fromKeyArn(this, 'KeyRef', props.key.keyArn);   // 실제 키를 넘기면 권한이 Data 키 정책에 붙어 순환
    const fnLogs = new logs.LogGroup(this, 'FnLogs', { logGroupName: `/id/${cfg.name}/api`, retention: cfg.logRetentionDays,
      encryptionKey: key, removalPolicy: RemovalPolicy.DESTROY });
    // 변경 이벤트(6.5, E-08): 제품 계정의 SQS가 구독한다(구독은 제품 쪽 스택이 만든다)
    this.events = new sns.Topic(this, 'Events', { topicName: `${p}-events`, masterKey: key, enforceSSL: true });
    this.events.addToResourcePolicy(new iam.PolicyStatement({ sid: 'ProductSubscribe', actions: ['sns:Subscribe'], resources: [this.events.topicArn],
      principals: cfg.productAccounts.map((a) => new iam.AccountPrincipal(a)), conditions: { StringEquals: { 'sns:Protocol': 'sqs' } } }));
    const svc = path.join(__dirname, '..', '..', '..', 'services', 'identity');
    this.fn = new nodejs.NodejsFunction(this, 'Fn', {
      functionName: `${p}-api`, runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64,
      entry: path.join(svc, 'src', 'handler.ts'), handler: 'handler', depsLockFilePath: path.join(svc, 'package-lock.json'), projectRoot: svc,
      bundling: { format: nodejs.OutputFormat.CJS, target: 'node22', minify: false, sourceMap: true, externalModules: ['@aws-sdk/*'],
        commandHooks: { beforeBundling: () => [], beforeInstall: () => [],
          afterBundling: (input: string, output: string) => [`cp -r "${input}/src/migrations" "${output}/migrations"`] } },
      memorySize: cfg.lambda.memoryMiB, timeout: Duration.seconds(30),   // Aurora 일시정지 재개(약 15초)를 견딘다
      ...(cfg.lambda.reservedConcurrency ? { reservedConcurrentExecutions: cfg.lambda.reservedConcurrency } : {}),
      logGroup: fnLogs, loggingFormat: lambda.LoggingFormat.JSON, tracing: lambda.Tracing.ACTIVE,
      environment: { ID_ENV: cfg.name, DB_CLUSTER_ARN: props.cluster.clusterArn, DB_MASTER_SECRET_ARN: props.cluster.secret!.secretArn,
        DB_APP_SECRET_ARN: props.appSecret.secretArn, DB_NAME: props.dbName, USER_POOL_ID: props.userPool.userPoolId,
        AUTH_DOMAIN: idAuthDomain(cfg), EVENTS_TOPIC_ARN: this.events.topicArn, NODE_OPTIONS: '--enable-source-maps' },
    });
    this.events.grantPublish(this.fn);
    // Cognito 관리(cognito-admin 이식): 이 풀의 IdP·앱 클라이언트만
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'CognitoAdmin', resources: [props.userPool.userPoolArn], actions: [
      'cognito-idp:CreateIdentityProvider', 'cognito-idp:UpdateIdentityProvider', 'cognito-idp:DeleteIdentityProvider', 'cognito-idp:DescribeIdentityProvider',
      'cognito-idp:ListIdentityProviders', 'cognito-idp:CreateUserPoolClient', 'cognito-idp:DescribeUserPoolClient', 'cognito-idp:UpdateUserPoolClient'] }));
    // grantDataApiAccess는 비밀 키 정책(Data 스택)에 이 역할을 붙여 스택 순환이 생긴다 → 역할 정책으로 직접 준다
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'DataApi', resources: [props.cluster.clusterArn], actions: ['rds-data:ExecuteStatement',
      'rds-data:BatchExecuteStatement', 'rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction'] }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'DbSecret', resources: [props.cluster.secret!.secretArn, props.appSecret.secretArn],
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'] }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'DbSecretKey', resources: [props.key.keyArn], actions: ['kms:Decrypt'],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } } }));

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { logGroupName: `/id/${cfg.name}/api-access`, retention: cfg.logRetentionDays,
      encryptionKey: key, removalPolicy: RemovalPolicy.DESTROY });
    const apiCert = new acm.Certificate(this, 'ApiCertificate', { domainName: idApiDomain(cfg), validation: acm.CertificateValidation.fromDns(props.zone) });
    const domain = new apigw.DomainName(this, 'ApiDomain', { domainName: idApiDomain(cfg), certificate: apiCert,
      securityPolicy: apigw.SecurityPolicy.TLS_1_2 });
    // 토큰 검증은 함수 안에서 한다(3.12: 제품 클라이언트가 등록될 때마다 바뀌는 audience 목록을 게이트웨이에 두지 않음)
    this.api = new apigw.HttpApi(this, 'Api', { apiName: p, disableExecuteApiEndpoint: true, createDefaultStage: false,
      defaultIntegration: new integrations.HttpLambdaIntegration('Lambda', this.fn) });
    const stage = new apigw.HttpStage(this, 'Stage', { httpApi: this.api, stageName: '$default', autoDeploy: true,
      domainMapping: { domainName: domain }, throttle: { rateLimit: cfg.throttle.rate, burstLimit: cfg.throttle.burst } });
    const cfn = stage.node.defaultChild as apigw.CfnStage;
    cfn.accessLogSettings = { destinationArn: accessLogs.logGroupArn, format: JSON.stringify({
      requestId: '$context.requestId', ip: '$context.identity.sourceIp', time: '$context.requestTime', method: '$context.httpMethod',
      path: '$context.path', status: '$context.status', latency: '$context.responseLatency', integrationError: '$context.integrationErrorMessage',
      userAgent: '$context.identity.userAgent' }) };

    const apex = new route53.ARecord(this, 'ApiAlias', { zone: props.zone, target: route53.RecordTarget.fromAlias(
      new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)) });
    new route53.AaaaRecord(this, 'ApiAliasV6', { zone: props.zone, target: route53.RecordTarget.fromAlias(
      new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)) });
    // 로그인 도메인 auth.<영역>(Cognito 관리형 로그인, CloudFront)
    const pool = cognito.UserPool.fromUserPoolId(this, 'PoolRef', props.userPool.userPoolId);
    const authDomain = new cognito.UserPoolDomain(this, 'AuthDomain', { userPool: pool,
      customDomain: { domainName: idAuthDomain(cfg), certificate: props.authCertificate } });
    authDomain.node.addDependency(apex);
    new route53.ARecord(this, 'AuthAlias', { zone: props.zone, recordName: 'auth', target: route53.RecordTarget.fromAlias(new targets.UserPoolDomainTarget(authDomain)) });
    new CfnOutput(this, 'ApiUrl', { value: `https://${idApiDomain(cfg)}` });
    new CfnOutput(this, 'LoginUrl', { value: `https://${idAuthDomain(cfg)}` });
    new CfnOutput(this, 'EventsTopicArn', { value: this.events.topicArn });
    new CfnOutput(this, 'FunctionName', { value: this.fn.functionName });
  }
}
