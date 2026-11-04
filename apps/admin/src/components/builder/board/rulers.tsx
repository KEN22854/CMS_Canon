'use client';

import { useEffect, useRef, useState } from 'react';
import type { Box, View } from './geometry';

export const RULER = 20;
const STEPS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

/** World distance between labelled ticks: the smallest step at least ~64 screen px apart. */
export function rulerStep(zoom: number): number {
  return STEPS.find((s) => s * zoom >= 64) ?? STEPS.at(-1)!;
}

/**
 * Top and left rulers in page CSS px, measured from the active artboard's top-left corner (0 is
 * where the page starts). The selected block's extent is highlighted. They follow pans and zooms
 * through the board's view listener, without re-rendering the board.
 */
export function Rulers({ subscribe, origin, selection, size }: { subscribe: (fn: (v: View) => void) => () => void; origin: { x: number; y: number }; selection: () => Box | null; size: () => { w: number; h: number } }) {
  const [v, setV] = useState<View | null>(null);
  const [sel, setSel] = useState<Box | null>(null);
  const raf = useRef(0);
  useEffect(
    () =>
      subscribe((next) => {
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(() => {
          setV(next);
          setSel(selection());
        });
      }),
    [subscribe, selection],
  );
  // Selection changes without a view change (a click): refresh the highlight too.
  useEffect(() => {
    const id = setInterval(() => setSel(selection()), 250);
    return () => clearInterval(id);
  }, [selection]);
  if (!v) return null;
  const { w, h } = size();
  const step = rulerStep(v.zoom);
  const ticks = (axis: 'x' | 'y') => {
    const len = axis === 'x' ? w : h;
    const o = axis === 'x' ? origin.x : origin.y;
    const pan = axis === 'x' ? v.x : v.y;
    // World coordinate at screen 0, relative to the artboard origin.
    const from = Math.floor(((0 - pan) / v.zoom - o) / step) * step;
    const to = (len - pan) / v.zoom - o;
    const out: { at: number; value: number }[] = [];
    for (let value = from; value <= to && out.length < 400; value += step) out.push({ at: (value + o) * v.zoom + pan, value });
    return out;
  };
  const hi = sel && { x: sel.x * v.zoom + v.x, y: sel.y * v.zoom + v.y, w: sel.w * v.zoom, h: sel.h * v.zoom };
  return (
    <div data-board-ui aria-hidden className="pointer-events-none absolute inset-0 z-30 text-[9px] tabular-nums text-muted-foreground" data-rulers>
      <div className="absolute left-0 top-0 h-5 w-full overflow-hidden border-b bg-card/95" style={{ height: RULER }}>
        {hi && <div className="absolute inset-y-0 bg-primary/20" style={{ left: hi.x, width: hi.w }} />}
        {ticks('x').map((t) => (
          <div key={t.value} className="absolute bottom-0 h-2 border-l border-muted-foreground/50" style={{ left: t.at }}>
            <span className="absolute -top-2.5 left-1 whitespace-nowrap">{t.value}</span>
          </div>
        ))}
      </div>
      <div className="absolute left-0 top-0 h-full overflow-hidden border-r bg-card/95" style={{ width: RULER }}>
        {hi && <div className="absolute inset-x-0 bg-primary/20" style={{ top: hi.y, height: hi.h }} />}
        {ticks('y').map((t) => (
          <div key={t.value} className="absolute right-0 w-2 border-t border-muted-foreground/50" style={{ top: t.at }}>
            <span className="absolute right-2.5 top-1 whitespace-nowrap" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
              {t.value}
            </span>
          </div>
        ))}
      </div>
      <div className="absolute left-0 top-0 border-b border-r bg-card" style={{ width: RULER, height: RULER }} />
    </div>
  );
}
