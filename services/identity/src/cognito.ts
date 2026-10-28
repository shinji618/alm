// Cognito 관리(ALM alm-cognito-admin core.mjs 이식, 17 문서 6.8): 테넌트 IdP(T-<테넌트>) 등록·삭제·조회,
// 제품 USER 클라이언트의 IdP 목록 맞추기, 제품 클라이언트 생성. 클라이언트 설정은 IdP 목록만 바꾸고 나머지는 그대로 둔다.
// 비밀 값은 로그에 남기지 않고 생성 응답에서 한 번만 돌려준다.
import { E } from './errors';

export interface Cip { [op: string]: (input: any) => Promise<any> }   // SDK 호출 어댑터(시험에서는 가짜)
export const SAML_ATTRIBUTES = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  name: 'http://schemas.microsoft.com/identity/claims/displayname',
};
export const OIDC_ATTRIBUTES = { email: 'email', name: 'name', email_verified: 'email_verified' };
export const idpName = (tenantCode: string) => `T-${tenantCode}`;
const isHttps = (u: unknown) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);

export function idpDetails(input: any) {
  if (input?.type === 'SAML') {
    const d: Record<string, string> = { IDPSignout: 'false', RequestSigningAlgorithm: 'rsa-sha256' };
    if (input.metadataUrl) { if (!isHttps(input.metadataUrl)) throw E.bad('metadataUrl: https URL'); d.MetadataURL = input.metadataUrl; }
    else if (typeof input.metadataXml === 'string' && input.metadataXml.includes('EntityDescriptor')) d.MetadataFile = input.metadataXml;
    else throw E.bad('SAML: metadataUrl 또는 metadataXml 필요');
    return { ProviderType: 'SAML', ProviderDetails: d, AttributeMapping: SAML_ATTRIBUTES };
  }
  if (input?.type === 'OIDC') {
    const o = input.oidc || {};
    if (!isHttps(o.issuer) || !o.clientId || !o.clientSecret) throw E.bad('OIDC: oidc.issuer(https)·clientId·clientSecret 필요');
    return { ProviderType: 'OIDC', AttributeMapping: OIDC_ATTRIBUTES, ProviderDetails: {
      oidc_issuer: o.issuer, client_id: o.clientId, client_secret: o.clientSecret, authorize_scopes: 'openid email profile', attributes_request_method: 'GET' } };
  }
  throw E.bad('type: SAML 또는 OIDC');
}

const READ_ONLY = ['ClientSecret', 'CreationDate', 'LastModifiedDate'];
// 클라이언트의 IdP 목록만 바꾼다(UpdateUserPoolClient는 빠진 항목을 기본값으로 되돌리므로 전체를 다시 보낸다)
export async function setClientIdps(cip: Cip, poolId: string, clientId: string, mutate: (l: string[]) => string[]): Promise<boolean> {
  const c = (await cip.describeUserPoolClient({ UserPoolId: poolId, ClientId: clientId })).UserPoolClient;
  const before: string[] = c.SupportedIdentityProviders || [];
  const after = [...new Set(mutate(before))].sort();
  if (after.length === before.length && after.every((x) => before.includes(x))) return false;
  const input = { ...c, SupportedIdentityProviders: after };
  for (const k of READ_ONLY) delete input[k];
  await cip.updateUserPoolClient(input);
  return true;
}

export async function registerIdp(cip: Cip, poolId: string, tenantCode: string, input: any) {
  const name = idpName(tenantCode), det = idpDetails(input);
  let created = true;
  try { await cip.describeIdentityProvider({ UserPoolId: poolId, ProviderName: name }); created = false; }
  catch (e: any) { if (e?.name !== 'ResourceNotFoundException') throw e; }
  if (created) await cip.createIdentityProvider({ UserPoolId: poolId, ProviderName: name, ...det });
  else await cip.updateIdentityProvider({ UserPoolId: poolId, ProviderName: name, ProviderDetails: det.ProviderDetails, AttributeMapping: det.AttributeMapping });
  return { providerName: name, created, samlEntityId: `urn:amazon:cognito:sp:${poolId}` };
}

export async function describeIdp(cip: Cip, poolId: string, tenantCode: string) {
  const name = idpName(tenantCode);
  try {
    const p = (await cip.describeIdentityProvider({ UserPoolId: poolId, ProviderName: name })).IdentityProvider;
    const d = { ...(p.ProviderDetails || {}) };
    delete d.client_secret; delete d.MetadataFile;
    return { providerName: name, type: p.ProviderType, details: d, attributeMapping: p.AttributeMapping, samlEntityId: `urn:amazon:cognito:sp:${poolId}` };
  } catch (e: any) { if (e?.name === 'ResourceNotFoundException') throw E.notFound('SSO 연결이 없습니다'); throw e; }
}

export async function removeIdp(cip: Cip, poolId: string, tenantCode: string) {
  try { await cip.deleteIdentityProvider({ UserPoolId: poolId, ProviderName: idpName(tenantCode) }); }
  catch (e: any) { if (e?.name !== 'ResourceNotFoundException') throw e; }
}

export async function listTenantIdps(cip: Cip, poolId: string): Promise<string[]> {
  const names: string[] = []; let NextToken: string | undefined;
  do {
    const r = await cip.listIdentityProviders({ UserPoolId: poolId, MaxResults: 60, NextToken });
    for (const p of r.Providers || []) if (p.ProviderName.startsWith('T-')) names.push(p.ProviderName);
    NextToken = r.NextToken;
  } while (NextToken);
  return names.sort();
}

// ---- 제품 클라이언트 ----
export interface UserClientIn { name: string; callbackUrls: string[]; logoutUrls: string[]; generateSecret: boolean; accessMinutes: number; refreshHours: number }
export async function createUserClient(cip: Cip, poolId: string, c: UserClientIn, idps: string[]) {
  const r = await cip.createUserPoolClient({
    UserPoolId: poolId, ClientName: c.name, GenerateSecret: c.generateSecret,
    AllowedOAuthFlows: ['code'], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthScopes: ['openid', 'email', 'profile'],
    CallbackURLs: c.callbackUrls, LogoutURLs: c.logoutUrls, SupportedIdentityProviders: idps.length ? idps : ['COGNITO'],
    AccessTokenValidity: c.accessMinutes, IdTokenValidity: c.accessMinutes, RefreshTokenValidity: c.refreshHours * 60,
    TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
    ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'], EnableTokenRevocation: true, PreventUserExistenceErrors: 'ENABLED',
  });
  return { clientId: r.UserPoolClient.ClientId as string, clientSecret: r.UserPoolClient.ClientSecret as string | undefined };
}
// 제품 백엔드 → 중앙 API(client_credentials). 범위: read·write
export async function createMachineClient(cip: Cip, poolId: string, name: string, scopes: string[]) {
  const r = await cip.createUserPoolClient({
    UserPoolId: poolId, ClientName: name, GenerateSecret: true,
    AllowedOAuthFlows: ['client_credentials'], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthScopes: scopes,
    AccessTokenValidity: 60, TokenValidityUnits: { AccessToken: 'minutes' }, EnableTokenRevocation: true, PreventUserExistenceErrors: 'ENABLED',
  });
  return { clientId: r.UserPoolClient.ClientId as string, clientSecret: r.UserPoolClient.ClientSecret as string };
}
