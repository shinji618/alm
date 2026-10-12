// 작업(프로세스) 단위 짧은 캐시. 여러 api 작업 사이에는 공유하지 않으므로 TTL로만 맞춘다(09 7장: 60초)
export class TtlCache<T> {
  private m = new Map<string, { v: T | null; at: number }>();
  constructor(private ttlMs = 60_000, private max = 5_000) {}
  async get(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v ?? undefined;
    const v = await load();
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(key, { v: v ?? null, at: Date.now() });
    return v;
  }
  delete(key: string) { this.m.delete(key); }
  clear() { this.m.clear(); }
}

// 작업 안에서만 세는 고정 창 호출 제한. API 호출 제한은 모든 작업이 함께 세는 common/shared.ts(Valkey)를 쓴다
export class RateLimiter {
  private m = new Map<string, { n: number; start: number }>();
  constructor(private limit: number, private windowMs: number) {}
  // 허용이면 0, 초과면 다시 시도할 수 있을 때까지 남은 초
  hit(key: string, now = Date.now()): number {
    const e = this.m.get(key);
    if (!e || now - e.start >= this.windowMs) { this.m.set(key, { n: 1, start: now }); this.gc(now); return 0; }
    e.n += 1;
    return e.n > this.limit ? Math.ceil((e.start + this.windowMs - now) / 1000) : 0;
  }
  private gc(now: number) {
    if (this.m.size < 10_000) return;
    for (const [k, e] of this.m) if (now - e.start >= this.windowMs) this.m.delete(k);
  }
}
