/**
 * Responsive style layer for page nodes (Canon 2.0 Builder).
 *
 * - Desktop first: `base` applies everywhere, smaller breakpoints override it.
 * - Only whitelisted properties with per-property value validators can be stored, so a saved
 *   document can never carry CSS injection (`url(javascript:…)`, `}` breakouts, `expression()`).
 * - One compiler for the builder canvas and the published site. Rules target `[data-cn="<id>"]`
 *   (the block's own root element) and breakpoints are container queries against the page's root
 *   section — the canvas previews a breakpoint by narrowing, exactly like the renderer.
 */

export const STYLE_BREAKPOINTS = [
  { id: 'base', label: 'Desktop', max: null, preview: 1280 },
  { id: 'laptop', label: 'Laptop', max: 1279, preview: 1100 },
  { id: 'tablet', label: 'Tablet', max: 991, preview: 820 },
  { id: 'mobileL', label: 'Mobile L', max: 767, preview: 430 },
  { id: 'mobileS', label: 'Mobile S', max: 479, preview: 375 },
] as const;

export type StyleBreakpoint = (typeof STYLE_BREAKPOINTS)[number]['id'];
export const BREAKPOINT_IDS = STYLE_BREAKPOINTS.map((b) => b.id) as StyleBreakpoint[];

// ── value grammars ───────────────────────────────────────────────────────────

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const UNIT = '(?:px|rem|em|%|vw|vh|svh|dvh|ch|fr)';
const LEN = `(?:${NUM}${UNIT}|0|auto)`;
const re = (s: string) => new RegExp(`^${s}$`);

const isLength = (v: string) => re(LEN).test(v);
const isLengthList = (max: number) => (v: string) => {
  const parts = v.trim().split(/\s+/);
  return parts.length >= 1 && parts.length <= max && parts.every(isLength);
};
const isNumber = (min: number, max: number) => (v: string) => re(NUM).test(v) && Number(v) >= min && Number(v) <= max;
const oneOf = (...opts: string[]) => (v: string) => opts.includes(v);

/** Site theme colours, usable in any colour property and kept in sync with the theme. */
export const THEME_COLORS = ['primary', 'background', 'foreground', 'muted'] as const;
const COLOR_FN = String.raw`(?:rgb|rgba|hsl|hsla)\(\s*${NUM}%?(?:\s*[, ]\s*${NUM}%?){2}(?:\s*[,/]\s*${NUM}%?)?\s*\)`;
const COLOR = `(?:#[0-9a-fA-F]{3,8}|${COLOR_FN}|transparent|currentColor|token:(?:${THEME_COLORS.join('|')}))`;
const isColor = (v: string) => re(COLOR).test(v) && (!v.startsWith('#') || [4, 5, 7, 9].includes(v.length));

/** One or two shadow layers: [inset] x y [blur [spread]] colour. */
const SHADOW_LAYER = `(?:inset\\s+)?${LEN}\\s+${LEN}(?:\\s+${LEN}){0,2}\\s+${COLOR}`;
const isShadow = (v: string) => v === 'none' || re(`${SHADOW_LAYER}(?:\\s*,\\s*${SHADOW_LAYER})?`).test(v);

/** linear/radial gradients built only from angles, colours and stop lengths. */
const STOP = `${COLOR}(?:\\s+${LEN}){0,2}`;
const isGradient = (v: string) =>
  v === 'none' ||
  re(`linear-gradient\\(\\s*(?:${NUM}deg\\s*,\\s*|to (?:top|bottom|left|right)(?: (?:left|right))?\\s*,\\s*)?${STOP}(?:\\s*,\\s*${STOP}){1,5}\\s*\\)`).test(v) ||
  re(`radial-gradient\\(\\s*(?:circle|ellipse)?\\s*,?\\s*${STOP}(?:\\s*,\\s*${STOP}){1,5}\\s*\\)`).test(v);

/** Grid templates: track lengths, repeat(), minmax() and the auto-fit/auto-fill keywords. */
const TRACK = `(?:${LEN}|min-content|max-content|minmax\\(\\s*${LEN}\\s*,\\s*${LEN}\\s*\\))`;
const isGridTemplate = (v: string) =>
  v === 'none' || re(`(?:(?:${TRACK}|repeat\\(\\s*(?:\\d{1,2}|auto-fit|auto-fill)\\s*,\\s*${TRACK}(?:\\s+${TRACK})*\\s*\\))\\s*){1,12}`).test(v.trim() + ' ');

const isFilter = (v: string) => v === 'none' || re(`(?:(?:blur\\(${LEN}\\)|(?:brightness|contrast|grayscale|saturate|sepia|invert)\\(${NUM}%?\\)|hue-rotate\\(${NUM}deg\\))\\s*){1,4}`).test(v.trim() + ' ');

// ── properties ───────────────────────────────────────────────────────────────

export type StyleGroup = 'layout' | 'position' | 'size' | 'spacing' | 'typography' | 'background' | 'border' | 'effects' | 'transform';

interface PropSpec {
  group: StyleGroup;
  /** CSS property emitted (transform parts are composed instead). */
  css?: string;
  valid: (v: string) => boolean;
  options?: readonly string[];
}

const ALIGN = ['flex-start', 'center', 'flex-end', 'stretch', 'baseline'] as const;
const JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const;
export const FONT_FAMILIES = { inherit: 'inherit', site: 'var(--site-font)', sans: 'ui-sans-serif, system-ui, sans-serif', serif: 'Georgia, Cambria, "Times New Roman", serif', mono: 'ui-monospace, Menlo, Consolas, monospace' } as const;

const opt = (group: StyleGroup, css: string, options: readonly string[]): PropSpec => ({ group, css, valid: oneOf(...options), options });
const len = (group: StyleGroup, css: string): PropSpec => ({ group, css, valid: isLength });

export const STYLE_PROPS = {
  display: opt('layout', 'display', ['block', 'flex', 'grid', 'inline-block', 'inline-flex', 'none']),
  flexDirection: opt('layout', 'flex-direction', ['row', 'column', 'row-reverse', 'column-reverse']),
  flexWrap: opt('layout', 'flex-wrap', ['nowrap', 'wrap']),
  justifyContent: opt('layout', 'justify-content', JUSTIFY),
  alignItems: opt('layout', 'align-items', ALIGN),
  gap: { group: 'layout', css: 'gap', valid: isLengthList(2) },
  gridTemplateColumns: { group: 'layout', css: 'grid-template-columns', valid: isGridTemplate },
  gridColumn: { group: 'layout', css: 'grid-column', valid: (v: string) => /^(?:span \d{1,2}|\d{1,2}(?: \/ (?:-?\d{1,2}|span \d{1,2}))?|auto)$/.test(v) },
  flexGrow: { group: 'layout', css: 'flex-grow', valid: isNumber(0, 10) },

  position: opt('position', 'position', ['static', 'relative', 'absolute', 'fixed', 'sticky']),
  top: len('position', 'top'),
  right: len('position', 'right'),
  bottom: len('position', 'bottom'),
  left: len('position', 'left'),
  zIndex: { group: 'position', css: 'z-index', valid: (v: string) => /^-?\d{1,4}$/.test(v) },

  width: len('size', 'width'),
  height: len('size', 'height'),
  minWidth: len('size', 'min-width'),
  maxWidth: { group: 'size', css: 'max-width', valid: (v: string) => v === 'none' || isLength(v) },
  minHeight: len('size', 'min-height'),
  maxHeight: { group: 'size', css: 'max-height', valid: (v: string) => v === 'none' || isLength(v) },

  marginTop: len('spacing', 'margin-top'),
  marginRight: len('spacing', 'margin-right'),
  marginBottom: len('spacing', 'margin-bottom'),
  marginLeft: len('spacing', 'margin-left'),
  paddingTop: len('spacing', 'padding-top'),
  paddingRight: len('spacing', 'padding-right'),
  paddingBottom: len('spacing', 'padding-bottom'),
  paddingLeft: len('spacing', 'padding-left'),

  fontFamily: { group: 'typography', css: 'font-family', valid: oneOf(...Object.keys(FONT_FAMILIES)), options: Object.keys(FONT_FAMILIES) },
  fontSize: len('typography', 'font-size'),
  fontWeight: opt('typography', 'font-weight', ['300', '400', '500', '600', '700', '800', '900']),
  lineHeight: { group: 'typography', css: 'line-height', valid: (v: string) => isNumber(0.5, 4)(v) || isLength(v) },
  letterSpacing: len('typography', 'letter-spacing'),
  textTransform: opt('typography', 'text-transform', ['none', 'uppercase', 'lowercase', 'capitalize']),
  textAlign: opt('typography', 'text-align', ['left', 'center', 'right', 'justify']),
  textDecoration: opt('typography', 'text-decoration', ['none', 'underline', 'line-through']),
  color: { group: 'typography', css: 'color', valid: isColor },

  backgroundColor: { group: 'background', css: 'background-color', valid: isColor },
  backgroundImage: { group: 'background', css: 'background-image', valid: isGradient },

  borderWidth: { group: 'border', css: 'border-width', valid: isLengthList(4) },
  borderStyle: opt('border', 'border-style', ['none', 'solid', 'dashed', 'dotted']),
  borderColor: { group: 'border', css: 'border-color', valid: isColor },
  borderRadius: { group: 'border', css: 'border-radius', valid: isLengthList(4) },

  boxShadow: { group: 'effects', css: 'box-shadow', valid: isShadow },
  opacity: { group: 'effects', css: 'opacity', valid: isNumber(0, 1) },
  filter: { group: 'effects', css: 'filter', valid: isFilter },
  mixBlendMode: opt('effects', 'mix-blend-mode', ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference']),
  overflow: opt('effects', 'overflow', ['visible', 'hidden', 'auto', 'clip']),

  translateX: { group: 'transform', valid: isLength },
  translateY: { group: 'transform', valid: isLength },
  rotate: { group: 'transform', valid: (v: string) => re(`${NUM}deg`).test(v) || v === '0' },
  scale: { group: 'transform', valid: isNumber(0, 5) },
  skewX: { group: 'transform', valid: (v: string) => re(`${NUM}deg`).test(v) || v === '0' },
} satisfies Record<string, PropSpec>;

export type StyleProperty = keyof typeof STYLE_PROPS;
export type StyleProps = Partial<Record<StyleProperty, string>>;
export type ResponsiveStyles = Partial<Record<StyleBreakpoint, StyleProps>>;

const SPECS = STYLE_PROPS as Record<string, PropSpec>;
const MAX_VALUE = 200;

/** Characters that could escape a declaration are rejected for every property, before grammars. */
const FORBIDDEN = /[;{}<>\\"'`]|\/\*|url\(|expression|javascript:|@import/i;

export function isValidStyleValue(prop: string, value: unknown): value is string {
  const spec = SPECS[prop];
  if (!spec || typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > MAX_VALUE || FORBIDDEN.test(v)) return false;
  return spec.valid(v);
}

export interface StyleIssue {
  path: string;
  message: string;
}

/** Validates a node's `styles` object; returns the cleaned value and any issues. */
export function validateStyles(input: unknown, path = 'styles'): { styles?: ResponsiveStyles; issues: StyleIssue[] } {
  if (input === undefined) return { issues: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { issues: [{ path, message: 'Styles must be an object' }] };
  const issues: StyleIssue[] = [];
  const out: ResponsiveStyles = {};
  for (const [bp, props] of Object.entries(input as Record<string, unknown>)) {
    if (!BREAKPOINT_IDS.includes(bp as StyleBreakpoint)) {
      issues.push({ path: `${path}.${bp}`, message: `Unknown breakpoint "${bp}"` });
      continue;
    }
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      issues.push({ path: `${path}.${bp}`, message: 'Breakpoint styles must be an object' });
      continue;
    }
    const clean: StyleProps = {};
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (!(k in SPECS)) issues.push({ path: `${path}.${bp}.${k}`, message: `"${k}" is not a supported style property` });
      else if (!isValidStyleValue(k, v)) issues.push({ path: `${path}.${bp}.${k}`, message: `Invalid value for ${k}` });
      else clean[k as StyleProperty] = (v as string).trim();
    }
    if (Object.keys(clean).length) out[bp as StyleBreakpoint] = clean;
  }
  return { styles: Object.keys(out).length ? out : undefined, issues };
}

/** Effective styles at a breakpoint: `base`, then every larger breakpoint's overrides, down to this one. */
export function resolveStyles(styles: ResponsiveStyles | undefined, bp: StyleBreakpoint): StyleProps {
  const out: StyleProps = {};
  if (!styles) return out;
  for (const id of BREAKPOINT_IDS) {
    Object.assign(out, styles[id]);
    if (id === bp) break;
  }
  return out;
}

/** The breakpoint that sets a property's effective value at `bp` (for "inherited from" hints). */
export function styleSource(styles: ResponsiveStyles | undefined, bp: StyleBreakpoint, prop: StyleProperty): StyleBreakpoint | null {
  let src: StyleBreakpoint | null = null;
  for (const id of BREAKPOINT_IDS) {
    if (styles?.[id]?.[prop] !== undefined) src = id;
    if (id === bp) break;
  }
  return src;
}

/** Returns a copy with one property set (or removed when value is empty) at one breakpoint. */
export function setStyle(styles: ResponsiveStyles | undefined, bp: StyleBreakpoint, prop: StyleProperty, value: string | undefined): ResponsiveStyles | undefined {
  const next: ResponsiveStyles = { ...(styles ?? {}) };
  const layer: StyleProps = { ...(next[bp] ?? {}) };
  if (value === undefined || value.trim() === '') delete layer[prop];
  else layer[prop] = value.trim();
  if (Object.keys(layer).length) next[bp] = layer;
  else delete next[bp];
  return Object.keys(next).length ? next : undefined;
}

// ── compiler ────────────────────────────────────────────────────────────────

const cssValue = (v: string) => (v.startsWith('token:') ? `rgb(var(--site-${v.slice(6)}))` : v.replace(/token:([a-z]+)/g, 'rgb(var(--site-$1))'));

function declarations(props: StyleProps): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, raw] of Object.entries(props) as [StyleProperty, string][]) {
    const spec = SPECS[k];
    if (!spec?.css || !isValidStyleValue(k, raw)) continue;
    out.set(spec.css, k === 'fontFamily' ? FONT_FAMILIES[raw as keyof typeof FONT_FAMILIES] : cssValue(raw));
  }
  // Transform parts compose into one property, in a fixed order.
  const ok = (k: StyleProperty) => props[k] !== undefined && isValidStyleValue(k, props[k]);
  const deg = (v: string) => (v === '0' ? '0deg' : v);
  const tf: string[] = [];
  if (ok('translateX') || ok('translateY')) tf.push(`translate(${ok('translateX') ? props.translateX : '0'}, ${ok('translateY') ? props.translateY : '0'})`);
  if (ok('rotate')) tf.push(`rotate(${deg(props.rotate!)})`);
  if (ok('scale')) tf.push(`scale(${props.scale})`);
  if (ok('skewX')) tf.push(`skewX(${deg(props.skewX!)})`);
  if (tf.length) out.set('transform', tf.join(' '));
  return out;
}

/** Doubled attribute: specificity (0,2,0) beats the block's own utility classes regardless of CSS order. */
const rule = (id: string, decls: Map<string, string>) => `[data-cn="${id}"][data-cn]{${[...decls].map(([k, v]) => `${k}:${v}`).join(';')}}`;

interface StyledNode {
  id: string;
  styles?: ResponsiveStyles;
  hidden?: boolean;
  children: StyledNode[];
}

/**
 * CSS for every styled node in the tree. Each breakpoint emits only what changes against the
 * level above, inside `@container (max-width: …)`. The root node is the query container itself,
 * so its own styles are desktop-only.
 */
export function compileStyles(root: StyledNode): string {
  const base: string[] = [];
  const byBp = new Map<StyleBreakpoint, string[]>();
  const walk = (n: StyledNode, isRoot: boolean) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n.id)) return;
    if (n.styles) {
      let prev = declarations(resolveStyles(n.styles, 'base'));
      if (prev.size) base.push(rule(n.id, prev));
      if (!isRoot) {
        for (const bp of BREAKPOINT_IDS.slice(1)) {
          const cur = declarations(resolveStyles(n.styles, bp));
          const diff = new Map([...cur].filter(([k, v]) => prev.get(k) !== v));
          // A property removed at a smaller breakpoint cannot happen (overrides only add), so diff is enough.
          if (diff.size) (byBp.get(bp) ?? byBp.set(bp, []).get(bp)!).push(rule(n.id, diff));
          prev = cur;
        }
      }
    }
    for (const c of n.children) walk(c, false);
  };
  walk(root, true);
  const parts = [...base];
  for (const b of STYLE_BREAKPOINTS.slice(1)) {
    const rules = byBp.get(b.id);
    if (rules?.length) parts.push(`@container (max-width: ${b.max}px){${rules.join('')}}`);
  }
  return parts.join('\n');
}
