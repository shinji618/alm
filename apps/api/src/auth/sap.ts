// SAP 머신 인증(09 6.6, 08 4.4): client_id → 연결(테넌트·회사코드·시스템 ID·허용 IP)
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { Db } from '../db/pool';

export interface SapConn {
  tenantId: string; tenantCode: string; connectionId: string; companyId: string; companyCode: string;
  systemId: string; allowedCidrs: string[]; clientId: string;
}

export async function sapConnection(db: Db, clientId: string): Promise<SapConn | undefined> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) return undefined;
  const r = (await db.query<{ tenant_id: string; connection_id: string; company_id: string; system_id: string; allowed_cidrs: unknown }>(
    'SELECT * FROM auth_sap_client($1)', [clientId]))[0];
  if (!r) return undefined;
  const extra = await db.withTx({ tenantId: r.tenant_id, actorType: 'SAP' }, async (c) => (await c.query(
    `SELECT t.code AS tenant_code, co.company_code, co.sap_enabled FROM tenant t, company co WHERE t.id = $1 AND co.id = $2`, [r.tenant_id, r.company_id])).rows[0]);
  if (!extra?.sap_enabled) return undefined;   // SAP 연계를 끈 회사: 연결이 있어도 쓰지 않는다
  return { tenantId: r.tenant_id, tenantCode: extra?.tenant_code ?? '', connectionId: r.connection_id, companyId: r.company_id,
    companyCode: extra?.company_code ?? '', systemId: r.system_id, clientId,
    allowedCidrs: Array.isArray(r.allowed_cidrs) ? r.allowed_cidrs.filter((x): x is string => typeof x === 'string') : [] };
}

/** SM59 기본 인증용 별칭(12자 이내) → Cognito clientId. 별칭 형식이 아니거나 없으면 undefined */
export const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{2,11}$/;
export async function sapClientByAlias(db: Db, alias: string): Promise<string | undefined> {
  if (!ALIAS.test(alias)) return undefined;
  return (await db.query<{ id: string | null }>('SELECT auth_sap_alias($1) AS id', [alias]))[0]?.id ?? undefined;
}

// 허용 IP(CIDR 목록). 목록이 비면 WAF 허용 목록만 적용(결정 S-09)
export function ipAllowed(ip: string | undefined, cidrs: string[]): boolean {
  if (!cidrs.length) return true;
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, '');
  const type = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : undefined;
  if (!type) return false;
  const bl = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split('/');
    const t = isIPv4(net) ? 'ipv4' : isIPv6(net) ? 'ipv6' : undefined;
    if (!t) continue;
    const prefix = bits === undefined ? (t === 'ipv4' ? 32 : 128) : Number(bits);
    if (Number.isInteger(prefix)) bl.addSubnet(net, prefix, t);
  }
  return bl.check(addr, type);
}
