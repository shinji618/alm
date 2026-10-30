// 0020: 시스템이 만든 카테고리 'SAP 미분류' → 'SAP Unclassified'. 관리자가 직접 고친 이름은 그대로
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, loadMigrations } from '../src/ops/migrate';

const host = process.env.TEST_PG_HOST;
const port = Number(process.env.TEST_PG_PORT || 5432);
const skip = !host && 'TEST_PG_HOST 없음';
const dbName = `alm_m20_${Date.now()}`;
after(async () => {
  if (skip) return;
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await su.end();
});

test('0020: 기본 이름만 영문으로 바꾼다(이미 고친 이름·다른 테넌트도 각자)', { skip }, async () => {
  const su = new Client({ host, port, user: 'postgres', database: 'postgres' });
  await su.connect(); await su.query(`CREATE DATABASE ${dbName}`); await su.end();
  const o = new Client({ host, port, user: 'postgres', database: dbName });
  await o.connect();
  try {
    const all = loadMigrations(join(__dirname, '..', '..', 'migrations'));
    const idx = all.findIndex((m) => m.file.startsWith('0020_'));
    assert.ok(idx > 0, '0020 파일이 있다');
    await migrate(o, all.slice(0, idx));
    const mk = async (id: string, code: string, name: string) => {
      await o.query(`INSERT INTO tenant (id, code, name, idp_provider_name) VALUES ($1, $2, 't', $3)`, [id, code, `T-${code}`]);
      await o.query(`INSERT INTO category (id, tenant_id, category_code, name) VALUES (gen_random_uuid(), $1, 'SAP-UNCLASSIFIED', $2)`, [id, name]);
    };
    await mk('00000000-0000-0000-0000-0000000000c1', 'M20A', 'SAP 미분류');
    await mk('00000000-0000-0000-0000-0000000000c2', 'M20B', '기타 SAP 자산');
    await migrate(o, all);
    const rows = (await o.query(`SELECT t.code, c.name FROM category c JOIN tenant t ON t.id = c.tenant_id ORDER BY t.code`)).rows;
    assert.deepEqual(rows, [{ code: 'M20A', name: 'SAP Unclassified' }, { code: 'M20B', name: '기타 SAP 자산' }]);
    assert.deepEqual(await migrate(o, all), [], '다시 적용해도 변화 없음');
  } finally { await o.end(); }
});
