// alm-cognito-admin 본문(WBS 3.3, 09 설계서 6.2·6.3·6.6, 10 정의서 6.2)
// api는 Cognito 권한이 없고 이 Lambda만 호출한다. 이 Lambda가 하는 일은 아래 동작뿐이다.
//   테넌트 IdP(T-<테넌트>) 등록·수정·삭제, 웹·PDA 클라이언트의 IdP 목록 맞추기,
//   SAP 클라이언트(alm-sap-<테넌트>-<SID>) 생성·삭제, 비밀 추가·조회·삭제(교체)
// 웹·PDA 클라이언트는 IdP 목록(SupportedIdentityProviders)만 바꾼다. 다른 설정은 그대로 둔다.
// 비밀 값은 로그에 남기지 않는다. 생성·추가 응답에서 한 번만 돌려준다.
//
// cip: Cognito 호출 어댑터(index.mjs가 SDK로 만든다. 시험에서는 가짜를 넣는다)
// env: { userPoolId, webClientId, pdaClientId }

export const TENANT_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,18}[A-Z0-9])?$/; // 대문자·숫자·하이픈, 밑줄 금지(09 6.1)
export const SID_RE = /^[A-Z][A-Z0-9]{2}$/;                        // SAP 시스템 ID(예: PRD, QAS)
export const SAP_PREFIX = 'alm-sap-';
export const SAP_SCOPE = 'alm-api/sap.api';
const IDP_PREFIX = 'T-';

// Entra ID SAML 기본 클레임 → 사용자 풀 속성
export const SAML_ATTRIBUTES = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  name: 'http://schemas.microsoft.com/identity/claims/displayname',
};
export const OIDC_ATTRIBUTES = { email: 'email', name: 'name', email_verified: 'email_verified' };

export class AdminError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const bad = (m) => { throw new AdminError('INVALID_INPUT', m); };

export const idpName = (tenantCode) => {
  if (typeof tenantCode !== 'string' || !TENANT_RE.test(tenantCode)) bad('tenantCode: 대문자·숫자·하이픈 1~20자');
  return `${IDP_PREFIX}${tenantCode}`;
};
const sapClientName = (tenantCode, systemId) => {
  idpName(tenantCode);
  if (typeof systemId !== 'string' || !SID_RE.test(systemId)) bad('systemId: SAP SID 3자(예: PRD)');
  return `${SAP_PREFIX}${tenantCode.toLowerCase()}-${systemId.toLowerCase()}`;
};
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);

function idpDetails(input) {
  if (input.type === 'SAML') {
    const d = { IDPSignout: 'false', RequestSigningAlgorithm: 'rsa-sha256' };
    if (input.metadataUrl) { if (!isHttps(input.metadataUrl)) bad('metadataUrl: https URL'); d.MetadataURL = input.metadataUrl; }
    else if (typeof input.metadataXml === 'string' && input.metadataXml.includes('EntityDescriptor')) d.MetadataFile = input.metadataXml;
    else bad('SAML: metadataUrl 또는 metadataXml 필요');
    return { ProviderType: 'SAML', ProviderDetails: d, AttributeMapping: SAML_ATTRIBUTES };
  }
  if (input.type === 'OIDC') {
    const o = input.oidc || {};
    if (!isHttps(o.issuer) || !o.clientId || !o.clientSecret) bad('OIDC: oidc.issuer(https)·clientId·clientSecret 필요');
    return { ProviderType: 'OIDC', AttributeMapping: OIDC_ATTRIBUTES, ProviderDetails: {
      oidc_issuer: o.issuer, client_id: o.clientId, client_secret: o.clientSecret,
      authorize_scopes: 'openid email profile', attributes_request_method: 'GET' } };
  }
  return bad('type: SAML 또는 OIDC');
}

// 클라이언트 설정을 그대로 두고 IdP 목록만 바꾼다(UpdateUserPoolClient는 빠진 항목을 기본값으로 되돌리므로 전체를 다시 보낸다)
const READ_ONLY = ['ClientSecret', 'CreationDate', 'LastModifiedDate'];
async function setClientIdps(cip, env, clientId, mutate) {
  const c = (await cip.describeUserPoolClient({ UserPoolId: env.userPoolId, ClientId: clientId })).UserPoolClient;
  const before = c.SupportedIdentityProviders || [];
  const after = [...new Set(mutate(before))].sort();
  if (after.length === before.length && after.every((x) => before.includes(x))) return false;
  const input = { ...c, SupportedIdentityProviders: after };
  for (const k of READ_ONLY) delete input[k];
  await cip.updateUserPoolClient(input);
  return true;
}
const userClients = (env) => [env.webClientId, env.pdaClientId];

async function listTenantIdps(cip, env) {
  const names = []; let NextToken;
  do {
    const r = await cip.listIdentityProviders({ UserPoolId: env.userPoolId, MaxResults: 60, NextToken });
    for (const p of r.Providers || []) if (p.ProviderName.startsWith(IDP_PREFIX)) names.push(p.ProviderName);
    NextToken = r.NextToken;
  } while (NextToken);
  return names.sort();
}

async function sapClient(cip, env, clientId) {
  if (typeof clientId !== 'string' || !clientId) bad('clientId 필요');
  const c = (await cip.describeUserPoolClient({ UserPoolId: env.userPoolId, ClientId: clientId })).UserPoolClient;
  if (!c.ClientName?.startsWith(SAP_PREFIX)) throw new AdminError('FORBIDDEN', 'SAP 클라이언트(alm-sap-*)만 다룰 수 있다');
  return c;
}

export const actions = {
  // 테넌트 IdP 등록(없으면 생성, 있으면 갱신) + 웹·PDA 클라이언트에 연결
  async registerIdp(cip, env, input) {
    const name = idpName(input.tenantCode);
    const det = idpDetails(input);
    let created = true;
    try {
      await cip.describeIdentityProvider({ UserPoolId: env.userPoolId, ProviderName: name });
      created = false;
    } catch (e) { if (e.name !== 'ResourceNotFoundException') throw e; }
    if (created) await cip.createIdentityProvider({ UserPoolId: env.userPoolId, ProviderName: name, ...det });
    else await cip.updateIdentityProvider({ UserPoolId: env.userPoolId, ProviderName: name,
      ProviderDetails: det.ProviderDetails, AttributeMapping: det.AttributeMapping });
    for (const id of userClients(env)) await setClientIdps(cip, env, id, (l) => [...l, name]);
    return { providerName: name, created,
      samlEntityId: `urn:amazon:cognito:sp:${env.userPoolId}` };
  },

  async describeIdp(cip, env, input) {
    const name = idpName(input.tenantCode);
    const p = (await cip.describeIdentityProvider({ UserPoolId: env.userPoolId, ProviderName: name })).IdentityProvider;
    const d = { ...(p.ProviderDetails || {}) };
    delete d.client_secret; delete d.MetadataFile;
    return { providerName: name, type: p.ProviderType, details: d, attributeMapping: p.AttributeMapping };
  },

  // 웹·PDA 클라이언트에서 빼고 IdP 삭제
  async removeIdp(cip, env, input) {
    const name = idpName(input.tenantCode);
    for (const id of userClients(env)) await setClientIdps(cip, env, id, (l) => l.filter((x) => x !== name));
    try { await cip.deleteIdentityProvider({ UserPoolId: env.userPoolId, ProviderName: name }); }
    catch (e) { if (e.name !== 'ResourceNotFoundException') throw e; }
    return { providerName: name, removed: true };
  },

  // 배포 뒤 실행: CloudFormation이 클라이언트를 갱신하면 IdP 목록이 템플릿 값으로 돌아가므로 T-* 를 다시 붙인다
  async syncIdps(cip, env) {
    const idps = await listTenantIdps(cip, env);
    const changed = [];
    for (const id of userClients(env)) {
      if (await setClientIdps(cip, env, id, (l) => [...l.filter((x) => !x.startsWith(IDP_PREFIX)), ...idps])) changed.push(id);
    }
    return { tenantIdps: idps, changedClients: changed.length };
  },

  // SAP 연결마다 클라이언트 1개(client_credentials, 60분). 비밀은 이 응답에서 한 번만 돌려준다
  async createSapClient(cip, env, input) {
    const name = sapClientName(input.tenantCode, input.systemId);
    const r = await cip.createUserPoolClient({
      UserPoolId: env.userPoolId, ClientName: name, GenerateSecret: true,
      AllowedOAuthFlows: ['client_credentials'], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthScopes: [SAP_SCOPE],
      AccessTokenValidity: 60, TokenValidityUnits: { AccessToken: 'minutes' },
      EnableTokenRevocation: true, PreventUserExistenceErrors: 'ENABLED',
    });
    const c = r.UserPoolClient;
    return { clientName: c.ClientName, clientId: c.ClientId, clientSecret: c.ClientSecret };
  },

  // 비밀 교체(09 6.6): 새 비밀 추가 → SAP 반영 → 24시간 뒤 이전 비밀 삭제(api가 예약)
  async addSapSecret(cip, env, input) {
    await sapClient(cip, env, input.clientId);
    const r = await cip.addUserPoolClientSecret({ UserPoolId: env.userPoolId, ClientId: input.clientId });
    const s = r.ClientSecretDescriptor || {};
    return { clientId: input.clientId, clientSecretId: s.ClientSecretId, clientSecret: s.ClientSecretValue,
      createdAt: s.ClientSecretCreateDate };
  },

  async listSapSecrets(cip, env, input) {
    await sapClient(cip, env, input.clientId);
    const r = await cip.listUserPoolClientSecrets({ UserPoolId: env.userPoolId, ClientId: input.clientId });
    return { clientId: input.clientId, secrets: (r.ClientSecrets || []).map((s) => ({
      clientSecretId: s.ClientSecretId, createdAt: s.ClientSecretCreateDate })) };
  },

  async deleteSapSecret(cip, env, input) {
    await sapClient(cip, env, input.clientId);
    if (typeof input.clientSecretId !== 'string' || !input.clientSecretId) bad('clientSecretId 필요');
    const { secrets } = await actions.listSapSecrets(cip, env, input);
    if (secrets.length <= 1) throw new AdminError('CONFLICT', '마지막 비밀은 지울 수 없다(새 비밀을 먼저 추가)');
    await cip.deleteUserPoolClientSecret({ UserPoolId: env.userPoolId, ClientId: input.clientId, ClientSecretId: input.clientSecretId });
    return { clientId: input.clientId, deleted: input.clientSecretId };
  },

  async deleteSapClient(cip, env, input) {
    await sapClient(cip, env, input.clientId);
    await cip.deleteUserPoolClient({ UserPoolId: env.userPoolId, ClientId: input.clientId });
    return { clientId: input.clientId, deleted: true };
  },
};

// 요청: { action, ...입력 }. 응답: { ok: true, result } 또는 { ok: false, error: { code, message } }
export async function handle(event, cip, env) {
  const fn = Object.hasOwn(actions, event?.action) ? actions[event.action] : undefined;
  try {
    if (!fn) bad(`action: ${Object.keys(actions).join(' | ')}`);
    return { ok: true, result: await fn(cip, env, event) };
  } catch (e) {
    if (e instanceof AdminError) return { ok: false, error: { code: e.code, message: e.message } };
    const code = e?.name === 'ResourceNotFoundException' ? 'NOT_FOUND'
      : e?.name === 'DuplicateProviderException' ? 'CONFLICT'
      : e?.name === 'LimitExceededException' ? 'LIMIT' : 'COGNITO_ERROR';
    return { ok: false, error: { code, message: String(e?.message || e).slice(0, 500) } };
  }
}
