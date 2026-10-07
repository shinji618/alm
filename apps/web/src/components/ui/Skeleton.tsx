import s from './ui.module.css';

export function Skeleton({ width = '100%' }: { width?: string | number }) {
  return <span className={s.skeleton} style={{ width }} aria-hidden="true" />;
}
