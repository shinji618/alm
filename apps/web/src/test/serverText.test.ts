import i18next from 'i18next';
import en from '@/i18n/en.json';
import ko from '@/i18n/ko.json';
import { ifName, sysText } from '@/lib/serverText';

async function make(lng: 'en' | 'ko') {
  const i = i18next.createInstance();
  await i.init({ lng, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } });
  return i.t.bind(i);
}

describe('serverText — 서버가 만든 한국어 문구의 화면 언어 변환', () => {
  it('영어 화면: 고정 사유·대리·동일 승인자·전기 오류를 번역', async () => {
    const t = await make('en');
    expect(sysText(t, 'ALM-111 할당에 따른 코스트센터 변경')).toBe('ALM-111 Cost center change due to assignment');
    expect(sysText(t, '[대리] 부서 관리자 없음 → 자산회계 결정')).toBe('[Proxy] No department manager → decided by Asset Accounting');
    expect(sysText(t, '[대리] 부서 관리자 없음 → 자산 관리자 결정 · 확인함')).toBe('[Proxy] No department manager → decided by Asset Manager · 확인함');
    expect(sysText(t, '[동일 승인자] 1단계 승인으로 함께 승인')).toBe('[Same approver] Approved together with step 1');
    expect(sysText(t, 'SAP 전기 시도 5회 초과(결과 회신 없음)')).toBe('SAP posting attempts exceeded 5 (no result reply)');
    expect(ifName(t, 'IF-MD-01', '조직·코드 마스터')).toBe('Org & code master');
  });
  it('사용자가 직접 쓴 문구와 알 수 없는 문구는 그대로', async () => {
    const t = await make('en');
    expect(sysText(t, '부서 이동 때문에 변경')).toBe('부서 이동 때문에 변경');
    expect(sysText(t, undefined)).toBe('');
    expect(ifName(t, 'IF-XX-99', '새 인터페이스')).toBe('새 인터페이스');
  });
  it('한국어 화면: 원문과 동일', async () => {
    const t = await make('ko');
    expect(sysText(t, '[동일 승인자] 2단계 승인으로 함께 승인')).toBe('[동일 승인자] 2단계 승인으로 함께 승인');
    expect(sysText(t, 'SAP 전기 시도 5회 초과(결과 회신 없음)')).toBe('SAP 전기 시도 5회 초과(결과 회신 없음)');
    expect(ifName(t, 'IF-AA-02', 'x')).toBe('자산 금액');
  });
});
