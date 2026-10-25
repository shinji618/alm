// IF-RC-01 대사 스냅샷 수신(08 5.6·5.7, openapi sapPostReconciliation). WBS 4.7
//   같은 batchId로 5,000건씩 분할(chunkNo 1부터). 첫 분할에 recon_run, 분할마다 recon_snapshot을 쌓고,
//   마지막 분할(isLast)에서 회사코드 + 자산번호로 ALM 자산과 맞춰 차이(recon_diff)를 만든다 → 202.
//   차이 계산은 집합 SQL 한 번이라 같은 요청 안에서 끝낸다(5만 건 기준 수 초). 오래 걸리면 worker 작업으로 옮긴다.
//   ALM 쪽 비교 대상: 같은 회사코드의 자산 중 RETIRED·DISPOSED는 비활성 12개월 이내만(스냅샷 범위와 같게).
//
//   차이(08 5.7)            조건                                    기본 조치
//   SAP_ONLY     SAP 자산이 ALM에 없음(SAP 비활성 제외)              SAP_TO_ALM(ALM에 생성)
//   ALM_ONLY     SAP 번호가 있는 ALM 자산이 스냅샷에 없음             REVIEW
//   COST_CENTER  KOSTL ≠ ALM 코스트센터                              SAP_TO_ALM
//   LOCATION     설명 2행(TXA50) ≠ ALM 사이트·룸(desc2, D-09 변경)   ALM_TO_SAP(IF-AA-04 description2)
//   SERIAL       SERNR ≠ ALM 시리얼                                  ALM_TO_SAP
//   TAG          INVNR이 있고 ≠ ALM 자산태그(INVNR 빈 값은 비교 안 함: 기본 SEND_INVNO 꺼짐)  ALM_TO_SAP
//   RETIRED      DEAKT 있음, ALM 활성                                SAP_TO_ALM(ALM RETIRED)
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AlmError } from '../common/errors';
import type { SapConn } from '../auth/sap';
import { Batch, logRun, Rec, RecError } from './inbound';

export const RC_MAX = 5000;
const chunkKey = (n: number) => `CHUNK:RC:${n}`;

interface Snap { assetNo: string; subNo: string; inventoryNo: string | null; serialNo: string | null; costCenter: string | null;
  location: string | null; room: string | null; deactDate: string | null; description2: string | null }

export async function postReconciliation(c: PoolClient, conn: SapConn, body: unknown, correlationId?: string): Promise<{ status: number; body: unknown }> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const bad = (m: string, code = 'ALM-E100'): never => { throw new AlmError(400, code, `입력 값을 확인하세요: ${m}`); };
  const h = new Rec(b);
  let batchId: string, runType: string, campaign: string | undefined, snapshotAt: string, chunkNo: number;
  try {
    batchId = h.str('batchId', 40, true)!;
    runType = h.str('runType', 10, true)!;
    campaign = h.str('campaignCode', 6);
    snapshotAt = h.ts('snapshotAt', true)!;
    chunkNo = h.int('chunkNo', { min: 1, max: 10000, required: true })!;
  } catch (e) { return bad((e as Error).message, (e as RecError).code); }
  if (runType !== 'WEEKLY' && runType !== 'CAMPAIGN') bad('runType은 WEEKLY 또는 CAMPAIGN');
  if (runType === 'CAMPAIGN' && !campaign) bad('CAMPAIGN이면 campaignCode 필수', 'ALM-E101');
  const isLast = b.isLast === true;
  if (!Array.isArray(b.records)) bad('records 배열이 필요합니다', 'ALM-E101');
  const raw = b.records as unknown[];
  if (raw.length > RC_MAX) throw new AlmError(400, 'ALM-E106', `한 번에 최대 ${RC_MAX}건입니다(받은 ${raw.length}건)`);

  // 레코드 검사: 한 건이라도 틀리면 분할 전체 400(SAP이 송신 전에 걸러 보낸다. 08 4.3)
  const errors: { index: number; code: string; message: string }[] = [];
  const snaps: Snap[] = [];
  raw.forEach((x, i) => {
    try {
      const f = new Rec((x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Record<string, unknown>);
      const cc = f.str('companyCode', 4, true)!;
      if (cc !== conn.companyCode) throw new RecError('ALM-E401', `연결(${conn.companyCode})에 허용되지 않은 회사코드 ${cc}`);
      snaps.push({ assetNo: f.str('assetNo', 12, true)!, subNo: f.str('subNo', 4, true)!, inventoryNo: f.str('inventoryNo', 25) ?? null,
        serialNo: f.str('serialNo', 18) ?? null, costCenter: f.str('costCenter', 10) ?? null, location: f.str('location', 10) ?? null,
        room: f.str('room', 8) ?? null, deactDate: f.date('deactDate') ?? null, description2: f.str('description2', 50) ?? null });
    } catch (e) { errors.push({ index: i, code: (e as RecError).code ?? 'ALM-E100', message: (e as Error).message }); }
  });
  if (errors.length) throw new AlmError(400, errors[0].code, `입력 값을 확인하세요: records[${errors[0].index}] ${errors[0].message} 외 ${errors.length - 1}건`,
    { errors: errors.slice(0, 50) });

  const startedAt = new Date();
  let run = (await c.query('SELECT id, status FROM recon_run WHERE batch_id = $1 FOR UPDATE', [batchId])).rows[0];
  const prev = run ? (await c.query(`SELECT m.record_key FROM sap_if_message m JOIN sap_if_run r ON r.id = m.run_id
      WHERE r.interface_id = 'IF-RC-01' AND r.batch_id = $1 AND m.result = 'CHUNK'`, [batchId])).rows.map((r) => Number(String(r.record_key).split(':')[2])) : [];
  const order = (m: string) => new AlmError(409, 'ALM-E303', `분할 순서 오류: ${m}. 새 batchId로 처음부터 다시 보내세요`);
  if (chunkNo === 1) {
    if (run) throw order(`배치 ${batchId}는 이미 시작됨`);
    let campaignId: string | null = null;
    if (campaign) {
      campaignId = (await c.query('SELECT id FROM count_campaign WHERE campaign_code = $1 AND company_id = $2', [campaign, conn.companyId])).rows[0]?.id ?? null;
      if (!campaignId) throw new AlmError(400, 'ALM-E100', `입력 값을 확인하세요: 실사 캠페인 ${campaign}이(가) 없습니다`);
    }
    run = (await c.query(`INSERT INTO recon_run (id, tenant_id, run_type, batch_id, count_campaign_id, status, snapshot_at)
      VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6) RETURNING id, status`, [randomUUID(), conn.tenantId, runType, batchId, campaignId, snapshotAt])).rows[0];
  } else {
    if (!run) throw order(`배치 ${batchId}의 1번 분할이 없음`);
    if (run.status !== 'RUNNING') throw order(`배치 ${batchId}는 이미 끝남`);
    if (prev.includes(chunkNo) || !prev.includes(chunkNo - 1)) throw order(`${chunkNo}번(받은 분할: ${prev.sort((x, y) => x - y).join(',')})`);
  }

  const ins = snaps.length ? (await c.query(
    `INSERT INTO recon_snapshot (id, tenant_id, run_id, company_code, sap_asset_no, sap_sub_no, inventory_no, serial_no, cost_center_code, location, room_no, deact_date, description2)
     SELECT gen_random_uuid(), $1, $2, $3, x.a, x.s, x.inv, x.ser, x.cc, x.loc, x.room, x.deact, x.d2
       FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::date[], $12::text[]) AS x(a, s, inv, ser, cc, loc, room, deact, d2)
     ON CONFLICT (run_id, company_code, sap_asset_no, sap_sub_no) DO NOTHING`,
    [conn.tenantId, run.id, conn.companyCode, snaps.map((s) => s.assetNo), snaps.map((s) => s.subNo), snaps.map((s) => s.inventoryNo), snaps.map((s) => s.serialNo),
      snaps.map((s) => s.costCenter), snaps.map((s) => s.location), snaps.map((s) => s.room), snaps.map((s) => s.deactDate), snaps.map((s) => s.description2)])).rowCount ?? 0 : 0;
  await c.query('UPDATE recon_run SET sap_count = sap_count + $2, updated_at = now(), version = version + 1 WHERE id = $1', [run.id, ins]);

  const batch = new Batch(batchId, snaps.length);
  for (let i = 0; i < snaps.length - ins; i++) batch.skip(`DUP:${i + 1}`, '같은 배치에 이미 받은 자산번호');
  batch.ok = ins;
  batch.extra.push({ key: chunkKey(chunkNo), result: 'CHUNK', message: isLast ? 'last' : undefined });
  if (isLast) {
    const r = await computeDiffs(c, conn, run.id);
    await c.query(`UPDATE recon_run SET status = 'SUCCEEDED', alm_count = $2, diff_count = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
      [run.id, r.alm, r.diffs]);
  }
  await logRun(c, conn, { interfaceId: 'IF-RC-01', batchId, correlationId, startedAt, batch, httpStatus: isLast ? 202 : 200 });
  return { status: isLast ? 202 : 200, body: { batchId, runId: run.id, received: snaps.length, status: isLast ? 'PROCESSING' : 'RECEIVING' } };
}

export async function computeDiffs(c: PoolClient, conn: SapConn, runId: string): Promise<{ alm: number; diffs: number }> {
  // desc2(사이트, 룸)와 같은 규칙(common/sap-text): 'Location: 사이트 | Room: 룸', 없는 쪽은 빼고 50자
  const scope = `SELECT a.id, a.sap_asset_no, a.sap_sub_no, a.asset_tag, a.serial_no, a.status, cc.cost_center_code, rm.room_code,
           nullif(left(concat_ws(' | ', 'Location: ' || st.site_code, 'Room: ' || rm.room_code), 50), '') AS desc2
      FROM asset a LEFT JOIN cost_center cc ON cc.id = a.cost_center_id LEFT JOIN room rm ON rm.id = a.room_id LEFT JOIN site st ON st.id = rm.site_id
     WHERE a.company_id = $2 AND (a.status NOT IN ('RETIRED', 'DISPOSED')
           OR coalesce(a.sap_deact_date, a.updated_at::date) >= current_date - interval '12 months')`;
  const alm = (await c.query(`SELECT count(*)::int AS n FROM (${scope.replace('$2', '$1')}) s`, [conn.companyId])).rows[0].n as number;
  const r = await c.query(
    `WITH alm AS (${scope}),
          snap AS (SELECT * FROM recon_snapshot WHERE run_id = $1),
          m AS (SELECT s.*, a.id AS asset_id, a.asset_tag, a.serial_no AS alm_serial, a.status, a.cost_center_code AS alm_cc, a.room_code, a.desc2
                  FROM snap s JOIN alm a ON a.sap_asset_no = s.sap_asset_no AND a.sap_sub_no = s.sap_sub_no)
     INSERT INTO recon_diff (id, tenant_id, run_id, diff_type, asset_id, sap_asset_no, sap_sub_no, alm_value, sap_value, action)
     SELECT gen_random_uuid(), $3, $1, d.t::recon_diff_type, d.asset_id, d.no, d.sub, left(d.alm, 100), left(d.sap, 100), d.act::recon_action FROM (
       SELECT 'SAP_ONLY' AS t, NULL::uuid AS asset_id, s.sap_asset_no AS no, s.sap_sub_no AS sub, NULL::text AS alm, s.inventory_no::text AS sap, 'SAP_TO_ALM' AS act
         FROM snap s WHERE s.deact_date IS NULL
          AND NOT EXISTS (SELECT 1 FROM alm a WHERE a.sap_asset_no = s.sap_asset_no AND a.sap_sub_no = s.sap_sub_no)
       UNION ALL
       SELECT 'ALM_ONLY', a.id, a.sap_asset_no, a.sap_sub_no, a.asset_tag, NULL, 'REVIEW'
         FROM alm a WHERE a.sap_asset_no IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM snap s WHERE s.sap_asset_no = a.sap_asset_no AND s.sap_sub_no = a.sap_sub_no)
       UNION ALL
       SELECT 'RETIRED', asset_id, sap_asset_no, sap_sub_no, status::text, deact_date::text, 'SAP_TO_ALM'
         FROM m WHERE deact_date IS NOT NULL AND status NOT IN ('RETIRED', 'DISPOSED')
       UNION ALL
       SELECT 'COST_CENTER', asset_id, sap_asset_no, sap_sub_no, alm_cc, cost_center_code, 'SAP_TO_ALM'
         FROM m WHERE deact_date IS NULL AND cost_center_code IS NOT NULL AND cost_center_code IS DISTINCT FROM alm_cc
       UNION ALL
       SELECT 'LOCATION', asset_id, sap_asset_no, sap_sub_no, desc2, description2, 'ALM_TO_SAP'
         FROM m WHERE deact_date IS NULL AND coalesce(description2, '') <> coalesce(desc2, '')
       UNION ALL
       SELECT 'SERIAL', asset_id, sap_asset_no, sap_sub_no, alm_serial, serial_no, 'ALM_TO_SAP'
         FROM m WHERE deact_date IS NULL AND coalesce(serial_no, '') <> coalesce(alm_serial, '')
       UNION ALL
       SELECT 'TAG', asset_id, sap_asset_no, sap_sub_no, asset_tag, inventory_no, 'ALM_TO_SAP'
         FROM m WHERE deact_date IS NULL AND coalesce(inventory_no, '') <> '' AND inventory_no <> asset_tag
     ) d`, [runId, conn.companyId, conn.tenantId]);
  return { alm, diffs: r.rowCount ?? 0 };
}
