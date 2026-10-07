import type { ReactNode } from 'react';
import s from './ui.module.css';

/** 빈 상태: 문장 1줄 + 다음 행동 1개 */
export function EmptyState({ message, action }: { message: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty} role="status">
      <span>{message}</span>
      {action}
    </div>
  );
}
