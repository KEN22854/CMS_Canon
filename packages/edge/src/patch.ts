/**
 * Variants and personalizations are *patches* over the published page, not copies of it: a few
 * block props change ("hero.title", "cta.buttonLabel") or a block is hidden. Canon facts, media
 * and every other block keep coming from the single published source of truth, so a fact change
 * reaches all variants at once.
 */
export type BlockPatch = Record<string, Record<string, unknown>>;

/** Special prop in a patch: `{ "__hidden": true }` removes the block from that variant. */
export const HIDDEN = '__hidden';

interface Node {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: Node[];
}

export function applyBlockPatch<T extends { root: Node }>(content: T, patch: BlockPatch | null | undefined): T {
  if (!patch || !Object.keys(patch).length) return content;
  const walk = (n: Node): Node | null => {
    const p = patch[n.id];
    if (p?.[HIDDEN] === true) return null;
    const children = n.children.map(walk).filter((c): c is Node => c !== null);
    if (!p) return children.length === n.children.length && children.every((c, i) => c === n.children[i]) ? n : { ...n, children };
    const { [HIDDEN]: _hidden, ...props } = p;
    return { ...n, props: { ...n.props, ...props }, children };
  };
  const root = walk(content.root);
  return { ...content, root: root ?? { ...content.root, children: [] } };
}

export function mergePatches(...patches: (BlockPatch | null | undefined)[]): BlockPatch {
  const out: BlockPatch = {};
  for (const p of patches) for (const [id, props] of Object.entries(p ?? {})) out[id] = { ...(out[id] ?? {}), ...props };
  return out;
}
