// 스키마 적용(마스터 계정, Data API 또는 pg). 파일 이름 순서, 적용 기록 schema_migrations, 같은 파일은 한 번만.
// 앱 계정(id_app) 비밀번호는 마이그레이션 뒤 비밀(id/<env>/db-app)의 값으로 맞춘다
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tx } from './db';

export interface Migration { file: string; sql: string }
export function loadMigrations(dir = join(__dirname, 'migrations')): Migration[] {
  return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }));
}

// 문장 단위로 나눈다(Data API는 한 호출에 한 문장). $$…$$ 본문과 문자열 안의 ;는 나누지 않는다
export function splitSql(sql: string): string[] {
  const out: string[] = []; let cur = '', i = 0, dollar: string | null = null, quote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (!dollar && !quote && ch === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; continue; }
    if (!quote) {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { if (dollar === m[0]) dollar = null; else if (!dollar) dollar = m[0]; cur += m[0]; i += m[0].length; continue; }
    }
    if (!dollar && ch === "'") quote = !quote;
    if (!dollar && !quote && ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function migrate(c: Tx, ms: Migration[], appPassword?: string): Promise<string[]> {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (file varchar(200) PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Map((await c.query(`SELECT file, checksum FROM schema_migrations`)).rows.map((r) => [r.file as string, r.checksum as string]));
  const applied: string[] = [];
  for (const m of ms) {
    const sum = createHash('sha256').update(m.sql).digest('hex');
    if (done.has(m.file)) { if (done.get(m.file) !== sum) throw new Error(`적용된 마이그레이션이 바뀌었습니다: ${m.file}`); continue; }
    for (const s of splitSql(m.sql)) await c.query(s);
    await c.query(`INSERT INTO schema_migrations (file, checksum) VALUES ($1, $2)`, [m.file, sum]);
    applied.push(m.file);
  }
  if (appPassword) {
    if (!/^[A-Za-z0-9]{32,128}$/.test(appPassword)) throw new Error('앱 계정 비밀번호 형식(영숫자 32자 이상)');
    await c.query(`ALTER ROLE id_app WITH LOGIN PASSWORD '${appPassword}'`);
  }
  return applied;
}
