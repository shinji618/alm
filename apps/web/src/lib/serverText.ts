import type { TFunction } from 'i18next';

// 서버가 만들어 저장하는 한국어 고정 문구를 화면 언어로 바꿔 보여준다.
// 사용자가 직접 입력한 값은 건드리지 않으며, 알 수 없는 문구는 원문 그대로 돌려준다.
const EXACT: Record<string, string> = {
  'ALM-112 자산 등록(SAP 등록 체크)': 'reasonRegister',
  'ALM-111 자산 정보 변경(SAP 마스터 반영)': 'reasonChange',
  'ALM-111 할당에 따른 코스트센터 변경': 'reasonAssign',
  '[대리] 부서 관리자 없음 → 자산회계 결정': 'proxyAssetAccounting',
  '[대리] 부서 관리자 없음 → 자산 관리자 결정': 'proxyAssetManager',
};

export function sysText(t: TFunction, text?: string | null): string {
  if (!text) return text ?? '';
  const exact = EXACT[text];
  if (exact) return t(`sysText.${exact}`, { defaultValue: text });
  // 대리 사유 뒤에 사용자가 쓴 의견이 이어붙은 경우: "[대리] … 결정 · 의견"
  for (const [ko, key] of Object.entries(EXACT)) {
    if (text.startsWith(`${ko} · `)) return `${t(`sysText.${key}`, { defaultValue: ko })}${text.slice(ko.length)}`;
  }
  let m = /^\[동일 승인자\] (\d+)단계 승인으로 함께 승인$/.exec(text);
  if (m) return t('sysText.merged', { n: m[1], defaultValue: text });
  m = /^SAP 전기 시도 (\d+)회 초과\(결과 회신 없음\)$/.exec(text);
  if (m) return t('sysText.postingExhausted', { n: m[1], defaultValue: text });
  return text;
}

export function ifName(t: TFunction, interfaceId: string, fallback: string): string {
  return t(`sysText.ifName.${interfaceId}`, { defaultValue: fallback });
}
