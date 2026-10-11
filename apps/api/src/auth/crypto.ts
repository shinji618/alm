// 쿠키 암호화(09 6.4): AES-256-GCM. 값 = base64url(버전 1바이트 | iv 12 | tag 16 | 암호문). 만료 시각은 암호문 안에 둔다.
// 키는 [현재, 이전] 순서. 봉인은 현재 키, 열기는 둘 다 시도(분기 교체 뒤 8시간 동안 이전 쿠키 허용)
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const V = 1;

export function seal(keys: Buffer[], purpose: string, payload: object, ttlSec: number): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys[0], iv);
  c.setAAD(Buffer.from(purpose));          // 쿠키끼리 바꿔 끼우기 방지(alm_pkce 값을 alm_rt에 넣는 등)
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([Buffer.from([V]), iv, c.getAuthTag(), ct]).toString('base64url');
}

export function open<T extends object>(keys: Buffer[], purpose: string, value: string | undefined): T | undefined {
  if (!value) return undefined;
  let buf: Buffer;
  try { buf = Buffer.from(value, 'base64url'); } catch { return undefined; }
  if (buf.length < 30 || buf[0] !== V) return undefined;
  const iv = buf.subarray(1, 13), tag = buf.subarray(13, 29), ct = buf.subarray(29);
  for (const k of keys) {
    try {
      const d = createDecipheriv('aes-256-gcm', k, iv);
      d.setAAD(Buffer.from(purpose));
      d.setAuthTag(tag);
      const p = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString()) as T & { exp: number };
      if (typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return undefined;
      return p;
    } catch { /* 다음 키 */ }
  }
  return undefined;
}

// PKCE(RFC 7636)
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
