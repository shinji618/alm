import { Stack, StackProps, Duration, RemovalPolicy, CfnResource } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvConfig, ORG, fqdn, drKeyAliasArn } from './config';

export interface DataProps extends StackProps { vpc: ec2.IVpc }

// 10 정의서 7장: KMS, RDS PostgreSQL 16, S3(files·exports), 백업
export class DataStack extends Stack {
  readonly dataKey: kms.Key;
  readonly secretsKey: kms.Key;
  readonly db: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly filesBucket: s3.Bucket;
  readonly exportsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: DataProps) {
    super(scope, id, props);
    const retain = cfg.name === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `alm/${cfg.name}/data`, enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
      description: 'ALM data: RDS, S3 files/exports, logs',
    });
    // CloudWatch Logs가 이 키로 로그 그룹을 암호화할 수 있게
    this.dataKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:/alm/${cfg.name}/*` } },
    }));
    this.secretsKey = new kms.Key(this, 'SecretsKey', {
      alias: `alm/${cfg.name}/secrets`, enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- RDS ----
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', { vpc: props.vpc, description: 'ALM RDS', allowAllOutbound: false });

    const params = new rds.ParameterGroup(this, 'DbParams', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_13 }),
      parameters: {
        shared_preload_libraries: 'pg_stat_statements,pgaudit',
        'pgaudit.log': 'ddl,role',
        'rds.force_ssl': '1',
        log_min_duration_statement: '1000',
        idle_in_transaction_session_timeout: '60000',
        timezone: 'UTC',
      },
    });

    this.db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: `alm-${cfg.name}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_13 }),
      instanceType: new ec2.InstanceType(cfg.db.instanceClass),
      vpc: props.vpc, vpcSubnets: { subnetGroupName: 'data' }, securityGroups: [this.dbSecurityGroup],
      multiAz: cfg.db.multiAz,
      allocatedStorage: cfg.db.allocatedGb, maxAllocatedStorage: cfg.db.maxAllocatedGb,
      storageType: rds.StorageType.GP3, storageEncrypted: true, storageEncryptionKey: this.dataKey,
      databaseName: 'alm',
      // 마스터 = 마이그레이션 소유자. 비밀은 Secrets Manager가 관리·교체. 앱은 IAM 인증(alm_app 로그인)
      credentials: rds.Credentials.fromGeneratedSecret('alm_owner', { encryptionKey: this.secretsKey }),
      iamAuthentication: true,
      parameterGroup: params,
      backupRetention: Duration.days(cfg.db.backupDays),
      preferredBackupWindow: '07:00-07:30',               // UTC = 동부 02~03시
      preferredMaintenanceWindow: 'sun:08:00-sun:09:00',  // UTC = 동부 일 03~04시
      autoMinorVersionUpgrade: true,
      deletionProtection: cfg.db.deletionProtection,
      enablePerformanceInsights: cfg.db.performanceInsights,
      performanceInsightEncryptionKey: cfg.db.performanceInsights ? this.dataKey : undefined,
      monitoringInterval: cfg.db.monitoringSeconds ? Duration.seconds(cfg.db.monitoringSeconds) : undefined,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_YEAR,   // 9.1: RDS 로그 1년
      copyTagsToSnapshot: true,
      removalPolicy: cfg.name === 'prd' ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });
    this.db.addRotationSingleUser({ automaticallyAfter: Duration.days(30) });

    // 자동 백업 리전 간 복제(12장: 리전 장애 RPO). CDK L2에 없어 속성 덮어쓰기
    if (cfg.db.crossRegionBackup) {
      const cfn = this.db.node.defaultChild as CfnResource;
      cfn.addPropertyOverride('AutomaticBackupReplicationRegion', ORG.backupRegion);
      cfn.addPropertyOverride('AutomaticBackupReplicationKmsKeyId', drKeyAliasArn(cfg));
      cfn.addPropertyOverride('AutomaticBackupReplicationRetentionPeriod', 7);
    }

    // ---- S3 ----
    const accessLogs = new s3.Bucket(this, 'S3AccessLogs', {
      bucketName: `alm-${cfg.name}-s3-access-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(365) }], removalPolicy: retain, autoDeleteObjects: cfg.name !== 'prd',
    });
    const appOrigin = `https://${fqdn(cfg.appHost)}`;
    this.filesBucket = new s3.Bucket(this, 'Files', {
      bucketName: `alm-${cfg.name}-files-${this.account}`,
      encryption: s3.BucketEncryption.KMS, encryptionKey: this.dataKey, bucketKeyEnabled: true,
      enforceSSL: true, versioned: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogs, serverAccessLogsPrefix: 'files/',
      cors: [{ allowedOrigins: [appOrigin], allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET], allowedHeaders: ['*'], maxAge: 3000 }],
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(90) },
        { transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(365) }] },
      ],
      eventBridgeEnabled: true, // GuardDuty S3 악성코드 검사 결과 연계(10장)
      removalPolicy: retain, autoDeleteObjects: cfg.name !== 'prd',
    });
    this.exportsBucket = new s3.Bucket(this, 'Exports', {
      bucketName: `alm-${cfg.name}-exports-${this.account}`,
      encryption: s3.BucketEncryption.KMS, encryptionKey: this.dataKey, bucketKeyEnabled: true,
      enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogs, serverAccessLogsPrefix: 'exports/',
      cors: [{ allowedOrigins: [appOrigin], allowedMethods: [s3.HttpMethods.GET], allowedHeaders: ['*'] }],
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });

    // ---- AWS Backup (PRD): 일간 35일, 월간 1년, backup 계정 볼트로 계정 간 사본 ----
    if (cfg.name === 'prd') {
      const vault = new backup.BackupVault(this, 'Vault', { backupVaultName: `alm-${cfg.name}`, encryptionKey: this.dataKey, removalPolicy: RemovalPolicy.RETAIN });
      const target = backup.BackupVault.fromBackupVaultArn(this, 'CentralVault', ORG.backupVaultArn);
      const plan = new backup.BackupPlan(this, 'Plan', { backupPlanName: `alm-${cfg.name}`, backupVault: vault });
      plan.addRule(new backup.BackupPlanRule({
        ruleName: 'daily', scheduleExpression: events.Schedule.cron({ hour: '8', minute: '0' }),
        deleteAfter: Duration.days(35), copyActions: [{ destinationBackupVault: target, deleteAfter: Duration.days(35) }],
      }));
      plan.addRule(new backup.BackupPlanRule({
        ruleName: 'monthly', scheduleExpression: events.Schedule.cron({ day: '1', hour: '9', minute: '0' }),
        deleteAfter: Duration.days(365), copyActions: [{ destinationBackupVault: target, deleteAfter: Duration.days(365) }],
      }));
      plan.addSelection('Db', { resources: [backup.BackupResource.fromRdsDatabaseInstance(this.db)] });
    }
  }
}
