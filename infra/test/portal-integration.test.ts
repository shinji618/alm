// Portal 연동 설정(09 앱 연동 계약): 중앙 ID 클라이언트·스코프와 Portal DEV 주소
import { describe, it, expect } from 'vitest';
import { ENVS } from '../lib/config';

describe('Portal 연동(DEV)', () => {
  it('portal-backend만 피드를 호출하고, 알림은 portal-dev의 /api로 보낸다', () => {
    const p = ENVS.dev.portal!;
    expect(p.clientIds.split(',')).toEqual(['7acekjs8qoiqdbmotqbuq4s01u']);   // portal-backend
    expect(p.feedScope).toBe('portal/feed');
    expect(p.notifyScope).toBe('portal/notify');
    expect(p.apiUrl).toBe('https://portal-dev.pasapps.com/api');              // ALM이 /v1/notifications 를 덧붙인다
  });
  it('중앙 ID가 있는 환경에서만 켠다', () => {
    for (const e of Object.values(ENVS)) if (e.portal) expect(e.centralId).toBeTruthy();
  });
});
