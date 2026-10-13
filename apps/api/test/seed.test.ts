// seed: ALM 시험 마스터(infra/scripts/seed/dev-masters.json) 멱등 등록. 로컬 PostgreSQL 16(TEST_PG_HOST)이 있을 때만
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';
import { parseSeed, seed } from '../src/ops/seed';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_seed_${Date.now()}`;
let owner: Client;

before(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  owner = new Client({ host, port, user: 'postgres', database: dbName });
  await owner.connect();
  await migrate(owner, loadMigrations(join(__dirname, '..', '..', 'migrations')));
});
after(async () => {
  if (skip) return;
  await owner?.end();
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

test('seed masters: 있는 테넌트에 마스터만, 다시 실행해도 같은 결과, 없는 자산클래스는 비움', { skip }, async () => {
  const raw = readFileSync(join(__dirname, '..', '..', '..', '..', 'infra', 'scripts', 'seed', 'dev-masters.json'), 'utf8');
  assert.throws(() => parseSeed('{"tenant":{"code":"TEST","name":"x"}}'), /idpType/);
  await assert.rejects(seed(owner, parseSeed(raw)), /테넌트 TEST가 없다/);
  const { tenantId } = await seed(owner, { tenant: { code: 'TEST', name: 'Okta 시험', idpType: 'OIDC', jitProvision: true }, domains: ['bsgglobal.com'] });
  await owner.query(`INSERT INTO asset_class (id, tenant_id, class_code, name) VALUES (gen_random_uuid(), $1, '00003200', 'IT HW')`, [tenantId]);
  await seed(owner, parseSeed(raw));
  await seed(owner, parseSeed(raw));
  const n = async (t: string) => (await owner.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  assert.deepEqual([await n('site'), await n('room'), await n('category'), await n('model'), await n('vendor'), await n('label_template')], [2, 10, 10, 10, 5, 1]);
  assert.equal((await owner.query(`SELECT jit_provision FROM tenant WHERE code = 'TEST'`)).rows[0].jit_provision, true, '테넌트 설정은 그대로');
  assert.deepEqual((await owner.query(`SELECT c.category_code, p.category_code AS parent, ac.class_code FROM category c LEFT JOIN category p ON p.id = c.parent_id
    LEFT JOIN asset_class ac ON ac.id = c.default_asset_class_id WHERE c.category_code IN ('NB', 'MON') ORDER BY 1`)).rows,
    [{ category_code: 'MON', parent: 'IT', class_code: null }, { category_code: 'NB', parent: 'IT', class_code: '00003200' }]);
  assert.deepEqual((await owner.query(`SELECT room_code, barcode FROM room WHERE is_storage ORDER BY 1`)).rows,
    [{ room_code: 'ATL-STO', barcode: 'RM-ATL-STO' }, { room_code: 'DUL-STO', barcode: 'RM-DUL-STO' }]);
});
