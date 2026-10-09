// 환경별 설정 — 10_AWS_아키텍처_정의서 14장. 값만 다르고 구성은 같다.
// 계정 ID·호스팅 영역 ID 등 '<…>' 자리 값은 3.1 착수 시 실제 값으로 바꾼다(README 참고).

export type EnvName = 'dev' | 'qa' | 'prd';

export interface OrgConfig {
  region: string;            // 주 리전
  backupRegion: string;      // 백업 리전
  accounts: { management: string; audit: string; logArchive: string; shared: string; backup: string; dev: string; qa: string; prd: string };
  domain: string;            // 서비스 도메인 (A-03)
  hostedZoneId: string;      // Route 53 호스팅 영역 ID (domain)
  githubRepo: string;        // OIDC 신뢰 대상
  ecrRepositoryName: string;
  backupVaultArn: string;    // backup 계정 볼트(Vault Lock 준수 모드)
  costCenter: string;
  workloadsOuId: string;     // Control Tower Workloads OU (추가 SCP 대상)
  securityOuId: string;      // Security OU
  ssoInstanceArn: string;    // IAM Identity Center 인스턴스
}

export interface EnvConfig {
  name: EnvName;
  account: string;
  appHost: string;           // alm / alm-qa / alm-dev
  authHost: string;          // auth / auth-qa / auth-dev
  vpcCidr: string;
  azs: string[];             // 계정 조회 없이 합성하려고 고정(계정마다 AZ 이름↔ID 매핑이 다르니 배포 전 확인)
  natGateways: number;
  interfaceEndpoints: boolean;
  flowLogs: boolean;
  db: { instanceClass: string; multiAz: boolean; allocatedGb: number; maxAllocatedGb: number; backupDays: number;
        performanceInsights: boolean; monitoringSeconds: number; deletionProtection: boolean;
        crossRegionBackup?: boolean };   // us-east-2로 자동 백업 복제(키는 Dr 스택)
  api: { cpu: number; memoryMiB: number; desired: number; max: number };
  worker: { cpu: number; memoryMiB: number; desired: number; max: number };
  logRetentionDays: number;
  execCommand: boolean;
  nightlyStop: boolean;      // A-10: 평일 07~20시만 운영
  alarmEmail: string;
  monthlyBudgetUsd: number;
  sapEgressCidrs: string[];  // WAF SAP 허용 목록(S-09)
  customerEgressCidrs: string[]; // IP 호출 제한 제외(고객사 출구)
  imageTag: string;          // 배포할 이미지 태그(파이프라인이 -c imageTag=… 로 넘김)
}

export const ORG: OrgConfig = {
  region: 'us-east-1',
  backupRegion: 'us-east-2',
  accounts: {
    // 2026-10-09 Control Tower 랜딩 존(조직 o-fhpi1b9oci)에서 생성. 나머지는 자리 값
    management: '740122273988', audit: '319759855604', logArchive: '085462181410',
    shared: '222222222222', backup: '333333333333',
    dev: '444444444444', qa: '555555555555', prd: '666666666666',
  },
  domain: 'bsgglobal.com',          // 서비스는 alm.<도메인> (A-03)
  hostedZoneId: 'Z0000000000000000000',
  githubRepo: 'shinji618/alm',
  ecrRepositoryName: 'alm',
  backupVaultArn: 'arn:aws:backup:us-east-1:333333333333:backup-vault:alm-backup-vault',
  costCenter: 'ALM',
  workloadsOuId: 'ou-xxxx-workloads',
  securityOuId: 'ou-xxxx-security',
  ssoInstanceArn: 'arn:aws:sso:::instance/ssoins-0000000000000000',
};

const common = {
  sapEgressCidrs: ['203.0.113.10/32'],      // 예시(TEST-NET-3). 고객 BASIS가 알려준 값으로 교체
  customerEgressCidrs: ['203.0.113.0/24'],  // 예시
  imageTag: 'bootstrap',
  azs: ['us-east-1a', 'us-east-1b'],
};

export const ENVS: Record<EnvName, EnvConfig> = {
  dev: {
    ...common, name: 'dev', account: ORG.accounts.dev, appHost: 'alm-dev', authHost: 'auth-dev',
    vpcCidr: '10.42.0.0/16', natGateways: 1, interfaceEndpoints: false, flowLogs: false,
    db: { instanceClass: 't4g.medium', multiAz: false, allocatedGb: 20, maxAllocatedGb: 100, backupDays: 1,
          performanceInsights: false, monitoringSeconds: 0, deletionProtection: false },
    api: { cpu: 512, memoryMiB: 1024, desired: 1, max: 2 },
    worker: { cpu: 256, memoryMiB: 512, desired: 1, max: 2 },
    logRetentionDays: 30, execCommand: true, nightlyStop: true,
    alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 200,
  },
  qa: {
    ...common, name: 'qa', account: ORG.accounts.qa, appHost: 'alm-qa', authHost: 'auth-qa',
    vpcCidr: '10.41.0.0/16', natGateways: 1, interfaceEndpoints: false, flowLogs: false,
    db: { instanceClass: 't4g.medium', multiAz: false, allocatedGb: 50, maxAllocatedGb: 200, backupDays: 7,
          performanceInsights: true, monitoringSeconds: 0, deletionProtection: true },
    api: { cpu: 512, memoryMiB: 1024, desired: 1, max: 2 },
    worker: { cpu: 256, memoryMiB: 512, desired: 1, max: 2 },
    logRetentionDays: 30, execCommand: false, nightlyStop: true,
    alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 200,
  },
  prd: {
    ...common, name: 'prd', account: ORG.accounts.prd, appHost: 'alm', authHost: 'auth',
    vpcCidr: '10.40.0.0/16', natGateways: 2, interfaceEndpoints: true, flowLogs: true,
    db: { instanceClass: 'm7g.large', multiAz: true, allocatedGb: 100, maxAllocatedGb: 1000, backupDays: 35,
          performanceInsights: true, monitoringSeconds: 60, deletionProtection: true,
          crossRegionBackup: true },
    api: { cpu: 1024, memoryMiB: 2048, desired: 2, max: 6 },
    worker: { cpu: 512, memoryMiB: 1024, desired: 1, max: 4 },
    logRetentionDays: 365, execCommand: false, nightlyStop: false,
    alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 900,
  },
};

export const fqdn = (host: string) => `${host}.${ORG.domain}`;
// us-east-2 재해 복구 키(Dr 스택). RDS 자동 백업 복제에 별칭 ARN으로 넘긴다
export const drKeyAlias = (env: EnvName) => `alias/alm/${env}/dr`;
export const drKeyAliasArn = (cfg: EnvConfig) => `arn:aws:kms:${ORG.backupRegion}:${cfg.account}:${drKeyAlias(cfg.name)}`;
export const AUDIT_BUCKET = `alm-audit-archive-${ORG.accounts.logArchive}`;
export const logBucketName = (env: EnvName) => `alm-logs-${env}-${ORG.accounts.logArchive}`;
