// Lambda 진입점: Cognito SDK 어댑터를 만들어 core.handle에 넘긴다(SDK는 Lambda 런타임에 포함)
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { handle } from './core.mjs';

const client = new sdk.CognitoIdentityProviderClient({});
const op = (name) => (input) => client.send(new sdk[`${name}Command`](input));
const cip = Object.fromEntries([
  'DescribeIdentityProvider', 'CreateIdentityProvider', 'UpdateIdentityProvider', 'DeleteIdentityProvider', 'ListIdentityProviders',
  'DescribeUserPoolClient', 'UpdateUserPoolClient', 'CreateUserPoolClient', 'DeleteUserPoolClient',
  'AddUserPoolClientSecret', 'ListUserPoolClientSecrets', 'DeleteUserPoolClientSecret',
].map((n) => [n[0].toLowerCase() + n.slice(1), op(n)]));

const env = {
  userPoolId: process.env.USER_POOL_ID,
  webClientId: process.env.WEB_CLIENT_ID,
  pdaClientId: process.env.PDA_CLIENT_ID,
};

export const handler = async (event) => {
  const res = await handle(event, cip, env);
  // 비밀 값은 남기지 않는다: 동작·결과 코드만 기록
  console.log(JSON.stringify({ action: event?.action, tenantCode: event?.tenantCode, ok: res.ok, error: res.error?.code }));
  return res;
};
