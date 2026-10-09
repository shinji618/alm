#!/usr/bin/env node
// 사용: cdk synth|deploy --all -c env=dev|qa|prd   (계정 공통: -c env=global)
import { App } from 'aws-cdk-lib';
import { buildEnv, buildGlobal, applyNag } from '../lib/build';
import { EnvName } from '../lib/config';

const app = new App();
const target = app.node.tryGetContext('env') as string | undefined;
if (!target || !['dev', 'qa', 'prd', 'global'].includes(target)) {
  throw new Error('-c env=dev|qa|prd|global 를 지정하세요');
}
const imageTag = app.node.tryGetContext('imageTag') as string | undefined;
const built = target === 'global' ? buildGlobal(app) : buildEnv(app, target as EnvName, imageTag ? { imageTag } : {});
if (app.node.tryGetContext('nag') !== 'off') applyNag(app, built.stacks, target);
