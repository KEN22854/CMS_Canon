import { animationRule, type BlockAnimation } from './animation';
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

/**
 * Interaction states, stored next to the breakpoints in the same `styles` object ("hover",
 * "active", "focus" layers). They apply on top of the block's styles at every width.
 */
export const STYLE_STATES = ['hover', 'active', 'focus'] as const;
export type StyleState = (typeof STYLE_STATES)[number];
/** A layer of the styles object: a breakpoint or an interaction state. */
export type StyleLayer = StyleBreakpoint | StyleState;
export const isStyleState = (l: string): l is StyleState => (STYLE_STATES as readonly string[]).includes(l);
const STATE_PSEUDO: Record<StyleState, string> = { hover: ':hover', active: ':active', focus: ':focus-visible' };

/**
 * Blocks whose visible control is an inner element (the link of a Button): their colours, border,
 * shadow, type and states style that element, while layout, size and spacing stay on the block.
 */
const INNER_TARGET: Record<string, string> = { button: '[data-cn-el]' };
const INNER_CSS = new Set(['color', 'background-color', 'background-image', 'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-transform', 'text-decoration', 'opacity', 'filter', 'transition']);
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
  flexShrink: { group: 'layout', css: 'flex-shrink', valid: isNumber(0, 10) },
  flexBasis: len('layout', 'flex-basis'),
  alignSelf: opt('layout', 'align-self', ['auto', ...ALIGN]),
  justifySelf: opt('layout', 'justify-self', ['auto', 'start', 'center', 'end', 'stretch']),
  alignContent: opt('layout', 'align-content', [...JUSTIFY, 'stretch']),
  gridTemplateRows: { group: 'layout', css: 'grid-template-rows', valid: isGridTemplate },
  gridRow: { group: 'layout', css: 'grid-row', valid: (v: string) => /^(?:span \d{1,2}|\d{1,2}(?: \/ (?:-?\d{1,2}|span \d{1,2}))?|auto)$/.test(v) },
  order: { group: 'layout', css: 'order', valid: (v: string) => /^-?\d{1,3}$/.test(v) },

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
  aspectRatio: { group: 'size', css: 'aspect-ratio', valid: (v: string) => v === 'auto' || /^\d{1,3}(?:\.\d{1,3})?(?: ?\/ ?\d{1,3}(?:\.\d{1,3})?)?$/.test(v) },

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
  fontStyle: opt('typography', 'font-style', ['normal', 'italic']),
  whiteSpace: opt('typography', 'white-space', ['normal', 'nowrap', 'pre-line', 'balance']),

  backgroundColor: { group: 'background', css: 'background-color', valid: isColor },
  backgroundImage: { group: 'background', css: 'background-image', valid: isGradient },
  backgroundSize: { group: 'background', css: 'background-size', valid: (v: string) => v === 'cover' || v === 'contain' || isLengthList(2)(v) },
  backgroundPosition: opt('background', 'background-position', ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right']),
  backgroundRepeat: opt('background', 'background-repeat', ['no-repeat', 'repeat', 'repeat-x', 'repeat-y']),

  borderWidth: { group: 'border', css: 'border-width', valid: isLengthList(4) },
  borderStyle: opt('border', 'border-style', ['none', 'solid', 'dashed', 'dotted']),
  borderColor: { group: 'border', css: 'border-color', valid: isColor },
  borderRadius: { group: 'border', css: 'border-radius', valid: isLengthList(4) },

  boxShadow: { group: 'effects', css: 'box-shadow', valid: isShadow },
  opacity: { group: 'effects', css: 'opacity', valid: isNumber(0, 1) },
  filter: { group: 'effects', css: 'filter', valid: isFilter },
  backdropFilter: { group: 'effects', css: 'backdrop-filter', valid: isFilter },
  cursor: opt('effects', 'cursor', ['auto', 'default', 'pointer', 'text', 'grab']),
  /** Smooth changes between states (hover, active…): all properties, this long. */
  transitionDuration: { group: 'effects', valid: (v: string) => /^\d{1,4}ms$/.test(v) && Number.parseInt(v, 10) <= 3000 },
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
export type ResponsiveStyles = Partial<Record<StyleLayer, StyleProps>>;

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
    if (!BREAKPOINT_IDS.includes(bp as StyleBreakpoint) && !isStyleState(bp)) {
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
    if (Object.keys(clean).length) out[bp as StyleLayer] = clean;
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
export function setStyle(styles: ResponsiveStyles | undefined, bp: StyleLayer, prop: StyleProperty, value: string | undefined): ResponsiveStyles | undefined {
  const v = value === undefined || value.trim() === '' ? undefined : value.trim();
  // Setting what is already there returns the same object, so callers see "no change".
  if (styles?.[bp]?.[prop] === v) return styles;
  const next: ResponsiveStyles = { ...(styles ?? {}) };
  const layer: StyleProps = { ...(next[bp] ?? {}) };
  if (v === undefined) delete layer[prop];
  else layer[prop] = v;
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
  if (ok('transitionDuration')) out.set('transition', `all ${props.transitionDuration} ease`);
  return out;
}

/** Doubled attribute: specificity (0,2,0) beats the block's own utility classes regardless of CSS order. */
const rule = (id: string, decls: Map<string, string>, suffix = '') => `[data-cn="${id}"][data-cn]${suffix}{${[...decls].map(([k, v]) => `${k}:${v}`).join(';')}}`;

/** The block's rules, split between the block and its inner control (see INNER_TARGET). */
function rules(id: string, decls: Map<string, string>, type: string | undefined, pseudo = ''): string | null {
  if (!decls.size) return null;
  const inner = type ? INNER_TARGET[type] : undefined;
  if (!inner) return rule(id, decls, pseudo);
  // In a state, movement (a press-in scale, a lift) belongs to the control too.
  const inEl = (k: string) => INNER_CSS.has(k) || (pseudo !== '' && k === 'transform');
  const own = new Map([...decls].filter(([k]) => !inEl(k)));
  const el = new Map([...decls].filter(([k]) => inEl(k)));
  // States follow the control itself (hovering the empty row next to a button does nothing).
  const out = [own.size ? rule(id, own, pseudo) : '', el.size ? rule(id, el, ` ${inner}${pseudo}`) : ''].join('');
  return out || null;
}

interface StyledNode {
  id: string;
  type?: string;
  styles?: ResponsiveStyles;
  animation?: BlockAnimation;
  hidden?: boolean;
  children: StyledNode[];
}

/**
 * CSS for every styled node in the tree. Each breakpoint emits only what changes against the
 * level above, inside `@container (max-width: …)`. The root node is the query container itself,
 * so its own styles are desktop-only. Pass `isPageRoot = false` to compile one subtree of a page
 * (the builder keeps one stylesheet per section, so an edit re-parses only that one).
 */
export function compileStyles(root: StyledNode, isPageRoot = true): string {
  const base: string[] = [];
  const byBp = new Map<StyleBreakpoint, string[]>();
  const walk = (n: StyledNode, isRoot: boolean) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n.id)) return;
    if (n.animation?.type) {
      const r = animationRule(n.id, n.animation);
      if (r) base.push(r);
    }
    if (n.styles) {
      const c = compiledNode(n.id, n.styles, isRoot, n.type);
      if (c.base) base.push(c.base);
      for (const [bp, r] of c.bps) (byBp.get(bp) ?? byBp.set(bp, []).get(bp)!).push(r);
    }
    for (const c of n.children) walk(c, false);
  };
  walk(root, isPageRoot);
  const parts = [...base];
  for (const b of STYLE_BREAKPOINTS.slice(1)) {
    const rules = byBp.get(b.id);
    if (rules?.length) parts.push(`@container (max-width: ${b.max}px){${rules.join('')}}`);
  }
  return parts.join('\n');
}

interface CompiledNode {
  base: string | null;
  bps: [StyleBreakpoint, string][];
}

/**
 * Rules per styles object. Editor updates are immutable and keep untouched `styles` objects by
 * identity, so an edit recompiles one node instead of the whole page.
 */
const compiled = new WeakMap<ResponsiveStyles, Map<string, CompiledNode>>();

function compiledNode(id: string, styles: ResponsiveStyles, isRoot: boolean, type?: string): CompiledNode {
  const key = `${isRoot ? 1 : 0}${type ?? ''}:${id}`;
  let byKey = compiled.get(styles);
  const hit = byKey?.get(key);
  if (hit) return hit;
  let prev = declarations(resolveStyles(styles, 'base'));
  // Interaction states come after the block's own rules (same specificity + a pseudo-class wins).
  const states = isRoot ? [] : STYLE_STATES.flatMap((st) => (styles[st] ? [rules(id, declarations(styles[st]!), type, STATE_PSEUDO[st])] : [])).filter(Boolean);
  const own = rules(id, prev, type);
  const out: CompiledNode = { base: own || states.length ? [own ?? '', ...states].join('') : null, bps: [] };
  if (!isRoot) {
    for (const bp of BREAKPOINT_IDS.slice(1)) {
      const cur = declarations(resolveStyles(styles, bp));
      // A property removed at a smaller breakpoint cannot happen (overrides only add), so diff is enough.
      const diff = new Map([...cur].filter(([k, v]) => prev.get(k) !== v));
      const r = rules(id, diff, type);
      if (r) out.bps.push([bp, r]);
      prev = cur;
    }
  }
  if (!byKey) compiled.set(styles, (byKey = new Map()));
  byKey.set(key, out);
  return out;
}

// ── Custom CSS text ──────────────────────────────────────────────────────────

const kebab = (p: string) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** CSS name → style property ("background-color" → backgroundColor; transform parts by their own names). */
const BY_CSS = new Map<string, StyleProperty>(Object.keys(STYLE_PROPS).map((p) => [SPECS[p]!.css ?? kebab(p), p as StyleProperty]));

export interface CssParseResult {
  props: StyleProps;
  errors: { line: number; text: string; reason: 'syntax' | 'unknown' | 'invalid' }[];
}

/**
 * Parses "property: value;" declarations typed by a person into validated style props. Unknown
 * properties and values outside the grammars are reported, never passed through: the site only
 * ever gets CSS compiled from the style layer, so this cannot inject selectors, url() or scripts.
 */
export function parseCssDeclarations(text: string): CssParseResult {
  const props: StyleProps = {};
  const errors: CssParseResult['errors'] = [];
  text
    .slice(0, 8000)
    .split('\n')
    .forEach((row, i) => {
      for (const raw of row.split(';')) {
        const decl = raw.trim();
        if (!decl) continue;
        const m = /^([a-zA-Z-]{1,40})\s*:\s*(.+)$/.exec(decl);
        if (!m) {
          errors.push({ line: i + 1, text: decl, reason: 'syntax' });
          continue;
        }
        const prop = BY_CSS.get(m[1]!.toLowerCase()) ?? (m[1]! in STYLE_PROPS ? (m[1] as StyleProperty) : undefined);
        const value = m[2]!.replace(/\s*!important\s*$/i, '').trim();
        if (!prop) errors.push({ line: i + 1, text: decl, reason: 'unknown' });
        else if (!isValidStyleValue(prop, value)) errors.push({ line: i + 1, text: decl, reason: 'invalid' });
        else props[prop] = value;
      }
    });
  return { props, errors };
}

/** Style props as editable CSS text, one declaration per line. */
export function stylesToCssText(props: StyleProps): string {
  return Object.entries(props)
    .map(([p, v]) => `${SPECS[p]?.css ?? kebab(p)}: ${v};`)
    .join('\n');
}
