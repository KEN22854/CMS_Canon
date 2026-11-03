#!/usr/bin/env node
/**
 * Converts open-source (MIT) Tailwind section templates into Canon block trees.
 *
 *   node packages/blocks/scripts/import-vendor-templates.cjs <download-dir>
 *
 * <download-dir> holds `tailblocks/` (github.com/mertJF/tailblocks: src/blocks/<category>/<light|dark>/<x>.js)
 * and `hyperui/` (github.com/markmead/hyperui: public/examples/marketing/<category>/<n>[-dark].html),
 * each with its LICENSE. The files are only read as text — nothing from them is executed.
 *
 * The markup is mapped to regular Canon blocks (section, group, heading, text, button, image,
 * form) and Tailwind classes to the style layer (desktop-first: the largest breakpoint becomes the
 * base, the mobile value an override). Texts become placeholders filled per locale when inserted;
 * accent colours become the site's primary colour. Every tree is validated with the same
 * `validatePageContent` the API uses; anything that doesn't validate is left out and reported.
 * Output: src/vendor/sections-data.ts (generated) and the licences next to it.
 */
const fs = require('fs');
const path = require('path');
const { validatePageContent, isValidStyleValue } = require('../dist/index.js');

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: import-vendor-templates.cjs <download-dir>');
  process.exit(1);
}
const OUT_DIR = path.join(__dirname, '..', 'src', 'vendor');

// ── tiny markup parser (well-formed template markup only) ────────────────────

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop', 'wbr']);

function parse(markup) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<\/?([a-zA-Z][\w.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(markup))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      const text = m[4];
      if (text.trim()) top.children.push({ text });
      else if (text.length) top.children.push({ text: ' ' });
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) {
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs = {};
    const ar = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(m[2] || ''))) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? (a[5] !== undefined ? `{${a[5]}}` : a[6] ?? '');
    const el = { tag, attrs, children: [] };
    top.children.push(el);
    if (!m[3] && !VOID.has(tag)) stack.push(el);
  }
  return root;
}

/** Tailblocks are React components: keep the returned JSX and make it plain markup. */
function jsxToMarkup(src) {
  const start = src.indexOf('return (');
  const end = src.lastIndexOf(');\n}');
  let jsx = start >= 0 && end > start ? src.slice(start + 'return ('.length, end) : src;
  jsx = jsx
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/className=\{`([^`]*)`\}/g, (_, c) => `class="${c.replace(/\$\{props\.theme\}/g, 'indigo')}"`)
    .replace(/className="/g, 'class="')
    .replace(/\{"\s*"\}/g, ' ')
    .replace(/\{\s*'[^']*'\s*\}/g, ' ');
  return jsx;
}

function htmlBody(src) {
  const m = src.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (m ? m[1] : src).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

// ── Tailwind → style layer ───────────────────────────────────────────────────

const SPACE = (n) => (n === 'px' ? 1 : Math.round(Number(n) * 4));
const FONT = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
const WEIGHT = { thin: 300, extralight: 300, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
const LEADING = { none: '1', tight: '1.25', snug: '1.375', normal: '1.5', relaxed: '1.625', loose: '2' };
const TRACKING = { tighter: '-0.05em', tight: '-0.025em', normal: '0em', wide: '0.025em', wider: '0.05em', widest: '0.1em' };
const MAXW = { xs: 320, sm: 384, md: 448, lg: 512, xl: 576, '2xl': 672, '3xl': 768, '4xl': 896, '5xl': 1024, '6xl': 1152, '7xl': 1280, prose: 680, screen: 1280 };
const RADIUS = { '': 4, sm: 2, md: 6, lg: 8, xl: 12, '2xl': 16, '3xl': 24, full: 9999 };
const SHADOW = {
  'shadow-xs': '0 1px 2px 0 rgba(0,0,0,0.05)',
  'shadow-sm': '0 1px 3px 0 rgba(0,0,0,0.1)',
  shadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)',
  'shadow-md': '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
  'shadow-lg': '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
  'shadow-xl': '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
  'shadow-2xl': '0 25px 50px -12px rgba(0,0,0,0.25)',
};
const GRAY = {
  50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712',
};
const NEUTRALS = new Set(['gray', 'slate', 'zinc', 'neutral', 'stone']);
const ACCENTS = new Set(['indigo', 'blue', 'teal', 'emerald', 'green', 'rose', 'red', 'pink', 'purple', 'violet', 'fuchsia', 'orange', 'amber', 'yellow', 'sky', 'cyan', 'lime']);

function colour(token) {
  if (token === 'white') return '#ffffff';
  if (token === 'black') return '#000000';
  if (token === 'transparent') return 'transparent';
  const m = token.match(/^([a-z]+)-(\d{2,3})(?:\/(\d+))?$/);
  if (!m) return null;
  const [, fam, shade, alpha] = m;
  let hex = null;
  if (NEUTRALS.has(fam)) hex = GRAY[shade] ?? null;
  // Accents follow the site's theme: light tints become the muted colour, the rest the primary.
  else if (ACCENTS.has(fam)) return Number(shade) <= 200 ? 'token:muted' : 'token:primary';
  if (!hex) return null;
  if (alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${Number(alpha) / 100})`;
  }
  return hex;
}

const BPS = ['', 'sm', 'md', 'lg', 'xl', '2xl'];

/**
 * Class list → { prop: { bp: value } } with bp in '', sm, md, lg, xl. `dark` variants count as
 * plain classes in dark templates and are ignored in light ones; hover/focus/group states are ignored.
 */
function classProps(classList, dark) {
  const out = {};
  const set = (prop, bp, v) => {
    if (v === null || v === undefined) return;
    (out[prop] ??= {})[bp] = v;
  };
  for (const raw of (classList || '').split(/\s+/).filter(Boolean)) {
    const parts = raw.split(':');
    const cls = parts.pop();
    let bp = '';
    let skip = false;
    for (const pre of parts) {
      if (pre === 'dark') {
        if (!dark) skip = true;
      } else if (BPS.includes(pre)) bp = pre;
      else skip = true; // hover:, focus:, group-hover:, rtl:, …
    }
    if (skip) continue;
    let m;
    if ((m = cls.match(/^text-(xs|sm|base|lg|xl|[2-9]xl)(?:\/(tight|snug|normal|relaxed|loose|none|\d+))?$/))) {
      set('fontSize', bp, `${FONT[m[1]]}px`);
      if (m[2]) set('lineHeight', bp, LEADING[m[2]] ?? (Number(m[2]) ? `${Number(m[2]) * 4}px` : null));
    } else if ((m = cls.match(/^text-(left|center|right|justify)$/))) set('textAlign', bp, m[1]);
    else if ((m = cls.match(/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/))) set('fontWeight', bp, String(WEIGHT[m[1]]));
    else if ((m = cls.match(/^leading-(none|tight|snug|normal|relaxed|loose)$/))) set('lineHeight', bp, LEADING[m[1]]);
    else if ((m = cls.match(/^tracking-(tighter|tight|normal|wide|wider|widest)$/))) set('letterSpacing', bp, TRACKING[m[1]]);
    else if (cls === 'uppercase' || cls === 'lowercase' || cls === 'capitalize') set('textTransform', bp, cls);
    else if ((m = cls.match(/^text-([a-z]+(?:-\d{2,3})?(?:\/\d+)?)$/))) set('color', bp, colour(m[1]));
    else if ((m = cls.match(/^bg-([a-z]+(?:-\d{2,3})?(?:\/\d+)?)$/))) set('backgroundColor', bp, colour(m[1]));
    else if ((m = cls.match(/^p([trblxy]?)-(\d+(?:\.5)?|px)$/))) {
      const v = `${SPACE(m[2])}px`;
      const sides = { '': ['Top', 'Right', 'Bottom', 'Left'], x: ['Left', 'Right'], y: ['Top', 'Bottom'], t: ['Top'], r: ['Right'], b: ['Bottom'], l: ['Left'] }[m[1]];
      for (const s of sides) set(`padding${s}`, bp, v);
    } else if ((m = cls.match(/^m([tb])-(\d+(?:\.5)?|px)$/))) set(m[1] === 't' ? 'marginTop' : 'marginBottom', bp, `${SPACE(m[2])}px`);
    else if ((m = cls.match(/^my-(\d+(?:\.5)?)$/))) {
      set('marginTop', bp, `${SPACE(m[1])}px`);
      set('marginBottom', bp, `${SPACE(m[1])}px`);
    }
    else if ((m = cls.match(/^gap(?:-x)?-(\d+(?:\.5)?)$/))) set('gap', bp, `${SPACE(m[1])}px`);
    else if ((m = cls.match(/^max-w-(xs|sm|md|lg|xl|[2-7]xl|prose|screen-\w+)$/))) set('maxWidth', bp, `${MAXW[m[1].replace(/^screen-\w+$/, 'screen')]}px`);
    else if ((m = cls.match(/^w-(\d+)\/(\d+)$/))) set('widthFraction', bp, Number(m[1]) / Number(m[2]));
    else if (cls === 'w-full') set('widthFraction', bp, 1);
    else if ((m = cls.match(/^(?:size|h)-(\d+)$/))) set('height', bp, `${SPACE(m[1])}px`);
    else if ((m = cls.match(/^rounded(?:-(sm|md|lg|xl|2xl|3xl|full))?$/))) set('borderRadius', bp, `${RADIUS[m[1] ?? '']}px`);
    else if (SHADOW[cls]) set('boxShadow', bp, SHADOW[cls]);
    else if ((m = cls.match(/^border(?:-(\d))?$/))) {
      set('borderWidth', bp, `${m[1] ?? 1}px`);
      set('borderStyle', bp, 'solid');
    }
    else if ((m = cls.match(/^border-([a-z]+-\d{2,3}(?:\/\d+)?|white|black)$/))) set('borderColor', bp, colour(m[1]));
    else if ((m = cls.match(/^opacity-(\d+)$/))) set('opacity', bp, String(Number(m[1]) / 100));
    else if (cls === 'hidden') set('display', bp, 'none');
    else if (cls === 'block' || cls === 'flex' || cls === 'grid' || cls === 'inline-flex' || cls === 'inline-block') set('displayKind', bp, cls);
    else if (cls === 'flex-col' || cls === 'flex-row' || cls === 'flex-col-reverse' || cls === 'flex-row-reverse') set('flexDirection', bp, cls.replace('flex-', '').replace('col', 'column'));
    else if (cls === 'flex-wrap') set('wrap', bp, true);
    else if ((m = cls.match(/^grid-cols-(\d+)$/))) set('gridCols', bp, Number(m[1]));
    else if ((m = cls.match(/^col-span-(\d+)$/))) set('gridColumn', bp, `span ${m[1]}`);
    else if ((m = cls.match(/^items-(start|center|end|stretch|baseline)$/))) set('alignItems', bp, { start: 'flex-start', end: 'flex-end' }[m[1]] ?? m[1]);
    else if ((m = cls.match(/^justify-(start|center|end|between|around|evenly)$/))) set('justifyContent', bp, { start: 'flex-start', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' }[m[1]]);
    else if (cls === 'mx-auto') set('centred', bp, true);
  }
  return out;
}

/** The desktop value (largest breakpoint) and, when the unprefixed one differs, the mobile one. */
const desk = (o) => (o ? (o['2xl'] ?? o.xl ?? o.lg ?? o.md ?? o.sm ?? o['']) : undefined);
const mobile = (o) => (o && o[''] !== undefined && o[''] !== desk(o) ? o[''] : undefined);

const STYLE_KEYS = ['fontSize', 'textAlign', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color', 'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'gap', 'maxWidth', 'borderRadius', 'boxShadow', 'borderWidth', 'borderStyle', 'borderColor', 'opacity', 'gridColumn'];

function stylesFrom(props, only = STYLE_KEYS) {
  const base = {};
  const mob = {};
  for (const k of only) {
    const d = desk(props[k]);
    const mo = mobile(props[k]);
    if (d !== undefined && isValidStyleValue(k, d)) base[k] = d;
    if (mo !== undefined && isValidStyleValue(k, mo)) mob[k] = mo;
  }
  // "hidden md:block": shown on desktop, hidden on phones.
  if (props.display) {
    const d = desk(props.display) ?? (desk(props.displayKind) ? 'block' : undefined);
    if (props.display[''] === 'none' && d !== 'none' && (props.displayKind?.md || props.displayKind?.sm || props.displayKind?.lg)) mob.display = 'none';
    else if (desk(props.display) === 'none') return null; // hidden everywhere (screen-reader text, decorations)
  }
  const out = {};
  if (Object.keys(base).length) out.base = base;
  if (Object.keys(mob).length) out.mobileL = mob;
  return Object.keys(out).length ? out : undefined;
}

const VISUAL = ['backgroundColor', 'borderWidth', 'boxShadow', 'borderRadius'];
const hasVisual = (props) => VISUAL.some((k) => desk(props[k]) !== undefined) || ['paddingTop', 'paddingLeft'].some((k) => desk(props[k]) !== undefined && parseInt(desk(props[k]), 10) >= 16 && VISUAL.some((v) => desk(props[v]) !== undefined));

// ── markup → blocks ──────────────────────────────────────────────────────────

let idSeq = 0;
const nid = () => `v${(++idSeq).toString(36)}`;
const textOf = (n) => (n.text !== undefined ? n.text : n.tag === 'svg' || n.tag === 'script' || n.tag === 'style' ? '' : n.tag === 'br' ? '\n' : n.children.map(textOf).join('')).replace(/[ \t\r\f\v]+/g, ' ');
const clean = (t) => t.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
const isPrice = (t) => /^[$€£₽]?\s?\d[\d.,]*\s?(k|K|M|%|\+)?(\/\w+)?$|^\d+[+%]?$|^Free$/i.test(t);

/** Placeholder text roles, filled per locale when the section is inserted. */
function placeholder(role, original) {
  const t = clean(original);
  if (!t) return '';
  if (isPrice(t)) return t;
  return `[[${role}]]`;
}

const SKIP = new Set(['svg', 'script', 'style', 'template', 'noscript', 'iframe', 'select', 'option', 'label', 'input', 'textarea', 'head', 'meta', 'link', 'title']);
const TEXTY = new Set(['p', 'span', 'small', 'strong', 'em', 'b', 'i', 'blockquote', 'dt', 'dd', 'time', 'cite', 'figcaption', 'address', 'sup']);
const BLOCKY = new Set(['div', 'section', 'header', 'footer', 'main', 'article', 'aside', 'figure', 'nav', 'ul', 'ol', 'li', 'dl', 'details', 'summary', 'form', 'fieldset', 'table', 'tbody', 'tr', 'td', 'th', 'a', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'p', 'blockquote']);
const hasBlockChildren = (n) => n.children.some((c) => c.tag && (BLOCKY.has(c.tag) && c.tag !== 'p' ? true : c.tag === 'p' || hasBlockChildren(c)));

function imageSrc(src, file, index) {
  if (!src) return '';
  const dummy = src.match(/dummyimage\.com\/(\d+)x(\d+)/);
  if (dummy) {
    const w = Math.min(1600, Number(dummy[1]));
    const h = Math.min(1600, Number(dummy[2]));
    return `https://picsum.photos/seed/canon-${file.replace(/[^a-z0-9]+/gi, '-')}-${index}/${w}/${h}`;
  }
  if (/^https:\/\/images\.unsplash\.com\//.test(src)) return src.replace(/&amp;/g, '&');
  return '';
}

function convert(n, ctx, depth) {
  if (n.text !== undefined) {
    const t = clean(n.text);
    return t ? [{ id: nid(), type: 'text', props: { doc: doc([placeholder(ctx.inLink ? 'btn' : 'p', t)]), align: 'left' }, children: [] }] : [];
  }
  if (SKIP.has(n.tag)) return [];
  const cls = classProps(n.attrs.class, ctx.dark);
  const styles = stylesFrom(cls);
  if (styles === null) return []; // hidden everywhere
  const align = desk(cls.textAlign) === 'center' ? 'center' : desk(cls.textAlign) === 'right' ? 'right' : 'left';

  if (/^h[1-6]$/.test(n.tag)) {
    const t = clean(textOf(n));
    if (!t) return [];
    const level = Math.min(4, Math.max(1, Number(n.tag[1])));
    return [{ id: nid(), type: 'heading', props: { text: placeholder(level <= 2 ? `h${level}` : 'h3', t), level, align }, children: [], ...(styles ? { styles: withMaxWidthReset(styles) } : {}) }];
  }
  if (n.tag === 'img') {
    // The counter is shared by the whole section (ctx is copied per subtree), so every photo differs.
    const src = imageSrc(n.attrs.src, ctx.file, ++ctx.counter.images);
    if (!src) return [];
    const radius = desk(cls.borderRadius);
    return [{ id: nid(), type: 'image', props: { mediaId: '', src, alt: '', caption: '', rounded: Boolean(radius) }, children: [], ...(styles ? { styles: withMaxWidthReset(styles) } : {}) }];
  }
  if (n.tag === 'form') {
    return [{ id: nid(), type: 'form', props: { formId: '', title: '', intro: '', submitLabel: '[[btn]]', layout: 'stacked' }, children: [] }];
  }
  if (n.tag === 'button' || (n.tag === 'a' && !hasBlockChildren(n))) {
    const t = clean(textOf(n));
    if (!t) return [];
    const c = n.attrs.class || '';
    const variant = /(^|\s)bg-(indigo|blue|teal|emerald|green|rose|red|pink|purple|violet|orange|amber|yellow|sky|cyan|gray-900|black)/.test(c) ? 'primary' : /(^|\s)(border|bg-)/.test(c) ? 'secondary' : 'link';
    return [{ id: nid(), type: 'button', props: { label: placeholder(variant === 'link' ? 'link' : 'btn', t), href: '#', variant, align }, children: [] }];
  }
  if (TEXTY.has(n.tag) && !hasBlockChildren(n)) {
    const t = clean(textOf(n));
    if (!t) return [];
    const short = t.split(' ').length <= 4;
    return [{ id: nid(), type: 'text', props: { doc: doc([placeholder(short ? 'label' : 'p', t)]), align }, children: [], ...(styles ? { styles: withMaxWidthReset(styles) } : {}) }];
  }

  // Containers.
  const kids = n.children.flatMap((c) => convert(c, { ...ctx, inLink: ctx.inLink || n.tag === 'a' }, depth + 1));
  if (!kids.length) return [];
  const direction = desk(cls.flexDirection);
  const kind = desk(cls.displayKind);
  let layout = 'stack';
  let columns = 3;
  const gridCols = desk(cls.gridCols);
  if (kind === 'grid' && gridCols && gridCols > 1) {
    layout = 'grid';
    columns = Math.min(6, gridCols);
  }
  else if ((kind === 'flex' || kind === 'inline-flex') && direction !== 'column' && direction !== 'column-reverse') {
    // Tailblocks: "flex flex-wrap" whose children are w-1/3 etc. is a grid in disguise.
    const fr = n.children.filter((c) => c.tag).map((c) => desk(classProps(c.attrs.class, ctx.dark).widthFraction)).filter((f) => f && f < 1);
    if (desk(cls.wrap) && fr.length >= 2) {
      layout = 'grid';
      columns = Math.min(6, Math.max(2, Math.round(1 / Math.min(...fr))));
    }
    else layout = 'row';
  }
  if (layout === 'stack' && kids.length === 1 && !hasVisual(cls)) {
    // A wrapper without a look of its own: keep its child (and its margins/alignment hints).
    return kids;
  }
  const groupStyles = styles ? withMaxWidthReset(styles) : undefined;
  const mob = {};
  if (layout === 'row' && (cls.flexDirection?.[''] === 'column' || cls.displayKind?.[''] === 'block')) mob.flexDirection = 'column';
  if (Object.keys(mob).length) {
    const s = groupStyles ?? {};
    s.mobileL = { ...(s.mobileL ?? {}), ...mob };
    return [mkGroup(layout, columns, kids, desk(cls.alignItems), s, depth)];
  }
  return [mkGroup(layout, columns, kids, desk(cls.alignItems), groupStyles, depth)];
}

/** Groups deeper than the document allows are dissolved into their parent. */
function mkGroup(layout, columns, kids, alignItems, styles, depth) {
  const align = alignItems === 'center' ? 'center' : alignItems === 'flex-end' ? 'end' : alignItems === 'flex-start' ? 'start' : 'stretch';
  return { id: nid(), type: 'group', props: { layout, gap: 'md', align, columns }, children: kids, ...(styles ? { styles } : {}), __depth: depth };
}

/** Blocks inside sections centre themselves (mx-auto max-w-*); template widths are kept explicit. */
function withMaxWidthReset(styles) {
  return styles;
}

function doc(paras) {
  return { type: 'doc', content: paras.map((t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] })) };
}

/** Keeps the tree within the depth limit by lifting the children of over-deep groups. */
function flattenDeep(node, depth = 1, max = 9) {
  delete node.__depth;
  if (!node.children?.length) return node;
  node.children = node.children.flatMap((c) => {
    delete c.__depth;
    if (c.type === 'group' && depth + 1 >= max) return c.children.map((g) => flattenDeep(g, depth + 1, max));
    return [flattenDeep(c, depth + 1, max)];
  });
  return node;
}

function toSection(markupRoot, ctx) {
  // The outermost element with a look (section/div with bg/padding) becomes the band.
  let top = markupRoot;
  while (top.children.filter((c) => c.tag && !SKIP.has(c.tag)).length === 1 && top.children.filter((c) => c.text && c.text.trim()).length === 0) {
    const next = top.children.find((c) => c.tag && !SKIP.has(c.tag));
    if (!next || !BLOCKY.has(next.tag) || ['a', 'button', 'img', 'form'].includes(next.tag) || /^h\d$/.test(next.tag)) break;
    top = next;
    if (['section', 'header', 'footer'].includes(top.tag)) break;
  }
  const bandCls = classProps(top.attrs?.class, ctx.dark);
  const kids = (top === markupRoot ? markupRoot.children : top.children).flatMap((c) => convert(c, ctx, 2));
  if (!kids.length) return null;
  const s = stylesFrom(bandCls, ['backgroundColor', 'color', 'paddingTop', 'paddingBottom', 'textAlign']) || undefined;
  const styles = s ? { ...s, base: { ...(s.base ?? {}) } } : { base: {} };
  if (!styles.base.paddingTop) styles.base.paddingTop = '64px';
  if (!styles.base.paddingBottom) styles.base.paddingBottom = '64px';
  if (ctx.dark && !styles.base.backgroundColor) styles.base.backgroundColor = '#111827';
  if (ctx.dark && !styles.base.color) styles.base.color = '#d1d5db';
  const section = { id: nid(), type: 'section', props: { background: 'default', paddingY: 'none', width: 'wide', anchor: '' }, children: kids, styles };
  return flattenDeep(section);
}

// ── sources ──────────────────────────────────────────────────────────────────

const TB_CATEGORY = { blog: 'content', contact: 'contact', content: 'content', cta: 'cta', ecommerce: 'shop', feature: 'features', footer: 'navigation', gallery: 'content', header: 'navigation', hero: 'hero', pricing: 'pricing', statistic: 'proof', step: 'features', team: 'team', testimonial: 'proof' };
const HU_CATEGORY = { banners: 'hero', 'blog-cards': 'content', cards: 'features', 'contact-forms': 'contact', ctas: 'cta', faqs: 'faq', 'feature-grids': 'features', footers: 'navigation', headers: 'navigation', 'logo-clouds': 'proof', 'newsletter-signup': 'cta', pricing: 'pricing', 'product-cards': 'shop', 'product-collections': 'shop', sections: 'content', stats: 'proof', 'team-sections': 'team', testimonials: 'proof' };
const TITLE = { blog: 'Blog', contact: 'Contact', content: 'Content', cta: 'Call to action', ecommerce: 'Product', feature: 'Features', footer: 'Footer', gallery: 'Gallery', header: 'Header', hero: 'Hero', pricing: 'Pricing', statistic: 'Stats', step: 'Steps', team: 'Team', testimonial: 'Testimonials', banners: 'Banner', 'blog-cards': 'Blog cards', cards: 'Cards', 'contact-forms': 'Contact form', ctas: 'Call to action', faqs: 'FAQ', 'feature-grids': 'Feature grid', footers: 'Footer', headers: 'Header', 'logo-clouds': 'Logo cloud', 'newsletter-signup': 'Newsletter', 'product-cards': 'Product card', 'product-collections': 'Product collection', sections: 'Section', stats: 'Stats', 'team-sections': 'Team', testimonials: 'Testimonials' };

const results = [];
const dropped = [];

function add(source, file, category, catTitle, variant, dark, markup) {
  idSeq = 0;
  const tree = toSection(parse(markup), { file, dark, counter: { images: 0 }, inLink: false });
  if (!tree) return dropped.push(`${file}: nothing to convert`);
  const res = validatePageContent({ root: { id: 'root', type: 'section', props: {}, children: [tree] } });
  if (!res.ok) return dropped.push(`${file}: ${res.issues.slice(0, 2).map((i) => `${i.path} ${i.message}`).join('; ')}`);
  const key = `${source === 'Tailblocks' ? 'tb' : 'hu'}-${file.replace(/\.(js|html)$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  results.push({ key, category, name: `${catTitle} · ${source} ${variant}${dark ? ' (dark)' : ''}`, source, file, tree: res.content.root.children[0] });
}

const tbRoot = path.join(SRC, 'tailblocks', 'src', 'blocks');
for (const cat of fs.readdirSync(tbRoot).sort()) {
  for (const tone of ['light', 'dark']) {
    const dir = path.join(tbRoot, cat, tone);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      add('Tailblocks', `${cat}/${tone}/${f}`, TB_CATEGORY[cat] ?? 'content', TITLE[cat] ?? cat, f.replace('.js', '').toUpperCase(), tone === 'dark', jsxToMarkup(src));
    }
  }
}
const huRoot = path.join(SRC, 'hyperui', 'public', 'examples', 'marketing');
for (const cat of fs.readdirSync(huRoot).sort()) {
  const files = fs.readdirSync(path.join(huRoot, cat)).filter((f) => f.endsWith('.html')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
  for (const f of files) {
    const src = fs.readFileSync(path.join(huRoot, cat, f), 'utf8');
    add('HyperUI', `${cat}/${f}`, HU_CATEGORY[cat] ?? 'content', TITLE[cat] ?? cat, f.replace(/(-dark)?\.html$/, ''), /-dark\.html$/.test(f), htmlBody(src));
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const header = `// GENERATED by scripts/import-vendor-templates.cjs — do not edit by hand.
// Converted from MIT-licensed templates; licences in ./LICENSE-tailblocks.txt and ./LICENSE-hyperui.txt.
import type { BlockNode } from '../tree';

export interface VendorSection {
  key: string;
  category: string;
  name: string;
  source: 'Tailblocks' | 'HyperUI';
  file: string;
  tree: BlockNode;
}

export const VENDOR_SECTIONS: VendorSection[] = `;
fs.writeFileSync(path.join(OUT_DIR, 'sections-data.ts'), `${header}${JSON.stringify(results)};\n`);
fs.copyFileSync(path.join(SRC, 'tailblocks', 'LICENSE'), path.join(OUT_DIR, 'LICENSE-tailblocks.txt'));
fs.copyFileSync(path.join(SRC, 'hyperui', 'LICENSE'), path.join(OUT_DIR, 'LICENSE-hyperui.txt'));
const by = {};
for (const r of results) by[`${r.source}/${r.category}`] = (by[`${r.source}/${r.category}`] ?? 0) + 1;
console.log(`converted ${results.length}, dropped ${dropped.length}`);
console.log(JSON.stringify(by));
if (dropped.length) console.log(dropped.slice(0, 30).join('\n'));
