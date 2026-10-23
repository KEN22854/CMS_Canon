import { collectFactKeys, collectTextFields, richTextToPlain, type BlockNode, type InlineNode, type PageContent, type RichBlockNode, type RichTextDoc } from '@canon/blocks';
import { collectionFieldsSchema, TEXT_TYPES, type EntryData } from '@canon/fields';
import { Injectable } from '@nestjs/common';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';

export type TargetType = 'PAGE' | 'ENTRY';

/** One editable text in a page block or entry field — the unit mentions point into. */
export interface TargetField {
  /** Page: "<prop>" or "<prop>[i].<itemProp>" (with blockId); entry: the field name. */
  fieldPath: string;
  blockId: string | null;
  kind: 'plain' | 'rich';
  value: string | RichTextDoc;
  label: string;
}

export interface ContentTarget {
  type: TargetType;
  id: string;
  tenantId: string;
  siteId: string;
  collectionId: string | null;
  locale: string;
  title: string;
  path: string;
  version: number;
  publishedVersion: number | null;
  fields: TargetField[];
  /** The raw draft: page content or entry data (what a branch change patches). */
  draft: PageContent | EntryData;
}

/** Plain text of a rich field with fact tokens blanked: BOUND mentions must not be "detected" again. */
const BLANK_FACTS = new Proxy({}, { get: () => '' }) as Record<string, string>;
export function plainOf(f: Pick<TargetField, 'kind' | 'value'>): string {
  return f.kind === 'rich' ? richTextToPlain(f.value as RichTextDoc, BLANK_FACTS) : (f.value as string);
}

export function boundKeys(f: Pick<TargetField, 'kind' | 'value'>): string[] {
  return f.kind === 'rich' ? [...collectFactKeys(f.value as RichTextDoc)] : [];
}

/**
 * Loads drafts on the system role — Canon workers run outside a request — always pinned to the
 * job's tenantId, and writes go back through Pages/EntriesService (RLS, CAS, audit, outbox).
 */
@Injectable()
export class ContentTargets {
  constructor(private readonly system: SystemPrismaService) {}

  async load(tenantId: string, type: TargetType, id: string): Promise<ContentTarget | null> {
    if (type === 'PAGE') {
      const p = await this.system.page.findFirst({ where: { id, tenantId, deletedAt: null } });
      if (!p) return null;
      const content = p.content as unknown as PageContent;
      const fields = collectTextFields(content).map((f) => ({
        fieldPath: f.item ? `${f.prop}[${f.item.index}].${f.item.prop}` : f.prop,
        blockId: f.blockId,
        kind: f.kind,
        value: f.value,
        label: f.item ? `${f.prop} #${f.item.index + 1} ${f.item.prop}` : f.prop,
      }));
      return { type, id, tenantId, siteId: p.siteId, collectionId: null, locale: p.locale, title: p.title, path: p.fullPath, version: p.version, publishedVersion: p.publishedVersion, fields, draft: content };
    }
    const e = await this.system.entry.findFirst({ where: { id, tenantId, deletedAt: null }, include: { collection: { select: { siteId: true, slug: true, schema: true } } } });
    if (!e) return null;
    const defs = collectionFieldsSchema.safeParse(e.collection.schema);
    const data = e.data as EntryData;
    const fields: TargetField[] = (defs.success ? defs.data : [])
      .filter((f) => TEXT_TYPES.has(f.type) && !f.multiple && data[f.name] !== undefined)
      .map((f) => ({ fieldPath: f.name, blockId: null, kind: f.type === 'richtext' ? 'rich' : 'plain', value: data[f.name] as string | RichTextDoc, label: f.label }));
    return { type, id, tenantId, siteId: e.collection.siteId, collectionId: e.collectionId, locale: e.locale, title: e.title, path: `/${e.collection.slug}/${e.slug}`, version: e.version, publishedVersion: e.publishedVersion, fields, draft: data };
  }
}

/** Returns a new draft with one field replaced (pages: inside the block's props; entries: data key). */
export function withField(t: Pick<ContentTarget, 'type' | 'draft'>, blockId: string | null, fieldPath: string, value: string | RichTextDoc): PageContent | EntryData {
  if (t.type === 'ENTRY') return { ...(t.draft as EntryData), [fieldPath]: value };
  const m = /^(\w+)(?:\[(\d+)\]\.(\w+))?$/.exec(fieldPath);
  if (!m) throw new Error(`Bad field path ${fieldPath}`);
  const [, prop, idx, itemProp] = m;
  const walk = (n: BlockNode): BlockNode => {
    if (n.id !== blockId) return { ...n, children: n.children.map(walk) };
    if (idx === undefined) return { ...n, props: { ...n.props, [prop!]: value } };
    const list = Array.isArray(n.props[prop!]) ? [...(n.props[prop!] as Record<string, unknown>[])] : [];
    list[Number(idx)] = { ...(list[Number(idx)] ?? {}), [itemProp!]: value };
    return { ...n, props: { ...n.props, [prop!]: list } };
  };
  return { root: walk((t.draft as PageContent).root) };
}

/**
 * Replaces the first occurrence of `span` in a field. In rich text the span must sit inside one
 * text leaf (one set of marks); a span that crosses formatting returns null so the change is
 * escalated to a human instead of silently dropping bold/links.
 */
export function replaceSpan(f: Pick<TargetField, 'kind' | 'value'>, span: string, replacement: string | InlineNode): string | RichTextDoc | null {
  if (f.kind === 'plain') {
    const s = f.value as string;
    const i = s.indexOf(span);
    if (i < 0 || typeof replacement !== 'string') return null;
    return s.slice(0, i) + replacement + s.slice(i + span.length);
  }
  let done = false;
  const inline = (nodes: InlineNode[] | undefined): InlineNode[] | undefined =>
    nodes?.flatMap((n): InlineNode[] => {
      if (done || n.type !== 'text') return [n];
      const i = n.text.indexOf(span);
      if (i < 0) return [n];
      done = true;
      const pre = n.text.slice(0, i);
      const post = n.text.slice(i + span.length);
      // Text stays one leaf (same marks); only a token (factRef) splits it.
      if (typeof replacement === 'string') {
        const text = pre + replacement + post;
        return text ? [{ ...n, text }] : [];
      }
      return [...(pre ? [{ ...n, text: pre }] : []), replacement, ...(post ? [{ ...n, text: post }] : [])];
    });
  const block = (b: RichBlockNode): RichBlockNode => {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        return { ...b, content: inline(b.content) } as RichBlockNode;
      case 'bulletList':
      case 'orderedList':
        return { ...b, content: b.content.map((li) => ({ ...li, content: li.content.map(block) })) };
      case 'blockquote':
        return { ...b, content: b.content.map(block) };
    }
  };
  const doc = f.value as RichTextDoc;
  const next = { ...doc, content: doc.content.map(block) };
  return done ? next : null;
}

/** ±N chars of plain context around a span (what the copywriter sees). */
export function contextAround(text: string, span: string, chars = 160): { before: string; after: string } {
  const i = text.indexOf(span);
  if (i < 0) return { before: '', after: '' };
  return { before: text.slice(Math.max(0, i - chars), i), after: text.slice(i + span.length, i + span.length + chars) };
}
