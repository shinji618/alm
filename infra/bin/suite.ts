#!/usr/bin/env node
// 공유 플랫폼(suite) 위의 ALM(통합 WBS 5.4). 사용: cdk -a "npx tsx bin/suite.ts" <명령> -c env=dev [-c imageTag=<태그>] [-c desired=0] [-c nag=off]
// 지금 쓰는 전용 환경(Alm-<Env>-*)은 bin/app.ts 그대로다 — 전환 시험(5.7)까지 함께 둔다.
import { App } from 'aws-cdk-lib';
import { ORG } from '../lib/config';
import { SUITE_ENVS, SuiteEnvName, suiteStackName } from '../lib/suite-config';
import { SuiteAlmStack } from '../lib/suite-alm-stack';
import { applyNag } from '../lib/build';

const app = new App();
const which = ((app.node.tryGetContext('env') as string | undefined) ?? 'dev') as SuiteEnvName;
if (!SUITE_ENVS[which]) throw new Error(`알 수 없는 env: ${which} (${Object.keys(SUITE_ENVS).join('|')})`);
const cfg = { ...SUITE_ENVS[which] };
const tag = app.node.tryGetContext('imageTag'); if (tag) cfg.imageTag = String(tag);
// 첫 배포: 스키마를 적용하기 전에는 서비스를 0개로 올린다(-c desired=0). scripts/suite-deploy.sh가 쓴다
const desired = app.node.tryGetContext('desired');
if (desired !== undefined) { cfg.api = { ...cfg.api, desired: Number(desired) }; cfg.worker = { ...cfg.worker, desired: Number(desired) }; }
const stack = new SuiteAlmStack(app, suiteStackName(cfg.name), cfg, { env: { account: cfg.account, region: ORG.region } });
if (app.node.tryGetContext('nag') !== 'off') applyNag(app, [stack], cfg.name);
