import { getBlock, setStyle, type BlockNode, type EditorOperation, type StyleBreakpoint } from '@canon/blocks';
import { useEffect } from 'react';
import { findNode, findParent, newBlock } from '../../editor/tree-ops';
import { position } from '../free-board';
import type { BuilderStore } from '../store';

/**
 * "Build the site like a board": objects go exactly where you drop them and can overlap, like
 * shapes. Under the hood they live in free-form areas (the `canvas` block: absolute positions per
 * breakpoint, stacking by order), so the page stays a list of sections the renderer publishes —
 * and phones get their own positions (the area's "Arrange for this screen" stacks them).
 */

/** Blocks that are whole page bands: they stay in the page flow even with free placement on. */
const FLOW_ONLY = new Set(['section', 'hero', 'cta', 'features', 'stats', 'faq', 'canvas', 'row', 'column', 'collection-list', 'cart']);
export const placesFreely = (b: BlockNode) => !FLOW_ONLY.has(b.type) && getBlock(b.type) !== undefined;

const FREE_SIZE: Record<string, { width: string; height?: string; guess: number }> = {
  heading: { width: '480px', guess: 60 },
  text: { width: '420px', guess: 120 },
  button: { width: '220px', guess: 56 },
  image: { width: '360px', guess: 260 },
  shape: { width: '240px', height: '160px', guess: 160 },
  icon: { width: '96px', guess: 64 },
  badge: { width: '160px', guess: 32 },
};
const sizeOf = (type: string) => FREE_SIZE[type] ?? { width: '360px', guess: 200 };

/** The artboard's content zoom (CanvasFrame sets it inline), so page px = screen px / zoom. */
export const zoomOf = (host: HTMLElement) => parseFloat(host.querySelector<HTMLElement>(':scope > [style*="zoom"]')?.style.zoom ?? '1') || 1;
const grid = (v: number, on: boolean) => (on ? Math.round(v / 8) * 8 : Math.round(v));

/** Position styles for a free-form child: desktop, plus the breakpoint being edited when it is smaller. */
function positioned(block: BlockNode, left: number, top: number, bp: StyleBreakpoint): BlockNode {
  const size = sizeOf(block.type);
  const pos = { position: 'absolute', left: `${left}px`, top: `${top}px`, maxWidth: 'none', marginTop: '0px', paddingLeft: '0px', paddingRight: '0px', width: size.width, ...(size.height ? { height: size.height } : {}) };
  const styles = { ...(block.styles ?? {}), base: { ...(block.styles?.base ?? {}), ...pos } };
  if (bp !== 'base') styles[bp] = { ...(styles[bp] ?? {}), left: pos.left, top: pos.top };
  return { ...block, styles };
}

/** Grows a free-form area at `bp` so that `bottom` (page px) fits, with some room below. */
function growOps(area: BlockNode, bottom: number, bp: StyleBreakpoint, host: HTMLElement): EditorOperation[] {
  const el = host.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(area.id)}"]`);
  const current = el ? el.getBoundingClientRect().height / zoomOf(host) : Number(area.props.height) || 560;
  const need = Math.ceil((bottom + 48) / 8) * 8;
  if (need <= current) return [];
  if (bp === 'base') return [{ op: 'PROPS_UPDATE', id: area.id, patch: { height: Math.min(4000, need) } }];
  return [{ op: 'NODE_META', id: area.id, patch: { styles: setStyle(area.styles, bp, 'minHeight', `${Math.min(4000, need)}px`) } }];
}

/**
 * Drops `block` at the screen point: into the free-form area under it, or into a new free-form
 * area placed in the page flow right there. One undo step. False when the block keeps to the flow.
 */
export function dropFreely(store: BuilderStore, host: HTMLElement, block: BlockNode, at: { x: number; y: number }): boolean {
  if (!placesFreely(block)) return false;
  const s = store.getState();
  const root = s.draft.content.root;
  const bp = s.breakpoint;
  const zoom = zoomOf(host);
  const hr = host.getBoundingClientRect();
  const under = document.elementsFromPoint(at.x, at.y).find((el) => host.contains(el) && el.closest('[data-block-id]'))?.closest<HTMLElement>('[data-block-id]') ?? null;
  // The page band under the pointer (a direct child of the page).
  let topId: string | null = null;
  for (let el: HTMLElement | null = under; el; el = el.parentElement?.closest<HTMLElement>('[data-block-id]') ?? null) {
    if (findParent(root, el.dataset.blockId!)?.parent.id === root.id) topId = el.dataset.blockId!;
  }
  const top = topId ? findNode(root, topId) : null;

  if (top?.type === 'canvas') {
    const frame = host.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(top.id)}"] [data-free-frame]`);
    if (!frame) return false;
    const fr = frame.getBoundingClientRect();
    const left = grid(Math.max(0, (at.x - fr.left) / zoom), s.snap);
    const y = grid(Math.max(0, (at.y - fr.top) / zoom), s.snap);
    const placed = positioned(block, left, y, bp);
    const r = s.applyMany([{ op: 'NODE_INSERT', parentId: top.id, index: top.children.length, nodes: [placed] }, ...growOps(top, y + sizeOf(block.type).guess, bp, host)]);
    if (r.applied) s.select(placed.id);
    return r.applied > 0;
  }

  // No free zone here: one appears in the page flow at this spot, with the object in it.
  const width = hr.width / zoom;
  const frameLeft = (width - Math.min(1200, width)) / 2;
  const left = grid(Math.max(0, (at.x - hr.left) / zoom - frameLeft - 40), s.snap);
  const y = 48;
  const placed = positioned(block, left, y, bp);
  const area: BlockNode = { ...newBlock('canvas'), name: 'Free zone', props: { ...newBlock('canvas').props, height: Math.max(320, Math.ceil((y + sizeOf(block.type).guess + 96) / 8) * 8) }, children: [placed] };
  let index = root.children.length;
  if (top && under) {
    const tr = host.querySelector(`[data-block-id="${CSS.escape(top.id)}"]`)!.getBoundingClientRect();
    const i = root.children.findIndex((c) => c.id === top.id);
    index = at.y < tr.top + tr.height / 2 ? i : i + 1;
  }
  const r = s.applyMany([{ op: 'NODE_INSERT', parentId: root.id, index, nodes: [area] }]);
  if (r.applied) s.select(placed.id);
  return r.applied > 0;
}

/**
 * Press and drag any object of a free-form area to move it — no need to select it first, like a
 * shape on a board. The move previews with a transform and commits one undoable edit at the
 * breakpoint being edited; the area grows to fit. Selected objects keep their own handles.
 */
export function useDirectFreeDrag(store: BuilderStore, hostRef: React.RefObject<HTMLDivElement | null>, readOnly: boolean) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host || readOnly) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-builder-ui], [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      const s = store.getState();
      const root = s.draft.content.root;
      // The free-form child under the pointer (the object, not something inside it).
      let el: HTMLElement | null = target.closest<HTMLElement>('[data-block-id]');
      let area: BlockNode | null = null;
      while (el) {
        const at = findParent(root, el.dataset.blockId!);
        if (at?.parent.type === 'canvas') {
          area = at.parent;
          break;
        }
        el = el.parentElement?.closest<HTMLElement>('[data-block-id]') ?? null;
      }
      if (!el || !area || el.hasAttribute('data-locked') || s.selectedIds.includes(el.dataset.blockId!)) return;
      const id = el.dataset.blockId!;
      const zoom = zoomOf(host);
      const pos = position(el);
      const start = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, h: el.getBoundingClientRect().height / zoom };
      let moved = false;
      const node = el;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / zoom;
        const dy = (ev.clientY - start.y) / zoom;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / zoom) return;
        if (!moved) {
          moved = true;
          window.getSelection()?.removeAllRanges();
        }
        node.style.translate = `${dx}px ${dy}px`;
        node.style.zIndex = '50';
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up, true);
        node.style.translate = '';
        node.style.zIndex = '';
        if (!moved) return;
        // The click that ends a drag selects the object (no navigation, no text editing).
        const snap = store.getState().snap && !ev.altKey;
        const left = grid(start.left + (ev.clientX - start.x) / zoom, snap);
        const top = grid(Math.max(-2000, start.top + (ev.clientY - start.y) / zoom), snap);
        const bp = store.getState().breakpoint;
        const st = store.getState();
        // An object stacked on a phone keeps its width when it gets its own position there.
        const width: EditorOperation[] = pos.flow ? [{ op: 'STYLE_SET', id, breakpoint: bp, property: 'width', value: `${Math.round(pos.width)}px` }] : [];
        st.applyMany([{ op: 'STYLE_SET', id, breakpoint: bp, property: 'left', value: `${left}px` }, { op: 'STYLE_SET', id, breakpoint: bp, property: 'top', value: `${top}px` }, ...width, ...growOps(area!, top + start.h, bp, host)]);
        st.select(id);
      };
      e.preventDefault();
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, true);
    };
    host.addEventListener('pointerdown', onDown);
    return () => host.removeEventListener('pointerdown', onDown);
  }, [store, hostRef, readOnly]);
}
