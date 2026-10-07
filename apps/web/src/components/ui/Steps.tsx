import s from './ui.module.css';
import { cx } from './cx';

/** current = 진행 중 단계 index. current >= steps.length 이면 모두 완료 */
export function Steps({ steps, current, label }: { steps: string[]; current: number; label: string }) {
  return (
    <ol className={s.steps} aria-label={label}>
      {steps.map((name, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={name} className={cx(s.step, state === 'done' && s.stepDone, state === 'current' && s.stepCurrent)} aria-current={state === 'current' ? 'step' : undefined}>
            <span className={s.stepDot}>{state === 'done' ? '✓' : i + 1}</span>
            {name}
          </li>
        );
      })}
    </ol>
  );
}
