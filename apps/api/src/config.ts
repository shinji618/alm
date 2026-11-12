// 실행 환경 값. ECS 작업 정의(infra/lib/app-stack.ts commonEnv·비밀)에서 들어온다. 로컬 시험은 같은 이름의 환경 변수를 준다.
export interface Config {
  env: string;                 // dev·qa·prd·local
  region: string;
  port: number;
  db: { host: string; port: number; name: string; user: string; password?: string; ssl: boolean };
  dbMaster?: { user: string; password: string };   // migrate 부트스트랩 때만(Secrets Manager → ECS 비밀)
  // 공유 플랫폼(suite) 모드(SUITE_MODE=1). DB 소유자가 RDS 마스터가 아니다(rds_superuser 없음): 확장·이벤트 트리거는 플랫폼이 대신 만든다(ops/migrate.ts)
  suiteMode?: boolean;
  // 통행증 모드(SUITE_AUTH=1, SUITE_ORIGIN). 웹 채널은 플랫폼이 서명한 통행증 쿠키로 인증한다(auth/suitePass.ts). 자체 웹 로그인(alm-web·쿠키 키)은 쓰지 않는다
  suite?: { issuer: string; jwksUrl: string };
  cognito: { userPoolId: string; webClientId: string; webClientSecret: string; pdaClientId: string; domain: string };
  // SAP 연결 클라이언트(alm-sap-*)가 있는 풀. 사용자 로그인을 중앙 ID 풀로 옮긴 뒤에도 SAP은 ALM 풀에 둔다(3.13). 없으면 cognito와 같음
  sapCognito?: { userPoolId: string; domain: string };
  // 중앙 ID 서비스(3.13). 있으면 로그인 판정·사용자·역할 변경을 위임하고 ALM DB는 미러가 된다
  central?: { url: string; tokenUrl: string; clientId: string; clientSecret: string };
  identityEventsQueueUrl?: string;   // 중앙 변경 이벤트(SNS → SQS)
  // PAS Portal 연동(09 앱 연동 계약). clientIds가 비면 portal API는 닫힌다. scope를 주면 토큰에 그 범위가 있어야 한다(전용 범위 portal.feed 추가 전에는 비워 두고 클라이언트 ID만 확인)
  portal?: { clientIds: string[]; scope?: string };
  // ALM → Portal 인앱 알림(09 §6). 없으면 보내지 않는다. 토큰은 앱 백엔드 머신 클라이언트(alm-backend)로 받는다
  portalNotify?: { url: string; tokenUrl: string; clientId: string; clientSecret: string; scope?: string };
  appOrigin: string;           // https://alm-dev.pasapps.com
  cookieKeys: Buffer[];        // [현재, 이전] — 분기 교체 뒤 8시간 동안 이전 키도 받는다(09 6.4)
  jobsQueueUrl?: string;
  cognitoAdminFunction?: string;
  auditBucket?: string;        // audit-archive: log-archive 계정 감사 버킷(Object Lock)
  filesBucket?: string;        // 첨부·사진(tenant/<id>/…)
  filesScanRequired?: boolean; // GuardDuty S3 악성코드 검사 태그가 NO_THREATS_FOUND일 때만 다운로드(FILES_SCAN=required)
  cache?: { endpoint: string; user: string; name: string };   // Valkey(TLS + IAM 인증). 없으면 작업 메모리로 센다(로컬·시험)
  mail?: { from: string; configSet?: string; eventsQueueUrl?: string };
}

const req = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`환경 변수 ${k}가 없다`);
  return v;
};
const opt = (k: string) => process.env[k] || undefined;

// 쿠키 키: Secrets Manager 문자열(64자) → SHA-256으로 32바이트 AES 키를 만든다
import { createHash } from 'node:crypto';
import { suiteAuthConfig } from './auth/suitePass';
const keyOf = (s: string) => createHash('sha256').update(s).digest();

export function loadConfig(role: string): Config {
  const needsHttp = role === 'api';
  const suite = suiteAuthConfig();
  const needsWebLogin = needsHttp && !suite;   // 통행증 모드에는 자체 웹 로그인 설정이 필요 없다
  return {
    env: process.env.ALM_ENV || 'local',
    region: process.env.AWS_REGION || 'us-east-1',
    port: Number(process.env.PORT || 3000),
    db: {
      host: req('DB_HOST'), port: Number(process.env.DB_PORT || 5432), name: process.env.DB_NAME || 'alm',
      // migrate·seed는 마스터 비밀로 접속하므로 IAM 로그인 계정이 없어도 된다
      user: opt('DB_IAM_USER') ?? (opt('DB_MASTER_PASSWORD') ? process.env.DB_MASTER_USER || 'alm_owner' : req('DB_IAM_USER')),
      password: opt('DB_PASSWORD'),                                          // DB_PASSWORD가 있으면 IAM 토큰 대신(로컬)
      ssl: process.env.DB_SSL !== 'false',
    },
    suiteMode: process.env.SUITE_MODE === '1',
    suite,
    dbMaster: opt('DB_MASTER_PASSWORD') ? { user: process.env.DB_MASTER_USER || 'alm_owner', password: req('DB_MASTER_PASSWORD') } : undefined,
    cognito: {
      userPoolId: needsHttp ? req('COGNITO_USER_POOL_ID') : process.env.COGNITO_USER_POOL_ID || '',
      webClientId: needsWebLogin ? req('COGNITO_WEB_CLIENT_ID') : process.env.COGNITO_WEB_CLIENT_ID || '',
      webClientSecret: needsWebLogin ? req('COGNITO_WEB_CLIENT_SECRET') : '',
      pdaClientId: process.env.COGNITO_PDA_CLIENT_ID || '',
      domain: needsHttp ? req('COGNITO_DOMAIN') : process.env.COGNITO_DOMAIN || '',
    },
    sapCognito: opt('COGNITO_SAP_USER_POOL_ID') ? { userPoolId: req('COGNITO_SAP_USER_POOL_ID'), domain: req('COGNITO_SAP_DOMAIN') } : undefined,
    central: opt('CENTRAL_ID_URL') && opt('CENTRAL_ID_CLIENT_SECRET')
      ? { url: req('CENTRAL_ID_URL'), tokenUrl: req('CENTRAL_ID_TOKEN_URL'), clientId: req('CENTRAL_ID_CLIENT_ID'), clientSecret: req('CENTRAL_ID_CLIENT_SECRET') } : undefined,
    portal: opt('PORTAL_CLIENT_IDS') ? { clientIds: req('PORTAL_CLIENT_IDS').split(',').map((x) => x.trim()).filter(Boolean), scope: opt('PORTAL_FEED_SCOPE') } : undefined,
    portalNotify: opt('PORTAL_API_URL') && opt('PORTAL_NOTIFY_CLIENT_SECRET')
      ? { url: req('PORTAL_API_URL'), tokenUrl: req('PORTAL_TOKEN_URL'), clientId: req('PORTAL_NOTIFY_CLIENT_ID'), clientSecret: req('PORTAL_NOTIFY_CLIENT_SECRET'), scope: opt('PORTAL_NOTIFY_SCOPE') } : undefined,
    identityEventsQueueUrl: opt('IDENTITY_EVENTS_QUEUE_URL'),
    appOrigin: needsHttp ? req('APP_ORIGIN') : process.env.APP_ORIGIN || '',
    cookieKeys: needsWebLogin ? [req('COOKIE_KEY'), opt('COOKIE_KEY_PREVIOUS')].filter((x): x is string => !!x).map(keyOf) : [],
    jobsQueueUrl: opt('JOBS_QUEUE_URL'),
    cognitoAdminFunction: opt('COGNITO_ADMIN_FUNCTION'),
    auditBucket: opt('AUDIT_BUCKET'),
    filesBucket: opt('FILES_BUCKET'),
    filesScanRequired: process.env.FILES_SCAN === 'required',
    // 역할별 부가 설정은 없어도 시작한다(migrate는 배포 첫 단계라 이전 작업 정의의 환경 변수로 새 이미지를 돌린다).
    // 셋 중 하나라도 없으면 작업 메모리로 센다
    cache: opt('CACHE_ENDPOINT') && opt('CACHE_USER') && opt('CACHE_NAME')
      ? { endpoint: req('CACHE_ENDPOINT'), user: req('CACHE_USER'), name: req('CACHE_NAME') } : undefined,
    mail: opt('MAIL_FROM') ? { from: req('MAIL_FROM'), configSet: opt('SES_CONFIG_SET'), eventsQueueUrl: opt('SES_EVENTS_QUEUE_URL') } : undefined,
  };
}
