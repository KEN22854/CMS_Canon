'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { union, type Box, type Device, type View } from './geometry';

const W = 168;
const H = 104;

/**
 * Overview of the whole board: every artboard as a block, the visible area as a frame. Click or
 * drag to move the view there. Only the frame follows pans (a listener, no board re-render).
 */
export function Minimap({ devices, heights, activeId, subscribe, viewport, onNavigate }: { devices: Device[]; heights: Record<string, number>; activeId: string; subscribe: (fn: (v: View) => void) => () => void; viewport: () => { w: number; h: number }; onNavigate: (v: View) => void }) {
  const t = useT();
  const [v, setV] = useState<View | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => subscribe(setV), [subscribe]);
  const boards = useMemo(() => devices.map((d) => ({ id: d.id, box: { x: d.x, y: d.y, w: d.width, h: heights[d.id] ?? 900 } })), [devices, heights]);
  if (!v) return null;
  const vp = viewport();
  const visible: Box = { x: -v.x / v.zoom, y: -v.y / v.zoom, w: vp.w / v.zoom, h: vp.h / v.zoom };
  const world = union([...boards.map((b) => b.box), visible])!;
  const pad = 0.06;
  const k = Math.min(W / (world.w * (1 + pad * 2)), H / (world.h * (1 + pad * 2)));
  const ox = (W - world.w * k) / 2 - world.x * k;
  const oy = (H - world.h * k) / 2 - world.y * k;
  const at = (b: Box) => ({ left: b.x * k + ox, top: b.y * k + oy, width: Math.max(2, b.w * k), height: Math.max(2, b.h * k) });

  const go = (clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const wx = (clientX - r.left - ox) / k;
    const wy = (clientY - r.top - oy) / k;
    onNavigate({ ...v, x: vp.w / 2 - wx * v.zoom, y: vp.h / 2 - wy * v.zoom });
  };
  return (
    <div
      ref={ref}
      role="img"
      aria-label={t('board.minimap')}
      data-minimap
      className="relative cursor-pointer overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur"
      style={{ width: W, height: H }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        go(e.clientX, e.clientY);
        const move = (ev: PointerEvent) => go(ev.clientX, ev.clientY);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      {boards.map((b) => (
        <div key={b.id} className={b.id === activeId ? 'absolute rounded-[2px] bg-primary/60' : 'absolute rounded-[2px] bg-muted-foreground/35'} style={at(b.box)} />
      ))}
      <div className="pointer-events-none absolute rounded-sm border-2 border-primary" style={at(visible)} />
    </div>
  );
}
