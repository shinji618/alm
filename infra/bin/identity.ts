#!/usr/bin/env node
// 중앙 ID 서비스(WBS 3.11). 사용: npx cdk -a "npx tsx bin/identity.ts" synth|deploy -c env=dev|qa|prd --all
import { App } from 'aws-cdk-lib';
import { buildIdentity } from '../lib/identity/build';
import { applyNag } from '../lib/build';
import { IdEnvName } from '../lib/identity/config';

const app = new App();
const target = app.node.tryGetContext('env') as string | undefined;
if (target && !['dev', 'qa', 'prd'].includes(target)) throw new Error(`알 수 없는 env: ${target} (dev|qa|prd)`);
if (!target) {
  console.error('[identity-infra] -c env=dev|qa|prd 가 없어 스택을 만들지 않습니다.');
} else {
  const built = buildIdentity(app, target as IdEnvName);
  if (app.node.tryGetContext('nag') !== 'off') applyNag(app, built.stacks, `id-${target}`);
}
