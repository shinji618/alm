// 여러 api·worker 작업이 함께 쓰는 호출 제한 카운터(10 정의서 6.4, 결정 A-13).
// ElastiCache Serverless for Valkey: TLS + IAM 인증(15분 토큰, 연결 때만 확인 → 10분마다 새 토큰을 다음 재연결용으로 넣어 둔다).
// 장애 때는 제한을 건너뛰고(fail-open) 경고만 남긴다. 캐시는 성능·공정성용이고 권한 판단 근거는 DB에 있다.
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, Provider } from '@smithy/types';
import { log } from './log';

export interface CounterStore {
  // key를 1 올리고 이번 창의 값을 돌려준다. 키는 ttlSec 뒤 사라진다
  incr(key: string, ttlSec: number): Promise<number>;
  close(): Promise<void>;
}

// 로컬·시험용(작업마다 따로 센다)
export class MemoryCounterStore implements CounterStore {
  private m = new Map<string, { n: number; until: number }>();
  constructor(private now = () => Date.now()) {}
  async incr(key: string, ttlSec: number) {
    const t = this.now();
    const e = this.m.get(key);
    if (!e || e.until <= t) {
      if (this.m.size > 20_000) for (const [k, v] of this.m) if (v.until <= t) this.m.delete(k);
      this.m.set(key, { n: 1, until: t + ttlSec * 1000 });
      return 1;
    }
    return ++e.n;
  }
  async close() { this.m.clear(); }
}

interface Pipeline { incr(k: string): Pipeline; expire(k: string, s: number, mode: 'NX'): Pipeline; exec(): Promise<[Error | null, unknown][] | null> }
type RedisLike = { multi(): Pipeline; quit(): Promise<unknown> };
export class ValkeyCounterStore implements CounterStore {
  constructor(private r: RedisLike, private onClose?: () => void) {}
  async incr(key: string, ttlSec: number) {
    const res = await this.r.multi().incr(key).expire(key, ttlSec, 'NX').exec();
    const [err, n] = res?.[0] ?? [new Error('Valkey MULTI 결과 없음'), 0];
    if (err) throw err;
    return Number(n);
  }
  async close() { this.onClose?.(); await this.r.quit().catch(() => undefined); }
}

// 고정 창 호출 제한. 허용이면 0, 초과면 다시 시도할 수 있을 때까지 남은 초(Retry-After)
export class SharedLimiter {
  private lastWarn = 0;
  constructor(private store: CounterStore, private now = () => Date.now()) {}
  async hit(key: string, limit: number, windowSec = 60): Promise<number> {
    const t = this.now() / 1000;
    const slot = Math.floor(t / windowSec);
    try {
      const n = await this.store.incr(`rl:${key}:${slot}`, windowSec + 5);
      return n > limit ? Math.max(1, Math.ceil((slot + 1) * windowSec - t)) : 0;
    } catch (e) {
      if (this.now() - this.lastWarn > 60_000) { this.lastWarn = this.now(); log.warn('rate limit store unavailable, allowing (fail-open)', { err: String(e) }); }
      return 0;
    }
  }
  close() { return this.store.close(); }
}

// 10 정의서 6.4 한도(분당)
export const LIMITS = { webUser: 600, pdaUser: 120, sapClient: 300, sapToken: 10, tenant: 3000 } as const;

// ElastiCache IAM 인증 토큰: "<캐시 이름>/?Action=connect&User=<사용자 ID>&ResourceType=ServerlessCache&X-Amz-…"(SigV4 사전 서명, 15분)
export async function elasticacheIamToken(o: { cacheName: string; userId: string; region: string; credentials: AwsCredentialIdentity | Provider<AwsCredentialIdentity>; now?: Date }): Promise<string> {
  const signer = new SignatureV4({ service: 'elasticache', region: o.region, credentials: o.credentials, sha256: Sha256 });
  const signed = await signer.presign({
    method: 'GET', protocol: 'http:', hostname: o.cacheName, path: '/', headers: { host: o.cacheName },
    query: { Action: 'connect', User: o.userId, ResourceType: 'ServerlessCache' },
  }, { expiresIn: 900, signingDate: o.now });
  const q = Object.entries(signed.query ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return `${o.cacheName}/?${q}`;
}

export async function connectCounterStore(c: { endpoint: string; user: string; name: string }, region: string): Promise<CounterStore> {
  const [{ default: Redis }, { defaultProvider }] = await Promise.all([import('ioredis'), import('@aws-sdk/credential-provider-node')]);
  const credentials = defaultProvider();
  const token = () => elasticacheIamToken({ cacheName: c.name, userId: c.user, region, credentials });
  const r = new Redis({
    host: c.endpoint, port: 6379, tls: { servername: c.endpoint }, username: c.user, password: await token(),
    connectTimeout: 2_000, commandTimeout: 300, maxRetriesPerRequest: 0, enableOfflineQueue: false,
    retryStrategy: (n) => Math.min(n * 500, 5_000),
  });
  r.on('error', (e) => log.warn('valkey error', { err: String(e) }));
  const timer = setInterval(() => { token().then((t) => { r.options.password = t; }, (e) => log.warn('valkey token refresh failed', { err: String(e) })); }, 10 * 60_000);
  timer.unref();
  return new ValkeyCounterStore(r as unknown as RedisLike, () => clearInterval(timer));
}
