import { App, Tags, Stack, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ORG, ENVS, EnvName, EnvConfig } from './config';
import { NetworkStack } from './network-stack';
import { DataStack } from './data-stack';
import { AuthStack } from './auth-stack';
import { AppStack } from './app-stack';
import { EdgeStack } from './edge-stack';
import { ObservabilityStack } from './observability-stack';
import { LogArchiveStack, LogArchiveReplicaStack } from './log-archive-stack';
import { SharedStack, BackupVaultStack, OrgBaselineStack, CiStack, DrStack } from './global-stacks';
import { applySuppressions } from './nag';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// 환경 스택 9개: Network → Data → Auth → App → Edge → Observability → Ci (+ PRD는 Dr, us-east-2)
export function buildEnv(app: App, name: EnvName, overrides: Partial<EnvConfig> = {}) {
  const cfg: EnvConfig = { ...ENVS[name], ...overrides };
  const env = { account: cfg.account, region: ORG.region };
  const p = `Alm-${cap(name)}`;
  const network = new NetworkStack(app, `${p}-Network`, cfg, { env });
  const data = new DataStack(app, `${p}-Data`, cfg, { env, vpc: network.vpc });
  const auth = new AuthStack(app, `${p}-Auth`, cfg, { env, secretsKey: data.secretsKey });
  const appStack = new AppStack(app, `${p}-App`, cfg, {
    env, vpc: network.vpc, dataKey: data.dataKey, db: data.db, dbSecurityGroup: data.dbSecurityGroup,
    userPool: auth.userPool, webClient: auth.webClient,
    pdaClient: auth.pdaClient, webClientSecret: auth.webClientSecret, cookieKeySecret: auth.cookieKeySecret, secretsKey: data.secretsKey,
  });
  const edge = new EdgeStack(app, `${p}-Edge`, cfg, { env, alb: appStack.alb, albSecurityGroup: appStack.albSecurityGroup,
    certificate: appStack.appCertificate, vpc: network.vpc });
  const obs = new ObservabilityStack(app, `${p}-Observability`, cfg, {
    env, alb: appStack.alb, targetGroup: appStack.targetGroup, apiService: appStack.apiService, workerService: appStack.workerService,
    jobsQueue: appStack.jobsQueue, jobsDlq: appStack.jobsDlq, db: data.db,
    certificates: [appStack.appCertificate, auth.authCertificate], webAclName: `alm-${name}`,
  });
  obs.addStackDependency(edge);
  const ci = new CiStack(app, `${p}-Ci`, cfg, { env, webBucketName: `alm-${name}-web-${cfg.account}`,
    distributionArn: `arn:aws:cloudfront::${cfg.account}:distribution/*` });
  const stacks: Stack[] = [network, data, auth, appStack, edge, obs, ci];
  if (cfg.db.crossRegionBackup) {
    const dr = new DrStack(app, `${p}-Dr`, cfg, { env: { account: cfg.account, region: ORG.backupRegion } });
    data.addStackDependency(dr);
    stacks.push(dr);
  }
  for (const s of stacks) tag(s, name);
  return { cfg, network, data, auth, app: appStack, edge, obs, ci, stacks };
}

// 계정 공통 스택(환경과 무관, 1회): 관리·log-archive·alm-shared·backup 계정
export function buildGlobal(app: App) {
  const a = ORG.accounts;
  const replica = new LogArchiveReplicaStack(app, 'Alm-LogArchiveReplica', { env: { account: a.logArchive, region: ORG.backupRegion } });
  const logArchive = new LogArchiveStack(app, 'Alm-LogArchive', { env: { account: a.logArchive, region: ORG.region } });
  logArchive.addStackDependency(replica);
  const shared = new SharedStack(app, 'Alm-Shared', { env: { account: a.shared, region: ORG.region } });
  const vault = new BackupVaultStack(app, 'Alm-BackupVault', { env: { account: a.backup, region: ORG.region } });
  const org = new OrgBaselineStack(app, 'Alm-OrgBaseline', { env: { region: ORG.region } });
  const stacks = [replica, logArchive, shared, vault, org];
  for (const s of stacks) tag(s, 'global');
  return { replica, logArchive, shared, vault, org, stacks };
}

function tag(s: Stack, env: string) {
  Tags.of(s).add('Project', 'ALM');
  Tags.of(s).add('Env', env);
  Tags.of(s).add('Owner', 'BSG');
  Tags.of(s).add('CostCenter', ORG.costCenter);
}

export function applyNag(app: App, stacks: Stack[], env?: string) {
  applySuppressions(app, stacks, env);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
}
