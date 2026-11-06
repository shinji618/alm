// 0021: tenant.central_tenant_id + auth_tenant_by_central_id(): 중앙 테넌트 ID → ALM 테넌트 ID(활성만)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_m21_${Date.now()}`;
after(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

test('0021: 중앙 테넌트 ID로 ALM 테넌트를 찾는다(비활성·미등록은 null)', { skip }, async () => {
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  const o = new Client({ host, port, user: 'postgres', database: dbName });
  await o.connect();
  try {
    await migrate(o, loadMigrations(join(__dirname, '..', '..', 'migrations')));
    const A = '00000000-0000-0000-0000-0000000000a1', B = '00000000-0000-0000-0000-0000000000a2';
    const CA = '9b713b63-5074-4c82-9a91-58aab684d859', CB = '9b713b63-5074-4c82-9a91-58aab684d860';
    await o.query(`INSERT INTO tenant (id, code, name, idp_provider_name, central_tenant_id) VALUES ($1,'M21A','a','T-M21A',$2)`, [A, CA]);
    await o.query(`INSERT INTO tenant (id, code, name, idp_provider_name, central_tenant_id, is_active) VALUES ($1,'M21B','b','T-M21B',$2,false)`, [B, CB]);
    const f = async (id: string) => (await o.query('SELECT auth_tenant_by_central_id($1) AS id', [id])).rows[0].id;
    assert.equal(await f(CA), A);
    assert.equal(await f(CB), null, '비활성 테넌트');
    assert.equal(await f('00000000-0000-0000-0000-000000000000'), null, '미등록');
  } finally { await o.end(); }
});
