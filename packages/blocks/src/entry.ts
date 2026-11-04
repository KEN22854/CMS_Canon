import { ENTRY_LINK_TOKEN_RE, externalImageUrl, externalVideoUrl, MEDIA_LINK_PROPS } from './definitions';
import { mapRichText, richTextToPlain, type RichBlockNode, type RichTextDoc } from './rich-text';
import type { BlockNode, PageContent } from './tree';

/**
 * Entry pages and entry lists (CMS 2.0). A collection with a route serves every published entry
 * at `${basePath}/${slug}`, rendered with a template page whose texts carry `{{entry.field}}`
 * tokens. `bindEntry` fills them from the entry's published snapshot. The output is plain page
 * content: renderers stay unaware of collections, and values are text (React escapes them), so an
 * entry can't inject markup.
 */

/** `{{entry.title}}`, `{{entry.cover}}`… Field names follow the collections' FIELD_NAME_RE. */
export const ENTRY_TOKEN_RE = /\{\{\s*entry\.([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}/g;
const WHOLE_TOKEN_RE = /^\{\{\s*entry\.([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}$/;

/** What a template sees of an entry: its columns plus its data fields. */
export interface BoundEntry {
  title: string;
  slug: string;
  summary?: string | null;
  publishedAt?: string | Date | null;
  data: Record<string, unknown>;
}

const isDoc = (v: unknown): v is RichTextDoc => typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'doc' && Array.isArray((v as { content?: unknown }).content);

/** The raw value behind a token: entry columns win over data fields of the same name. */
function rawValue(e: BoundEntry, name: string): unknown {
  if (name === 'title') return e.title;
  if (name === 'slug') return e.slug;
  if (name === 'summary') return e.summary ?? '';
  if (name === 'publishedAt') return e.publishedAt ?? '';
  return e.data[name];
}

/** A value as text: dates as YYYY-MM-DD, lists joined, rich text as plain text, objects/relations empty. */
export function entryValueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(entryValueText).filter(Boolean).join(', ');
  if (isDoc(v)) return richTextToPlain(v);
  return '';
}

export function fillEntryTokens(text: string, e: BoundEntry): string {
  if (!text.includes('{{')) return text;
  return text.replace(ENTRY_TOKEN_RE, (_, name: string) => {
    const v = rawValue(e, name);
    // A media list in a single-media prop ("{{entry.gallery}}" as mediaId) takes the first one.
    return Array.isArray(v) && v.every((x) => typeof x === 'string') && WHOLE_TOKEN_RE.test(text) ? String(v[0] ?? '') : entryValueText(v);
  });
}

/** A paragraph that is exactly one token naming a rich text field becomes that field's blocks. */
function bindDoc(doc: RichTextDoc, e: BoundEntry): RichTextDoc {
  const content: RichBlockNode[] = [];
  for (const b of doc.content) {
    if (b.type === 'paragraph' && b.content?.length === 1 && b.content[0]!.type === 'text') {
      const m = WHOLE_TOKEN_RE.exec(b.content[0]!.text.trim());
      const v = m ? rawValue(e, m[1]!) : undefined;
      if (isDoc(v)) {
        content.push(...v.content);
        continue;
      }
    }
    content.push(b);
  }
  return mapRichText({ ...doc, content }, (t) => fillEntryTokens(t, e));
}

function bindValue(v: unknown, e: BoundEntry, key = ''): unknown {
  if (typeof v === 'string') {
    const out = fillEntryTokens(v, e);
    // A media link that came from an entry passes the same allowlist as one typed into the page.
    const kind = MEDIA_LINK_PROPS[key];
    if (kind && ENTRY_LINK_TOKEN_RE.test(v)) return (kind === 'image' ? externalImageUrl : externalVideoUrl).safeParse(out).success && !ENTRY_LINK_TOKEN_RE.test(out) ? out : '';
    return out;
  }
  if (isDoc(v)) return bindDoc(v, e);
  if (Array.isArray(v)) return v.map((x) => bindValue(x, e, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bindValue(x, e, k)]));
  return v;
}

/** The template page with every `{{entry.*}}` token in props (any depth) filled from the entry. */
export function bindEntry(content: PageContent, e: BoundEntry): PageContent {
  const walk = (n: BlockNode): BlockNode => ({ ...n, props: bindValue(n.props, e) as Record<string, unknown>, children: n.children.map(walk) });
  return { root: walk(content.root) };
}

/** Field names used as tokens anywhere in the tree (the template editor lists unknown ones). */
export function entryTokensIn(content: PageContent): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(ENTRY_TOKEN_RE)) out.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  const walk = (n: BlockNode) => {
    visit(n.props);
    n.children.forEach(walk);
  };
  walk(content.root);
  return [...out];
}

/** Public path of an entry under a collection route. */
export const entryPath = (basePath: string, slug: string) => `${basePath}/${slug}`;

// ── entry lists ─────────────────────────────────────────────────────────────

/** One card of a "Collection list" block, resolved by delivery from published snapshots. */
export interface ListItem {
  id: string;
  title: string;
  /** Entry page path when the collection has a route; otherwise the card is not a link. */
  path: string | null;
  text: string;
  mediaId: string | null;
  /** An external image (allow-listed host) when the image field holds a URL. */
  imageUrl: string | null;
  date: string | null;
}

export interface ListSpec {
  blockId: string;
  collection: string;
  limit: number;
  sort: 'newest' | 'oldest' | 'title';
  tag: string;
  imageField: string;
  textField: string;
}

/** Every Collection list block in a tree (after components are expanded). */
export function collectListSpecs(root: BlockNode): ListSpec[] {
  const out: ListSpec[] = [];
  const walk = (n: BlockNode) => {
    if (n.type === 'collection-list' && typeof n.props.collection === 'string' && n.props.collection) {
      const p = n.props;
      out.push({
        blockId: n.id,
        collection: p.collection as string,
        limit: Math.min(24, Math.max(1, Number(p.limit) || 6)),
        sort: p.sort === 'oldest' || p.sort === 'title' ? p.sort : 'newest',
        tag: typeof p.tag === 'string' ? p.tag : '',
        imageField: typeof p.imageField === 'string' ? p.imageField : '',
        textField: typeof p.textField === 'string' ? p.textField : '',
      });
    }
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** Card content from an entry: the named fields, or the first media field and the summary. */
export function listItemOf(
  e: BoundEntry & { id: string },
  fields: readonly { name: string; type: string }[],
  spec: Pick<ListSpec, 'imageField' | 'textField'>,
  path: string | null,
): ListItem {
  const imageName = spec.imageField || fields.find((f) => f.type === 'media' || /image|photo|cover/i.test(f.name))?.name;
  const textName = spec.textField || (e.summary ? 'summary' : fields.find((f) => f.type === 'textarea' || f.type === 'richtext')?.name);
  const img = imageName ? rawValue(e, imageName) : undefined;
  const first = Array.isArray(img) ? img[0] : img;
  const isUrl = typeof first === 'string' && /^https?:\/\//.test(first);
  // Image links from entries pass the same host allowlist as templates; other links are dropped.
  const safeUrl = isUrl && externalImageUrl.safeParse(first).success;
  const text = textName ? entryValueText(rawValue(e, textName)) : '';
  return {
    id: e.id,
    title: e.title,
    path,
    text: text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text,
    mediaId: typeof first === 'string' && first && !isUrl ? first : null,
    imageUrl: safeUrl ? (first as string) : null,
    date: e.publishedAt ? entryValueText(e.publishedAt) : null,
  };
}
