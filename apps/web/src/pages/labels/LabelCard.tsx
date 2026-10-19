// 라벨 미리보기(화면설계서 ALM-250 .3): 2" × 1" 카드, 테마와 관계없이 흰 바탕·검은 글자(실물과 같게).
//   QR·Code 128은 화면에서 직접 그린다(외부 렌더러 없음). 실제 인쇄는 프린터가 ZPL로 만든다
import { useMemo } from 'react';
import { qrMatrix } from '@/lib/qr';
import { code128Widths } from '@/lib/code128';
import type { Layout } from './types';
import c from './labels.module.css';

export interface LabelData { assetTag: string; companyName?: string; model?: string; sapAssetNo?: string; roomCode?: string }

export function QrSvg({ value, size }: { value: string; size: number }) {
  const m = useMemo(() => { try { return qrMatrix(value); } catch { return undefined; } }, [value]);
  if (!m) return null;
  const n = m.length + 2;   // 조용한 영역 1칸
  const d = m.flatMap((row, y) => row.map((on, x) => (on ? `M${x + 1} ${y + 1}h1v1h-1z` : ''))).join('');
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" aria-hidden="true" data-testid="qr">
      <rect width={n} height={n} fill="#fff" /><path d={d} fill="#000" />
    </svg>
  );
}

export function Code128Svg({ value, height }: { value: string; height: number }) {
  const w = useMemo(() => code128Widths(value), [value]);
  const total = w.reduce((a, b) => a + b, 0);
  let x = 0;
  const bars = w.map((wd, i) => { const r = i % 2 === 0 ? <rect key={i} x={x} y={0} width={wd} height={10} /> : null; x += wd; return r; });
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${total} 10`} preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true" data-testid="code128">
      <g fill="#000">{bars}</g>
    </svg>
  );
}

export function LabelCard({ data, layout }: { data: LabelData; layout: Layout }) {
  const info = [data.sapAssetNo, data.roomCode].filter(Boolean).join('  ');
  return (
    <figure className={c.label} aria-label={data.assetTag}>
      {layout === 'CODE128_ONLY' ? (
        <div className={c.labelCol}>
          <div className={c.company}>{data.companyName}</div>
          <Code128Svg value={data.assetTag} height={40} />
          <div className={c.tag}>{data.assetTag}</div>
          <div className={c.meta}>{[data.model, info].filter(Boolean).join('  ')}</div>
        </div>
      ) : (
        <>
          <div className={c.labelRow}>
            <QrSvg value={data.assetTag} size={layout === 'QR_ONLY' ? 96 : 84} />
            <div className={c.text}>
              <div className={c.company}>{data.companyName}</div>
              <div className={c.tag}>{data.assetTag}</div>
              <div className={c.meta}>{data.model}</div>
              <div className={c.meta}>{info}</div>
            </div>
          </div>
          {layout === 'QR_CODE128' && <Code128Svg value={data.assetTag} height={34} />}
        </>
      )}
    </figure>
  );
}
