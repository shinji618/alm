// 최소 XLSX·CSV 읽기(외부 라이브러리 없이, 자산 일괄 업로드용). 첫 시트(또는 이름이 맞는 시트)의 셀을 문자열 표로 돌려준다.
//   ZIP: 끝의 중앙 디렉터리에서 항목을 찾아 STORE·DEFLATE(node:zlib inflateRawSync)를 푼다. 암호화·ZIP64는 지원하지 않는다
//   셀: 공유 문자열(t="s"), 인라인 문자열, 숫자, 불리언, 수식 결과(t="str"). 날짜 셀은 숫자(엑셀 일련번호)로 오므로 호출 쪽이 열 종류에 따라 바꾼다
import { inflateRawSync } from 'node:zlib';

export interface RawSheet { name: string; rows: string[][] }

const MAX_ENTRY = 20 * 1024 * 1024;

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (usize > MAX_ENTRY) throw new Error('zip entry too large');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY }));
  }
  return out;
}

const unesc = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
  const m: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (m[e.toLowerCase()]) return m[e.toLowerCase()];
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
/** <t> 조각을 이어 붙인다(서식 run <r><t>…</t></r> 포함, 발음 <rPh> 제외) */
const textOf = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export function readXlsx(buf: Buffer, preferSheet?: string): RawSheet {
  const files = unzip(buf);
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Error('not an xlsx workbook');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: unesc(/name="([^"]*)"/.exec(m[1])?.[1] ?? ''), rid: /r:id="([^"]*)"/.exec(m[1])?.[1] ?? '' }));
  const pick = sheets.find((s) => preferSheet && s.name.toLowerCase() === preferSheet.toLowerCase()) ?? sheets[0];
  if (!pick) throw new Error('no sheet');
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => ({ id: /Id="([^"]*)"/.exec(m[1])?.[1], target: /Target="([^"]*)"/.exec(m[1])?.[1] }))
    .find((r) => r.id === pick.rid);
  const target = rel?.target ?? 'worksheets/sheet1.xml';
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const xml = files.get(path)?.toString('utf8');
  if (!xml) throw new Error('sheet not found');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(/r="(\d+)"/.exec(rm[1])?.[1] ?? rows.length + 1) - 1;
    const row: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const ci = ref ? colIndex(ref) : row.length;
      const t = /t="([^"]*)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(body);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v !== undefined ? unesc(v) : '';
      row[ci] = val;
    }
    rows[r] = Array.from(row, (x) => x ?? '');
  }
  return { name: pick.name, rows: Array.from(rows, (x) => x ?? []) };
}

/** CSV(RFC 4180, 쉼표·세미콜론·탭 자동, UTF-8 BOM 무시) */
export function readCsv(text: string): RawSheet {
  const s = text.replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return { name: 'csv', rows };
}

/** 엑셀 날짜 일련번호(1900 체계) → YYYY-MM-DD */
export function excelDate(n: number): string {
  return new Date(Math.round((n - 25569) * 86400_000)).toISOString().slice(0, 10);
}
