// 경계 시험(17 문서 3장): platform/identity는 ALM 모듈(assets·requests·admin 등)을 import하지 않는다. 허용: 같은 모듈, common, db, 외부 패키지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const root = join(__dirname, '..', '..', 'src');
const dir = join(root, 'platform', 'identity');
const ALLOWED = ['platform/identity', 'common', 'db'];

test('platform/identity는 ALM 모듈을 import하지 않는다', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 7);
  const bad: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/from '(\.[^']*)'/g)) {
      const target = relative(root, resolve(dir, m[1])).replace(/\\/g, '/');
      if (!ALLOWED.some((a) => target === a || target.startsWith(`${a}/`))) bad.push(`${f} → ${target}`);
    }
  }
  assert.deepEqual(bad, []);
});
