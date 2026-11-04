import { decodeEntities } from '@canon/blocks';

/**
 * WordPress eXtended RSS (the file Tools → Export produces). Read as text with a narrow
 * tag-by-tag reader — no DTDs, no entities from the file, no external references — so an export
 * can't make the parser fetch anything or blow up memory (XXE / billion laughs don't apply).
 */
export interface WxrItem {
  type: 'post' | 'page';
  title: string;
  slug: string;
  link: string;
  status: 'publish' | 'draft' | 'pending' | 'private' | 'future' | 'trash' | string;
  date: string | null;
  author: string;
  content: string;
  excerpt: string;
  categories: string[];
  tags: string[];
  /** Parent page id in WordPress (0 = top level). */
  parentId: number;
  id: number;
}

export interface WxrSite {
  title: string;
  link: string;
  items: WxrItem[];
  /** Attachments, menu items, revisions… counted, not imported. */
  skipped: Record<string, number>;
}

export const MAX_WXR_ITEMS = 2_000;

const cdata = (s: string) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name.replace(/[:.]/g, (c) => `\\${c}`)}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(/[:.]/g, (c) => `\\${c}`)}>`));
  if (!m) return '';
  const raw = m[1]!;
  return /^\s*<!\[CDATA\[/.test(raw) ? cdata(raw) : decodeEntities(raw.trim());
}

export function parseWxr(xml: string): WxrSite {
  if (!/<rss[\s>]/.test(xml) || !/xmlns:wp=/.test(xml)) throw new Error('Not a WordPress export (WXR) file');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Exports with a DOCTYPE are not accepted');
  const channel = xml.slice(0, xml.indexOf('<item>') >= 0 ? xml.indexOf('<item>') : xml.length);
  const items: WxrItem[] = [];
  const skipped: Record<string, number> = {};
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1]!;
    const type = tag(x, 'wp:post_type');
    if (type !== 'post' && type !== 'page') {
      skipped[type || 'unknown'] = (skipped[type || 'unknown'] ?? 0) + 1;
      continue;
    }
    if (items.length >= MAX_WXR_ITEMS) {
      skipped.overLimit = (skipped.overLimit ?? 0) + 1;
      continue;
    }
    const cats = [...x.matchAll(/<category\s+domain="(category|post_tag)"[^>]*>([\s\S]*?)<\/category>/g)];
    const date = tag(x, 'wp:post_date_gmt') || tag(x, 'wp:post_date');
    items.push({
      type,
      title: tag(x, 'title'),
      slug: tag(x, 'wp:post_name'),
      link: tag(x, 'link'),
      status: tag(x, 'wp:status'),
      date: date && !date.startsWith('0000') ? new Date(`${date.replace(' ', 'T')}Z`).toISOString() : null,
      author: tag(x, 'dc:creator'),
      content: tag(x, 'content:encoded'),
      excerpt: tag(x, 'excerpt:encoded'),
      categories: cats.filter((c) => c[1] === 'category').map((c) => cdata(c[2]!).trim()).filter(Boolean),
      tags: cats.filter((c) => c[1] === 'post_tag').map((c) => cdata(c[2]!).trim()).filter(Boolean),
      parentId: Number(tag(x, 'wp:post_parent')) || 0,
      id: Number(tag(x, 'wp:post_id')) || 0,
    });
  }
  return { title: tag(channel, 'title'), link: tag(channel, 'link'), items, skipped };
}
