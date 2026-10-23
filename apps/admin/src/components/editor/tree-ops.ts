import { getBlock, FACT_KEY_RE, type BlockNode, type InlineNode, type PageContent, type RichTextDoc } from '@canon/blocks';

/** Immutable tree edits — every operation returns a new tree, so React state and undo stay simple. */

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

/** A fresh block with defaults; Columns start with two columns so they are usable at once. */
export function newBlock(type: string): BlockNode {
  const def = getBlock(type);
  const children = type === 'row' ? [newBlock('column'), newBlock('column')] : [];
  return { id: newId(), type, props: structuredClone((def?.defaults() ?? {}) as Record<string, unknown>), children };
}

/** Deep copy with new ids (duplicate, paste, AI-generated blocks). */
export function cloneWithIds(b: BlockNode): BlockNode {
  return { id: newId(), type: b.type, props: structuredClone(b.props), children: b.children.map(cloneWithIds) };
}

/**
 * Nesting rules the builder enforces before the API ever sees the tree: containers only, the
 * definition's allowedChildren, columns only inside Columns, sections only at the top level.
 */
export function canContain(parent: BlockNode, childType: string, isRoot: boolean): boolean {
  const def = getBlock(parent.type);
  if (!isRoot && !def?.isContainer) return false;
  if (def?.allowedChildren && !isRoot) return def.allowedChildren.includes(childType);
  if (childType === 'column') return false;
  if (childType === 'section') return isRoot;
  return true;
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

/**
 * Where a block added from the palette goes: into the selected container if it fits, else right
 * after the selected block, else (walking up) after the nearest ancestor that accepts it, else at the end.
 */
export function insertNear(content: PageContent, selectedId: string | null, block: BlockNode): PageContent {
  const root = content.root;
  const sel = selectedId ? findNode(root, selectedId) : null;
  if (sel && sel.id !== root.id && getBlock(sel.type)?.isContainer && canContain(sel, block.type, false)) return insertBlock(content, sel.id, sel.children.length, block);
  let cur = sel && sel.id !== root.id ? sel.id : null;
  while (cur) {
    const at = findParent(root, cur);
    if (!at) break;
    if (canContain(at.parent, block.type, at.parent.id === root.id)) return insertBlock(content, at.parent.id, at.index + 1, block);
    cur = at.parent.id === root.id ? null : at.parent.id;
  }
  return insertBlock(content, root.id, root.children.length, block);
}

export function replaceBlock(content: PageContent, id: string, block: BlockNode): PageContent {
  return { root: mapTree(content.root, (n) => (n.id === id ? block : n)) };
}

export function findNode(root: BlockNode, id: string): BlockNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function mapTree(node: BlockNode, fn: (n: BlockNode) => BlockNode): BlockNode {
  const next = fn(node);
  return { ...next, children: next.children.map((c) => mapTree(c, fn)) };
}

export function updateProps(content: PageContent, id: string, patch: Record<string, unknown>): PageContent {
  return { root: mapTree(content.root, (n) => (n.id === id ? { ...n, props: { ...n.props, ...patch } } : n)) };
}

export function insertBlock(content: PageContent, parentId: string, index: number, block: BlockNode): PageContent {
  return {
    root: mapTree(content.root, (n) => {
      if (n.id !== parentId) return n;
      const children = [...n.children];
      children.splice(Math.max(0, Math.min(index, children.length)), 0, block);
      return { ...n, children };
    }),
  };
}

export function removeBlock(content: PageContent, id: string): PageContent {
  return { root: mapTree(content.root, (n) => ({ ...n, children: n.children.filter((c) => c.id !== id) })) };
}

export function moveBlock(content: PageContent, id: string, delta: -1 | 1): PageContent {
  return {
    root: mapTree(content.root, (n) => {
      const i = n.children.findIndex((c) => c.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= n.children.length) return n;
      const children = [...n.children];
      [children[i], children[j]] = [children[j]!, children[i]!];
      return { ...n, children };
    }),
  };
}

export function duplicateBlock(content: PageContent, id: string): PageContent {
  const cloneIds = cloneWithIds;
  return {
    root: mapTree(content.root, (n) => {
      const i = n.children.findIndex((c) => c.id === id);
      if (i < 0) return n;
      const children = [...n.children];
      children.splice(i + 1, 0, cloneIds(children[i]!));
      return { ...n, children };
    }),
  };
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

// ── rich text ⇄ plain editing ────────────────────────────────────────────────

const FACT_TOKEN = /\{\{fact:([a-z0-9_.]+)\}\}/g;

/**
 * Phase 2 edits rich text as paragraphs of plain text, with Canon facts shown as {{fact:key}}.
 * Only "simple" docs (paragraphs of unformatted text + fact tokens) round-trip losslessly; richer
 * docs are shown read-only until the TipTap editor lands in Phase 3, so nothing is silently lost.
 */
export function isSimpleDoc(doc: RichTextDoc | undefined): boolean {
  return Boolean(doc) && doc!.content.every((b) => b.type === 'paragraph' && (b.content ?? []).every((n) => n.type === 'factRef' || (n.type === 'text' && !n.marks?.length)));
}

export function docToPlain(doc: RichTextDoc): string {
  return doc.content
    .map((b) => (b.type === 'paragraph' ? (b.content ?? []).map((n) => (n.type === 'text' ? n.text : n.type === 'factRef' ? `{{fact:${n.attrs.factKey}}}` : '')).join('') : ''))
    .join('\n\n');
}

export function plainToDoc(text: string): RichTextDoc {
  const paragraphs = text.split(/\n{2,}/);
  return {
    type: 'doc',
    content: paragraphs.map((p) => {
      const content: InlineNode[] = [];
      let last = 0;
      for (const m of p.matchAll(FACT_TOKEN)) {
        const key = m[1]!;
        if (m.index! > last) content.push({ type: 'text', text: p.slice(last, m.index) });
        if (FACT_KEY_RE.test(key)) content.push({ type: 'factRef', attrs: { factKey: key } });
        else content.push({ type: 'text', text: m[0] });
        last = m.index! + m[0].length;
      }
      if (last < p.length) content.push({ type: 'text', text: p.slice(last) });
      return { type: 'paragraph' as const, content };
    }),
  };
}
