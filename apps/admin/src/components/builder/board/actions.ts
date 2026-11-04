import { getBlock, setStyle, type BlockNode, type EditorOperation } from '@canon/blocks';
import { findNode, findParent } from '../../editor/tree-ops';
import { alignFree, distributeFree, freeSelection, type AlignHow } from '../free-board';
import type { BuilderStore } from '../store';

/**
 * Editing commands shared by the board's top bar, the context menu and the shortcuts. Each one is
 * a single undoable edit through the store's typed operations — the same path every other edit takes.
 */

const HORIZONTAL: Record<'left' | 'hcenter' | 'right', { prop: 'left' | 'center' | 'right'; self: string }> = {
  left: { prop: 'left', self: 'flex-start' },
  hcenter: { prop: 'center', self: 'center' },
  right: { prop: 'right', self: 'flex-end' },
};

const selected = (store: BuilderStore): BlockNode[] => {
  const s = store.getState();
  return s.selectedIds.map((id) => findNode(s.draft.content.root, id)).filter((n): n is BlockNode => Boolean(n) && n!.id !== s.draft.content.root.id);
};

/**
 * Align the selection. Free-form elements move (positions at this breakpoint); blocks in the page
 * flow use their own alignment setting when they have one, else align themselves in their parent.
 * Vertical alignment only means something for free-form elements.
 */
export function alignSelection(store: BuilderStore, host: HTMLElement | null, scale: number, how: AlignHow): boolean {
  const s = store.getState();
  const free = freeSelection(s.draft.content.root, s.selectedIds);
  if (free && host) {
    const r = s.applyMany(alignFree(host, free.canvas.id, free.ids, scale, s.breakpoint, how));
    return r.applied > 0;
  }
  if (how !== 'left' && how !== 'hcenter' && how !== 'right') return false;
  const h = HORIZONTAL[how];
  const ops: EditorOperation[] = selected(store).flatMap((n): EditorOperation[] => {
    const field = getBlock(n.type)?.fields.align;
    if (field?.options?.includes(h.prop)) return [{ op: 'PROPS_UPDATE', id: n.id, patch: { align: h.prop } }];
    return [{ op: 'NODE_META', id: n.id, patch: { styles: setStyle(n.styles, s.breakpoint, 'alignSelf', h.self) } }];
  });
  return s.applyMany(ops).applied > 0;
}

export function distributeSelection(store: BuilderStore, host: HTMLElement | null, scale: number, axis: 'x' | 'y'): boolean {
  const s = store.getState();
  const free = freeSelection(s.draft.content.root, s.selectedIds);
  if (!free || !host) return false;
  return s.applyMany(distributeFree(host, free.canvas.id, free.ids, scale, s.breakpoint, axis)).applied > 0;
}

/** Forward/backward one step: later siblings paint on top (free-form) and come later (flow). */
export function arrange(store: BuilderStore, dir: 1 | -1): boolean {
  const s = store.getState();
  const root = s.draft.content.root;
  const nodes = selected(store);
  if (!nodes.length) return false;
  // Move the far end first so the selected blocks don't swap places with each other.
  const ordered = nodes
    .map((n) => ({ n, at: findParent(root, n.id) }))
    .filter((x) => x.at && !x.n.locked)
    .sort((a, b) => (dir === 1 ? b.at!.index - a.at!.index : a.at!.index - b.at!.index));
  const ops: EditorOperation[] = ordered.map((x) => ({ op: 'NODE_REORDER', id: x.n.id, delta: dir }));
  return s.applyMany(ops).applied > 0;
}

/** To the front/back of the parent (free-form stacking order). */
export function arrangeToEnd(store: BuilderStore, where: 'front' | 'back'): boolean {
  const s = store.getState();
  const root = s.draft.content.root;
  const nodes = selected(store);
  const at = nodes[0] && findParent(root, nodes[0].id);
  if (!at) return false;
  const ids = at.parent.children.filter((c) => nodes.some((n) => n.id === c.id) && !c.locked).map((c) => c.id);
  const ops: EditorOperation[] = where === 'front' ? ids.map((id) => ({ op: 'NODE_MOVE', id, parentId: at.parent.id, index: at.parent.children.length })) : [...ids].reverse().map((id) => ({ op: 'NODE_MOVE', id, parentId: at.parent.id, index: 0 }));
  return s.applyMany(ops).applied > 0;
}

/** Hide or show the selection; a mixed selection becomes hidden. */
export function toggleHidden(store: BuilderStore): void {
  const nodes = selected(store);
  const hide = nodes.some((n) => !n.hidden);
  store.getState().applyMany(nodes.map((n) => ({ op: 'NODE_META', id: n.id, patch: { hidden: hide || undefined } })));
}

/** Lock or unlock the selection; a mixed selection becomes locked. */
export function toggleLocked(store: BuilderStore): void {
  const nodes = selected(store);
  const lock = nodes.some((n) => !n.locked);
  store.getState().applyMany(nodes.map((n) => ({ op: 'NODE_META', id: n.id, patch: { locked: lock || undefined } })));
}

export function selectParent(store: BuilderStore): void {
  const s = store.getState();
  const id = s.selectedId;
  const at = id ? findParent(s.draft.content.root, id) : null;
  s.select(at && at.parent.id !== s.draft.content.root.id ? at.parent.id : null);
}
