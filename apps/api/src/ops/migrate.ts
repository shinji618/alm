// DB 마이그레이션(배포 1단계, deploy.sh run_migrate). 설계 문서의 Prisma migrate 대신 번호 붙은 SQL 파일을 순서대로 적용한다.
//  1) 부트스트랩(매번, 멱등): NOLOGIN 역할 · IAM 로그인 계정 · 기본 권한 · pgaudit
//  2) schema_migrations에 없는 파일만 한 트랜잭션씩 적용. 이미 적용된 파일의 내용이 바뀌었으면 중단
// 접속: RDS 마스터(alm_owner, Secrets Manager → ECS 비밀 DB_MASTER_*). 이벤트 트리거·역할 생성에 rds_superuser가 필요하다.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { Config } from '../config';
import { sslOption } from '../db/pool';
import { Signer } from '@aws-sdk/rds-signer';
import { log } from '../common/log';

const LOCK_KEY = 4_242_001;   // pg_advisory_lock: 동시에 두 migrate가 돌지 않게

export interface Migration { version: string; file: string; sql: string; checksum: string }

export function loadMigrations(dir = join(__dirname, '..', 'migrations')): Migration[] {
  return readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map((file) => {
    const raw = readFileSync(join(dir, file), 'utf8');
    return { version: file.slice(0, 4), file, sql: stripTx(raw), checksum: createHash('sha256').update(raw).digest('hex') };
  });
}

// 파일 안의 맨 바깥 BEGIN;/COMMIT;은 빼고 러너가 기록과 함께 한 트랜잭션으로 묶는다
export function stripTx(sql: string): string {
  return sql.replace(/^\s*BEGIN\s*;\s*$/m, '').replace(/^\s*COMMIT\s*;\s*$(?![\s\S]*^\s*COMMIT\s*;)/m, '');
}

const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`잘못된 역할 이름 ${s}`); return s; };

export async function bootstrap(c: Client): Promise<void> {
  const me = ident((await c.query('SELECT current_user AS u')).rows[0].u);
  const hasRole = async (r: string) => (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r])).rowCount === 1;
  const rdsIam = await hasRole('rds_iam');
  await c.query('BEGIN');
  for (const r of ['alm_app', 'alm_readonly']) if (!(await hasRole(r))) await c.query(`CREATE ROLE ${r} NOLOGIN NOBYPASSRLS`);
  if (!(await hasRole('alm_audit_owner'))) await c.query('CREATE ROLE alm_audit_owner NOLOGIN');
  // PG15+는 public 스키마 CREATE가 기본 회수 → 소유권을 받을 역할(감사 소유)과 월 파티션을 만들 역할에 준다
  await c.query('GRANT USAGE, CREATE ON SCHEMA public TO alm_audit_owner');
  // 로그인 계정(IAM 토큰). 비밀번호 없음 — rds_iam이 없는 로컬은 시험에서 따로 비밀번호를 준다
  const logins: [string, string][] = [['alm_app_login', 'alm_app'], ['alm_owner_iam', me], ['alm_archive_login', 'alm_audit_owner']];
  for (const [login, member] of logins) {
    if (!(await hasRole(login))) await c.query(`CREATE ROLE ${login} LOGIN NOBYPASSRLS`);
    if (member !== me) { await c.query(`GRANT ${ident(member)} TO ${login}`); }
    else {
      // PG16은 RDS 마스터가 자기 자신의 멤버십을 줄 수 없다(ADMIN 없음) → 건너뛴다. alm_owner_iam은 partman 전용, 3.4 2차에서 정리
      await c.query('SAVEPOINT g');
      try { await c.query(`GRANT ${ident(member)} TO ${login}`); await c.query('RELEASE SAVEPOINT g'); }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT g'); log.warn('owner grant skipped', { login, err: String(e) }); }
    }
    if (rdsIam) await c.query(`GRANT rds_iam TO ${login}`);
  }
  // 이후 마이그레이션이 만드는 테이블에도 같은 권한(0001은 직접 GRANT)
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alm_app`);
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA public GRANT SELECT ON TABLES TO alm_readonly`);
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO alm_app`);
  const pgaudit = (await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'pgaudit'`)).rowCount === 1;
  if (pgaudit) await c.query('CREATE EXTENSION IF NOT EXISTS pgaudit');
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version varchar(4) PRIMARY KEY, file varchar(200) NOT NULL, checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by varchar(63) NOT NULL DEFAULT session_user)`);
  await c.query('REVOKE ALL ON schema_migrations FROM alm_app, alm_readonly');
  await c.query('COMMIT');
  log.info('bootstrap ok', { owner: me, rdsIam, pgaudit });
}

// 감사 객체 소유권을 넘기려면(ALTER … OWNER TO alm_audit_owner) PG16에서는 그 역할로 SET ROLE 할 수 있어야 한다.
// 적용하는 동안만 SET 권한을 받고 끝나면 회수한다(파이프라인 계정이 평소에는 감사 소유 역할이 아니도록, 09 8장)
async function withAuditOwner<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  const can = (await c.query(`SELECT pg_has_role(current_user, 'alm_audit_owner', 'SET') AS ok`)).rows[0].ok as boolean;
  if (!can) await c.query('GRANT alm_audit_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE');
  try { return await fn(); } finally {
    if (!can) await c.query('REVOKE alm_audit_owner FROM CURRENT_USER').catch((e) => log.warn('audit owner revoke failed', { err: String(e) }));
  }
}

export async function migrate(c: Client, migrations = loadMigrations()): Promise<string[]> {
  await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await bootstrap(c);
    const applied = new Map((await c.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]));
    const done: string[] = [];
    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`${m.file}: 이미 적용된 파일의 내용이 바뀌었다. 새 번호 파일로 추가한다`);
        continue;
      }
      const t0 = Date.now();
      await withAuditOwner(c, async () => {
        await c.query('BEGIN');
        try {
          await c.query(m.sql);
          await c.query('INSERT INTO schema_migrations (version, file, checksum) VALUES ($1, $2, $3)', [m.version, m.file, m.checksum]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      });
      log.info('migration applied', { file: m.file, ms: Date.now() - t0 });
      done.push(m.file);
    }
    log.info('migrate done', { applied: done.length, total: migrations.length });
    return done;
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
  }
}

export async function ownerClient(cfg: Config): Promise<Client> {
  const user = cfg.dbMaster?.user ?? cfg.db.user;
  const password = cfg.dbMaster?.password ?? cfg.db.password ??
    (await new Signer({ hostname: cfg.db.host, port: cfg.db.port, username: user, region: cfg.region }).getAuthToken());
  const c = new Client({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user, password, ssl: sslOption(cfg.db.ssl),
    application_name: 'alm-migrate', connectionTimeoutMillis: 15_000 });
  await c.connect();
  return c;
}

export async function runMigrate(cfg: Config): Promise<void> {
  const c = await ownerClient(cfg);
  try { await migrate(c); } finally { await c.end(); }
}
