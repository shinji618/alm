import type { ReactNode } from 'react';
import s from './ui.module.css';

export interface TimelineEvent {
  id: string;
  meta: ReactNode;
  body: ReactNode;
}

export function Timeline({ events, label }: { events: TimelineEvent[]; label: string }) {
  return (
    <ol className={s.timeline} aria-label={label}>
      {events.map((e) => (
        <li key={e.id} className={s.event}>
          <div className={s.eventMeta}>{e.meta}</div>
          <div>{e.body}</div>
        </li>
      ))}
    </ol>
  );
}
