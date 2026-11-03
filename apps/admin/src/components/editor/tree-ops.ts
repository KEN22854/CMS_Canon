import { FACT_KEY_RE, type InlineNode, type RichTextDoc } from '@canon/blocks';

/**
 * Tree edits live in @canon/blocks (shared with the API and Canon AI, with typed operations);
 * re-exported here for the editor code that imports them from this module.
 */
export {
  canContain,
  cloneWithIds,
  duplicateBlock,
  findNode,
  findParent,
  insertBlock,
  insertBlocks,
  insertNear,
  insertionPoint,
  isWithin,
  moveBlock,
  moveTo,
  newBlock,
  newId,
  outline,
  removeBlock,
  removeBlocks,
  replaceBlock,
  updateNodeMeta,
  updateProps,
  type NodeMeta,
  type OutlineItem,
} from '@canon/blocks';

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
