// 공유 호출 제한(Valkey)·IAM 토큰·메일 템플릿 단위 시험. TEST_VALKEY_HOST가 있으면 실제 Valkey(로컬, 인증 없음)로도 센다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCounterStore, SharedLimiter, ValkeyCounterStore, elasticacheIamToken, CounterStore } from '../src/common/shared';
import { render } from '../src/notify/templates';
import { parseSesEvent } from '../src/notify/mail';

test('호출 제한: 고정 창, 초과 시 다음 창까지 남은 초, 키별로 따로', async () => {
  let now = 1_000_000_040_000;                     // 창(60초) 시작 + 20초
  const lim = new SharedLimiter(new MemoryCounterStore(() => now), () => now);
  for (let i = 0; i < 3; i++) assert.equal(await lim.hit('u:web:a', 3), 0);
  assert.equal(await lim.hit('u:web:a', 3), 40, '4번째는 40초 뒤');
  assert.equal(await lim.hit('u:web:b', 3), 0, '다른 키');
  now += 40_000;                                   // 다음 창
  assert.equal(await lim.hit('u:web:a', 3), 0);
});

test('호출 제한: 저장소 장애면 허용(fail-open)', async () => {
  const broken: CounterStore = { incr: async () => { throw new Error('down'); }, close: async () => undefined };
  const lim = new SharedLimiter(broken);
  for (let i = 0; i < 5; i++) assert.equal(await lim.hit('k', 1), 0);
});

test('호출 제한: Valkey 저장소는 MULTI INCR + EXPIRE NX', async () => {
  const calls: string[] = [];
  const fake = { multi() {
    const p = { incr: (k: string) => (calls.push(`incr ${k}`), p), expire: (k: string, s: number, m: string) => (calls.push(`expire ${k} ${s} ${m}`), p),
      exec: async () => [[null, 7], [null, 1]] as [Error | null, unknown][] };
    return p;
  }, quit: async () => 'OK' };
  const s = new ValkeyCounterStore(fake);
  assert.equal(await s.incr('rl:x:1', 65), 7);
  assert.deepEqual(calls, ['incr rl:x:1', 'expire rl:x:1 65 NX']);
});

test('실제 Valkey로 세기', { skip: !process.env.TEST_VALKEY_HOST && 'TEST_VALKEY_HOST 없음' }, async () => {
  const { default: Redis } = await import('ioredis');
  const r = new Redis({ host: process.env.TEST_VALKEY_HOST, port: Number(process.env.TEST_VALKEY_PORT || 6379) });
  const lim = new SharedLimiter(new ValkeyCounterStore(r as never));
  const key = `t:${Date.now()}`;
  assert.equal(await lim.hit(key, 2), 0);
  assert.equal(await lim.hit(key, 2), 0);
  assert.ok((await lim.hit(key, 2)) > 0);
  await lim.close();
});

test('ElastiCache IAM 토큰: 캐시 이름 + connect 사전 서명(15분)', async () => {
  const t = await elasticacheIamToken({ cacheName: 'alm-dev', userId: 'alm-dev-app', region: 'us-east-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }, now: new Date('2026-10-12T00:00:00Z') });
  assert.match(t, /^alm-dev\/\?/);
  for (const p of ['Action=connect', 'User=alm-dev-app', 'ResourceType=ServerlessCache', 'X-Amz-Expires=900', 'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'X-Amz-Credential=AKIDEXAMPLE%2F20261012%2Fus-east-1%2Felasticache%2Faws4_request', 'X-Amz-Signature=']) assert.ok(t.includes(p), p);
});

test('메일 템플릿: 언어, 이스케이프, 줄바꿈 제거, 앱 안 링크만', () => {
  const m = render('APPROVAL_REQUESTED', 'ko', { requester: '<b>홍길동</b>', requestType: '이관', requestNo: 'AR-1\r\nBcc: x@y.z', target: 'NB-001',
    path: '/requests/123' }, 'https://alm.example.test');
  assert.equal(m.subject, '[ALM] 승인 요청: AR-1 Bcc: x@y.z', '제목에 줄바꿈이 남지 않는다');
  assert.ok(m.html.includes('&lt;b&gt;홍길동&lt;/b&gt;') && !m.html.includes('<b>홍'));
  assert.ok(m.html.includes('href="https://alm.example.test/requests/123"'));
  assert.ok(m.text.includes('요청 보기: https://alm.example.test/requests/123'));
  const en = render('APPROVAL_DECIDED', 'en', { approver: 'Kim', requestNo: 'AR-2', decision: 'REJECTED', path: 'https://evil.test/x' }, 'https://alm.example.test');
  assert.equal(en.subject, '[ALM] Rejected: AR-2');
  assert.ok(!en.html.includes('evil.test'), '바깥 링크는 만들지 않는다');
  assert.throws(() => render('NOPE', 'ko', {}, ''), /모르는 메일 템플릿/);
});

test('SES 이벤트 메시지 해석', () => {
  assert.equal(parseSesEvent('{"eventType":"Bounce","mail":{}}')?.type, 'ses-event');
  assert.equal(parseSesEvent('{"Type":"Notification"}'), undefined);
  assert.equal(parseSesEvent('x'), undefined);
});
