#!/usr/bin/env node
// 사용: cdk synth|deploy -c env=dev|qa|prd [--all]   (계정 공통: -c env=global)
// env 없이 실행하면(예: cdk bootstrap) 스택을 만들지 않는다.
import { App } from 'aws-cdk-lib';
import { buildEnv, buildGlobal, applyNag } from '../lib/build';
import { EnvName } from '../lib/config';

const app = new App();
const target = app.node.tryGetContext('env') as string | undefined;
if (target && !['dev', 'qa', 'prd', 'global'].includes(target)) {
  throw new Error(`알 수 없는 env: ${target} (dev|qa|prd|global)`);
}
if (!target) {
  console.error('[alm-infra] -c env=dev|qa|prd|global 이 없어 스택을 만들지 않습니다(cdk bootstrap은 괜찮음).');
} else {
  const imageTag = app.node.tryGetContext('imageTag') as string | undefined;
  const built = target === 'global' ? buildGlobal(app) : buildEnv(app, target as EnvName, imageTag ? { imageTag } : {});
  if (app.node.tryGetContext('nag') !== 'off') applyNag(app, built.stacks, target === 'global' ? undefined : target);
}
