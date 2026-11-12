// 공유 플랫폼(suite) 모드(통합 WBS 5.4). 빌드 때 VITE_SUITE=1이면 켜진다(vite.config.ts가 기준 경로 /alm/ 과 공통 틀 스크립트를 넣는다).
// 로그인·통행증·CSRF는 플랫폼의 공통 틀(/_suite/shell.js → window.suite)이 맡는다. 계약: pas-suite README "플랫폼 공통 로그인과 공통 틀".
export const SUITE: boolean = import.meta.env.VITE_SUITE === '1';
/** 기준 경로('/' 또는 '/alm/')에서 끝의 '/'를 뺀 값. 라우터 basename·API 주소에 쓴다 */
export const BASE_PATH: string = import.meta.env.BASE_URL.replace(/\/$/, '');

export interface SuiteApi {
  ready: Promise<unknown>;
  /** 변경 요청에 CSRF 헤더를 붙이고, 통행증 만료(401)면 한 번 갱신한 뒤 다시 보낸다. 로그인이 끊겼으면 로그인 화면으로 보낸다 */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  logout(): Promise<void>;
}
declare global { interface Window { suite?: SuiteApi } }

/** 공통 틀. 스크립트가 빠졌으면(배포 오류) 조용히 넘어가지 않고 알린다 */
export function suite(): SuiteApi {
  if (!window.suite) throw new Error('공통 틀(/_suite/shell.js)을 불러오지 못했습니다');
  return window.suite;
}
