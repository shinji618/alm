import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seal, open, s256 } from '../src/auth/crypto';
import { catalog, effectiveRoles, permissionsOf, permissionFor } from '../src/auth/permissions';
import { safeReturnTo, domainOf } from '../src/http/auth.controller';
import { stripTx } from '../src/ops/migrate';
import { parseSeed } from '../src/ops/seed';
import { Worker, parseJob } from '../src/worker/worker';
import { channelOfPath } from '../src/http/auth.guard';
import { loadConfig } from '../src/config';

const k1 = Buffer.alloc(32, 1), k2 = Buffer.alloc(32, 2);
const cat = catalog(join(__dirname, '..', '..', '..', '..', 'api', 'permissions.json'));

test('쿠키 봉인: 왕복·용도 불일치·키 교체·만료·변조', () => {
  const v = seal([k1], 'alm_rt', { rt: 'x' }, 60);
  assert.equal(open<{ rt: string }>([k1], 'alm_rt', v)?.rt, 'x');
  assert.equal(open([k1], 'alm_pkce', v), undefined);
  assert.equal(open<{ rt: string }>([k2, k1], 'alm_rt', v)?.rt, 'x', '이전 키로도 열린다');
  assert.equal(open([k2], 'alm_rt', v), undefined);
  assert.equal(open([k1], 'alm_rt', seal([k1], 'alm_rt', {}, -1)), undefined, '만료');
  const b = Buffer.from(v, 'base64url'); b[b.length - 1] ^= 1;
  assert.equal(open([k1], 'alm_rt', b.toString('base64url')), undefined, '변조');
  assert.equal(open([k1], 'alm_rt', 'garbage'), undefined);
  assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // RFC 7636 부록 B
});

test('권한: 암묵 EMPLOYEE·감사인 배타·ALL 우선', () => {
  assert.deepEqual(effectiveRoles([], cat), ['EMPLOYEE']);
  assert.deepEqual(effectiveRoles(['AUDITOR', 'SYS_ADMIN'], cat), ['AUDITOR']);
  assert.deepEqual(effectiveRoles(['ASSET_MANAGER'], cat).sort(), ['ASSET_MANAGER', 'EMPLOYEE']);
  const p = permissionsOf(effectiveRoles(['ASSET_MANAGER'], cat), cat);
  assert.deepEqual(p.get('asset.read'), ['ALL'], 'EMPLOYEE OWN + 관리자 ALL → ALL');
  assert.ok(p.has('auth'));
  const e = permissionsOf(['EMPLOYEE'], cat);
  assert.deepEqual(e.get('asset.read'), ['OWN']);
  assert.equal(e.has('asset.write'), false);
  assert.equal(permissionFor('getMe', cat), 'auth');
  assert.equal(permissionFor('authLogin', cat), null);
  assert.equal(permissionFor('nope', cat), undefined);
  assert.equal(cat.permissions.length, 39);
});

test('권한 카탈로그가 openapi의 모든 operationId(웹·PDA·SAP)를 덮는다', () => {
  const yaml = readFileSync(join(__dirname, '..', '..', '..', '..', 'api', 'openapi.yaml'), 'utf8');
  const ops = [...yaml.matchAll(/operationId:\s*(\w+)/g)].map((m) => m[1]);
  assert.ok(ops.length > 100);
  assert.deepEqual(ops.filter((o) => !(o in cat.operations)), []);
  assert.equal(cat.operations.sapToken, null); assert.equal(cat.operations.sapPing, 'sap.api'); assert.equal(cat.operations.pdaGetMe, 'count.scan');
});

test('returnTo·이메일 도메인·채널', () => {
  assert.equal(safeReturnTo('/assets?id=1'), '/assets?id=1');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', undefined, '/a b']) assert.equal(safeReturnTo(bad), '/');
  assert.equal(domainOf('Kim@BSGGlobal.com'), 'bsgglobal.com');
  assert.equal(domainOf('no-at'), undefined);
  assert.equal(channelOfPath('/api/v1/pda/me'), 'PDA');
  assert.equal(channelOfPath('/api/v1/sap/postings'), 'SAP');
  assert.equal(channelOfPath('/api/v1/me'), 'WEB');
});

test('마이그레이션 파일의 바깥 트랜잭션 제거', () => {
  assert.equal(stripTx('-- x\nBEGIN;\nCREATE TABLE a();\nCOMMIT;\n').trim(), '-- x\n\nCREATE TABLE a();');
  const s = stripTx('BEGIN;\nDO $$ BEGIN NULL; END $$;\nCOMMIT;\n');
  assert.ok(s.includes('DO $$ BEGIN NULL; END $$;') && !/^COMMIT;/m.test(s));
});

test('seed 입력 검증', () => {
  const ok = parseSeed('{"tenant":{"code":"TEST","name":"t","idpType":"OIDC"},"domains":["example.com"],"users":[{"email":"a@example.com","displayName":"A","roles":["SYS_ADMIN"]}]}');
  assert.equal(ok.tenant.code, 'TEST');
  assert.throws(() => parseSeed('{"tenant":{"code":"t","name":"t","idpType":"OIDC"},"domains":["example.com"]}'));
  assert.throws(() => parseSeed('{"tenant":{"code":"T","name":"t","idpType":"OIDC"},"domains":["Example.com"]}'));
  assert.throws(() => parseSeed('{"tenant":{"code":"T","name":"t","idpType":"OIDC"},"domains":["e.com"],"users":[{"email":"a@e.com","displayName":"A","roles":["AUDITOR"]}]}'));
  assert.throws(() => parseSeed(undefined));
  const base = '"tenant":{"code":"T","name":"t","idpType":"OIDC"},"domains":["e.com"]';
  assert.throws(() => parseSeed(`{${base},"sapConnections":[{"systemId":"S4D100","companyCode":"1000","clientId":"abc"}]}`), /systemId/);
  assert.throws(() => parseSeed(`{${base},"companies":[{"code":"10000","name":"x"}]}`), /companies.code/);
  assert.equal(parseSeed(`{${base},"companies":[{"code":"1000","name":"BSG"}],"sapConnections":[{"systemId":"S4D-100","companyCode":"1000","clientId":"abc","allowedCidrs":["1.2.3.4/32"]}]}`).sapConnections?.length, 1);
});

test('작업 큐: 처리기 없는 유형·깨진 메시지는 지우고, 처리기 오류는 남긴다', async () => {
  assert.equal(parseJob('{"type":"sap-watch"}')?.type, 'sap-watch');
  assert.equal(parseJob('nope'), undefined);
  const deleted: string[] = [];
  const sqs = { send: async (cmd: { constructor: { name: string }; input: any }) => {
    if (cmd.constructor.name === 'ReceiveMessageCommand') return { Messages: [
      { MessageId: '1', ReceiptHandle: 'r1', Body: '{"type":"sap-watch","source":"scheduler"}' },
      { MessageId: '2', ReceiptHandle: 'r2', Body: 'not json' },
      { MessageId: '3', ReceiptHandle: 'r3', Body: '{"type":"boom"}' },
      { MessageId: '4', ReceiptHandle: 'r4', Body: '{"type":"ok"}' },
    ] };
    deleted.push(...cmd.input.Entries.map((e: { ReceiptHandle: string }) => e.ReceiptHandle));
    return {};
  } };
  const ran: string[] = [];
  const w = new Worker(sqs as never, 'https://sqs/q', { boom: async () => { throw new Error('x'); }, ok: async (j) => { ran.push(j.type); } });
  assert.equal(await w.pollOnce(0), 3);
  assert.deepEqual(deleted.sort(), ['r1', 'r2', 'r4']);
  assert.deepEqual(ran, ['ok']);
});

test('설정: 이전 작업 정의(CACHE_NAME 없음)로 새 이미지를 돌려도 migrate가 시작한다', () => {
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { DB_HOST: 'h', DB_MASTER_PASSWORD: 'x', CACHE_ENDPOINT: 'c.cache.amazonaws.com', CACHE_USER: 'u', MAIL_FROM: 'no-reply@x.test' });
    delete process.env.CACHE_NAME; delete process.env.DB_IAM_USER;
    const c = loadConfig('migrate');
    assert.equal(c.cache, undefined);
    assert.equal(c.db.user, 'alm_owner');
    process.env.CACHE_NAME = 'alm-dev';
    assert.deepEqual(loadConfig('migrate').cache, { endpoint: 'c.cache.amazonaws.com', user: 'u', name: 'alm-dev' });
  } finally { process.env = keep; }
});
