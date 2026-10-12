// 실행 환경 값. ECS 작업 정의(infra/lib/app-stack.ts commonEnv·비밀)에서 들어온다. 로컬 시험은 같은 이름의 환경 변수를 준다.
export interface Config {
  env: string;                 // dev·qa·prd·local
  region: string;
  port: number;
  db: { host: string; port: number; name: string; user: string; password?: string; ssl: boolean };
  dbMaster?: { user: string; password: string };   // migrate 부트스트랩 때만(Secrets Manager → ECS 비밀)
  cognito: { userPoolId: string; webClientId: string; webClientSecret: string; pdaClientId: string; domain: string };
  appOrigin: string;           // https://alm-dev.bsgapps.com
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
const keyOf = (s: string) => createHash('sha256').update(s).digest();

export function loadConfig(role: string): Config {
  const needsHttp = role === 'api';
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
    dbMaster: opt('DB_MASTER_PASSWORD') ? { user: process.env.DB_MASTER_USER || 'alm_owner', password: req('DB_MASTER_PASSWORD') } : undefined,
    cognito: {
      userPoolId: needsHttp ? req('COGNITO_USER_POOL_ID') : process.env.COGNITO_USER_POOL_ID || '',
      webClientId: needsHttp ? req('COGNITO_WEB_CLIENT_ID') : process.env.COGNITO_WEB_CLIENT_ID || '',
      webClientSecret: needsHttp ? req('COGNITO_WEB_CLIENT_SECRET') : '',
      pdaClientId: process.env.COGNITO_PDA_CLIENT_ID || '',
      domain: needsHttp ? req('COGNITO_DOMAIN') : process.env.COGNITO_DOMAIN || '',
    },
    appOrigin: needsHttp ? req('APP_ORIGIN') : process.env.APP_ORIGIN || '',
    cookieKeys: needsHttp ? [req('COOKIE_KEY'), opt('COOKIE_KEY_PREVIOUS')].filter((x): x is string => !!x).map(keyOf) : [],
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
