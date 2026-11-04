import { z } from 'zod';

/**
 * Block animations: an entrance (on page load or when the block scrolls into view) and a hover
 * effect. One setting per block (not per breakpoint). Rendered as data attributes plus CSS
 * variables; the keyframes are plain CSS, and people who prefer reduced motion get none of it.
 */
export const ANIMATION_TYPES = ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom-in', 'zoom-out', 'blur-in', 'rotate-in', 'flip-up'] as const;
export const ANIMATION_TRIGGERS = ['load', 'scroll'] as const;
export const ANIMATION_EASINGS = ['ease', 'ease-out', 'ease-in-out', 'spring', 'linear'] as const;
export const HOVER_EFFECTS = ['none', 'lift', 'grow', 'glow', 'dim', 'tilt'] as const;

export type AnimationType = (typeof ANIMATION_TYPES)[number];

export interface BlockAnimation {
  /** Entrance; absent = no entrance animation. */
  type?: AnimationType;
  trigger?: (typeof ANIMATION_TRIGGERS)[number];
  /** Milliseconds. */
  duration?: number;
  delay?: number;
  easing?: (typeof ANIMATION_EASINGS)[number];
  hover?: (typeof HOVER_EFFECTS)[number];
  /** Containers: children enter one after another, this many ms apart. */
  stagger?: number;
}

export const animationSchema = z
  .object({
    type: z.enum(ANIMATION_TYPES).optional(),
    trigger: z.enum(ANIMATION_TRIGGERS).optional(),
    duration: z.number().int().min(100).max(5000).optional(),
    delay: z.number().int().min(0).max(10000).optional(),
    easing: z.enum(ANIMATION_EASINGS).optional(),
    hover: z.enum(HOVER_EFFECTS).optional(),
    /** Containers: the children enter one after another, this many ms apart (the container itself doesn't move). */
    stagger: z.number().int().min(50).max(2000).optional(),
  })
  .strict();

export const ANIMATION_DEFAULTS = { trigger: 'scroll', duration: 700, delay: 0, easing: 'ease-out', hover: 'none' } as const;

/** Undefined when nothing would happen (keeps documents minimal). */
export function normalizeAnimation(a: BlockAnimation | undefined): BlockAnimation | undefined {
  if (!a) return undefined;
  const out: BlockAnimation = {};
  if (a.type) {
    out.type = a.type;
    if (a.trigger && a.trigger !== ANIMATION_DEFAULTS.trigger) out.trigger = a.trigger;
    if (a.duration !== undefined && a.duration !== ANIMATION_DEFAULTS.duration) out.duration = a.duration;
    if (a.delay) out.delay = a.delay;
    if (a.easing && a.easing !== ANIMATION_DEFAULTS.easing) out.easing = a.easing;
    if (a.stagger) out.stagger = a.stagger;
  }
  if (a.hover && a.hover !== 'none') out.hover = a.hover;
  return Object.keys(out).length ? out : undefined;
}

const EASE: Record<(typeof ANIMATION_EASINGS)[number], string> = {
  ease: 'ease',
  'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  linear: 'linear',
};

/** Per-block timing, as CSS variables on the block (compiled with the page's styles). */
export function animationRule(id: string, a: BlockAnimation): string | null {
  if (!a.type) return null;
  const decl = [`--anim-dur:${a.duration ?? ANIMATION_DEFAULTS.duration}ms`, `--anim-delay:${a.delay ?? 0}ms`, `--anim-ease:${EASE[a.easing ?? ANIMATION_DEFAULTS.easing]}`];
  return `[data-cn="${id}"][data-anim]{${decl.join(';')}}`;
}

/**
 * Keyframes and the rules that run them. Scroll entrances only hide their block once the page's
 * script marked the document ready (`html.canon-anim`), so without JavaScript nothing stays hidden.
 */
export const ANIMATION_CSS = [
  '[data-anim]{animation-duration:var(--anim-dur,700ms);animation-delay:var(--anim-delay,0ms);animation-timing-function:var(--anim-ease,cubic-bezier(0.16,1,0.3,1));animation-fill-mode:both}',
  '.canon-anim [data-anim-trigger="scroll"]:not([data-anim-in]){opacity:0;animation-name:none!important}',
  ...ANIMATION_TYPES.map((t) => `[data-anim="${t}"]{animation-name:canon-${t}}`),
  '@keyframes canon-fade{from{opacity:0}to{opacity:1}}',
  '@keyframes canon-slide-up{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}',
  '@keyframes canon-slide-down{from{opacity:0;transform:translateY(-40px)}to{opacity:1;transform:none}}',
  '@keyframes canon-slide-left{from{opacity:0;transform:translateX(60px)}to{opacity:1;transform:none}}',
  '@keyframes canon-slide-right{from{opacity:0;transform:translateX(-60px)}to{opacity:1;transform:none}}',
  '@keyframes canon-zoom-in{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}',
  '@keyframes canon-zoom-out{from{opacity:0;transform:scale(1.15)}to{opacity:1;transform:none}}',
  '@keyframes canon-blur-in{from{opacity:0;filter:blur(12px)}to{opacity:1;filter:none}}',
  '@keyframes canon-rotate-in{from{opacity:0;transform:rotate(-8deg) scale(.95)}to{opacity:1;transform:none}}',
  '@keyframes canon-flip-up{from{opacity:0;transform:perspective(800px) rotateX(35deg)}to{opacity:1;transform:none}}',
  '[data-hover]{transition:transform .25s ease,box-shadow .25s ease,opacity .25s ease,filter .25s ease}',
  '[data-hover="lift"]:hover{transform:translateY(-6px);box-shadow:0 18px 40px -16px rgba(0,0,0,.35)}',
  '[data-hover="grow"]:hover{transform:scale(1.04)}',
  '[data-hover="glow"]:hover{box-shadow:0 0 0 4px rgb(var(--site-primary) / .25),0 12px 32px -12px rgb(var(--site-primary) / .6)}',
  '[data-hover="dim"]:hover{opacity:.8}',
  '[data-hover="tilt"]:hover{transform:perspective(800px) rotateX(4deg) rotateY(-4deg)}',
  '@media (prefers-reduced-motion:reduce){[data-anim]{animation:none!important;opacity:1!important}[data-hover]{transition:none!important}[data-hover]:hover{transform:none!important}}',
].join('\n');

/** Most children that get a staggered entrance (a long list shouldn't take a minute to appear). */
const MAX_STAGGERED = 24;

/**
 * Turns "children one by one" into explicit entrances: each child without an entrance of its own
 * gets the container's (type, trigger, duration, easing) with a growing delay; the container keeps
 * only its hover effect. Run on the delivered tree, so renderers stay unaware of staggering.
 */
export function expandStagger<T extends { animation?: BlockAnimation; children: T[] }>(node: T): T {
  const children = node.children.map(expandStagger);
  const a = node.animation;
  if (!a?.type || !a.stagger) return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
  const step = a.stagger;
  const staggered = children.map((c, i) => {
    if (c.animation?.type || i >= MAX_STAGGERED) return c;
    const own = normalizeAnimation({ type: a.type, trigger: a.trigger, duration: a.duration, easing: a.easing, delay: (a.delay ?? 0) + i * step, hover: c.animation?.hover });
    return { ...c, animation: own };
  });
  return { ...node, animation: a.hover && a.hover !== 'none' ? { hover: a.hover } : undefined, children: staggered };
}
