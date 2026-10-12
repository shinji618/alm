// 감사 기록 월 파티션 관리·S3 보관(09 8.3). 보관 계정(alm_archive_login)으로 실행하고 S3는 메모리로 흉내 낸다.
//   TEST_PG_HOST=/tmp TEST_PG_PORT=55432 npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { ArchiveStore, archiveAll, candidates, maintainPartitions, keysOf } from '../src/ops/archive';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_archive_${Date.now()}`;
const T = '00000000-0000-0000-0000-0000000000aa';

let su: Client;        // 슈퍼유저(시험 데이터 준비)
let arc: Client;       // 보관 계정

class MemStore implements ArchiveStore {
  objects = new Map<string, Buffer[]>();      // 버전 관리 흉내(덮어쓰지 않고 쌓는다)
  corrupt = false;
  async head(key: string) {
    const v = this.objects.get(key)?.at(-1);
    return v ? { sha256: createHash('sha256').update(v).digest('base64') } : null;
  }
  async put(key: string, body: Buffer, sha256: string) {
    assert.equal(createHash('sha256').update(body).digest('base64'), sha256, 'S3가 검증하는 체크섬');
    this.objects.set(key, [...(this.objects.get(key) ?? []), Buffer.from(body)]);
  }
  async get(key: string) {
    const v = this.objects.get(key)!.at(-1)!;
    return this.corrupt ? Buffer.concat([v, Buffer.from('x')]) : v;
  }
}

const monthStart = (back: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);

before(async () => {
  if (skip) return;
  const admin = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  su = new Client({ host, port, user: 'postgres', database: dbName });
  await su.connect();
  await migrate(su, loadMigrations(join(__dirname, '..', '..', 'migrations')));
  await su.query(`ALTER ROLE alm_archive_login PASSWORD 'test'`);
  arc = new Client({ host, port, user: 'alm_archive_login', password: 'test', database: dbName });
  await arc.connect();
  await su.query(`INSERT INTO tenant (id, code, name, idp_provider_name) VALUES ('${T}', 'ARC', 'arc', 'T-ARC')`);
});

after(async () => {
  if (skip) return;
  await arc?.end();
  await su?.end();
  const admin = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

test('partman: 보관 계정으로 이번 달 ~ 3개월 뒤 파티션 확인(멱등), 파티션 소유자는 alm_audit_owner', { skip }, async () => {
  assert.deepEqual(await maintainPartitions(arc), [], 'migrate가 이미 만들었다');
  const owners = (await su.query(`SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent IN ('audit_log'::regclass, 'security_event'::regclass)`)).rows.map((r) => r.o);
  assert.deepEqual(owners, ['alm_audit_owner']);
  // 보관 계정도 앱처럼 감사 기록을 고치거나 다른 표를 바꿀 수는 없다
  await arc.query(`SELECT set_config('app.tenant_id', '${T}', false)`);   // RLS 식이 계획 단계에서 먼저 평가되지 않게
  await assert.rejects(arc.query(`UPDATE tenant SET name = 'x'`), /permission denied/);
  await assert.rejects(arc.query(`DELETE FROM asset`), /permission denied/);
  await arc.query(`RESET app.tenant_id`);
});

test('audit-archive: 14개월 전 이전 파티션만 S3로 → 체크섬·건수 확인 → 분리·삭제, 다시 실행하면 대상 없음', { skip }, async () => {
  // 18개월 전부터 파티션을 만들고(실제로는 그 달에 만들어져 있다) 오래된 행을 넣는다
  await su.query('SELECT log_partition_maintain(0, 18)');
  const old = monthStart(16), keep = monthStart(13);
  await su.query(`INSERT INTO security_event (id, tenant_id, event_type, actor_type, channel, occurred_at, detail)
    SELECT gen_random_uuid(), '${T}', 'LOGIN', 'USER', 'WEB', $1::timestamptz + make_interval(secs => g), jsonb_build_object('n', g)
      FROM generate_series(1, 12001) g`, [old]);                            // 5,000건 단위 3번 넘게 읽는다
  await su.query(`INSERT INTO security_event (id, tenant_id, event_type, actor_type, channel, occurred_at)
    VALUES (gen_random_uuid(), '${T}', 'LOGOUT', 'USER', 'WEB', $1)`, [keep]);
  await su.query(`INSERT INTO audit_log (id, tenant_id, table_name, row_id, action, actor_type, db_user, tx_id, occurred_at)
    VALUES (gen_random_uuid(), '${T}', 'asset', gen_random_uuid(), 'INSERT', 'SYSTEM', 'x', 1, $1)`, [old]);

  const list = await candidates(arc);
  assert.ok(list.every((p) => p.month <= iso(monthStart(14))), '13개월 온라인 기간은 남긴다');
  assert.ok(list.some((p) => p.partition.startsWith('security_event_p') && p.month === iso(old)));
  assert.ok(!list.some((p) => p.month === iso(keep)));
  assert.deepEqual(await archiveAll(arc, new MemStore(), 'test', { dryRun: true }), [], 'dry-run은 아무것도 안 한다');

  const store = new MemStore();
  const res = await archiveAll(arc, store, 'test');
  assert.equal(res.length, list.length);
  const se = res.find((r) => r.table === 'security_event' && r.month === iso(old))!;
  assert.equal(se.rows, 12001);
  assert.equal(se.key, keysOf('test', se).data);
  assert.match(se.key, /^test\/audit\/security_event\/year=\d{4}\/month=\d{2}\/security_event_p\d{6}\.ndjson\.gz$/);
  const lines = gunzipSync(store.objects.get(se.key)!.at(-1)!).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 12001);
  assert.deepEqual(lines.slice(0, 3).map((l) => l.detail.n), [1, 2, 3], 'occurred_at 순서');
  assert.equal(lines[0].tenant_id, T);
  const manifest = JSON.parse(store.objects.get(keysOf('test', se).manifest)!.at(-1)!.toString('utf8'));
  assert.equal(manifest.rows, 12001);
  assert.equal(manifest.sha256, createHash('sha256').update(store.objects.get(se.key)!.at(-1)!).digest('base64'));

  const left = (await su.query(`SELECT
      (SELECT count(*)::int FROM security_event WHERE occurred_at < $1) AS old_rows,
      (SELECT count(*)::int FROM security_event WHERE occurred_at >= $1) AS kept,
      (SELECT count(*)::int FROM audit_log WHERE occurred_at < $1) AS old_audit,
      (SELECT count(*)::int FROM pg_class WHERE relname = $2) AS part`, [monthStart(14 - 1), se.partition])).rows[0];
  assert.deepEqual(left, { old_rows: 0, kept: 1, old_audit: 0, part: 0 });
  assert.deepEqual(await candidates(arc), []);
});

test('audit-archive: 이미 같은 파일이 있으면 다시 올리지 않고, 내려받은 내용이 다르면 삭제하지 않는다', { skip }, async () => {
  const m = monthStart(17);
  await su.query('SELECT log_partition_maintain(0, 18)');                // 앞 시험이 지운 빈 파티션 다시 만들기
  await su.query(`INSERT INTO security_event (id, tenant_id, event_type, actor_type, channel, occurred_at)
    VALUES (gen_random_uuid(), '${T}', 'LOGIN', 'USER', 'WEB', $1)`, [m]);
  const store = new MemStore();
  store.corrupt = true;
  await assert.rejects(archiveAll(arc, store, 'test'), /체크섬 불일치/);
  const part = `security_event_p${iso(m).slice(0, 7).replace('-', '')}`;
  assert.equal((await su.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = $1`, [part])).rows[0].n, 1, '파티션 남음');
  store.corrupt = false;
  const [r] = await archiveAll(arc, store, 'test');
  assert.equal(r.uploaded, false, '같은 체크섬이면 다시 올리지 않음');
  assert.equal(store.objects.get(r.key)!.length, 1);
  assert.equal(r.dropped, true);
});

test('log_partition_drop: 앱 계정은 실행 불가, 보관 계정도 13개월 안 파티션은 거부', { skip }, async () => {
  await assert.rejects(arc.query('SELECT log_partition_drop($1, $2::date, 0)', ['security_event', iso(monthStart(1))]), /online window/);
  await su.query(`ALTER ROLE alm_app_login PASSWORD 'test'`);
  const app = new Client({ host, port, user: 'alm_app_login', password: 'test', database: dbName });
  await app.connect();
  try {
    await assert.rejects(app.query('SELECT log_partition_drop($1, $2::date, 0)', ['security_event', '2000-01-01']), /permission denied/);
    await assert.rejects(app.query('SELECT count(*) FROM security_event_default'), /permission denied/);
  } finally { await app.end(); }
});
