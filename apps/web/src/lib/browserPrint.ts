// Zebra Browser Print(PC에 설치하는 로컬 서비스) 클라이언트 — 라벨 출력(ALM-250, 결정 A-08).
//   서버는 프린터에 연결하지 않는다. 화면이 ZPL을 받아 이 로컬 서비스로 프린터(USB·사내망)에 보낸다.
//   https 화면은 https://localhost:9101(처음 한 번 인증서 허용 필요), 안 되면 http://localhost:9100. CSP connect-src에 둘 다 있다(infra edge-stack)
export interface BpDevice { name: string; uid: string; connection?: string; deviceType?: string; provider?: string; manufacturer?: string; version?: number | string }
export type BpStatus = { state: 'checking' } | { state: 'notInstalled' } | { state: 'noPrinter'; base: string } | { state: 'ready'; base: string; devices: BpDevice[]; defaultUid?: string };

const BASES = ['https://localhost:9101', 'http://localhost:9100'];
const TIMEOUT_MS = 3000;

async function req(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(timer); }
}

/** 설치·연결 확인과 프린터 목록 */
export async function detect(): Promise<BpStatus> {
  for (const base of BASES) {
    let r: Response;
    try { r = await req(`${base}/available`); } catch { continue; }
    if (!r.ok) continue;
    const body = (await r.json().catch(() => ({}))) as { printer?: BpDevice[] };
    const devices = (body.printer ?? []).filter((d) => d && d.name);
    if (!devices.length) return { state: 'noPrinter', base };
    let defaultUid: string | undefined;
    try {
      const d = await req(`${base}/default?type=printer`);
      const txt = d.ok ? await d.text() : '';
      defaultUid = txt ? (JSON.parse(txt) as BpDevice).uid : undefined;
    } catch { /* 기본 프린터 없음 */ }
    return { state: 'ready', base, devices, defaultUid };
  }
  return { state: 'notInstalled' };
}

/** ZPL 한 묶음을 프린터로 보낸다. 실패하면 Browser Print 오류 문구로 예외 */
export async function write(base: string, device: BpDevice, zpl: string): Promise<void> {
  const r = await req(`${base}/write`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ device, data: zpl }) });
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Browser Print HTTP ${r.status}`);
}

/** 등록된 프린터의 장치 이름과 맞는 Browser Print 장치(없으면 기본 → 첫 번째) */
export function pickDevice(st: Extract<BpStatus, { state: 'ready' }>, deviceName?: string): BpDevice {
  return (deviceName && st.devices.find((d) => d.name === deviceName))
    || st.devices.find((d) => d.uid === st.defaultUid) || st.devices[0];
}
