import type { BlockNode } from '@canon/blocks';
import { canContain, findNode, findParent, isWithin } from '../editor/tree-ops';

export interface DropTarget {
  parentId: string;
  index: number;
  /** Indicator in coordinates relative to the overlay host. */
  line: { x: number; y: number; w: number; h: number };
  /** Empty container: highlight it instead of drawing a line. */
  box?: boolean;
}

export type DragItem = { kind: 'new'; type: string } | { kind: 'move'; id: string; type: string };

/** Pointer this close to a container's edge means "next to the container", not "inside it". */
const EDGE_PX = 10;

const blockEl = (el: Element | null): HTMLElement | null => (el?.closest('[data-block-id]') as HTMLElement | null) ?? null;

function directBlockChildren(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-block-id]')].filter((c) => c.parentElement?.closest('[data-block-id]') === container);
}

/** Only a flex row lays children side by side; flex-direction alone defaults to "row" on any element. */
function isHorizontal(container: HTMLElement): boolean {
  const cs = getComputedStyle(container);
  return /flex/.test(cs.display) && cs.flexDirection.startsWith('row');
}

/**
 * Resolves where a dragged block would land on the canvas by hit-testing the rendered blocks
 * (data-block-id attributes from @canon/ui-blocks). Rules mirror tree-ops: containers accept by
 * definition, Columns only take columns, a block never lands inside itself; when the hovered
 * container refuses, the drop bubbles up to its parent.
 */
export function resolveCanvasDrop(host: HTMLElement, x: number, y: number, root: BlockNode, item: DragItem): DropTarget | null {
  const hostRect = host.getBoundingClientRect();
  const rel = (r: DOMRect) => ({ x: r.left - hostRect.left, y: r.top - hostRect.top, w: r.width, h: r.height });
  const hit = document.elementsFromPoint(x, y).find((e) => host.contains(e) && blockEl(e));
  let el = hit ? blockEl(hit) : (host.querySelector<HTMLElement>(`[data-block-id="${root.id}"]`) ?? null);

  while (el) {
    const id = el.dataset.blockId!;
    const node = findNode(root, id);
    if (!node) return null;
    const isRoot = id === root.id;
    const parentEl = isRoot ? null : blockEl(el.parentElement);
    if (item.kind === 'move' && isWithin(root, item.id, id)) {
      el = parentEl;
      continue;
    }

    const r = el.getBoundingClientRect();
    const nearEdge = !isRoot && (y - r.top < EDGE_PX || r.bottom - y < EDGE_PX);
    if (el.hasAttribute('data-block-container') && !nearEdge && canContain(node, item.type, isRoot)) {
      const kids = directBlockChildren(el).filter((k) => !(item.kind === 'move' && k.dataset.blockId === item.id));
      if (kids.length === 0) return { parentId: id, index: 0, line: rel(r), box: true };
      const horizontal = isHorizontal(el);
      const before = kids.findIndex((k) => {
        const kr = k.getBoundingClientRect();
        return horizontal ? x < kr.left + kr.width / 2 : y < kr.top + kr.height / 2;
      });
      return lineAt(node, kids, before < 0 ? kids.length : before, horizontal, rel, id);
    }

    const at = findParent(root, id);
    if (at && parentEl && canContain(at.parent, item.type, at.parent.id === root.id)) {
      const horizontal = isHorizontal(parentEl);
      const after = horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
      const kids = directBlockChildren(parentEl);
      const pos = kids.indexOf(el);
      return lineAt(at.parent, kids, (pos < 0 ? at.index : pos) + (after ? 1 : 0), horizontal, rel, at.parent.id);
    }
    el = parentEl;
  }
  return null;
}

function lineAt(parent: BlockNode, kids: HTMLElement[], index: number, horizontal: boolean, rel: (r: DOMRect) => DropTarget['line'], parentId: string): DropTarget {
  // DOM order matches tree order, so the DOM index is the tree index (the dragged block excluded
  // above is still in the tree: moveTo() expects pre-removal indexes, so map back via ids).
  const ref = kids[Math.min(index, kids.length - 1)]!;
  const rr = rel(ref.getBoundingClientRect());
  const atEnd = index >= kids.length;
  const line = horizontal ? { x: (atEnd ? rr.x + rr.w : rr.x) - 2, y: rr.y, w: 4, h: rr.h } : { x: rr.x, y: (atEnd ? rr.y + rr.h : rr.y) - 2, w: rr.w, h: 4 };
  const treeIndex = atEnd ? (kids[kids.length - 1] ? parent.children.findIndex((c) => c.id === kids[kids.length - 1]!.dataset.blockId) + 1 : 0) : parent.children.findIndex((c) => c.id === ref.dataset.blockId);
  return { parentId, index: Math.max(0, treeIndex), line };
}

/**
 * Same for the layers list: upper half of a row = before, lower half = after, and pointer to the
 * right of the label on a container row = inside it (at the end).
 */
export function resolveLayerDrop(host: HTMLElement, x: number, y: number, root: BlockNode, item: DragItem): DropTarget | null {
  const hostRect = host.getBoundingClientRect();
  const row = document.elementsFromPoint(x, y).find((e) => host.contains(e) && e.closest('[data-layer-id]'))?.closest<HTMLElement>('[data-layer-id]');
  if (!row) return null;
  const id = row.dataset.layerId!;
  if (item.kind === 'move' && isWithin(root, item.id, id)) return null;
  const node = findNode(root, id);
  const at = findParent(root, id);
  if (!node || !at) return null;
  const r = row.getBoundingClientRect();
  const depth = Number(row.dataset.depth ?? 0);
  const line = (yy: number, indent: number) => ({ x: r.left - hostRect.left + indent, y: yy - hostRect.top - 1, w: r.width - indent, h: 2 });
  const inside = x > r.left + 28 + depth * 14 + 40 && canContain(node, item.type, false);
  if (inside) return { parentId: id, index: node.children.length, line: line(r.bottom, (depth + 1) * 14) };
  if (!canContain(at.parent, item.type, at.parent.id === root.id)) return null;
  const after = y > r.top + r.height / 2;
  return { parentId: at.parent.id, index: at.index + (after ? 1 : 0), line: line(after ? r.bottom : r.top, depth * 14) };
}
