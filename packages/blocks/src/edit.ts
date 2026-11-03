import { getBlock } from './definitions';
import { setStyle, type StyleBreakpoint, type StyleProperty } from './styles';
import type { BlockNode, PageContent } from './tree';

/**
 * Immutable page-tree edits shared by the builder, the API and the AI planner. Every function
 * returns a new tree (untouched subtrees keep their identity), or the same object when nothing
 * changed, so callers can compare by reference.
 */

export const newId = () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);

/** A fresh block with defaults; Columns start with two columns so they are usable at once. */
export function newBlock(type: string): BlockNode {
  const def = getBlock(type);
  const children = type === 'row' ? [newBlock('column'), newBlock('column')] : [];
  return { id: newId(), type, props: structuredClone((def?.defaults() ?? {}) as Record<string, unknown>), children };
}

/** Deep copy with new ids (duplicate, paste, AI-generated blocks); name, flags and styles are kept. */
export function cloneWithIds(b: BlockNode): BlockNode {
  const { id: _id, children, props, ...meta } = b;
  return { ...structuredClone(meta), id: newId(), type: b.type, props: structuredClone(props), children: children.map(cloneWithIds) };
}

/**
 * Nesting rules enforced before the API ever sees the tree: containers only, the definition's
 * allowedChildren, columns only inside Columns, sections only at the top level.
 */
export function canContain(parent: BlockNode, childType: string, isRoot: boolean): boolean {
  const def = getBlock(parent.type);
  if (!isRoot && !def?.isContainer) return false;
  if (def?.allowedChildren && !isRoot) return def.allowedChildren.includes(childType);
  if (childType === 'column') return false;
  if (childType === 'section') return isRoot;
  return true;
}

export function findNode(root: BlockNode, id: string): BlockNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

export function findParent(root: BlockNode, id: string): { parent: BlockNode; index: number } | null {
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i]!;
    if (c.id === id) return { parent: root, index: i };
    const hit = findParent(c, id);
    if (hit) return hit;
  }
  return null;
}

/** True when `id` is `ancestorId` or inside it — a block can't be dropped into itself. */
export function isWithin(root: BlockNode, ancestorId: string, id: string): boolean {
  const a = findNode(root, ancestorId);
  return Boolean(a && findNode(a, id));
}

/** Rebuilds only the path to the nodes `fn` changes; other subtrees keep their identity. */
function mapTree(node: BlockNode, fn: (n: BlockNode) => BlockNode): BlockNode {
  const next = fn(node);
  let changed = next !== node;
  const children = next.children.map((c) => {
    const m = mapTree(c, fn);
    if (m !== c) changed = true;
    return m;
  });
  return changed ? { ...next, children } : node;
}

const withRoot = (content: PageContent, root: BlockNode): PageContent => (root === content.root ? content : { root });

export function replaceBlock(content: PageContent, id: string, block: BlockNode): PageContent {
  return withRoot(content, mapTree(content.root, (n) => (n.id === id ? block : n)));
}

export function updateProps(content: PageContent, id: string, patch: Record<string, unknown>): PageContent {
  return withRoot(content, mapTree(content.root, (n) => (n.id === id ? { ...n, props: { ...n.props, ...patch } } : n)));
}

/** Node-level fields edited by the Style panel and Layers (name, visibility, lock, styles). */
export type NodeMeta = Partial<Pick<BlockNode, 'name' | 'hidden' | 'locked' | 'styles'>>;

export function updateNodeMeta(content: PageContent, id: string, patch: NodeMeta): PageContent {
  return withRoot(
    content,
    mapTree(content.root, (n) => {
      if (n.id !== id) return n;
      const next: BlockNode = { ...n, ...patch };
      // Unset fields are removed, so documents stay minimal and diffs readable.
      for (const k of Object.keys(patch) as (keyof NodeMeta)[]) if (patch[k] === undefined || patch[k] === false || patch[k] === '') delete next[k];
      return next;
    }),
  );
}

export function insertBlock(content: PageContent, parentId: string, index: number, block: BlockNode): PageContent {
  return insertBlocks(content, parentId, index, [block]);
}

export function insertBlocks(content: PageContent, parentId: string, index: number, blocks: BlockNode[]): PageContent {
  return withRoot(
    content,
    mapTree(content.root, (n) => {
      if (n.id !== parentId) return n;
      const children = [...n.children];
      children.splice(Math.max(0, Math.min(index, children.length)), 0, ...blocks);
      return { ...n, children };
    }),
  );
}

export function removeBlock(content: PageContent, id: string): PageContent {
  return removeBlocks(content, [id]);
}

export function removeBlocks(content: PageContent, ids: readonly string[]): PageContent {
  const drop = new Set(ids);
  drop.delete(content.root.id);
  if (!drop.size) return content;
  return withRoot(content, mapTree(content.root, (n) => (n.children.some((c) => drop.has(c.id)) ? { ...n, children: n.children.filter((c) => !drop.has(c.id)) } : n)));
}

export function moveBlock(content: PageContent, id: string, delta: -1 | 1): PageContent {
  return withRoot(
    content,
    mapTree(content.root, (n) => {
      const i = n.children.findIndex((c) => c.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= n.children.length) return n;
      const children = [...n.children];
      [children[i], children[j]] = [children[j]!, children[i]!];
      return { ...n, children };
    }),
  );
}

/** Moves a block to (parentId, index) where index counts siblings *before* the move. */
export function moveTo(content: PageContent, id: string, parentId: string, index: number): PageContent {
  const node = findNode(content.root, id);
  const from = findParent(content.root, id);
  const target = findNode(content.root, parentId);
  if (!node || !from || !target || isWithin(content.root, id, parentId)) return content;
  if (!canContain(target, node.type, target.id === content.root.id)) return content;
  const adjusted = from.parent.id === parentId && from.index < index ? index - 1 : index;
  if (from.parent.id === parentId && from.index === adjusted) return content;
  return insertBlock(removeBlock(content, id), parentId, adjusted, node);
}

export function duplicateBlock(content: PageContent, id: string): PageContent {
  return withRoot(
    content,
    mapTree(content.root, (n) => {
      const i = n.children.findIndex((c) => c.id === id);
      if (i < 0) return n;
      const children = [...n.children];
      children.splice(i + 1, 0, cloneWithIds(children[i]!));
      return { ...n, children };
    }),
  );
}

/**
 * Where a block added from the palette goes: into the selected container if it fits, else right
 * after the selected block, else (walking up) after the nearest ancestor that accepts it, else at the end.
 */
export function insertionPoint(content: PageContent, selectedId: string | null, type: string): { parentId: string; index: number } {
  const root = content.root;
  const sel = selectedId ? findNode(root, selectedId) : null;
  if (sel && sel.id !== root.id && getBlock(sel.type)?.isContainer && canContain(sel, type, false)) return { parentId: sel.id, index: sel.children.length };
  let cur = sel && sel.id !== root.id ? sel.id : null;
  while (cur) {
    const at = findParent(root, cur);
    if (!at) break;
    if (canContain(at.parent, type, at.parent.id === root.id)) return { parentId: at.parent.id, index: at.index + 1 };
    cur = at.parent.id === root.id ? null : at.parent.id;
  }
  return { parentId: root.id, index: root.children.length };
}

export function insertNear(content: PageContent, selectedId: string | null, block: BlockNode): PageContent {
  const at = insertionPoint(content, selectedId, block.type);
  return insertBlock(content, at.parentId, at.index, block);
}

/**
 * The selection reduced to blocks that can be acted on together: existing, not the root, and
 * not inside another selected block (moving a parent already moves its children). Document order.
 */
export function normalizeSelection(root: BlockNode, ids: readonly string[]): string[] {
  const want = new Set(ids);
  const out: string[] = [];
  const walk = (n: BlockNode, covered: boolean) => {
    const hit = !covered && n.id !== root.id && want.has(n.id);
    if (hit) out.push(n.id);
    for (const c of n.children) walk(c, covered || hit);
  };
  walk(root, false);
  return out;
}

/**
 * Wraps sibling blocks in a new container (a Group unless `wrapper` says otherwise), at the
 * position of the first one. Blocks with different parents, or that the wrapper can't hold, are
 * refused (same content back).
 */
export function groupBlocks(content: PageContent, ids: readonly string[], wrapper: BlockNode = newBlock('group')): PageContent {
  const sel = normalizeSelection(content.root, ids);
  if (!sel.length) return content;
  const first = findParent(content.root, sel[0]!);
  if (!first) return content;
  const parent = first.parent;
  if (!sel.every((id) => parent.children.some((c) => c.id === id))) return content;
  if (!canContain(parent, wrapper.type, parent.id === content.root.id)) return content;
  const nodes = parent.children.filter((c) => sel.includes(c.id));
  if (!nodes.every((n) => canContain(wrapper, n.type, false))) return content;
  const index = parent.children.findIndex((c) => c.id === sel[0]);
  const group: BlockNode = { ...wrapper, children: [...wrapper.children, ...nodes] };
  return insertBlock(removeBlocks(content, sel), parent.id, index, group);
}

/** Replaces a container with its children, if its parent can hold all of them. */
export function ungroupBlock(content: PageContent, id: string): PageContent {
  const node = findNode(content.root, id);
  const at = findParent(content.root, id);
  if (!node || !at || !node.children.length) return content;
  if (!node.children.every((c) => canContain(at.parent, c.type, at.parent.id === content.root.id))) return content;
  return insertBlocks(removeBlock(content, id), at.parent.id, at.index, node.children);
}

export interface OutlineItem {
  node: BlockNode;
  depth: number;
  parentId: string;
  index: number;
  siblings: number;
}

export function outline(root: BlockNode): OutlineItem[] {
  const out: OutlineItem[] = [];
  const walk = (n: BlockNode, depth: number) =>
    n.children.forEach((c, index) => {
      out.push({ node: c, depth, parentId: n.id, index, siblings: n.children.length });
      walk(c, depth + 1);
    });
  walk(root, 0);
  return out;
}

// ── typed operations ────────────────────────────────────────────────────────

/**
 * Every builder edit as data. The builder applies them, keeps a log of them, and Canon AI
 * proposes them (Stage 5): one vocabulary for people, agents and audit. Operations are
 * validated against the tree when applied; one that doesn't fit is a no-op, never a partial edit.
 */
export type EditorOperation =
  | { op: 'NODE_INSERT'; parentId: string; index: number; nodes: BlockNode[] }
  | { op: 'NODE_REMOVE'; ids: string[] }
  | { op: 'NODE_MOVE'; id: string; parentId: string; index: number }
  | { op: 'NODE_REORDER'; id: string; delta: -1 | 1 }
  | { op: 'NODE_DUPLICATE'; id: string }
  | { op: 'NODE_REPLACE'; id: string; node: BlockNode }
  | { op: 'PROPS_UPDATE'; id: string; patch: Record<string, unknown> }
  | { op: 'NODE_META'; id: string; patch: NodeMeta }
  | { op: 'STYLE_SET'; id: string; breakpoint: StyleBreakpoint; property: StyleProperty; value: string | null }
  | { op: 'NODE_GROUP'; ids: string[]; wrapper?: BlockNode }
  | { op: 'NODE_UNGROUP'; id: string };

export type OperationType = EditorOperation['op'];

/** Locked blocks can't be moved, removed, regrouped or restyled until unlocked (NODE_META can unlock). */
function touchesLocked(root: BlockNode, op: EditorOperation): boolean {
  const locked = (id: string) => Boolean(findNode(root, id)?.locked);
  switch (op.op) {
    case 'NODE_REMOVE':
    case 'NODE_GROUP':
      return op.ids.some(locked);
    case 'NODE_MOVE':
    case 'NODE_REORDER':
    case 'NODE_REPLACE':
    case 'PROPS_UPDATE':
    case 'STYLE_SET':
    case 'NODE_UNGROUP':
      return locked(op.id);
    default:
      return false;
  }
}

export function applyOperation(content: PageContent, op: EditorOperation): PageContent {
  if (touchesLocked(content.root, op)) return content;
  switch (op.op) {
    case 'NODE_INSERT': {
      const parent = findNode(content.root, op.parentId);
      if (!parent || !op.nodes.every((n) => canContain(parent, n.type, parent.id === content.root.id))) return content;
      return insertBlocks(content, op.parentId, op.index, op.nodes);
    }
    case 'NODE_REMOVE':
      return removeBlocks(content, op.ids);
    case 'NODE_MOVE':
      return moveTo(content, op.id, op.parentId, op.index);
    case 'NODE_REORDER':
      return moveBlock(content, op.id, op.delta);
    case 'NODE_DUPLICATE':
      return duplicateBlock(content, op.id);
    case 'NODE_REPLACE':
      return replaceBlock(content, op.id, op.node);
    case 'PROPS_UPDATE':
      return updateProps(content, op.id, op.patch);
    case 'NODE_META':
      return updateNodeMeta(content, op.id, op.patch);
    case 'STYLE_SET': {
      const n = findNode(content.root, op.id);
      if (!n) return content;
      return updateNodeMeta(content, op.id, { styles: setStyle(n.styles, op.breakpoint, op.property, op.value ?? undefined) });
    }
    case 'NODE_GROUP':
      return groupBlocks(content, op.ids, op.wrapper);
    case 'NODE_UNGROUP':
      return ungroupBlock(content, op.id);
  }
}

export function applyOperations(content: PageContent, ops: readonly EditorOperation[]): PageContent {
  return ops.reduce(applyOperation, content);
}

/** One line per operation for the history panel, audit and AI diffs. */
export function describeOperation(op: EditorOperation, root?: BlockNode): string {
  const label = (id: string) => {
    const n = root && findNode(root, id);
    return n ? (n.name ?? getBlock(n.type)?.name ?? n.type) : id;
  };
  switch (op.op) {
    case 'NODE_INSERT':
      return `Insert ${op.nodes.map((n) => getBlock(n.type)?.name ?? n.type).join(', ')}`;
    case 'NODE_REMOVE':
      return `Delete ${op.ids.length === 1 ? label(op.ids[0]!) : `${op.ids.length} blocks`}`;
    case 'NODE_MOVE':
    case 'NODE_REORDER':
      return `Move ${label(op.id)}`;
    case 'NODE_DUPLICATE':
      return `Duplicate ${label(op.id)}`;
    case 'NODE_REPLACE':
      return `Replace ${label(op.id)}`;
    case 'PROPS_UPDATE':
      return `Edit ${label(op.id)}: ${Object.keys(op.patch).join(', ')}`;
    case 'NODE_META':
      return `${Object.keys(op.patch).map((k) => (k === 'hidden' ? (op.patch.hidden ? 'Hide' : 'Show') : k === 'locked' ? (op.patch.locked ? 'Lock' : 'Unlock') : k === 'name' ? 'Rename' : 'Style')).join(', ')} ${label(op.id)}`;
    case 'STYLE_SET':
      return `${label(op.id)}: ${op.property} ${op.value ?? 'reset'} (${op.breakpoint})`;
    case 'NODE_GROUP':
      return `Group ${op.ids.length} blocks`;
    case 'NODE_UNGROUP':
      return `Ungroup ${label(op.id)}`;
  }
}
