// 테넌트 SSO 연결(13 런북의 절차를 API로): IdP 등록 → 그 테넌트가 쓰는 제품의 USER 클라이언트에 연결
import { Tx } from './db';
import { Cip, describeIdp, listTenantIdps, registerIdp, removeIdp, setClientIdps } from './cognito';

export interface CognitoEnv { cip: Cip; poolId: string; authDomain?: string }

// 모든 USER 클라이언트의 테넌트 IdP 목록을 DB(테넌트 제품)와 풀의 IdP에 맞춘다. T-* 아닌 항목(COGNITO 등)은 둔다
export async function syncIdps(c: Tx, ce: CognitoEnv) {
  const existing = new Set(await listTenantIdps(ce.cip, ce.poolId));
  const rows = (await c.query(`SELECT pc.client_id, coalesce(json_agg('T-' || t.code ORDER BY t.code) FILTER (WHERE t.code IS NOT NULL), '[]')::text AS idps
      FROM product_client pc LEFT JOIN tenant_product tp ON tp.product_code = pc.product_code LEFT JOIN tenant t ON t.id = tp.tenant_id AND t.is_active
     WHERE pc.kind = 'USER' GROUP BY pc.client_id ORDER BY pc.client_id`)).rows;
  let changed = 0;
  for (const r of rows) {
    const want = (JSON.parse(r.idps) as string[]).filter((x) => existing.has(x));
    if (await setClientIdps(ce.cip, ce.poolId, r.client_id, (l) => {
      const rest = l.filter((x) => !x.startsWith('T-') && !(want.length && x === 'COGNITO'));
      return [...rest, ...want].length ? [...rest, ...want] : ['COGNITO'];
    })) changed++;
  }
  return { tenantIdps: [...existing].sort(), userClients: rows.length, changedClients: changed };
}

export async function putSso(c: Tx, ce: CognitoEnv, tenantCode: string, body: unknown) {
  const r = await registerIdp(ce.cip, ce.poolId, tenantCode, body);
  const sync = await syncIdps(c, ce);
  return { ...r, acsUrl: ce.authDomain ? `https://${ce.authDomain}/saml2/idpresponse` : undefined, changedClients: sync.changedClients };
}
export async function getSso(ce: CognitoEnv, tenantCode: string) {
  return { ...(await describeIdp(ce.cip, ce.poolId, tenantCode)), acsUrl: ce.authDomain ? `https://${ce.authDomain}/saml2/idpresponse` : undefined };
}
export async function deleteSso(c: Tx, ce: CognitoEnv, tenantCode: string) {
  const name = `T-${tenantCode}`;
  const clients = (await c.query(`SELECT client_id FROM product_client WHERE kind = 'USER'`)).rows.map((r) => r.client_id as string);
  for (const id of clients) await setClientIdps(ce.cip, ce.poolId, id, (l) => { const n = l.filter((x) => x !== name); return n.length ? n : ['COGNITO']; });
  await removeIdp(ce.cip, ce.poolId, tenantCode);
  return { providerName: name, removed: true };
}
