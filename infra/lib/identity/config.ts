// 중앙 ID 서비스(WBS 3.11, 17 문서 6장·E-09) 환경 설정. 계정은 dev·qa·prd별 identity 계정(Control Tower Account Factory).
// 구성: API Gateway(HTTP) + Lambda(VPC 밖) → Aurora PostgreSQL Serverless v2(Data API, 격리 서브넷) / Cognito 새 사용자 풀
// 계정 ID가 '<…>'면 아직 계정이 없다는 뜻이다(합성·시험은 되지만 배포 불가).
import { ORG, ENVS } from '../config';

export type IdEnvName = 'dev' | 'qa' | 'prd';

export interface IdEnvConfig {
  name: IdEnvName;
  account: string;
  zoneName: string;            // 환경 영역(identity 계정 소유, pasapps.com에서 NS 위임). API = 영역 최상위, 로그인 = auth.<영역>
  vpcCidr: string;             // Aurora 전용 격리 서브넷(NAT 없음)
  db: { minAcu: number; maxAcu: number; backupDays: number; deletionProtection: boolean; readers: number };
  lambda: { memoryMiB: number; reservedConcurrency?: number };
  throttle: { rate: number; burst: number };   // API 기본 호출 제한(초당)
  logRetentionDays: number;
  alarmEmail: string;
  monthlyBudgetUsd: number;
  productAccounts: string[];   // 변경 이벤트 주제(SNS)를 구독할 제품 계정(제품별 SQS, E-08)
}

const PENDING = /^<.*>$/;
export const isPending = (cfg: IdEnvConfig) => PENDING.test(cfg.account);
// 합성용 자리 계정(계정 생성 전). 배포 스크립트는 isPending이면 멈춘다
export const accountOf = (cfg: IdEnvConfig) => (isPending(cfg) ? '000000000000' : cfg.account);

export const ID_ENVS: Record<IdEnvName, IdEnvConfig> = {
  dev: {
    name: 'dev', account: '718468742633', zoneName: `id-dev.${ORG.domain}`, vpcCidr: '10.52.0.0/16',
    db: { minAcu: 0, maxAcu: 2, backupDays: 1, deletionProtection: false, readers: 0 },   // 0 ACU = 5분 유휴 시 자동 일시정지(첫 요청 재개 약 15초)
    lambda: { memoryMiB: 512 }, throttle: { rate: 20, burst: 40 },
    logRetentionDays: 30, alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 50,
    productAccounts: [ENVS.dev.account],
  },
  qa: {
    name: 'qa', account: '<identity-qa>', zoneName: `id-qa.${ORG.domain}`, vpcCidr: '10.51.0.0/16',
    db: { minAcu: 0, maxAcu: 2, backupDays: 7, deletionProtection: true, readers: 0 },
    lambda: { memoryMiB: 512 }, throttle: { rate: 20, burst: 40 },
    logRetentionDays: 30, alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 50,
    productAccounts: [ENVS.qa.account],
  },
  prd: {
    name: 'prd', account: '<identity-prd>', zoneName: `id.${ORG.domain}`, vpcCidr: '10.50.0.0/16',
    // 로그인 경로라 일시정지하지 않는다(재개 지연). 리더 1개 = 다중 AZ 장애 조치
    db: { minAcu: 0.5, maxAcu: 8, backupDays: 35, deletionProtection: true, readers: 1 },
    lambda: { memoryMiB: 1024, reservedConcurrency: 100 }, throttle: { rate: 200, burst: 400 },
    logRetentionDays: 365, alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 300,
    productAccounts: [ENVS.prd.account],
  },
};

export const idApiDomain = (cfg: IdEnvConfig) => cfg.zoneName;
export const idAuthDomain = (cfg: IdEnvConfig) => `auth.${cfg.zoneName}`;
export const idPrefix = (cfg: IdEnvConfig) => `id-${cfg.name}`;           // 리소스 이름 접두사
// API 범위(리소스 서버 'id-api'): 제품 백엔드의 머신 클라이언트가 client_credentials로 받는다(3.12에서 제품 등록 때 발급)
export const ID_SCOPES = {
  read: '사용자·역할·테넌트 조회(제품 백엔드)',
  write: '사용자·역할 변경(제품 관리 화면 대행)',
  admin: '테넌트·SSO 연결·제품 등록(플랫폼 관리)',
} as const;
