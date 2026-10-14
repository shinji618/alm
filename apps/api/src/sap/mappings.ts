// 기본 필드 매핑(08 인터페이스 명세서 5·6장). 테넌트 등록(seed) 때 비어 있으면 넣는다. 화면(ALM-310)은 설명만 고친다
import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';

export const DEFAULT_MAPPINGS: [string, string, string, 'SAP' | 'ALM', string, string][] = [
  ['company.company_code', 'T001', 'BUKRS', 'SAP', 'IF-MD-01', '회사코드'],
  ['cost_center.cost_center_code', 'CSKS', 'KOSTL', 'SAP', 'IF-MD-01', '코스트센터(유효기간 DATAB·DATBI)'],
  ['profit_center.profit_center_code', 'CEPC', 'PRCTR', 'SAP', 'IF-MD-01', '손익센터·세그먼트(이관 ABUMN 판단)'],
  ['asset_class.class_code', 'ANKA', 'ANLKL', 'SAP', 'IF-MD-01', '자산클래스(ALM 직접 등록 클래스 제외)'],
  ['asset.sap_asset_no', 'ANLA', 'ANLN1', 'SAP', 'IF-AA-01, IF-AA-03', '자산번호. 신규는 IF-AA-03 결과로 받음'],
  ['asset.sap_sub_no', 'ANLA', 'ANLN2', 'SAP', 'IF-AA-01, IF-AA-03', '보조번호'],
  ['asset.description', 'ANLA', 'TXT50', 'SAP', 'IF-AA-01, IF-AA-03, IF-AA-04', '자산명. ALM에서 바꾸면 IF-AA-04로 보냄'],
  ['asset.asset_class_id', 'ANLA', 'ANLKL', 'SAP', 'IF-AA-01, IF-AA-03', '자산클래스'],
  ['asset.asset_tag', 'ANLA', 'INVNR', 'ALM', 'IF-AA-03, IF-AA-04', '자산태그 = 재고번호'],
  ['asset.serial_no', 'ANLA', 'SERNR', 'ALM', 'IF-AA-03, IF-AA-04', '시리얼(SAP 18자)'],
  ['asset.room_id', 'ANLZ', 'STORT', 'ALM', 'IF-AA-03, IF-AA-04', '룸 코드 = 위치'],
  ['asset.cost_center_id', 'ANLZ', 'KOSTL', 'SAP', 'IF-AA-01, IF-AA-04, IF-AA-05', '코스트센터. ALM 변경은 승인 후 전기'],
  ['asset.sap_cap_date', 'ANLA', 'AKTIV', 'SAP', 'IF-AA-01', '취득일'],
  ['asset.sap_deact_date', 'ANLA', 'DEAKT', 'SAP', 'IF-AA-01, IF-RC-01', '비활성일'],
  ['asset.last_count_date', 'ANLA', 'IVDAT', 'ALM', 'IF-AA-07', '마지막 실사일'],
  ['asset.last_count_note', 'ANLA', 'INVZU', 'ALM', 'IF-AA-07', '실사 메모'],
  ['asset_value.acquisition_value', 'ANLC', 'KANSW+ANSWL', 'SAP', 'IF-AA-02', '취득가(상각영역 01)'],
  ['asset_value.accum_depreciation', 'ANLC', 'KNAFA+NAFAG', 'SAP', 'IF-AA-02', '감가상각누계액'],
  ['po_item.po_no', 'EKPO', 'EBELN', 'SAP', 'IF-MM-01, IF-MM-02', '자산 PO(계정지정 A)'],
  ['goods_receipt.material_doc', 'MATDOC', 'MBLNR', 'SAP', 'IF-MM-03', '입고 자재문서(101·102·122)'],
];

export async function seedFieldMappings(c: Client | PoolClient, tenantId: string): Promise<number> {
  if ((await c.query('SELECT 1 FROM field_mapping WHERE tenant_id = $1 LIMIT 1', [tenantId])).rowCount) return 0;
  for (const [alm, table, field, master, ifs, desc] of DEFAULT_MAPPINGS) {
    await c.query(`INSERT INTO field_mapping (id, tenant_id, alm_field, sap_table, sap_field, master_system, interface_ids, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), tenantId, alm, table, field, master, ifs, desc]);
  }
  return DEFAULT_MAPPINGS.length;
}
