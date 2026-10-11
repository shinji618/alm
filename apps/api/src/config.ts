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
      user: req('DB_IAM_USER'), password: opt('DB_PASSWORD'),               // DB_PASSWORD가 있으면 IAM 토큰 대신(로컬)
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
  };
}
