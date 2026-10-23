import { collectTextFields, richTextToPlain, type BlockNode, type PageContent, type RichTextDoc } from '@canon/blocks';
import { TEXT_TYPES, valueToText, type EntryData, type FieldDef } from '@canon/fields';
import type { Section } from './chunker';

/** Blocks whose first text acts as a heading for what follows (until the next one). */
const HEADING_BLOCKS: Record<string, string> = { heading: 'text', hero: 'title', cta: 'title', features: 'title', faq: 'title' };

/**
 * One section per block, in reading order. BOUND fact tokens are rendered with current values,
 * so the index answers "how much is Pro?" with today's price — and re-indexing on FactChanged
 * keeps it that way.
 */
export function pageSections(title: string, content: PageContent, facts: Readonly<Record<string, string>>): Section[] {
  const typeOf = new Map<string, string>();
  const walk = (n: BlockNode) => (typeOf.set(n.id, n.type), n.children.forEach(walk));
  walk(content.root);

  const byBlock = new Map<string, string[]>();
  const order: string[] = [];
  for (const f of collectTextFields(content)) {
    const text = f.kind === 'rich' ? richTextToPlain(f.value as RichTextDoc, facts) : (f.value as string);
    if (!text.trim()) continue;
    if (!byBlock.has(f.blockId)) (byBlock.set(f.blockId, []), order.push(f.blockId));
    byBlock.get(f.blockId)!.push(text.trim());
  }

  let heading = title;
  const sections: Section[] = [];
  for (const blockId of order) {
    const texts = byBlock.get(blockId)!;
    const type = typeOf.get(blockId) ?? '';
    if (HEADING_BLOCKS[type]) heading = texts[0]!.slice(0, 160);
    sections.push({ heading, text: texts.join('\n'), anchor: blockId });
  }
  return sections;
}

export function entrySections(title: string, fields: readonly FieldDef[], data: EntryData, facts: Readonly<Record<string, string>>): Section[] {
  const sections: Section[] = [];
  const meta: string[] = [];
  for (const f of fields) {
    if (!f.ai || f.type === 'media' || f.type === 'relation' || f.type === 'json') continue;
    const v = data[f.name];
    const text = f.type === 'richtext' && v && typeof v === 'object' ? richTextToPlain(v as RichTextDoc, facts) : valueToText(f, v);
    if (!text.trim()) continue;
    // Long text fields stand alone; short scalars (price, category, date) read best together.
    if (TEXT_TYPES.has(f.type) && text.length > 120) sections.push({ heading: `${title} — ${f.label}`, text, anchor: f.name });
    else meta.push(`${f.label}: ${text}`);
  }
  if (meta.length) sections.unshift({ heading: title, text: meta.join('\n'), anchor: 'fields' });
  return sections;
}
