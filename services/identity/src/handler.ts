// Lambda 진입점. API Gateway(HTTP API v2) 요청 또는 직접 호출(운영: 마이그레이션·플랫폼 관리, IAM 허가)
//   직접 호출: { action: 'migrate' } | { action: 'http', method, path, query?, body? }(플랫폼 관리자로 처리)
import { RDSDataClient, BeginTransactionCommand, ExecuteStatementCommand, CommitTransactionCommand, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { dataApiDb, retryResume } from './db';
import { route, Deps, HttpReq } from './api';
import { snsPublisher } from './events';
import { Cip } from './cognito';
import { loadMigrations, migrate } from './migrate';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`환경 변수 없음: ${k}`); return v; };
const rds = new RDSDataClient({});
const cmds = { Begin: BeginTransactionCommand, Exec: ExecuteStatementCommand, Commit: CommitTransactionCommand, Rollback: RollbackTransactionCommand };

// SDK 명령 이름 → 호출(createUserPoolClient → CreateUserPoolClientCommand)
function cipOf(client: CognitoIdentityProviderClient): Cip {
  return new Proxy({}, { get: (_t, op: string) => (input: any) => {
    const Cmd = (cognitoSdk as any)[`${op[0].toUpperCase()}${op.slice(1)}Command`];
    if (!Cmd) throw new Error(`Cognito 명령 없음: ${op}`);
    return client.send(new Cmd(input));
  } }) as Cip;
}

let deps: Deps | undefined;
function getDeps(): Deps {
  return (deps ??= {
    db: dataApiDb(rds, cmds, { resourceArn: env('DB_CLUSTER_ARN'), secretArn: env('DB_APP_SECRET_ARN'), database: env('DB_NAME') }),
    cognito: { cip: cipOf(new CognitoIdentityProviderClient({})), poolId: env('USER_POOL_ID'), authDomain: process.env.AUTH_DOMAIN },
    publisher: snsPublisher(new SNSClient({}), PublishCommand, process.env.EVENTS_TOPIC_ARN),
    verifier: CognitoJwtVerifier.create({ userPoolId: env('USER_POOL_ID'), tokenUse: 'access', clientId: null }) as any,
  });
}

async function runMigrate() {
  const sm = new SecretsManagerClient({});
  const app = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: env('DB_APP_SECRET_ARN') }))).SecretString ?? '{}');
  const master = dataApiDb(rds, cmds, { resourceArn: env('DB_CLUSTER_ARN'), secretArn: env('DB_MASTER_SECRET_ARN'), database: env('DB_NAME') });
  const applied = await retryResume(() => master.withTx({}, (c) => migrate(c, loadMigrations(), app.password)));
  console.info(JSON.stringify({ msg: 'migrate', applied }));
  return { ok: true, applied };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });

export async function handler(event: any) {
  if (event?.requestContext?.http) {
    const method = event.requestContext.http.method, path = event.rawPath;
    if (method === 'GET' && path === '/health') return json(200, { status: 'UP', env: process.env.ID_ENV, time: new Date().toISOString() });
    if (method === 'GET' && path === '/health/db') {
      try {
        const r = await retryResume(() => getDeps().db.withTx({}, (c) => c.query(`SELECT count(*)::int AS products FROM product`)));
        return json(200, { status: 'UP', products: r.rows[0].products });
      } catch (e: any) { console.error(JSON.stringify({ msg: 'db check failed', error: e?.name })); return json(503, { status: 'DOWN', error: e?.name }); }
    }
    let body: unknown;
    if (event.body) {
      try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); }
      catch { return json(400, { code: 'ID-E100', message: '본문이 JSON이 아닙니다' }); }
    }
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v as string]));
    const req: HttpReq = { method, path, query: event.queryStringParameters ?? {}, headers, body };
    const r = await retryResume(() => route(getDeps(), req));
    return json(r.status, r.body, r.headers);
  }
  // 직접 호출(운영)
  if (event?.action === 'migrate') return runMigrate();
  if (event?.action === 'http') {
    const r = await retryResume(() => route(getDeps(), { method: event.method ?? 'GET', path: event.path, query: event.query ?? {}, headers: {}, body: event.body },
      { clientId: 'iam-invoke', scopes: [], admin: true }));
    return { status: r.status, body: r.body };
  }
  return { ok: false, error: 'action: migrate | http' };
}
