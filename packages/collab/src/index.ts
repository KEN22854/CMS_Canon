import * as Y from 'yjs';

/**
 * A page draft as a Yjs document, shared by the collaboration server and the builder.
 *
 *   meta:   Y.Map  title, slug, description, seo, root (block id), saved {version, hash, by}
 *   blocks: Y.Map  blockId → Y.Map { type, props: Y.Map<prop → JSON value>, children: Y.Array<id> }
 *
 * Granularity is the block *prop*: two people editing a hero's title and its button at the same
 * time both win; the same prop is last-writer-wins. Rich text is one prop value (a TipTap JSON
 * doc), so concurrent edits of the *same* text block resolve per field, not per character —
 * a deliberate trade for a model the existing renderer, validators and Canon all understand.
 */
export interface DraftNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: DraftNode[];
}

export interface CollabDraft {
  title: string;
  slug: string;
  description: string;
  seo: Record<string, unknown>;
  content: { root: DraftNode };
}

export const META_KEYS = ['title', 'slug', 'description', 'seo'] as const;
export const LOCAL = 'local';

const json = (v: unknown) => JSON.stringify(v ?? null);
const same = (a: unknown, b: unknown) => json(a) === json(b);

export function isInitialized(doc: Y.Doc): boolean {
  return typeof doc.getMap('meta').get('root') === 'string';
}

function blockMap(n: DraftNode): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('type', n.type);
  const props = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(n.props)) props.set(k, v);
  m.set('props', props);
  const children = new Y.Array<string>();
  children.push(n.children.map((c) => c.id));
  m.set('children', children);
  return m;
}

function flatten(root: DraftNode): Map<string, DraftNode> {
  const out = new Map<string, DraftNode>();
  const walk = (n: DraftNode) => (out.set(n.id, n), n.children.forEach(walk));
  walk(root);
  return out;
}

/** Fills an empty document from a draft (the first editor to join seeds the room). */
export function draftToYDoc(doc: Y.Doc, draft: CollabDraft, origin: unknown = LOCAL): void {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    for (const k of META_KEYS) meta.set(k, draft[k]);
    blocks.clear();
    for (const n of flatten(draft.content.root).values()) blocks.set(n.id, blockMap(n));
    meta.set('root', draft.content.root.id);
  }, origin);
}

/**
 * Rebuilds the draft. Concurrent moves can leave a block listed under two parents or under
 * none; the walk keeps the first occurrence and drops unreachable blocks, so the result is
 * always a valid tree.
 */
export function yDocToDraft(doc: Y.Doc): CollabDraft | null {
  const meta = doc.getMap('meta');
  const rootId = meta.get('root');
  if (typeof rootId !== 'string') return null;
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const seen = new Set<string>();
  const build = (id: string, depth: number): DraftNode | null => {
    const m = blocks.get(id);
    if (!m || seen.has(id) || depth > 12) return null;
    seen.add(id);
    const props = (m.get('props') as Y.Map<unknown> | undefined)?.toJSON() ?? {};
    const childIds = (m.get('children') as Y.Array<string> | undefined)?.toArray() ?? [];
    return { id, type: String(m.get('type')), props: props as Record<string, unknown>, children: childIds.map((c) => build(c, depth + 1)).filter((c): c is DraftNode => c !== null) };
  };
  const root = build(rootId, 0);
  if (!root) return null;
  return {
    title: String(meta.get('title') ?? ''),
    slug: String(meta.get('slug') ?? ''),
    description: String(meta.get('description') ?? ''),
    seo: (meta.get('seo') as Record<string, unknown>) ?? {},
    content: { root },
  };
}

/**
 * Applies a local edit as the smallest Yjs change: only changed meta keys, props and child
 * lists are touched, so a concurrent edit elsewhere in the page is never overwritten.
 */
export function applyDraftDiff(doc: Y.Doc, prev: CollabDraft, next: CollabDraft, origin: unknown = LOCAL): void {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    for (const k of META_KEYS) if (!same(prev[k], next[k])) meta.set(k, next[k]);
    if (prev.content.root.id !== next.content.root.id) meta.set('root', next.content.root.id);
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const before = flatten(prev.content.root);
    const after = flatten(next.content.root);
    for (const id of before.keys()) if (!after.has(id)) blocks.delete(id);
    for (const [id, n] of after) {
      const old = before.get(id);
      const m = blocks.get(id);
      if (!old || !m) {
        blocks.set(id, blockMap(n));
        continue;
      }
      if (old.type !== n.type) m.set('type', n.type);
      const props = m.get('props') as Y.Map<unknown>;
      for (const k of Object.keys(old.props)) if (!(k in n.props)) props.delete(k);
      for (const [k, v] of Object.entries(n.props)) if (!same(old.props[k], v)) props.set(k, v);
      const oldIds = old.children.map((c) => c.id);
      const newIds = n.children.map((c) => c.id);
      if (!same(oldIds, newIds)) {
        const arr = m.get('children') as Y.Array<string>;
        arr.delete(0, arr.length);
        arr.push(newIds);
      }
    }
  }, origin);
}

/** Key-order independent JSON: Y.Map and plain objects enumerate keys differently. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** FNV-1a of the draft JSON: "is my draft what the leader just saved?" without shipping it. */
export function draftHash(d: CollabDraft): string {
  const s = stable([d.title, d.slug, d.description, d.seo, d.content]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export interface SavedMarker {
  version: number;
  hash: string;
  by: string;
}

export { Y };
