import { useCallback, useEffect, useRef, useState } from 'react';

/** 비동기 호출 결과(로딩·오류·다시 부르기). deps가 바뀌면 다시 부르고, 늦게 온 이전 응답은 버린다 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(undefined);
    fnRef.current(ctl.signal).then(
      (d) => { if (!ctl.signal.aborted) { setData(d); setLoading(false); } },
      (e) => { if (!ctl.signal.aborted) { setError(e instanceof Error ? e : new Error(String(e))); setLoading(false); } },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload, setData };
}
