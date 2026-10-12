// 메일 템플릿(10 정의서 8.2 "보내는 것"). 사용자 언어(ko·en)로 만든다. 값은 모두 HTML 이스케이프한다.
// 4.x 업무 기능이 notification.template 이름으로 고른다. 템플릿 추가 = 여기에 한 항목 추가
export type Locale = 'ko' | 'en';
export type Params = Record<string, string | number | undefined>;
interface Tpl { subject: Record<Locale, (p: Params) => string>; lines: Record<Locale, (p: Params) => string[]>; action?: Record<Locale, string> }

const v = (p: Params, k: string) => String(p[k] ?? '');
const KIND: Record<Locale, Record<string, string>> = {
  ko: { CONTRACT: '계약', WARRANTY: '보증', RETURN: '반납' },
  en: { CONTRACT: 'Contract', WARRANTY: 'Warranty', RETURN: 'Return' },
};

export const TEMPLATES: Record<string, Tpl> = {
  TEST: {
    subject: { ko: () => '[ALM] 메일 발송 시험', en: () => '[ALM] Mail delivery test' },
    lines: { ko: (p) => ['ALM 메일 발송 시험입니다.', `환경: ${v(p, 'env')}`], en: (p) => ['This is an ALM mail delivery test.', `Environment: ${v(p, 'env')}`] },
  },
  APPROVAL_REQUESTED: {
    subject: { ko: (p) => `[ALM] 승인 요청: ${v(p, 'requestNo')}`, en: (p) => `[ALM] Approval requested: ${v(p, 'requestNo')}` },
    lines: {
      ko: (p) => [`${v(p, 'requester')}님이 ${v(p, 'requestType')} 요청(${v(p, 'requestNo')})의 승인을 요청했습니다.`, `대상: ${v(p, 'target')}`],
      en: (p) => [`${v(p, 'requester')} requested your approval for ${v(p, 'requestType')} ${v(p, 'requestNo')}.`, `Target: ${v(p, 'target')}`],
    },
    action: { ko: '요청 보기', en: 'Open request' },
  },
  APPROVAL_DECIDED: {
    subject: {
      ko: (p) => `[ALM] ${p.decision === 'REJECTED' ? '반려' : '승인'}: ${v(p, 'requestNo')}`,
      en: (p) => `[ALM] ${p.decision === 'REJECTED' ? 'Rejected' : 'Approved'}: ${v(p, 'requestNo')}`,
    },
    lines: {
      ko: (p) => [`${v(p, 'approver')}님이 요청 ${v(p, 'requestNo')}을(를) ${p.decision === 'REJECTED' ? '반려' : '승인'}했습니다.`, ...(p.comment ? [`의견: ${v(p, 'comment')}`] : [])],
      en: (p) => [`${v(p, 'approver')} ${p.decision === 'REJECTED' ? 'rejected' : 'approved'} request ${v(p, 'requestNo')}.`, ...(p.comment ? [`Comment: ${v(p, 'comment')}`] : [])],
    },
    action: { ko: '요청 보기', en: 'Open request' },
  },
  EXPIRY: {
    subject: {
      ko: (p) => `[ALM] ${KIND.ko[v(p, 'kind')] ?? ''} 만료 ${v(p, 'days')}일 전: ${v(p, 'name')}`,
      en: (p) => `[ALM] ${KIND.en[v(p, 'kind')] ?? ''} expires in ${v(p, 'days')} days: ${v(p, 'name')}`,
    },
    lines: {
      ko: (p) => [`${v(p, 'name')}의 ${KIND.ko[v(p, 'kind')] ?? ''} 만료일은 ${v(p, 'date')}입니다(${v(p, 'days')}일 남음).`],
      en: (p) => [`${KIND.en[v(p, 'kind')] ?? ''} for ${v(p, 'name')} ends on ${v(p, 'date')} (${v(p, 'days')} days left).`],
    },
    action: { ko: '자세히 보기', en: 'View details' },
  },
  COUNT_ASSIGNED: {
    subject: { ko: (p) => `[ALM] 실사 배정: ${v(p, 'campaign')}`, en: (p) => `[ALM] Physical count assigned: ${v(p, 'campaign')}` },
    lines: {
      ko: (p) => [`실사 캠페인 ${v(p, 'campaign')}에 배정되었습니다.`, `룸: ${v(p, 'rooms')}`, `기한: ${v(p, 'dueDate')}`],
      en: (p) => [`You were assigned to physical count ${v(p, 'campaign')}.`, `Rooms: ${v(p, 'rooms')}`, `Due: ${v(p, 'dueDate')}`],
    },
  },
  GR_CANCELLED: {
    subject: { ko: (p) => `[ALM] 입고 취소: ${v(p, 'poNo')}`, en: (p) => `[ALM] Goods receipt reversed: ${v(p, 'poNo')}` },
    lines: {
      ko: (p) => [`PO ${v(p, 'poNo')}의 입고가 SAP에서 취소되었습니다(이동유형 ${v(p, 'movementType')}, 수량 ${v(p, 'quantity')}).`,
        `입고 취소 표시한 자산: ${v(p, 'assets')}`, '자산을 확인하고 라벨·재고를 정리하세요.'],
      en: (p) => [`A goods receipt for PO ${v(p, 'poNo')} was reversed in SAP (movement ${v(p, 'movementType')}, quantity ${v(p, 'quantity')}).`,
        `Assets marked as reversed: ${v(p, 'assets')}`, 'Please check the assets and clean up labels and stock.'],
    },
    action: { ko: '자산 보기', en: 'Open assets' },
  },
  SAP_POSTING_FAILED: {
    subject: { ko: (p) => `[ALM] SAP 전기 실패: ${v(p, 'reference')}`, en: (p) => `[ALM] SAP posting failed: ${v(p, 'reference')}` },
    lines: {
      ko: (p) => [`SAP 전기 ${v(p, 'reference')}이(가) 실패했습니다.`, `오류: ${v(p, 'message')}`],
      en: (p) => [`SAP posting ${v(p, 'reference')} failed.`, `Error: ${v(p, 'message')}`],
    },
    action: { ko: '전기 큐 보기', en: 'Open posting queue' },
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// 메일 제목·본문에 줄바꿈·제어 문자가 들어가지 않게(헤더 주입 방지)
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

export function render(template: string, locale: string, params: Params, appOrigin: string): { subject: string; html: string; text: string } {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`모르는 메일 템플릿 ${template}`);
  const l: Locale = locale === 'en' ? 'en' : 'ko';
  const clean: Params = Object.fromEntries(Object.entries(params).map(([k, x]) => [k, x === undefined ? undefined : oneLine(String(x))]));
  const subject = oneLine(t.subject[l](clean));
  const lines = t.lines[l](clean);
  // 링크는 앱 안 경로만(다른 사이트로 보내는 링크를 만들지 않음)
  const path = typeof params.path === 'string' && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(params.path) ? params.path : undefined;
  const link = path && t.action ? `${appOrigin}${path}` : undefined;
  const footer = l === 'ko' ? '이 메일은 ALM에서 자동으로 보냈습니다. 회신하지 마세요.' : 'This message was sent automatically by ALM. Please do not reply.';
  const html = ['<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937">',
    ...lines.map((x) => `<p>${esc(x)}</p>`),
    link ? `<p><a href="${esc(link)}" style="color:#1d4ed8">${esc(t.action![l])}</a></p>` : '',
    `<p style="color:#6b7280;font-size:12px">${esc(footer)}</p></body></html>`].join('');
  const text = [...lines, ...(link ? ['', `${t.action![l]}: ${link}`] : []), '', footer].join('\n');
  return { subject, html, text };
}
