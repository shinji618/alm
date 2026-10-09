import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as organizations from 'aws-cdk-lib/aws-organizations';
import * as sso from 'aws-cdk-lib/aws-sso';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { ORG, ENVS, EnvConfig, drKeyAlias } from './config';

const GITHUB_OIDC = 'https://token.actions.githubusercontent.com';
const githubProvider = (scope: Construct) => new iam.OidcProviderNative(scope, 'GitHubOidc', {
  url: GITHUB_OIDC, clientIds: ['sts.amazonaws.com'],
});
const githubPrincipal = (provider: iam.OidcProviderNative, subjects: string[]) => new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
  StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
  StringLike: { 'token.actions.githubusercontent.com:sub': subjects },
});

// alm-shared 계정: ECR(이미지 1개, 다이제스트 승격), CI 빌드 역할
export class SharedStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const repo = new ecr.Repository(this, 'Repo', {
      repositoryName: ORG.ecrRepositoryName, imageTagMutability: ecr.TagMutability.IMMUTABLE, imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256, removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'untagged 14 days', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(14) },
        { description: 'keep last 100', tagStatus: ecr.TagStatus.ANY, maxImageCount: 100 }],
    });
    // 환경 계정의 ECS 실행 역할이 당겨 갈 수 있게
    repo.addToResourcePolicy(new iam.PolicyStatement({
      principals: Object.values(ENVS).map((e) => new iam.AccountPrincipal(e.account)),
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
    }));
    const provider = githubProvider(this);
    const ci = new iam.Role(this, 'CiRole', {
      roleName: 'alm-ci-build', maxSessionDuration: Duration.hours(1),
      assumedBy: githubPrincipal(provider, [`repo:${ORG.githubRepo}:ref:refs/heads/main`, `repo:${ORG.githubRepo}:ref:refs/tags/v*`]),
      description: 'GitHub Actions image build/push (main, release tags)',
    });
    repo.grantPullPush(ci);
    ecr.AuthorizationToken.grantRead(ci);
  }
}

// backup 계정: 계정 간 사본 볼트(Vault Lock 준수 모드)
export class BackupVaultStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const key = new kms.Key(this, 'VaultKey', { alias: 'alm/backup', enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
    const vaultName = ORG.backupVaultArn.split(':').pop()!;
    new backup.BackupVault(this, 'Vault', {
      backupVaultName: vaultName, encryptionKey: key, removalPolicy: RemovalPolicy.RETAIN,
      // 잠금 후 3일이 지나면 준수 모드로 굳어 누구도 바꾸거나 지울 수 없다
      lockConfiguration: { minRetention: Duration.days(35), maxRetention: Duration.days(400), changeableFor: Duration.days(3) },
      accessPolicy: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({
        principals: [new iam.AccountPrincipal(ENVS.prd.account)], actions: ['backup:CopyIntoBackupVault'], resources: ['*'],
      })] }),
    });
  }
}

// 관리 계정(1회): Control Tower가 만들지 않는 추가 SCP, Identity Center 권한 세트(3.1)
export class OrgBaselineStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const dir = path.join(__dirname, '..', 'org', 'scp');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const name = `alm-${path.basename(f, '.json')}`;
      new organizations.CfnPolicy(this, name, {
        name, type: 'SERVICE_CONTROL_POLICY', description: `ALM ${name} (architecture 3.1)`,
        content: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
        targetIds: [ORG.workloadsOuId, ORG.securityOuId, ORG.sharedOuId],
      });
    }
    const ps = (id: string, name: string, desc: string, hours: number, managed: string[], inline?: object) =>
      new sso.CfnPermissionSet(this, id, { instanceArn: ORG.ssoInstanceArn, name, description: desc,
        sessionDuration: `PT${hours}H`, managedPolicies: managed, inlinePolicy: inline });
    ps('DevAdmin', 'DevAdmin', 'DEV account admin', 8, ['arn:aws:iam::aws:policy/AdministratorAccess']);
    ps('ReadOnly', 'ReadOnly', 'Read-only, all accounts', 8, ['arn:aws:iam::aws:policy/ReadOnlyAccess']);
    ps('ProdOperator', 'ProdOperator', 'PRD logs/metrics read, ECS service restart', 4, ['arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess'], {
      Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['ecs:Describe*', 'ecs:List*', 'ecs:UpdateService'], Resource: '*' },
        { Effect: 'Allow', Action: ['logs:StartQuery', 'logs:GetQueryResults', 'logs:FilterLogEvents', 'logs:GetLogEvents'], Resource: '*' },
      ] });
    ps('BreakGlass', 'BreakGlass', 'Approved 1h emergency access (alerts on use)', 1, ['arn:aws:iam::aws:policy/AdministratorAccess']);
  }
}

// 환경 계정: GitHub Actions 배포 역할(11장). cdk deploy는 부트스트랩 역할을 거친다
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps & { webBucketName: string; distributionArn: string }) {
    super(scope, id, props);
    const provider = githubProvider(this);
    const Env = cfg.name[0].toUpperCase() + cfg.name.slice(1);
    // DEV는 main 브랜치, QA·PRD는 GitHub 환경(PRD는 승인 규칙)
    const subjects = cfg.name === 'dev'
      ? [`repo:${ORG.githubRepo}:ref:refs/heads/main`, `repo:${ORG.githubRepo}:environment:dev`]
      : [`repo:${ORG.githubRepo}:environment:${cfg.name}`];
    const role = new iam.Role(this, 'DeployRole', { roleName: `alm-deploy-${cfg.name}`, maxSessionDuration: Duration.hours(1),
      assumedBy: githubPrincipal(provider, subjects), description: `GitHub Actions deploy (${cfg.name})` });
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CdkBootstrapRoles', actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'ReadStackOutputs', actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/Alm-${Env}-*/*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Migrate', actions: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition', 'ecs:RunTask',
      'ecs:DescribeTasks', 'ecs:DescribeServices'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'PassTaskRoles', actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${this.account}:role/Alm-${Env}-App-*`],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'MigrateLogs', actions: ['logs:GetLogEvents', 'logs:FilterLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/alm/${cfg.name}/migrate:*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WebSync', actions: ['s3:ListBucket', 's3:PutObject', 's3:DeleteObject', 's3:GetObject'],
      resources: [`arn:aws:s3:::${props.webBucketName}`, `arn:aws:s3:::${props.webBucketName}/*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Invalidate', actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [props.distributionArn] }));
  }
}

// 환경 계정 us-east-2: RDS 자동 백업 리전 간 복제용 키(12장)
export class DrStack extends Stack {
  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);
    new kms.Key(this, 'DrKey', { alias: drKeyAlias(cfg.name).replace(/^alias\//, ''), enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN, description: `ALM ${cfg.name} RDS cross-region backup` });
  }
}
