// 요청 본문 검사. 위반은 모아서 400 ID-E100 + errors[]
import { E, FieldError } from './errors';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const TENANT_CODE = /^[A-Z0-9](?:[A-Z0-9-]{0,18}[A-Z0-9])?$/;
export const PRODUCT_CODE = /^[a-z][a-z0-9-]{1,19}$/;
export const ROLE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
type O = Record<string, unknown>;

export class Check {
  readonly errors: FieldError[] = [];
  constructor(readonly body: unknown) {}
  fail(field: string, message: string) { this.errors.push({ field, message }); }
  obj(v: unknown = this.body, field = '$'): O {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as O;
    this.fail(field, '객체여야 합니다'); return {};
  }
  str(o: O, k: string, opt: { required?: boolean; max?: number; pattern?: RegExp; field?: string } = {}): string | undefined {
    const f = opt.field ?? k, v = o[k];
    if (v === undefined || v === null || v === '') { if (opt.required) this.fail(f, '필수 값입니다'); return undefined; }
    if (typeof v !== 'string') { this.fail(f, '문자열이어야 합니다'); return undefined; }
    const t = v.trim();
    if (opt.max && t.length > opt.max) this.fail(f, `최대 ${opt.max}자입니다`);
    else if (opt.pattern && !opt.pattern.test(t)) this.fail(f, '형식이 올바르지 않습니다');
    return t;
  }
  bool(o: O, k: string, field = k): boolean | undefined {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') { this.fail(field, '참·거짓이어야 합니다'); return undefined; }
    return v;
  }
  int(o: O, k: string, opt: { min?: number; max?: number; field?: string } = {}): number | undefined {
    const f = opt.field ?? k, v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || (opt.min !== undefined && v < opt.min) || (opt.max !== undefined && v > opt.max)) {
      this.fail(f, '범위를 벗어난 정수입니다'); return undefined;
    }
    return v;
  }
  date(o: O, k: string, field = k): string | undefined {
    const v = this.str(o, k, { field, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    if (v && Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { this.fail(field, '날짜가 올바르지 않습니다'); return undefined; }
    return v;
  }
  arr(o: O, k: string, opt: { required?: boolean; max?: number; field?: string } = {}): unknown[] {
    const f = opt.field ?? k, v = o[k];
    if (v === undefined || v === null) { if (opt.required) this.fail(f, '필수 값입니다'); return []; }
    if (!Array.isArray(v)) { this.fail(f, '배열이어야 합니다'); return []; }
    if (opt.max && v.length > opt.max) { this.fail(f, `최대 ${opt.max}건입니다`); return []; }
    return v;
  }
  done() {
    if (this.errors.length) throw E.bad(`입력 값을 확인하세요: ${this.errors[0].field} ${this.errors[0].message}`, this.errors);
  }
}
