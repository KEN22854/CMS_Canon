'use client';

import type { BlockNode, EditorOperation, StyleBreakpoint } from '@canon/blocks';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, BringToFront, Paintbrush, RotateCw, SendToBack, Settings2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findNode, findParent } from '../editor/tree-ops';
import type { BuilderStore } from './store';

/**
 * The free-form block as a board: move one or many elements together, snap to the edges and
 * centres of the other elements and of the frame (guides show where), rotate, resize, align,
 * distribute, change the stacking order, nudge with the arrow keys. Coordinates are CSS pixels of
 * the frame (the canvas zoom is divided out); every gesture commits one undoable edit at the
 * breakpoint being edited. Alt turns snapping off.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface HostRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 8;
const SNAP_PX = 6; // on screen
const gridSnap = (v: number, on: boolean) => (on ? Math.round(v / GRID) * GRID : Math.round(v));

const q = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
const frameOf = (host: HTMLElement, canvasId: string) => host.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(canvasId)}"] [data-free-frame]`);

/** Element box in frame CSS px. */
function boxIn(frame: DOMRect, el: Element, scale: number): Box {
  const r = el.getBoundingClientRect();
  return { x: (r.left - frame.left) / scale, y: (r.top - frame.top) / scale, w: r.width / scale, h: r.height / scale };
}

const set = (id: string, breakpoint: StyleBreakpoint, property: 'left' | 'top' | 'width' | 'height' | 'rotate', value: string): EditorOperation => ({ op: 'STYLE_SET', id, breakpoint, property, value });

/** Current left/top of an element as its stylesheet places it (not including a drag preview). */
function position(el: HTMLElement) {
  const cs = getComputedStyle(el);
  return { left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0 };
}

/** The free-form children selected together (same parent block), primary last. */
export function freeSelection(root: BlockNode, selectedIds: string[]): { canvas: BlockNode; ids: string[] } | null {
  const primary = selectedIds.at(-1);
  if (!primary) return null;
  const at = findParent(root, primary);
  if (!at || at.parent.type !== 'canvas') return null;
  const ids = selectedIds.filter((id) => at.parent.children.some((c) => c.id === id && !c.locked));
  return ids.length ? { canvas: at.parent, ids } : null;
}

export function FreeSelection({ canvas, ids, hostRef, scale, breakpoint, store, onDone }: { canvas: BlockNode; ids: string[]; hostRef: React.RefObject<HTMLDivElement | null>; scale: number; breakpoint: StyleBreakpoint; store: BuilderStore; onDone: () => void }) {
  const t = useT();
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [geo, setGeo] = useState<{ frame: HostRect; boxes: Box[] } | null>(null);
  const primary = ids.at(-1)!;

  // Measure: the frame (in host px) and each selected element (in frame px).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const frameEl = frameOf(host, canvas.id);
      if (!frameEl) return setGeo(null);
      const hr = host.getBoundingClientRect();
      const fr = frameEl.getBoundingClientRect();
      setGeo({ frame: { x: fr.left - hr.left, y: fr.top - hr.top, w: fr.width, h: fr.height }, boxes: ids.map((id) => (q(host, id) ? boxIn(fr, q(host, id)!, scale) : { x: 0, y: 0, w: 0, h: 0 })) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef, canvas, ids, scale, breakpoint]);

  if (!geo) return null;
  const toHost = (b: Box): HostRect => ({ x: geo.frame.x + b.x * scale, y: geo.frame.y + b.y * scale, w: b.w * scale, h: b.h * scale });
  const union = (bs: Box[]): Box => {
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
  };

  // Move every selected element; the selection's box snaps to other elements and the frame.
  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      store.getState().toggleSelect((e.currentTarget as HTMLElement).dataset.id!);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = (e.currentTarget as HTMLElement).dataset.id!;
    const host = hostRef.current!;
    const frameEl = frameOf(host, canvas.id)!;
    const fr = frameEl.getBoundingClientRect();
    const els = ids.map((id) => q(host, id)!).filter(Boolean);
    const starts = els.map((el) => ({ el, pos: position(el), box: boxIn(fr, el, scale) }));
    const sel = union(starts.map((s) => s.box));
    const others = canvas.children.filter((c) => !ids.includes(c.id)).map((c) => q(host, c.id)).filter((x): x is HTMLElement => Boolean(x)).map((el) => boxIn(fr, el, scale));
    const fw = fr.width / scale;
    const fh = fr.height / scale;
    const xs = [0, fw / 2, fw, ...others.flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w])];
    const ys = [0, fh / 2, ...others.flatMap((b) => [b.y, b.y + b.h / 2, b.y + b.h])];
    const threshold = SNAP_PX / scale;
    let moved = false;
    let last = { dx: 0, dy: 0, gx: [] as number[], gy: [] as number[] };
    const snapAxis = (start: number, size: number, d: number, cands: number[]) => {
      let best: { diff: number; at: number } | null = null;
      for (const edge of [start + d, start + d + size / 2, start + d + size]) {
        for (const c of cands) {
          const diff = c - edge;
          if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, at: c };
        }
      }
      return best;
    };
    const move = (ev: PointerEvent) => {
      let dx = (ev.clientX - e.clientX) / scale;
      let dy = (ev.clientY - e.clientY) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      const gx: number[] = [];
      const gy: number[] = [];
      if (!ev.altKey && store.getState().snap) {
        const sx = snapAxis(sel.x, sel.w, dx, xs);
        const sy = snapAxis(sel.y, sel.h, dy, ys);
        if (sx) {
          dx += sx.diff;
          gx.push(sx.at);
        }
        if (sy) {
          dy += sy.diff;
          gy.push(sy.at);
        }
      }
      for (const s of starts) s.el.style.translate = `${dx}px ${dy}px`;
      last = { dx, dy, gx, gy };
      setGuides({ x: gx, y: gy });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      for (const s of starts) s.el.style.translate = '';
      setGuides({ x: [], y: [] });
      // A click without dragging selects just that element, as in any editor.
      if (!moved) return store.getState().select(id);
      // A guide snap is exact; otherwise positions land on the 8 px grid (Alt: free).
      const grid = !ev.altKey && store.getState().snap && !last.gx.length && !last.gy.length;
      const ops = starts.flatMap((s) => [set(s.el.dataset.blockId!, breakpoint, 'left', `${gridSnap(s.pos.left + last.dx, grid)}px`), set(s.el.dataset.blockId!, breakpoint, 'top', `${gridSnap(Math.max(-2000, s.pos.top + last.dy), grid)}px`)]);
      store.getState().applyMany(ops);
      onDone();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Resize the primary element (right edge: width; corner: width and height).
  const startResize = (mode: 'e' | 'se') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = q(hostRef.current!, primary)!;
    const r = el.getBoundingClientRect();
    const start = { w: r.width / scale, h: r.height / scale };
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      el.style.width = `${Math.max(16, start.w + (ev.clientX - e.clientX) / scale)}px`;
      if (mode === 'se') el.style.height = `${Math.max(8, start.h + (ev.clientY - e.clientY) / scale)}px`;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.style.width = '';
      el.style.height = '';
      if (!moved) return;
      const g = !ev.altKey && store.getState().snap;
      const ops = [set(primary, breakpoint, 'width', `${gridSnap(Math.max(16, start.w + (ev.clientX - e.clientX) / scale), g)}px`)];
      if (mode === 'se') ops.push(set(primary, breakpoint, 'height', `${gridSnap(Math.max(8, start.h + (ev.clientY - e.clientY) / scale), g)}px`));
      store.getState().applyMany(ops);
      onDone();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Rotate the primary element around its centre (Shift: steps of 15°).
  const startRotate = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = q(hostRef.current!, primary)!;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const angle = (ev: { clientX: number; clientY: number; shiftKey: boolean }) => {
      const a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      const n = ((Math.round(a) % 360) + 540) % 360 - 180;
      return ev.shiftKey ? Math.round(n / 15) * 15 : n;
    };
    const move = (ev: PointerEvent) => (el.style.rotate = `${angle(ev)}deg`);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.style.rotate = '';
      store.getState().applyMany([set(primary, breakpoint, 'rotate', `${angle(ev)}deg`)]);
      onDone();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const align = (how: AlignHow) => {
    store.getState().applyMany(alignFree(hostRef.current!, canvas.id, ids, scale, breakpoint, how));
    onDone();
  };
  const distribute = (axis: 'x' | 'y') => {
    store.getState().applyMany(distributeFree(hostRef.current!, canvas.id, ids, scale, breakpoint, axis));
    onDone();
  };
  // Stacking order is document order inside the block: last child is on top.
  const order = (where: 'front' | 'back') => {
    const s = store.getState();
    const parent = findNode(s.draft.content.root, canvas.id)!;
    const sorted = parent.children.filter((c) => ids.includes(c.id)).map((c) => c.id);
    const ops: EditorOperation[] = where === 'front' ? sorted.map((id) => ({ op: 'NODE_MOVE', id, parentId: canvas.id, index: parent.children.length })) : [...sorted].reverse().map((id) => ({ op: 'NODE_MOVE', id, parentId: canvas.id, index: 0 }));
    s.applyMany(ops);
    onDone();
  };

  const open = (panel: 'block' | 'style') => {
    const s = store.getState();
    s.select(primary);
    s.openInspector(panel);
  };

  const boxes = geo.boxes.map(toHost);
  const p = boxes.at(-1)!;
  const sel = toHost(union(geo.boxes));
  const many = ids.length > 1;
  return (
    <>
      {ids.map((id, i) => (
        <div key={id} data-builder-ui data-id={id} title={t('simple.dragToMove')} onPointerDown={startMove} onDoubleClick={(e) => editBelow(e, id)} className={cn('pointer-events-auto absolute z-10 cursor-move rounded-sm', many && 'outline outline-2 outline-primary/70')} style={{ left: boxes[i]!.x, top: boxes[i]!.y, width: boxes[i]!.w, height: boxes[i]!.h }} aria-label={t('simple.dragToMove')} />
      ))}
      {guides.x.map((gx) => (
        <div key={`x${gx}`} className="pointer-events-none absolute z-30 w-px bg-pink-500" style={{ left: geo.frame.x + gx * scale, top: geo.frame.y, height: geo.frame.h }} />
      ))}
      {guides.y.map((gy) => (
        <div key={`y${gy}`} className="pointer-events-none absolute z-30 h-px bg-pink-500" style={{ top: geo.frame.y + gy * scale, left: geo.frame.x, width: geo.frame.w }} />
      ))}
      {/* Handles on the primary element. */}
      <div data-builder-ui aria-label={t('simple.resize')} title={t('simple.resize')} onPointerDown={startResize('e')} className="pointer-events-auto absolute z-20 h-4 w-2 cursor-ew-resize rounded-sm border border-primary bg-background" style={{ left: p.x + p.w - 4, top: p.y + p.h / 2 - 8 }} />
      <div data-builder-ui aria-label={t('simple.resize')} onPointerDown={startResize('se')} className="pointer-events-auto absolute z-20 h-3 w-3 cursor-nwse-resize rounded-sm border border-primary bg-background" style={{ left: p.x + p.w - 6, top: p.y + p.h - 6 }} />
      <div data-builder-ui aria-label={t('board.rotate')} title={t('board.rotate')} onPointerDown={startRotate} className="pointer-events-auto absolute z-20 grid h-5 w-5 cursor-grab place-items-center rounded-full border border-primary bg-background text-primary" style={{ left: p.x + p.w / 2 - 10, top: p.y - 28 }}>
        <RotateCw className="h-3 w-3" aria-hidden />
      </div>
      <span className="pointer-events-none absolute z-20 rounded bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground" style={{ left: p.x, top: p.y + p.h + 4 }}>
        {Math.round(p.w / scale)} × {Math.round(p.h / scale)}
      </span>
      {/* Arrange the selection. */}
      <div data-builder-ui className="pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-lg border bg-card/95 p-0.5 text-card-foreground shadow-lg" style={{ left: sel.x, top: sel.y + sel.h + 22 }} onClick={(e) => e.stopPropagation()}>
        {/* The element's own settings (the block bar above belongs to the whole free-form block). */}
        {!many && (
          <>
            <Tool label={t('board.content')} onClick={() => open('block')}><Settings2 className="h-3.5 w-3.5" /></Tool>
            <Tool label={t('board.design')} onClick={() => open('style')}><Paintbrush className="h-3.5 w-3.5" /></Tool>
            <span className="mx-0.5 h-4 w-px bg-border" />
          </>
        )}
        <Tool label={t('board.alignLeft')} onClick={() => align('left')}><AlignStartVertical className="h-3.5 w-3.5" /></Tool>
        <Tool label={t('board.alignHCenter')} onClick={() => align('hcenter')}><AlignCenterVertical className="h-3.5 w-3.5" /></Tool>
        <Tool label={t('board.alignRight')} onClick={() => align('right')}><AlignEndVertical className="h-3.5 w-3.5" /></Tool>
        <Tool label={t('board.alignTop')} onClick={() => align('top')}><AlignStartHorizontal className="h-3.5 w-3.5" /></Tool>
        <Tool label={t('board.alignVCenter')} onClick={() => align('vcenter')}><AlignCenterHorizontal className="h-3.5 w-3.5" /></Tool>
        <Tool label={t('board.alignBottom')} onClick={() => align('bottom')}><AlignEndHorizontal className="h-3.5 w-3.5" /></Tool>
        {ids.length > 2 && (
          <>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <Tool label={t('board.distributeX')} onClick={() => distribute('x')}><AlignHorizontalSpaceAround className="h-3.5 w-3.5" /></Tool>
            <Tool label={t('board.distributeY')} onClick={() => distribute('y')}><AlignVerticalSpaceAround className="h-3.5 w-3.5" /></Tool>
          </>
        )}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Tool label={t('board.front')} onClick={() => order('front')}><BringToFront className="h-3.5 w-3.5" /></Tool>
        <Tool label={t('board.back')} onClick={() => order('back')}><SendToBack className="h-3.5 w-3.5" /></Tool>
      </div>
    </>
  );
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={(e) => (e.stopPropagation(), onClick())} className="rounded-md p-1 hover:bg-muted">
      {children}
    </button>
  );
}

/** A double-click on a move cover edits the text underneath in place. */
function editBelow(e: React.MouseEvent, id: string) {
  const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x instanceof HTMLElement && x.dataset.field && x.closest(`[data-block-id="${CSS.escape(id)}"]`));
  if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
}

/** Arrow keys nudge selected free-form elements by 1 px (Shift: 10 px), one undo step per press. */
export function useFreeKeyboard(store: BuilderStore, hostRef: React.RefObject<HTMLDivElement | null>, readOnly: boolean) {
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith('Arrow') || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const s = store.getState();
      const sel = freeSelection(s.draft.content.root, s.selectedIds);
      const host = hostRef.current;
      if (!sel || !host) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const ops = sel.ids.flatMap((id) => {
        const el = q(host, id);
        if (!el) return [];
        const pos = position(el);
        return dx ? [set(id, s.breakpoint, 'left', `${Math.round(pos.left + dx)}px`)] : [set(id, s.breakpoint, 'top', `${Math.round(pos.top + dy)}px`)];
      });
      s.applyMany(ops);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, hostRef, readOnly]);
}

export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Align free-form elements: against the selection's box, or the frame when one element is selected. */
export function alignFree(host: HTMLElement, canvasId: string, ids: string[], scale: number, breakpoint: StyleBreakpoint, how: AlignHow): EditorOperation[] {
  const frame = frameOf(host, canvasId);
  if (!frame) return [];
  const fr = frame.getBoundingClientRect();
  const items = ids.flatMap((id) => (q(host, id) ? [{ id, el: q(host, id)! }] : [])).map((x) => ({ ...x, box: boxIn(fr, x.el, scale), pos: position(x.el) }));
  if (!items.length) return [];
  const all = items.map((i) => i.box);
  const ref: Box = items.length > 1 ? { x: Math.min(...all.map((b) => b.x)), y: Math.min(...all.map((b) => b.y)), w: Math.max(...all.map((b) => b.x + b.w)) - Math.min(...all.map((b) => b.x)), h: Math.max(...all.map((b) => b.y + b.h)) - Math.min(...all.map((b) => b.y)) } : { x: 0, y: 0, w: fr.width / scale, h: fr.height / scale };
  return items.map((i): EditorOperation => {
    const target = how === 'left' ? ref.x : how === 'hcenter' ? ref.x + (ref.w - i.box.w) / 2 : how === 'right' ? ref.x + ref.w - i.box.w : how === 'top' ? ref.y : how === 'vcenter' ? ref.y + (ref.h - i.box.h) / 2 : ref.y + ref.h - i.box.h;
    const horizontal = how === 'left' || how === 'hcenter' || how === 'right';
    const delta = target - (horizontal ? i.box.x : i.box.y);
    return set(i.id, breakpoint, horizontal ? 'left' : 'top', `${Math.round((horizontal ? i.pos.left : i.pos.top) + delta)}px`);
  });
}

/** Equal gaps between three or more free-form elements, keeping the outer two in place. */
export function distributeFree(host: HTMLElement, canvasId: string, ids: string[], scale: number, breakpoint: StyleBreakpoint, axis: 'x' | 'y'): EditorOperation[] {
  const frame = frameOf(host, canvasId);
  if (!frame || ids.length < 3) return [];
  const fr = frame.getBoundingClientRect();
  const items = ids.flatMap((id) => (q(host, id) ? [{ id, el: q(host, id)! }] : [])).map((x) => ({ ...x, box: boxIn(fr, x.el, scale), pos: position(x.el) }));
  items.sort((a, b) => (axis === 'x' ? a.box.x - b.box.x : a.box.y - b.box.y));
  const first = items[0]!.box;
  const lastBox = items.at(-1)!.box;
  const total = items.reduce((s, i) => s + (axis === 'x' ? i.box.w : i.box.h), 0);
  const span = axis === 'x' ? lastBox.x + lastBox.w - first.x : lastBox.y + lastBox.h - first.y;
  const gap = (span - total) / (items.length - 1);
  let cursor = axis === 'x' ? first.x : first.y;
  const ops: EditorOperation[] = [];
  for (const i of items) {
    const delta = cursor - (axis === 'x' ? i.box.x : i.box.y);
    ops.push(set(i.id, breakpoint, axis === 'x' ? 'left' : 'top', `${Math.round((axis === 'x' ? i.pos.left : i.pos.top) + delta)}px`));
    cursor += (axis === 'x' ? i.box.w : i.box.h) + gap;
  }
  return ops;
}
