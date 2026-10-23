import { z } from 'zod';

/**
 * ProseMirror/TipTap JSON subset we render. Kept closed (no arbitrary node types, no raw HTML):
 * rich text is stored as data and rendered by our components, so stored XSS has nowhere to live.
 * `factRef` is the Canon BOUND mention: rendered from the fact graph, never from stored text.
 */
const safeHref = z
  .string()
  .max(2048)
  .refine((h) => /^(https?:|mailto:|tel:|\/|#)/i.test(h), { message: 'Only http(s), mailto, tel, relative and anchor links are allowed' });

export const markSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }),
  z.object({ type: z.literal('italic') }),
  z.object({ type: z.literal('code') }),
  z.object({ type: z.literal('strike') }),
  z.object({ type: z.literal('link'), attrs: z.object({ href: safeHref, target: z.enum(['_blank', '_self']).optional() }) }),
]);
export type Mark = z.infer<typeof markSchema>;

export type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hardBreak' }
  | { type: 'factRef'; attrs: { factKey: string } };

export type RichBlockNode =
  | { type: 'paragraph'; content?: InlineNode[] }
  | { type: 'heading'; attrs: { level: 2 | 3 | 4 }; content?: InlineNode[] }
  | { type: 'bulletList' | 'orderedList'; content: { type: 'listItem'; content: RichBlockNode[] }[] }
  | { type: 'blockquote'; content: RichBlockNode[] };

export interface RichTextDoc {
  type: 'doc';
  content: RichBlockNode[];
}

export const FACT_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export const inlineSchema: z.ZodType<InlineNode> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(20_000), marks: z.array(markSchema).max(5).optional() }),
  z.object({ type: z.literal('hardBreak') }),
  z.object({ type: z.literal('factRef'), attrs: z.object({ factKey: z.string().regex(FACT_KEY_RE) }) }),
]);

export const richBlockSchema: z.ZodType<RichBlockNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('paragraph'), content: z.array(inlineSchema).max(500).optional() }),
    z.object({ type: z.literal('heading'), attrs: z.object({ level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }), content: z.array(inlineSchema).max(200).optional() }),
    z.object({
      type: z.enum(['bulletList', 'orderedList']),
      content: z.array(z.object({ type: z.literal('listItem'), content: z.array(richBlockSchema).max(20) })).max(200),
    }),
    z.object({ type: z.literal('blockquote'), content: z.array(richBlockSchema).max(50) }),
  ]),
) as z.ZodType<RichBlockNode>;

export const richTextSchema: z.ZodType<RichTextDoc> = z.object({ type: z.literal('doc'), content: z.array(richBlockSchema).max(500) });

export function emptyDoc(text = ''): RichTextDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] };
}

/** Plain text for search, SEO prompts and previews. Fact tokens render via the resolver when given. */
export function richTextToPlain(doc: RichTextDoc, facts: Readonly<Record<string, string>> = {}): string {
  const inline = (nodes: InlineNode[] = []) =>
    nodes.map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : (facts[n.attrs.factKey] ?? `{{fact:${n.attrs.factKey}}}`))).join('');
  const block = (b: RichBlockNode): string => {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        return inline(b.content);
      case 'bulletList':
      case 'orderedList':
        return b.content.map((li) => li.content.map(block).join('\n')).join('\n');
      case 'blockquote':
        return b.content.map(block).join('\n');
    }
  };
  return doc.content.map(block).join('\n\n');
}

/** Visits every text leaf so translation/rewrites can map strings 1:1 without touching structure or facts. */
export function mapRichText(doc: RichTextDoc, fn: (text: string) => string): RichTextDoc {
  const inline = (nodes?: InlineNode[]) => nodes?.map((n) => (n.type === 'text' ? { ...n, text: fn(n.text) } : n));
  const block = (b: RichBlockNode): RichBlockNode => {
    switch (b.type) {
      case 'paragraph':
        return { ...b, content: inline(b.content) };
      case 'heading':
        return { ...b, content: inline(b.content) };
      case 'bulletList':
      case 'orderedList':
        return { ...b, content: b.content.map((li) => ({ ...li, content: li.content.map(block) })) };
      case 'blockquote':
        return { ...b, content: b.content.map(block) };
    }
  };
  return { ...doc, content: doc.content.map(block) };
}

export function collectFactKeys(doc: RichTextDoc, into: Set<string> = new Set()): Set<string> {
  const visit = (nodes?: InlineNode[]) => nodes?.forEach((n) => n.type === 'factRef' && into.add(n.attrs.factKey));
  const block = (b: RichBlockNode): void => {
    if (b.type === 'paragraph' || b.type === 'heading') visit(b.content);
    else if (b.type === 'blockquote') b.content.forEach(block);
    else b.content.forEach((li) => li.content.forEach(block));
  };
  doc.content.forEach(block);
  return into;
}
