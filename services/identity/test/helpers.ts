// 시험 도구: 로컬 PostgreSQL(TEST_PG_HOST), 가짜 Cognito·토큰 검증·이벤트 발행
import { Client, Pool } from 'pg';
import { pgDb } from '../src/db';
import { loadMigrations, migrate } from '../src/migrate';
import { Deps, route, HttpReq } from '../src/api';
import { IdEvent } from '../src/events';
import { join } from 'node:path';

export const host = process.env.TEST_PG_HOST;
export const port = Number(process.env.TEST_PG_PORT || 5432);
export const APP_PASSWORD = 'TestAppPassword0123456789abcdefABCDEF';

export class FakeCognito {
  idps = new Map<string, any>();
  clients = new Map<string, any>();
  calls: string[] = [];
  private n = 0;
  cip: any = new Proxy({}, { get: (_t, op: string) => async (input: any) => { this.calls.push(op); return (this as any)[`_${op}`](input); } });
  private nf() { return Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }); }
  _describeIdentityProvider(i: any) { const p = this.idps.get(i.ProviderName); if (!p) throw this.nf(); return { IdentityProvider: p }; }
  _createIdentityProvider(i: any) { this.idps.set(i.ProviderName, { ...i }); return {}; }
  _updateIdentityProvider(i: any) { this.idps.set(i.ProviderName, { ...this.idps.get(i.ProviderName), ...i }); return {}; }
  _deleteIdentityProvider(i: any) { if (!this.idps.delete(i.ProviderName)) throw this.nf(); return {}; }
  _listIdentityProviders() { return { Providers: [...this.idps.keys()].map((ProviderName) => ({ ProviderName })) }; }
  _createUserPoolClient(i: any) {
    const id = `client${++this.n}`;
    const c = { ...i, ClientId: id, ...(i.GenerateSecret ? { ClientSecret: `secret${this.n}` } : {}) };
    this.clients.set(id, c);
    return { UserPoolClient: c };
  }
  _describeUserPoolClient(i: any) { const c = this.clients.get(i.ClientId); if (!c) throw this.nf(); return { UserPoolClient: { ...c, CreationDate: new Date() } }; }
  _updateUserPoolClient(i: any) {
    if ('ClientSecret' in i || 'CreationDate' in i) throw new Error('읽기 전용 항목을 보냄');
    this.clients.set(i.ClientId, { ...this.clients.get(i.ClientId), ...i }); return {};
  }
}

// 토큰 = 'tok:<clientId>:<범위,범위>'
export const verifier = { async verify(t: string) {
  const [k, client_id, scopes] = t.split(':');
  if (k !== 'tok') throw new Error('bad token');
  return { client_id, scope: (scopes ?? '').split(',').filter(Boolean).map((s) => `id-api/${s}`).join(' ') };
} };

export interface Env { deps: Deps; cognito: FakeCognito; events: IdEvent[]; owner: Client; appPool: Pool; dbName: string;
  call(token: string | undefined, method: string, path: string, body?: unknown, headers?: Record<string, string>): ReturnType<typeof route> }

export async function setup(): Promise<Env> {
  const dbName = `idsvc_${process.pid}_${Date.now()}`;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  const owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await pgDb({ connect: async () => Object.assign(owner, { release() {} }) }).withTx({}, (c) => migrate(c, loadMigrations(join(__dirname, '..', '..', 'src', 'migrations')), APP_PASSWORD));
  const appPool = new Pool({ host, port, user: 'id_app', password: APP_PASSWORD, database: dbName, max: 3 });
  const cognito = new FakeCognito();
  const events: IdEvent[] = [];
  const deps: Deps = { db: pgDb(appPool), cognito: { cip: cognito.cip, poolId: 'us-east-1_TEST', authDomain: 'auth.id-test.example' },
    publisher: { async publish(e) { events.push(...e); } }, verifier, log: { error() {}, info() {} } };
  const call = (token: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const [p, qs] = path.split('?');
    const req: HttpReq = { method, path: p, query: Object.fromEntries(new URLSearchParams(qs ?? '')), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body };
    return route(deps, req);
  };
  return { deps, cognito, events, owner, appPool, dbName, call };
}

export async function teardown(e: Env | undefined) {
  if (!e) return;
  await e.appPool.end(); await e.owner.end();
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${e.dbName} WITH (FORCE)`); await su.end();
}

// ALM 권한 카탈로그(api/permissions.json)에서 역할 부여에 필요한 부분
export const ALM_CATALOG = {
  roles: [
    { code: 'SYS_ADMIN', name: '시스템 관리자' }, { code: 'ASSET_MANAGER', name: '자산 관리자' },
    { code: 'DEPT_MANAGER', name: '부서 관리자', requiredScope: ['costCenter'] }, { code: 'ASSET_ACCOUNTANT', name: '자산회계' },
    { code: 'COUNTER', name: '실사 담당자' }, { code: 'EMPLOYEE', name: '직원' },
    { code: 'AUDITOR', name: '감사인', requireValidUntil: true, maxValidYears: 1 },
  ],
  adminRole: 'SYS_ADMIN', exclusiveRoles: ['AUDITOR'], implicit: { role: 'EMPLOYEE', excludedIf: ['AUDITOR'] },
  scopeDimensions: [{ dimension: 'company', label: '회사코드', max: 4 }, { dimension: 'site', label: '사이트', max: 10 }, { dimension: 'costCenter', label: '코스트센터', max: 10 }],
  sodRules: [
    { rule: 'SOD-01', roles: ['ASSET_MANAGER', 'ASSET_ACCOUNTANT'], description: '자산 등록·할당부터 최종 승인·SAP 전기까지 한 사람이 처리' },
    { rule: 'SOD-04', roles: ['DEPT_MANAGER', 'ASSET_ACCOUNTANT'], sameScope: 'costCenter', scopeLabel: '코스트센터', description: '부서 승인과 최종 승인을 한 사람이 처리({scope})' },
  ],
};
