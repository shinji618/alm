// 공유 플랫폼(suite)에 올리는 ALM 설정(통합 WBS 5.4). 네트워크·DB·Valkey·클러스터·ALB·CloudFront·발신 도메인은 플랫폼(pas-suite)이 만들고,
// 여기서는 SSM 파라미터 /suite/<env>/<키>로 참조한다(pas-suite infra/lib/suite/params.ts와 이름을 맞춘다).
// 이름 규칙(pas-suite config.ts): 스택 Suite-<Env>-Alm, 버킷 suite-<env>-alm-<용도>-<계정>, 비밀 alm/<env>/…, 로그 /suite/<env>/alm/…,
//   ECS 서비스 alm-<역할>, 태스크 정의 suite-<env>-alm-<역할>, ALB 규칙 우선순위 200~299, 제품 헤더 X-Suite-Product: alm,
//   DB alm·소유자 alm_owner(IAM 인증), Valkey 사용자 suite-<env>-alm(키 접두어 alm:)
// 지금 쓰는 전용 환경(Alm-<Env>-*)은 lib/config.ts 그대로다 — 전환 시험(5.7)까지 함께 둔다.
export type SuiteEnvName = 'dev';
export interface SuiteEnvConfig {
  name: SuiteEnvName;
  account: string;                 // suite-<env> 계정(= 지금 ALM DEV 계정)
  appDomain: string;               // 고객용 주소(= 통행증 발급자). ALM 화면은 /alm
  idApiUrl: string;                // 중앙 ID API(통행증 공개 키를 WAF를 거치지 않고 읽는다)
  azs: string[];
  // max > desired 이고 야간 정지가 없는 환경에서만 자동 확장한다(플랫폼 야간 정지는 서비스 수를 0으로 내리므로 자동 확장과 함께 쓰지 않는다)
  api: { cpu: number; memoryMiB: number; desired: number; max: number };
  worker: { cpu: number; memoryMiB: number; desired: number; max: number };
  logRetentionDays: number;
  execCommand: boolean;
  nightlyStop: boolean;            // 플랫폼이 서비스·RDS를 밤에 끈다 → 일정 작업을 DB가 켜진 시간에 돌린다
  imageTag: string;
  // Portal 연동(09 앱 연동 계약): 새 중앙 ID에 등록한 portal-backend 클라이언트 ID(쉼표 구분). 비어 있으면 Portal 피드 API는 닫힌다
  portal: { clientIds: string; feedScope: string; notifyScope: string };
}
export const PRODUCT = 'alm';
export const PRODUCT_HEADER = 'X-Suite-Product';
export const ALB_PRIORITY = 200;
export const OWNER_DB_USER = 'alm_owner';   // 플랫폼(pas-suite Data 스택)이 만든 ALM DB 소유자 역할

export const SUITE_ENVS: Record<SuiteEnvName, SuiteEnvConfig> = {
  dev: { name: 'dev', account: '236501162716', appDomain: 'app-dev.pasapps.com', idApiUrl: 'https://id.app-dev.pasapps.com', azs: ['us-east-1a', 'us-east-1b'],
    api: { cpu: 512, memoryMiB: 1024, desired: 1, max: 2 }, worker: { cpu: 256, memoryMiB: 512, desired: 1, max: 2 },
    logRetentionDays: 30, execCommand: true, nightlyStop: true, imageTag: 'bootstrap',
    // 2026-11-11 새 중앙 ID(풀 us-east-1_ULHTQjnp6): portal-backend(피드 호출 주체, 범위 portal/feed). 알림 송신은 비밀의 alm-backend(범위 portal/notify)
    portal: { clientIds: '25qk2s95tebtjhdrrtelg7r1mi', feedScope: 'portal/feed', notifyScope: 'portal/notify' } },
    // SAP 토큰은 2026-11-16부터 새 중앙 ID의 SAP 연결(범위 alm/sap.api)에서 받는다 — 전용 환경의 ALM 풀(us-east-1_2iCIGqVTT)은 더 쓰지 않는다(통합 WBS 5.7)
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
export const suiteStackName = (env: SuiteEnvName) => `Suite-${cap(env)}-${cap(PRODUCT)}`;
export const suitePrefix = (env: SuiteEnvName) => `suite-${env}`;
export const paramName = (env: SuiteEnvName, key: string) => `/suite/${env}/${key}`;
