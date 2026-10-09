import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ORG, ENVS, EnvName, AUDIT_BUCKET, logBucketName } from './config';

const AUDIT_YEARS_DAYS = 3653;           // 10년(SOX 감사 보관, 09 9장)
const ELB_ACCOUNT_US_EAST_1 = '127311923021';
const replicaBucketName = `alm-audit-archive-replica-${ORG.accounts.logArchive}`;
const replicaKeyAlias = 'alias/alm/audit-replica';

// us-east-2 사본(감사 보관 복제 대상). LogArchive보다 먼저 배포한다
export class LogArchiveReplicaStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const key = new kms.Key(this, 'ReplicaKey', { alias: replicaKeyAlias, enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
    new s3.Bucket(this, 'AuditReplica', {
      bucketName: replicaBucketName, encryption: s3.BucketEncryption.KMS, encryptionKey: key, bucketKeyEnabled: true,
      versioned: true, objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(AUDIT_YEARS_DAYS)),
      enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ transitions: [{ storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: Duration.days(1) }] }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

// log-archive 계정: 감사 보관(Object Lock 준수 모드 10년) + 환경별 접근 로그 버킷(1년)
export class LogArchiveStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const envAccounts = Object.values(ENVS).map((e) => e.account);

    // KMS alm/audit — 환경 계정은 S3를 통해서만 쓰기·읽기
    const key = new kms.Key(this, 'AuditKey', { alias: 'alm/audit', enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN,
      description: 'ALM audit archive (audit_log export, pgaudit)' });
    key.addToResourcePolicy(new iam.PolicyStatement({
      principals: envAccounts.map((a) => new iam.AccountPrincipal(a)),
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'], resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
    }));

    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      bucketName: `alm-s3-access-logs-${this.account}`, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(365) }], removalPolicy: RemovalPolicy.RETAIN,
    });

    const audit = new s3.Bucket(this, 'AuditArchive', {
      bucketName: AUDIT_BUCKET, encryption: s3.BucketEncryption.KMS, encryptionKey: key, bucketKeyEnabled: true,
      versioned: true, objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(AUDIT_YEARS_DAYS)),
      enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogs, serverAccessLogsPrefix: 'audit/',
      lifecycleRules: [{ transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(90) },
        { storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: Duration.days(365) }] }],
      replicationRules: [{
        destination: s3.Bucket.fromBucketArn(this, 'ReplicaRef', `arn:aws:s3:::${replicaBucketName}`),
        priority: 1, sseKmsEncryptedObjects: true,
        kmsKey: kms.Key.fromKeyArn(this, 'ReplicaKeyArn', `arn:aws:kms:${ORG.backupRegion}:${this.account}:${replicaKeyAlias}`),
      }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // 환경 계정은 자기 접두사(<env>/)에만 쓰고 읽는다. 삭제는 Object Lock이 막는다
    for (const e of Object.values(ENVS)) {
      audit.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.AccountPrincipal(e.account)], actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
        resources: [audit.arnForObjects(`${e.name}/*`)],
        conditions: { ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${e.account}:role/*` } },
      }));
      audit.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.AccountPrincipal(e.account)], actions: ['s3:ListBucket', 's3:GetBucketLocation', 's3:ListBucketMultipartUploads'],
        resources: [audit.bucketArn], conditions: { StringLike: { 's3:prefix': [`${e.name}/*`, ''] } },
      }));
    }

    // 환경별 로그 버킷: ALB 접근 로그(SSE-S3만 지원), CloudFront 표준 로그 v2
    for (const e of Object.values(ENVS)) {
      const b = new s3.Bucket(this, `Logs-${e.name}`, {
        bucketName: logBucketName(e.name as EnvName), encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        serverAccessLogsBucket: accessLogs, serverAccessLogsPrefix: `${e.name}/`,
        lifecycleRules: [{ expiration: Duration.days(365) }], removalPolicy: RemovalPolicy.RETAIN,
      });
      b.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.AccountPrincipal(ELB_ACCOUNT_US_EAST_1)],
        actions: ['s3:PutObject'], resources: [b.arnForObjects(`alb/AWSLogs/${e.account}/*`)] }));
      b.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:PutObject'], resources: [b.arnForObjects('cloudfront/*')],
        conditions: { StringEquals: { 'aws:SourceAccount': e.account, 's3:x-amz-acl': 'bucket-owner-full-control' } } }));
    }
  }
}
