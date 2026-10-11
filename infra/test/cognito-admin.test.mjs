// alm-cognito-admin 본문 시험(WBS 3.3): 가짜 Cognito로 동작·검증·보호 규칙을 확인한다
import { describe, it, expect, beforeEach } from 'vitest';
import { handle, SAML_ATTRIBUTES } from '../lambda/cognito-admin/core.mjs';

const env = { userPoolId: 'us-east-1_TEST', webClientId: 'web', pdaClientId: 'pda' };
const nf = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });

function fakeCognito() {
  const s = {
    idps: new Map(),
    clients: new Map([
      ['web', { ClientId: 'web', ClientName: 'alm-web', UserPoolId: env.userPoolId, ClientSecret: 'w-secret', CallbackURLs: ['https://x/cb'],
        SupportedIdentityProviders: ['COGNITO'], AllowedOAuthFlows: ['code'], CreationDate: 1, LastModifiedDate: 2 }],
      ['pda', { ClientId: 'pda', ClientName: 'alm-pda', UserPoolId: env.userPoolId, SupportedIdentityProviders: ['COGNITO'] }],
    ]),
    secrets: new Map(), updates: [], seq: 0,
  };
  const client = (id) => { const c = s.clients.get(id); if (!c) throw nf(); return c; };
  const cip = {
    describeIdentityProvider: async ({ ProviderName }) => {
      const p = s.idps.get(ProviderName); if (!p) throw nf(); return { IdentityProvider: p };
    },
    createIdentityProvider: async (i) => { s.idps.set(i.ProviderName, { ...i }); },
    updateIdentityProvider: async (i) => { s.idps.set(i.ProviderName, { ...s.idps.get(i.ProviderName), ...i }); },
    deleteIdentityProvider: async ({ ProviderName }) => { if (!s.idps.delete(ProviderName)) throw nf(); },
    listIdentityProviders: async () => ({ Providers: [...s.idps.keys(), 'Google'].map((n) => ({ ProviderName: n })) }),
    describeUserPoolClient: async ({ ClientId }) => ({ UserPoolClient: { ...client(ClientId) } }),
    updateUserPoolClient: async (i) => { s.updates.push(i); s.clients.set(i.ClientId, { ...client(i.ClientId), ...i }); },
    createUserPoolClient: async (i) => {
      const id = `c${++s.seq}`; const c = { ...i, ClientId: id, ClientSecret: `secret-${id}` };
      s.clients.set(id, c); s.secrets.set(id, [{ ClientSecretId: 's0' }]); return { UserPoolClient: c };
    },
    deleteUserPoolClient: async ({ ClientId }) => { s.clients.delete(ClientId); },
    addUserPoolClientSecret: async ({ ClientId }) => {
      const d = { ClientSecretId: `s${s.secrets.get(ClientId).length}`, ClientSecretValue: 'new-secret', ClientSecretCreateDate: 3 };
      s.secrets.get(ClientId).push(d); return { ClientSecretDescriptor: d };
    },
    listUserPoolClientSecrets: async ({ ClientId }) => ({ ClientSecrets: s.secrets.get(ClientId) }),
    deleteUserPoolClientSecret: async ({ ClientId, ClientSecretId }) => {
      s.secrets.set(ClientId, s.secrets.get(ClientId).filter((x) => x.ClientSecretId !== ClientSecretId));
    },
  };
  return { s, cip };
}

let f;
beforeEach(() => { f = fakeCognito(); });
const run = (e) => handle(e, f.cip, env);

describe('테넌트 IdP', () => {
  it('SAML 등록 → T-<테넌트>, Entra 속성 매핑, 웹·PDA 클라이언트에 연결(다른 설정은 유지)', async () => {
    const r = await run({ action: 'registerIdp', tenantCode: 'ACME', type: 'SAML', metadataUrl: 'https://login.microsoftonline.com/x/federationmetadata.xml' });
    expect(r).toMatchObject({ ok: true, result: { providerName: 'T-ACME', created: true, samlEntityId: 'urn:amazon:cognito:sp:us-east-1_TEST' } });
    expect(f.s.idps.get('T-ACME')).toMatchObject({ ProviderType: 'SAML', AttributeMapping: SAML_ATTRIBUTES });
    expect(f.s.clients.get('web').SupportedIdentityProviders).toEqual(['COGNITO', 'T-ACME']);
    expect(f.s.clients.get('pda').SupportedIdentityProviders).toEqual(['COGNITO', 'T-ACME']);
    const webUpdate = f.s.updates.find((u) => u.ClientId === 'web');
    expect(webUpdate.CallbackURLs).toEqual(['https://x/cb']);          // 나머지 설정을 그대로 다시 보낸다
    expect(webUpdate).not.toHaveProperty('ClientSecret');              // 읽기 전용 항목은 빼고 보낸다
  });
  it('두 번 등록하면 갱신만(클라이언트는 다시 바꾸지 않음)', async () => {
    const e = { action: 'registerIdp', tenantCode: 'ACME', type: 'SAML', metadataUrl: 'https://idp/meta' };
    await run(e); const n = f.s.updates.length;
    const r = await run({ ...e, metadataUrl: 'https://idp/meta2' });
    expect(r.result.created).toBe(false);
    expect(f.s.idps.get('T-ACME').ProviderDetails.MetadataURL).toBe('https://idp/meta2');
    expect(f.s.updates.length).toBe(n);
  });
  it('OIDC 등록, 조회 때 클라이언트 비밀은 돌려주지 않음', async () => {
    await run({ action: 'registerIdp', tenantCode: 'BETA-2', type: 'OIDC', oidc: { issuer: 'https://okta.example.com', clientId: 'id', clientSecret: 'shh' } });
    const r = await run({ action: 'describeIdp', tenantCode: 'BETA-2' });
    expect(r.result.type).toBe('OIDC');
    expect(JSON.stringify(r)).not.toContain('shh');
  });
  it('잘못된 입력은 INVALID_INPUT(밑줄·소문자·http 금지)', async () => {
    for (const e of [
      { action: 'registerIdp', tenantCode: 'AC_ME', type: 'SAML', metadataUrl: 'https://x' },
      { action: 'registerIdp', tenantCode: 'acme', type: 'SAML', metadataUrl: 'https://x' },
      { action: 'registerIdp', tenantCode: 'ACME', type: 'SAML', metadataUrl: 'http://x' },
      { action: 'registerIdp', tenantCode: 'ACME', type: 'LDAP' },
      { action: 'nope' },
    ]) expect((await run(e)).error.code).toBe('INVALID_INPUT');
  });
  it('삭제: 클라이언트에서 빼고 IdP 삭제', async () => {
    await run({ action: 'registerIdp', tenantCode: 'ACME', type: 'SAML', metadataUrl: 'https://idp/meta' });
    await run({ action: 'removeIdp', tenantCode: 'ACME' });
    expect(f.s.idps.has('T-ACME')).toBe(false);
    expect(f.s.clients.get('web').SupportedIdentityProviders).toEqual(['COGNITO']);
  });
  it('syncIdps: 배포로 목록이 되돌아가도 T-* 를 다시 붙이고, T- 아닌 IdP는 건드리지 않음', async () => {
    await run({ action: 'registerIdp', tenantCode: 'ACME', type: 'SAML', metadataUrl: 'https://idp/meta' });
    f.s.clients.get('web').SupportedIdentityProviders = ['COGNITO'];   // CloudFormation 갱신 흉내
    const r = await run({ action: 'syncIdps' });
    expect(r.result).toEqual({ tenantIdps: ['T-ACME'], changedClients: 1 });
    expect(f.s.clients.get('web').SupportedIdentityProviders).toEqual(['COGNITO', 'T-ACME']);
  });
});

describe('SAP 클라이언트', () => {
  it('생성: alm-sap-<테넌트>-<sid>, client_credentials, sap.api, 60분, 비밀은 응답에만', async () => {
    const r = await run({ action: 'createSapClient', tenantCode: 'ACME', systemId: 'PRD' });
    expect(r.result).toMatchObject({ clientName: 'alm-sap-acme-prd', clientSecret: 'secret-c1' });
    expect(f.s.clients.get('c1')).toMatchObject({ AllowedOAuthFlows: ['client_credentials'], AllowedOAuthScopes: ['alm-api/sap.api'],
      AccessTokenValidity: 60, GenerateSecret: true });
  });
  it('비밀 교체: 추가 → 이전 비밀 삭제, 마지막 비밀은 못 지움', async () => {
    await run({ action: 'createSapClient', tenantCode: 'ACME', systemId: 'PRD' });
    const add = await run({ action: 'addSapSecret', clientId: 'c1' });
    expect(add.result).toMatchObject({ clientSecretId: 's1', clientSecret: 'new-secret' });
    expect((await run({ action: 'deleteSapSecret', clientId: 'c1', clientSecretId: 's0' })).ok).toBe(true);
    expect((await run({ action: 'deleteSapSecret', clientId: 'c1', clientSecretId: 's1' })).error.code).toBe('CONFLICT');
  });
  it('웹·PDA 클라이언트는 SAP 동작으로 건드릴 수 없음', async () => {
    for (const action of ['addSapSecret', 'listSapSecrets', 'deleteSapClient']) {
      expect((await run({ action, clientId: 'web' })).error.code).toBe('FORBIDDEN');
    }
    expect(f.s.clients.has('web')).toBe(true);
  });
  it('SID 형식 확인', async () => {
    expect((await run({ action: 'createSapClient', tenantCode: 'ACME', systemId: 'prd' })).error.code).toBe('INVALID_INPUT');
  });
});
