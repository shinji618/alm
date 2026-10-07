import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

interface FieldShellProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  full?: boolean;
}

function Shell({ id, label, required, error, hint, full, children }: FieldShellProps & { id: string; children: ReactNode }) {
  return (
    <div className={cx(s.field, full && s.fieldFull)}>
      <label htmlFor={id} className={cx(s.fieldLabel, required && s.required)}>
        {label}
      </label>
      {children}
      {error ? (
        <span id={`${id}-err`} className={s.fieldError} role="alert">
          {error}
        </span>
      ) : (
        hint && <span className={s.fieldHint}>{hint}</span>
      )}
    </div>
  );
}

type Native<T> = Omit<T, 'id'> & FieldShellProps & { id?: string };

export function TextField({ label, required, error, hint, full, id, className, ...rest }: Native<InputHTMLAttributes<HTMLInputElement>>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Shell id={fid} label={label} required={required} error={error} hint={hint} full={full}>
      <input id={fid} required={required} aria-invalid={!!error} aria-describedby={error ? `${fid}-err` : undefined} className={cx(s.input, error && s.inputInvalid, className)} {...rest} />
    </Shell>
  );
}

export function SelectField({ label, required, error, hint, full, id, className, options, ...rest }: Native<SelectHTMLAttributes<HTMLSelectElement>> & { options: Array<{ value: string; label: string }> }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Shell id={fid} label={label} required={required} error={error} hint={hint} full={full}>
      <select id={fid} required={required} aria-invalid={!!error} className={cx(s.input, error && s.inputInvalid, className)} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function TextareaField({ label, required, error, hint, full = true, id, className, rows = 3, ...rest }: Native<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Shell id={fid} label={label} required={required} error={error} hint={hint} full={full}>
      <textarea id={fid} rows={rows} required={required} aria-invalid={!!error} className={cx(s.input, error && s.inputInvalid, className)} {...rest} />
    </Shell>
  );
}

export function CheckboxField({ label, id, full = true, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> & { label: string; id?: string; full?: boolean }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx(s.field, full && s.fieldFull)}>
      <label htmlFor={fid} className={s.checkboxRow}>
        <input id={fid} type="checkbox" className={s.check} {...rest} />
        {label}
      </label>
    </div>
  );
}

/** 2열 폼 그리드(820px 이하 1열) */
export function FormGrid({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) {
  return (
    <form
      className={s.form}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
    </form>
  );
}
