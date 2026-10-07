import type { ButtonHTMLAttributes, Ref } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

export type ButtonVariant = 'default' | 'primary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  ref?: Ref<HTMLButtonElement>;
}

/** 화면설계서 4장 · Button */
export function Button({ variant = 'default', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(s.btn, variant === 'primary' && s.btnPrimary, variant === 'danger' && s.btnDanger, size === 'sm' && s.btnSmall, className)}
      {...rest}
    />
  );
}
