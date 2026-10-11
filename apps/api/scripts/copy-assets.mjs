// 빌드 산출물에 실행 때 읽는 파일을 넣는다: 권한 카탈로그(api/permissions.json), 마이그레이션 SQL
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
mkdirSync(join(root, 'dist'), { recursive: true });
const perms = existsSync(join(root, 'permissions.json')) ? join(root, 'permissions.json') : join(repo, 'api', 'permissions.json');
cpSync(perms, join(root, 'dist', 'permissions.json'));
cpSync(join(root, 'migrations'), join(root, 'dist', 'migrations'), { recursive: true });
