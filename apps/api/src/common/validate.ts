// 요청 본문 검사(openapi 스키마 기준). 위반은 모두 모아 400 ALM-E100/E101 + errors[](FieldError)로 돌려준다
import { AlmError } from './errors';

export interface FieldError { field: string; code: string; message: string }

export class Check {
  readonly errors: FieldError[] = [];
  constructor(readonly body: unknown) {}

  private add(field: string, code: string, message: string) { this.errors.push({ field, code, message }); }
  fail(field: string, message: string) { this.add(field, 'ALM-E100', message); }

  obj(v: unknown = this.body, field = '$'): Record<string, unknown> {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    this.fail(field, '객체여야 합니다');
    return {};
  }

  str(o: Record<string, unknown>, k: string, opt: { required?: boolean; max?: number; pattern?: RegExp; field?: string } = {}): string | undefined {
    const f = opt.field ?? k, v = o[k];
    if (v === undefined || v === null || v === '') { if (opt.required) this.add(f, 'ALM-E101', '필수 값입니다'); return undefined; }
    if (typeof v !== 'string') { this.fail(f, '문자열이어야 합니다'); return undefined; }
    const t = v.trim();
    if (opt.max && t.length > opt.max) this.fail(f, `최대 ${opt.max}자입니다`);
    else if (opt.pattern && !opt.pattern.test(t)) this.fail(f, '형식이 올바르지 않습니다');
    return t;
  }

  bool(o: Record<string, unknown>, k: string, field = k): boolean | undefined {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') { this.fail(field, '참·거짓이어야 합니다'); return undefined; }
    return v;
  }

  int(o: Record<string, unknown>, k: string, opt: { min?: number; max?: number; field?: string } = {}): number | undefined {
    const f = opt.field ?? k, v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) { this.fail(f, '정수여야 합니다'); return undefined; }
    if ((opt.min !== undefined && v < opt.min) || (opt.max !== undefined && v > opt.max)) { this.fail(f, `범위를 벗어났습니다`); return undefined; }
    return v;
  }

  // 금액 등 숫자(소수 2자리로 반올림)
  num(o: Record<string, unknown>, k: string, opt: { min?: number; max?: number; field?: string } = {}): number | undefined {
    const f = opt.field ?? k, v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.fail(f, '숫자여야 합니다'); return undefined; }
    if ((opt.min !== undefined && v < opt.min) || (opt.max !== undefined && v > opt.max)) { this.fail(f, '범위를 벗어났습니다'); return undefined; }
    return Math.round(v * 100) / 100;
  }

  uuid(o: Record<string, unknown>, k: string, opt: { required?: boolean; field?: string } = {}): string | undefined {
    return this.str(o, k, { ...opt, pattern: UUID });
  }

  oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[], field = k): T | undefined {
    const v = this.str(o, k, { field });
    if (v !== undefined && !values.includes(v as T)) { this.fail(field, `${values.join(', ')} 중 하나`); return undefined; }
    return v as T | undefined;
  }

  date(o: Record<string, unknown>, k: string, field = k): string | undefined {
    const v = this.str(o, k, { field, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    if (v && Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { this.fail(field, '날짜가 올바르지 않습니다'); return undefined; }
    return v;
  }

  arr(o: Record<string, unknown>, k: string, opt: { required?: boolean; max?: number } = {}): unknown[] {
    const v = o[k];
    if (v === undefined || v === null) { if (opt.required) this.add(k, 'ALM-E101', '필수 값입니다'); return []; }
    if (!Array.isArray(v)) { this.fail(k, '배열이어야 합니다'); return []; }
    if (opt.max && v.length > opt.max) { this.fail(k, `최대 ${opt.max}건입니다`); return []; }
    return v;
  }

  done() {
    if (!this.errors.length) return;
    const first = this.errors[0];
    throw new AlmError(400, this.errors.every((e) => e.code === 'ALM-E101') ? 'ALM-E101' : 'ALM-E100',
      `입력 값을 확인하세요: ${first.field} ${first.message}${this.errors.length > 1 ? ` 외 ${this.errors.length - 1}건` : ''}`, { errors: this.errors });
  }
}

export const EMAIL = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
