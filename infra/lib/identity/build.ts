import { App, Stack, Tags } from 'aws-cdk-lib';
import { ORG } from '../config';
import { ID_ENVS, IdEnvName, IdEnvConfig, accountOf } from './config';
import { IdDnsStack, IdDataStack, IdAuthStack, IdApiStack } from './stacks';
import { IdObservabilityStack, IdCiStack } from './ops-stacks';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// 중앙 ID 서비스 환경: Id-<Env>-Dns → Data → Auth → Api → Observability, Ci
export function buildIdentity(app: App, name: IdEnvName, overrides: Partial<IdEnvConfig> = {}) {
  const cfg: IdEnvConfig = { ...ID_ENVS[name], ...overrides };
  const env = { account: accountOf(cfg), region: ORG.region };
  const p = `Id-${cap(name)}`;
  const dns = new IdDnsStack(app, `${p}-Dns`, cfg, { env });
  const data = new IdDataStack(app, `${p}-Data`, cfg, { env });
  const auth = new IdAuthStack(app, `${p}-Auth`, cfg, { env, zone: dns.zone });
  const api = new IdApiStack(app, `${p}-Api`, cfg, { env, zone: dns.zone, cluster: data.cluster, dbName: data.dbName, key: data.key, appSecret: data.appSecret,
    userPool: auth.userPool, authCertificate: auth.authCertificate });
  const obs = new IdObservabilityStack(app, `${p}-Observability`, cfg, { env, fn: api.fn, api: api.api, cluster: data.cluster });
  const ci = new IdCiStack(app, `${p}-Ci`, cfg, { env });
  const stacks: Stack[] = [dns, data, auth, api, obs, ci];
  for (const s of stacks) {
    Tags.of(s).add('Project', 'Identity'); Tags.of(s).add('Env', name); Tags.of(s).add('Owner', 'BSG'); Tags.of(s).add('CostCenter', 'PLATFORM');
  }
  return { cfg, dns, data, auth, api, obs, ci, stacks };
}
