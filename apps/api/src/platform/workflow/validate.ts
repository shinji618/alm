// 워크플로 정의 검사·정규화. 요청 본문이나 DB 행(json)이 정의로 쓸 수 있는 모양인지 본다. 모든 위반을 모아 돌려준다
import { Catalog, DEFAULT_OPTIONS, DefOptions, KEY_RE, NONE, SKIP, StepDef, WorkflowDef } from './types';

export interface DefIssue { field: string; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// 입력(알 수 없는 값)을 정의로 바꾼다. 모양이 틀리면 issues에 담는다(정의는 가능한 만큼만 채움)
export function parseDefinition(input: unknown, subjectType: string): { def: WorkflowDef; issues: DefIssue[] } {
  const issues: DefIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const b = isObj(input) ? input : (add('$', '객체여야 합니다'), {} as Record<string, unknown>);

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) add('name', '흐름 이름은 필수입니다');
  else if (name.length > 100) add('name', '최대 100자입니다');

  const steps: StepDef[] = [];
  if (!Array.isArray(b.steps)) add('steps', '단계 목록이어야 합니다');
  else b.steps.forEach((raw, i) => {
    const f = `steps[${i}]`;
    if (!isObj(raw)) { add(f, '객체여야 합니다'); return; }
    const str = (k: string, max: number): string => {
      const v = raw[k];
      if (typeof v !== 'string' || !v.trim()) { add(`${f}.${k}`, '필수 값입니다'); return ''; }
      if (v.trim().length > max) add(`${f}.${k}`, `최대 ${max}자입니다`);
      return v.trim();
    };
    if (raw.mergeSame !== undefined && typeof raw.mergeSame !== 'boolean') add(`${f}.mergeSame`, '참·거짓이어야 합니다');
    steps.push({ key: str('key', 30), label: str('label', 40), resolver: str('resolver', 60), fallback: str('fallback', 60),
      mergeSame: raw.mergeSame === true });
  });

  const o = isObj(b.options) ? b.options : {};
  if (b.options !== undefined && !isObj(b.options)) add('options', '객체여야 합니다');
  const options: DefOptions = { ...DEFAULT_OPTIONS };
  for (const k of Object.keys(DEFAULT_OPTIONS) as (keyof DefOptions)[]) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') add(`options.${k}`, '참·거짓이어야 합니다');
    else options[k] = o[k] as boolean;
  }
  for (const k of Object.keys(o)) if (!(k in DEFAULT_OPTIONS)) add(`options.${k}`, '알 수 없는 설정입니다');
  return { def: { subjectType, name, steps, options }, issues };
}

// 제품이 준 카탈로그에 맞는지 본다(담당자 규칙·대리 규칙·최종 단계·중복)
export function validateDefinition(def: WorkflowDef, cat: Catalog): DefIssue[] {
  const issues: DefIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  if (!cat.subjects.some((s) => s.code === def.subjectType)) add('subjectType', '알 수 없는 대상 유형입니다');
  if (!def.steps.length) { add('steps', '단계가 하나 이상 있어야 합니다'); return issues; }
  if (def.steps.length > cat.maxSteps) add('steps', `단계는 최대 ${cat.maxSteps}개입니다`);

  const keys = new Set<string>(), used = new Set<string>();
  def.steps.forEach((s, i) => {
    const f = `steps[${i}]`;
    if (s.key && !KEY_RE.test(s.key)) add(`${f}.key`, '소문자로 시작하는 영문 소문자·숫자·밑줄(30자 이하)이어야 합니다');
    if (s.key && keys.has(s.key)) add(`${f}.key`, '다른 단계와 겹칩니다');
    keys.add(s.key);
    const r = cat.resolvers.find((x) => x.code === s.resolver);
    if (s.resolver && !r) add(`${f}.resolver`, '알 수 없는 담당자 규칙입니다');
    if (r?.subjects && !r.subjects.includes(def.subjectType)) add(`${f}.resolver`, `이 요청 유형에는 쓸 수 없는 규칙입니다(${r.label})`);
    if (s.resolver && used.has(s.resolver)) add(`${f}.resolver`, '같은 담당자 규칙을 두 단계에 쓸 수 없습니다(같은 사람이 두 단계를 승인할 수 없음)');
    used.add(s.resolver);
    const last = i === def.steps.length - 1;
    if (last && r && !r.final) add(`${f}.resolver`, `최종 단계에는 쓸 수 없는 규칙입니다(${r.label})`);
    if (s.fallback === SKIP) { if (last) add(`${f}.fallback`, '최종 단계는 건너뛸 수 없습니다'); }
    else if (s.fallback && s.fallback !== NONE && !cat.fallbacks.some((x) => x.code === s.fallback)) add(`${f}.fallback`, '알 수 없는 대리 규칙입니다');
    if (!s.fallback) add(`${f}.fallback`, '필수 값입니다');
    if (last && s.mergeSame) add(`${f}.mergeSame`, '최종 단계에는 쓸 수 없습니다');
  });
  return issues;
}

// 저장용 정규화(키 순서 고정): DB json에 같은 모양으로 쌓는다
export const toStored = (def: WorkflowDef) => ({
  steps: def.steps.map((s) => ({ key: s.key, label: s.label, resolver: s.resolver, fallback: s.fallback, mergeSame: s.mergeSame })),
  options: { fixerCannotReapprove: def.options.fixerCannotReapprove, requesterNoStep: def.options.requesterNoStep, proxyIfAllSkipped: def.options.proxyIfAllSkipped },
});

// 두 정의가 같은가(초안이 게시본과 달라졌는지)
export const sameDefinition = (a: WorkflowDef, b: WorkflowDef): boolean =>
  a.name === b.name && JSON.stringify(toStored(a)) === JSON.stringify(toStored(b));
