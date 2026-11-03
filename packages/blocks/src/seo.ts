import { getBlock } from './definitions';
import { richTextToPlain, type RichTextDoc } from './rich-text';
import { collectTextFields, type BlockNode, type PageContent } from './tree';

/**
 * SEO audit (Stage 9): deterministic checks of one page against what search engines and people
 * need — titles, descriptions, headings, image alt texts, links, indexing, thin content. The API
 * runs it over every page of a site (with the cross-page context: other titles, existing paths);
 * the same function can run in the builder for a live hint. No network, no model.
 */

export type SeoSeverity = 'error' | 'warning' | 'info';

export type SeoIssueCode =
  | 'title-missing'
  | 'title-long'
  | 'title-short'
  | 'title-duplicate'
  | 'description-missing'
  | 'description-long'
  | 'description-short'
  | 'description-duplicate'
  | 'h1-missing'
  | 'h1-multiple'
  | 'heading-skip'
  | 'image-alt'
  | 'link-empty'
  | 'link-broken'
  | 'noindex'
  | 'thin-content'
  | 'og-image-missing'
  | 'slug-long';

export interface SeoIssue {
  code: SeoIssueCode;
  severity: SeoSeverity;
  /** Block the issue is about, when there is one (opens it in the builder). */
  blockId?: string;
  /** Extra detail: the duplicate title, the broken href, the counted value. */
  detail?: string;
}

export interface SeoPageInput {
  id: string;
  title: string;
  /** Public path (with the locale prefix for non-default locales). */
  path: string;
  description: string | null;
  seo: { title?: string; description?: string; noindex?: boolean; ogImageMediaId?: string };
  content: PageContent;
}

export interface SeoSiteContext {
  /** Public paths that resolve (published pages) plus redirect sources. */
  knownPaths: ReadonlySet<string>;
  /** Prefix redirects ("/blog" for a /blog/* rule): links below them resolve too. */
  knownPrefixes?: readonly string[];
  /** How many pages use each effective title / description (lower-cased). */
  titleCounts: ReadonlyMap<string, number>;
  descriptionCounts: ReadonlyMap<string, number>;
  /** Alt texts of media in the library (an image block falls back to them). */
  mediaAlt: Readonly<Record<string, string | null>>;
  /** The site has a default social image, so a page without one is fine. */
  defaultOgImage: boolean;
}

export const SEO_LIMITS = { titleMin: 15, titleMax: 60, descriptionMin: 50, descriptionMax: 160, minWords: 120, slugMax: 75 } as const;

const WEIGHT: Record<SeoSeverity, number> = { error: 15, warning: 6, info: 1 };

export const effectiveTitle = (p: Pick<SeoPageInput, 'title' | 'seo'>) => (p.seo.title || p.title).trim();
export const effectiveDescription = (p: Pick<SeoPageInput, 'description' | 'seo'>) => (p.seo.description || p.description || '').trim();

export function auditPage(page: SeoPageInput, site: SeoSiteContext): { issues: SeoIssue[]; score: number; words: number } {
  const issues: SeoIssue[] = [];
  const add = (code: SeoIssueCode, severity: SeoSeverity, extra: Omit<SeoIssue, 'code' | 'severity'> = {}) => issues.push({ code, severity, ...extra });

  const title = effectiveTitle(page);
  if (!title) add('title-missing', 'error');
  else {
    if (title.length > SEO_LIMITS.titleMax) add('title-long', 'warning', { detail: String(title.length) });
    if (title.length < SEO_LIMITS.titleMin) add('title-short', 'warning', { detail: String(title.length) });
    if ((site.titleCounts.get(title.toLowerCase()) ?? 0) > 1) add('title-duplicate', 'warning', { detail: title });
  }
  const description = effectiveDescription(page);
  if (!description) add('description-missing', 'warning');
  else {
    if (description.length > SEO_LIMITS.descriptionMax) add('description-long', 'info', { detail: String(description.length) });
    if (description.length < SEO_LIMITS.descriptionMin) add('description-short', 'info', { detail: String(description.length) });
    if ((site.descriptionCounts.get(description.toLowerCase()) ?? 0) > 1) add('description-duplicate', 'info', { detail: description.slice(0, 80) });
  }
  if (page.seo.noindex) add('noindex', 'info');
  if (!page.seo.ogImageMediaId && !site.defaultOgImage) add('og-image-missing', 'info');
  const slug = page.path.split('/').pop() ?? '';
  if (slug.length > SEO_LIMITS.slugMax) add('slug-long', 'info', { detail: String(slug.length) });

  // Headings in document order: heroes are the page's h1, heading blocks and rich-text headings.
  const headings: { level: number; blockId: string }[] = [];
  const links: { href: string; blockId: string }[] = [];
  const walk = (n: BlockNode) => {
    if (!n.hidden) {
      const p = n.props;
      if (n.type === 'hero' && typeof p.title === 'string' && p.title) headings.push({ level: 1, blockId: n.id });
      if (n.type === 'heading') headings.push({ level: Number(p.level) || 2, blockId: n.id });
      if (n.type === 'cta' && p.title) headings.push({ level: 2, blockId: n.id });
      const def = getBlock(n.type);
      for (const [k, f] of Object.entries(def?.fields ?? {})) {
        const v = p[k];
        if (f.kind === 'url' && typeof v === 'string' && labelled(n, k)) links.push({ href: v, blockId: n.id });
        if (f.kind === 'richtext' && v && typeof v === 'object') richWalk(v as RichTextDoc, n.id, headings, links);
      }
      if (n.type === 'image') {
        const mediaId = typeof p.mediaId === 'string' ? p.mediaId : '';
        const alt = (typeof p.alt === 'string' && p.alt.trim()) || (mediaId && site.mediaAlt[mediaId]?.trim());
        if (mediaId && !alt) add('image-alt', 'warning', { blockId: n.id });
      }
    }
    n.children.forEach(walk);
  };
  walk(page.content.root);

  const h1 = headings.filter((h) => h.level === 1);
  if (h1.length === 0) add('h1-missing', 'error');
  if (h1.length > 1) add('h1-multiple', 'warning', { blockId: h1[1]!.blockId, detail: String(h1.length) });
  for (let i = 1; i < headings.length; i++) {
    if (headings[i]!.level > headings[i - 1]!.level + 1) add('heading-skip', 'info', { blockId: headings[i]!.blockId, detail: `h${headings[i - 1]!.level} → h${headings[i]!.level}` });
  }
  for (const l of links) {
    const href = l.href.trim();
    if (!href || href === '#') add('link-empty', 'warning', { blockId: l.blockId });
    else if (href.startsWith('/') && !href.startsWith('//')) {
      const path = href.split(/[?#]/)[0]!.replace(/\/$/, '').toLowerCase() || '/';
      if (!site.knownPaths.has(path) && !site.knownPrefixes?.some((p) => path === p || path.startsWith(`${p}/`))) add('link-broken', 'error', { blockId: l.blockId, detail: href });
    }
  }

  const words = collectTextFields(page.content)
    .map((f) => (typeof f.value === 'string' ? f.value : richTextToPlain(f.value)))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  if (words < SEO_LIMITS.minWords) add('thin-content', 'info', { detail: String(words) });

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + WEIGHT[i.severity], 0));
  return { issues, score, words };
}

const MEDIA_FIELDS = new Set(['url', 'src', 'imageUrl', 'videoUrl', 'fileUrl']);

/** A link field counts only when its button actually shows (a CTA without a label renders no link). */
function labelled(n: BlockNode, field: string): boolean {
  const p = n.props;
  if (n.type === 'hero' && field === 'ctaHref') return Boolean(p.ctaLabel);
  if (n.type === 'cta' && field === 'buttonHref') return Boolean(p.buttonLabel);
  if (n.type === 'button' && field === 'href') return Boolean(p.label);
  // Video URLs are embeds and the stock-media fields are files, not links a visitor follows.
  return !MEDIA_FIELDS.has(field);
}

function richWalk(doc: RichTextDoc, blockId: string, headings: { level: number; blockId: string }[], links: { href: string; blockId: string }[]) {
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; attrs?: { level?: number }; marks?: { type: string; attrs?: { href?: string } }[]; content?: unknown[] };
    if (n.type === 'heading') headings.push({ level: n.attrs?.level ?? 2, blockId });
    for (const m of n.marks ?? []) if (m.type === 'link' && typeof m.attrs?.href === 'string') links.push({ href: m.attrs.href, blockId });
    n.content?.forEach(visit);
  };
  doc.content.forEach(visit);
}

// ── structured data ─────────────────────────────────────────────────────────

export interface StructuredDataInput {
  site: { name: string; url: string; logoUrl?: string | null; locale: string };
  page: { title: string; path: string; description?: string | null; content: PageContent; isHome: boolean };
  /** Ancestor pages for the breadcrumb, root first (without the home page). */
  breadcrumbs: { title: string; path: string }[];
}

/**
 * Schema.org JSON-LD for a published page: Organization and WebSite on the home page, a
 * BreadcrumbList below it, and an FAQPage when the page has visible FAQ blocks. Built only from
 * the page's own published content, so it never claims what the page doesn't show.
 */
export function structuredData({ site, page, breadcrumbs }: StructuredDataInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const abs = (path: string) => `${site.url}${path === '/' ? '' : path}`;
  if (page.isHome) {
    out.push({ '@context': 'https://schema.org', '@type': 'Organization', name: site.name, url: site.url, ...(site.logoUrl ? { logo: site.logoUrl } : {}) });
    out.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: site.url, inLanguage: site.locale });
  } else {
    const items = [{ title: site.name, path: '/' }, ...breadcrumbs, { title: page.title, path: page.path }];
    out.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.title, item: abs(b.path) })) });
  }
  const faqs: { q: string; a: string }[] = [];
  const walk = (n: BlockNode) => {
    if (n.hidden) return;
    if (n.type === 'faq' && Array.isArray(n.props.items)) for (const it of n.props.items as { q?: unknown; a?: unknown }[]) if (typeof it.q === 'string' && typeof it.a === 'string' && it.q && it.a) faqs.push({ q: it.q, a: it.a });
    n.children.forEach(walk);
  };
  walk(page.content.root);
  if (faqs.length) out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.slice(0, 50).map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  return out;
}

/** JSON for a <script type="application/ld+json">: "<" escaped so content can't close the tag. */
export function jsonLd(data: unknown): string {
  // "<" and the line/paragraph separators (valid JSON, but line ends in older JS parsers) as escapes.
  const escapes: Record<number, string> = { 60: "\\u003c", 8232: "\\u2028", 8233: "\\u2029" };
  return [...JSON.stringify(data)].map((ch) => escapes[ch.charCodeAt(0)] ?? ch).join("");
}
