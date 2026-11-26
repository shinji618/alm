// DB 연결(10 정의서 5장·09 8장). RDS IAM 인증 토큰(15분)을 연결마다 새로 받고, RDS CA로 서버 인증서를 확인한다.
// 업무 쿼리는 withTx()로만 실행한다: 트랜잭션 시작 때 SET LOCAL app.* 를 넣어 RLS·감사 트리거가 동작하게 한다.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient, PoolConfig } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { tenantDb } from '@shinji618/platform-db';
import { Config } from '../config';

export type ActorType = 'USER' | 'SYSTEM' | 'SAP' | 'PDA';
export interface TxContext {
  tenantId: string;
  userId?: string;
  actorType: ActorType;
  correlationId?: string;
  clientIp?: string;
}

const CA_PATHS = [process.env.DB_CA_FILE, join(__dirname, '..', '..', 'certs', 'rds-global-bundle.pem'), '/app/certs/rds-global-bundle.pem'];

export function sslOption(enabled: boolean): PoolConfig['ssl'] {
  if (!enabled) return false;
  const ca = CA_PATHS.find((p): p is string => !!p && existsSync(p));
  if (!ca) throw new Error('RDS CA 묶음(certs/rds-global-bundle.pem)이 없다. 이미지 빌드를 확인한다');
  return { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true };
}

export function createPool(cfg: Config, opts: { user?: string; password?: string; max?: number } = {}): Pool {
  const user = opts.user ?? cfg.db.user;
  const fixed = opts.password ?? (opts.user ? undefined : cfg.db.password);
  const signer = fixed ? undefined : new Signer({ hostname: cfg.db.host, port: cfg.db.port, username: user, region: cfg.region });
  return new Pool({
    host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user,
    password: fixed ?? (() => signer!.getAuthToken()),
    ssl: sslOption(cfg.db.ssl),
    max: opts.max ?? 10, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 10_000,
    application_name: `alm-${process.env.APP_ROLE || 'api'}`,
    statement_timeout: 30_000,
  });
}

export class Db {
  private readonly tx;
  constructor(readonly pool: Pool) { this.tx = tenantDb(() => pool.connect()); }

  // 테넌트를 모르는 단계(로그인): SECURITY DEFINER 함수만 부른다
  async query<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  // 트랜잭션 하나에만 값을 건다(SET LOCAL) — 공통 패키지 @shinji618/platform-db(통합 WBS 7.1). 감사 트리거가 app.* 다섯 값을 읽는다
  withTx<T>(ctx: TxContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.tx.withSettings({ 'app.tenant_id': ctx.tenantId, 'app.user_id': ctx.userId, 'app.actor_type': ctx.actorType,
      'app.correlation_id': ctx.correlationId, 'app.client_ip': ctx.clientIp }, fn);
  }

  close() { return this.pool.end(); }
}
