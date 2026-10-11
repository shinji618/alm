// 환경별 설정 — 10_AWS_아키텍처_정의서 14장. 값만 다르고 구성은 같다.
// 계정 ID·호스팅 영역 ID 등 '<…>' 자리 값은 3.1 착수 시 실제 값으로 바꾼다(README 참고).

export type EnvName = 'dev' | 'qa' | 'prd';

export interface OrgConfig {
  region: string;            // 주 리전
  backupRegion: string;      // 백업 리전
  accounts: { management: string; audit: string; logArchive: string; shared: string; backup: string; dev: string; qa: string; prd: string };
  domain: string;            // 상위 도메인(관리 계정 Route 53 등록·호스팅 영역). 환경 영역은 여기서 NS 위임(scripts/delegate-zones.sh)
  githubRepo: string;        // OIDC 신뢰 대상
  githubRepoIds: string;     // GitHub OIDC sub의 불변 ID 형식(owner@ownerId/repo@repoId). 2026-10 확인: sub = repo:<이것>:ref:…
  ecrRepositoryName: string;
  backupVaultArn: string;    // backup 계정 볼트(Vault Lock 준수 모드)
  costCenter: string;
  workloadsOuId: string;     // Control Tower Workloads OU (추가 SCP 대상)
  securityOuId: string;      // Security OU
  sharedOuId: string;        // Shared OU
  ssoInstanceArn: string;    // IAM Identity Center 인스턴스
}

export interface EnvConfig {
  name: EnvName;
  account: string;
  zoneName: string;          // 환경 호스팅 영역(환경 계정 소유). 앱 = 영역 최상위, 로그인 = auth.<영역>, 메일 = no-reply@<영역>
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
    // 2026-10-09~10 Control Tower(조직 o-fhpi1b9oci) Account Factory로 생성
    management: '740122273988', audit: '319759855604', logArchive: '085462181410',
    shared: '631237958461', backup: '262325793971',
    dev: '236501162716', qa: '428477779499', prd: '482545366457',
  },
  // 2026-10-10 Route 53 등록(관리 계정). ALM은 alm[-qa|-dev].bsgapps.com 영역을 환경 계정에 두고 위임받는다
  domain: 'bsgapps.com',
  githubRepo: 'shinji618/alm',
  githubRepoIds: 'shinji618@335630296/alm@1409332069',
  ecrRepositoryName: 'alm',
  backupVaultArn: 'arn:aws:backup:us-east-1:262325793971:backup-vault:alm-backup-vault',
  costCenter: 'ALM',
  workloadsOuId: 'ou-9djy-5jnut6za',
  securityOuId: 'ou-9djy-4stg96uq',
  sharedOuId: 'ou-9djy-10yk9mcs',
  ssoInstanceArn: 'arn:aws:sso:::instance/ssoins-72231dff1f435dc2',
};

const common = {
  sapEgressCidrs: ['203.0.113.10/32'],      // 예시(TEST-NET-3). 고객 BASIS가 알려준 값으로 교체
  customerEgressCidrs: ['203.0.113.0/24'],  // 예시
  imageTag: 'bootstrap',
  azs: ['us-east-1a', 'us-east-1b'],
};

export const ENVS: Record<EnvName, EnvConfig> = {
  dev: {
    ...common, name: 'dev', account: ORG.accounts.dev, zoneName: 'alm-dev.bsgapps.com',
    vpcCidr: '10.42.0.0/16', natGateways: 1, interfaceEndpoints: false, flowLogs: false,
    db: { instanceClass: 't4g.medium', multiAz: false, allocatedGb: 20, maxAllocatedGb: 100, backupDays: 1,
          performanceInsights: false, monitoringSeconds: 0, deletionProtection: false },
    api: { cpu: 512, memoryMiB: 1024, desired: 1, max: 2 },
    worker: { cpu: 256, memoryMiB: 512, desired: 1, max: 2 },
    logRetentionDays: 30, execCommand: true, nightlyStop: true,
    alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 200,
  },
  qa: {
    ...common, name: 'qa', account: ORG.accounts.qa, zoneName: 'alm-qa.bsgapps.com',
    vpcCidr: '10.41.0.0/16', natGateways: 1, interfaceEndpoints: false, flowLogs: false,
    db: { instanceClass: 't4g.medium', multiAz: false, allocatedGb: 50, maxAllocatedGb: 200, backupDays: 7,
          performanceInsights: true, monitoringSeconds: 0, deletionProtection: true },
    api: { cpu: 512, memoryMiB: 1024, desired: 1, max: 2 },
    worker: { cpu: 256, memoryMiB: 512, desired: 1, max: 2 },
    logRetentionDays: 30, execCommand: false, nightlyStop: true,
    alarmEmail: 'shinji@bsgglobal.com', monthlyBudgetUsd: 200,
  },
  prd: {
    ...common, name: 'prd', account: ORG.accounts.prd, zoneName: 'alm.bsgapps.com',
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

export const appDomain = (cfg: EnvConfig) => cfg.zoneName;
export const authDomain = (cfg: EnvConfig) => `auth.${cfg.zoneName}`;
// us-east-2 재해 복구 키(Dr 스택). RDS 자동 백업 복제에 별칭 ARN으로 넘긴다
export const drKeyAlias = (env: EnvName) => `alias/alm/${env}/dr`;
export const drKeyAliasArn = (cfg: EnvConfig) => `arn:aws:kms:${ORG.backupRegion}:${cfg.account}:${drKeyAlias(cfg.name)}`;
export const AUDIT_BUCKET = `alm-audit-archive-${ORG.accounts.logArchive}`;
export const logBucketName = (env: EnvName) => `alm-logs-${env}-${ORG.accounts.logArchive}`;
// CloudFront 표준 로그 v2 계정 간 전송: 전송 대상은 대상 계정(log-archive)에 있어야 한다
export const cdnLogDestinationName = (env: EnvName) => `alm-${env}-cdn-s3`;
export const cdnLogDestinationArn = (env: EnvName) =>
  `arn:aws:logs:${ORG.region}:${ORG.accounts.logArchive}:delivery-destination:${cdnLogDestinationName(env)}`;
