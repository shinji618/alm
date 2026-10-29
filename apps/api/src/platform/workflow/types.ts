// 워크플로 정의 모델(공유 라이브러리 platform/workflow, 17 문서 4장·결정 E-03·E-11). 제품 용어(자산·코스트센터·SAP)를 모른다.
//   정의 = 단계 목록 + 단계별 담당자 규칙(resolver, 제품이 코드로 제공) + 담당자가 없을 때 처리(fallback) + 직무 분리 선택 규칙.
//   담당자 규칙의 목록과 뜻은 제품 어댑터가 카탈로그(Catalog)로 넘긴다. 자유 형태 설계기는 만들지 않는다.

export type DefStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface StepDef {
  key: string;            // 단계 식별자(정의 안에서 유일, 소문자·숫자·밑줄)
  label: string;          // 화면에 보이는 이름
  resolver: string;       // 담당자 규칙 코드(카탈로그의 resolvers[].code)
  fallback: string;       // 담당자가 없을 때: 'SKIP'(건너뜀) · 'NONE'(건너뛸 수 없음, 담당자가 없으면 제출 불가) · 카탈로그 fallbacks[].code(대리 규칙)
  mergeSame: boolean;     // 앞 단계와 같은 담당자면 한 번에 승인
}

export interface DefOptions {
  fixerCannotReapprove: boolean;   // 전기 오류를 보정한 사람은 그 재승인을 할 수 없다(H-08)
  requesterNoStep: boolean;        // 요청자는 같은 흐름의 어떤 단계도 승인할 수 없다(엄격). 끄면 대리 규칙이 적용된다
  proxyIfAllSkipped: boolean;      // 최종 단계 앞의 모든 단계에 담당자가 없으면 첫 단계를 대리 규칙으로 처리
}

export interface WorkflowDef {
  subjectType: string;
  name: string;
  steps: StepDef[];
  options: DefOptions;
}

export interface ResolverInfo {
  code: string;
  label: string;
  subjects?: string[];   // 이 규칙을 쓸 수 있는 대상 유형(비면 모두)
  final?: boolean;       // 최종 단계에 쓸 수 있는가
}

export interface FallbackInfo { code: string; label: string; resolver: string }   // resolver: 대리 승인자를 찾는 담당자 규칙

export interface Catalog {
  subjects: { code: string; label: string }[];
  resolvers: ResolverInfo[];
  fallbacks: FallbackInfo[];                 // 'SKIP'은 항상 쓸 수 있으므로 넣지 않는다
  mandatoryRules: { code: string; label: string }[];   // 끌 수 없는 직무 분리 규칙(화면 표시용)
  maxSteps: number;
}

export const SKIP = 'SKIP';
export const NONE = 'NONE';
export const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/;
export const DEFAULT_OPTIONS: DefOptions = { fixerCannotReapprove: true, requesterNoStep: false, proxyIfAllSkipped: true };
