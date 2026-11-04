import type { InlineNode, Mark, RichBlockNode, RichTextDoc } from './rich-text';

/**
 * HTML from other systems (WordPress posts, Tilda/Webflow exports) → Canon rich text (Stage 17).
 * A small tolerant tokenizer, not a browser: the input is read as text, never executed. Only the
 * closed rich-text node set comes out — paragraphs, headings, lists, quotes, bold/italic/code/strike
 * and links with safe URLs; scripts, styles, forms, iframes and comments are dropped; images are
 * reported (their URLs) so the caller can import them separately.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', euro: '€' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

type Tok = { t: 'open'; name: string; attrs: Record<string, string> } | { t: 'close'; name: string } | { t: 'text'; v: string };

const DROP = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'button', 'select', 'textarea', 'svg', 'canvas', 'template', 'head', 'title']);
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area']);

function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let last = 0;
  let skip: string | null = null;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1]!.toLowerCase();
    const closing = m[0][1] === '/';
    if (skip) {
      if (closing && name === skip) {
        skip = null;
        last = re.lastIndex;
      }
      continue;
    }
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    last = re.lastIndex;
    if (DROP.has(name)) {
      if (!closing && !m[0].endsWith('/>')) skip = name;
      continue;
    }
    if (closing) out.push({ t: 'close', name });
    else {
      const attrs: Record<string, string> = {};
      for (const a of m[2]!.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      out.push({ t: 'open', name, attrs });
      if (VOID.has(name)) out.push({ t: 'close', name });
    }
  }
  if (!skip && last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

const SAFE_HREF = /^(https?:|mailto:|tel:|\/|#)/i;
const MARK_OF: Record<string, Mark['type']> = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', code: 'code', s: 'strike', del: 'strike', strike: 'strike' };
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'tr', 'hr', 'dl', 'dt', 'dd']);

interface Frame {
  kind: 'paragraph' | 'heading' | 'list' | 'item' | 'quote';
  level?: 2 | 3 | 4;
  ordered?: boolean;
  inline: InlineNode[];
  blocks: RichBlockNode[];
  items?: { type: 'listItem'; content: RichBlockNode[] }[];
}

export interface HtmlImport {
  doc: RichTextDoc;
  images: { src: string; alt: string }[];
  /** Plain text length — empty documents are worth reporting. */
  textLength: number;
}

/**
 * Converts HTML to a rich text document. WordPress "classic" content (no <p>, blank lines between
 * paragraphs) is handled like WordPress does: double newlines are paragraph breaks.
 */
export function htmlToRichText(html: string): HtmlImport {
  const looksClassic = !/<(p|div|h[1-6]|ul|ol|blockquote)[\s>]/i.test(html);
  const source = looksClassic ? html.split(/\n\s*\n/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('') : html;
  const images: HtmlImport['images'] = [];
  const root: Frame = { kind: 'quote', inline: [], blocks: [] };
  const stack: Frame[] = [root];
  const marks: Mark[] = [];
  let textLength = 0;
  const top = () => stack[stack.length - 1]!;

  // Inline content always lands in a paragraph-like frame; loose text gets an implicit paragraph.
  const inlineTarget = (): Frame => {
    const f = top();
    if (f.kind === 'paragraph' || f.kind === 'heading') return f;
    const p: Frame = { kind: 'paragraph', inline: [], blocks: [] };
    stack.push(p);
    return p;
  };
  const closeTo = (pred: (f: Frame) => boolean) => {
    while (stack.length > 1) {
      const f = stack.pop()!;
      emit(f);
      if (pred(f)) return;
    }
  };
  const flushInline = () => {
    const f = top();
    if (f.kind === 'paragraph' || f.kind === 'heading') {
      stack.pop();
      emit(f);
    }
  };
  function emit(f: Frame) {
    const parent = top();
    const inline = trimInline(f.inline);
    let node: RichBlockNode | null = null;
    if (f.kind === 'paragraph') node = inline.length ? { type: 'paragraph', content: inline } : null;
    else if (f.kind === 'heading') node = inline.length ? { type: 'heading', attrs: { level: f.level ?? 2 }, content: inline } : null;
    else if (f.kind === 'list') node = f.items?.length ? { type: f.ordered ? 'orderedList' : 'bulletList', content: f.items } : null;
    else if (f.kind === 'quote') node = f.blocks.length ? { type: 'blockquote', content: f.blocks } : null;
    else if (f.kind === 'item') {
      const content = f.blocks.length ? f.blocks : [];
      if (parent.kind === 'list' && content.length) parent.items!.push({ type: 'listItem', content });
      return;
    }
    if (node) parent.blocks.push(node);
  }

  for (const tok of tokenize(source)) {
    if (tok.t === 'text') {
      const v = decodeEntities(tok.v).replace(/\s+/g, ' ');
      if (!v.trim() && !(top().kind === 'paragraph' || top().kind === 'heading')) continue;
      const f = inlineTarget();
      textLength += v.trim().length;
      f.inline.push({ type: 'text', text: v, ...(marks.length ? { marks: dedupe(marks) } : {}) });
      continue;
    }
    const name = tok.name;
    if (tok.t === 'open') {
      if (name === 'br') inlineTarget().inline.push({ type: 'hardBreak' });
      else if (name === 'img') {
        if (tok.attrs.src) images.push({ src: tok.attrs.src, alt: tok.attrs.alt ?? '' });
      } else if (MARK_OF[name]) marks.push({ type: MARK_OF[name]! } as Mark);
      else if (name === 'a') {
        const href = (tok.attrs.href ?? '').trim();
        // javascript:, data: and other schemes become plain text.
        if (SAFE_HREF.test(href) && href.length <= 2048) marks.push({ type: 'link', attrs: { href } });
      } else if (/^h[1-6]$/.test(name)) {
        flushInline();
        const n = Number(name[1]);
        stack.push({ kind: 'heading', level: n <= 2 ? 2 : n === 3 ? 3 : 4, inline: [], blocks: [] });
      } else if (name === 'p' || name === 'div' || name === 'figcaption' || name === 'dt' || name === 'dd' || name === 'pre') {
        flushInline();
        stack.push({ kind: 'paragraph', inline: [], blocks: [] });
      } else if (name === 'ul' || name === 'ol') {
        flushInline();
        stack.push({ kind: 'list', ordered: name === 'ol', inline: [], blocks: [], items: [] });
      } else if (name === 'li') {
        flushInline();
        if (top().kind !== 'list') stack.push({ kind: 'list', ordered: false, inline: [], blocks: [], items: [] });
        stack.push({ kind: 'item', inline: [], blocks: [] });
      } else if (name === 'blockquote') {
        flushInline();
        stack.push({ kind: 'quote', inline: [], blocks: [] });
      } else if (BLOCKS.has(name)) flushInline();
    } else {
      if (MARK_OF[name]) {
        const i = marks.map((m) => m.type).lastIndexOf(MARK_OF[name]!);
        if (i >= 0) marks.splice(i, 1);
      } else if (name === 'a') {
        const i = marks.map((m) => m.type).lastIndexOf('link');
        if (i >= 0) marks.splice(i, 1);
      } else if (/^h[1-6]$/.test(name)) closeTo((f) => f.kind === 'heading');
      else if (name === 'p' || name === 'div' || name === 'figcaption' || name === 'dt' || name === 'dd' || name === 'pre') {
        if (top().kind === 'paragraph') closeTo((f) => f.kind === 'paragraph');
      } else if (name === 'li') {
        if (stack.some((f) => f.kind === 'item')) closeTo((f) => f.kind === 'item');
      } else if (name === 'ul' || name === 'ol') {
        if (stack.some((f) => f.kind === 'list')) closeTo((f) => f.kind === 'list');
      } else if (name === 'blockquote') {
        if (stack.length > 1 && stack.some((f, i) => i > 0 && f.kind === 'quote')) closeTo((f) => f.kind === 'quote');
      } else if (BLOCKS.has(name)) flushInline();
    }
  }
  closeTo(() => false);
  const content = root.blocks.slice(0, 500);
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph', content: [] }] }, images, textLength };
}

function dedupe(marks: Mark[]): Mark[] {
  const seen = new Set<string>();
  return marks.filter((m) => (seen.has(m.type) ? false : (seen.add(m.type), true))).slice(0, 5);
}

/** Trims spaces at the edges of a block and merges adjacent text with the same marks. */
function trimInline(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const n of nodes) {
    const prev = merged[merged.length - 1];
    if (n.type === 'text' && prev?.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) prev.text += n.text;
    else merged.push(n.type === 'text' ? { ...n } : n);
  }
  while (merged[0]?.type === 'hardBreak') merged.shift();
  while (merged[merged.length - 1]?.type === 'hardBreak') merged.pop();
  const first = merged[0];
  if (first?.type === 'text') first.text = first.text.replace(/^\s+/, '');
  const last = merged[merged.length - 1];
  if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '');
  return merged.filter((n) => n.type !== 'text' || n.text.length > 0).map((n) => (n.type === 'text' ? { ...n, text: n.text.slice(0, 20_000) } : n));
}
