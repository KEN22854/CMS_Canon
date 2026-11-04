import { ICONS } from './icons';
import { ANIMATION_CSS, compileStyles, expandInstance, formatMoney, videoEmbedUrl, type BlockNode, type IconName, type ListItem, type RichTextDoc, type ShopConfig, type ShopProduct } from '@canon/blocks';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { FormView, type RenderForm } from './form';
import { RichText } from './rich-text';

/**
 * Renderers for every block in @canon/blocks. They are plain (server-compatible) components: no
 * hooks, no client state, so apps/web renders them as RSC and the builder canvas renders the very
 * same markup. Props were validated (and defaulted) by the API on save, so renderers trust shapes
 * but still treat every string as text — nothing here injects HTML.
 *
 * Responsiveness uses container queries against the root section (`@container`), not viewport
 * media queries: the builder previews tablet/mobile by narrowing the canvas, not the window.
 */
export interface RenderMedia {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  dominantColor: string | null;
  variants?: { sources: { url: string; width: number; height: number; format: 'webp' | 'avif' }[] } | null;
}

export interface RenderContext {
  media: Record<string, RenderMedia>;
  facts: Record<string, string>;
  /** Preview/draft: placeholders for unfinished blocks and unresolved facts. */
  draft: boolean;
  /**
   * Builder canvas: every block's root element carries data-block-id / data-block-container so the
   * editor can hit-test, outline and compute drop positions from the DOM without wrapper elements
   * (wrappers would break flex/grid layouts like Columns). Embeds become inert.
   */
  editing?: boolean;
  /** Forms embedded on the page (public definitions, keyed by id). */
  forms?: Record<string, RenderForm>;
  /** Cards of Collection list blocks, by block id (published entries, resolved by delivery). */
  lists?: Record<string, ListItem[]>;
  /** Products named by Buy blocks (price and stock from the published product). */
  products?: Record<string, ShopProduct>;
  /** The site's shop, when the page has a Cart block. */
  shop?: ShopConfig | null;
  /** The page's language (prices, the cart's labels). */
  locale?: string;
  /**
   * Global component trees by id. Delivery expands components before rendering, so only the
   * builder passes these (working copies), to draw instances in place.
   */
  components?: Record<string, BlockNode>;
  /** Placeholder texts shown in drafts and the builder, in the editor's language (English otherwise). */
  labels?: Partial<RenderLabels>;
  /**
   * Renders child blocks. The builder passes a memoised BlockRenderer, so an edit re-renders only
   * the path to the changed block (untouched subtrees keep their identity); the site renders plainly.
   */
  Child?: ComponentType<BlockRendererProps>;
}

export interface BlockRendererProps {
  node: BlockNode;
  ctx: RenderContext;
  isRoot?: boolean;
  parent?: BlockNode;
}

export const DEFAULT_RENDER_LABELS = {
  addColumns: 'Add columns',
  emptyPage: 'Drag blocks here, or generate a page with AI',
  dropHere: 'Drop blocks here',
  componentDeleted: 'This component was deleted',
  chooseComponent: 'Choose a component',
  chooseImage: 'Choose an image',
  pasteVideo: 'Paste a YouTube or Vimeo link',
  formMissing: 'This form is inactive or was deleted',
  chooseForm: 'Choose a form in the inspector',
  noRenderer: 'Block “{type}” has no renderer yet',
  chooseCollection: 'Choose a collection in the inspector',
  buyTemplate: 'Price, stock and “Add to cart” of the product (filled in on each product page)',
  buyMissing: 'This product isn’t published or has no price',
  cartPreview: 'The cart and checkout appear here on the site',
  noShop: 'Turn a collection into a shop first (Collections → Shop)',
  inStock: '{count} in stock',
  soldOut: 'Sold out',
  noEntries: 'No published entries match yet — publish some, or change the filter',
};
export type RenderLabels = typeof DEFAULT_RENDER_LABELS;
const label = (ctx: RenderContext, k: keyof RenderLabels) => ctx.labels?.[k] ?? DEFAULT_RENDER_LABELS[k];

type P = Record<string, unknown>;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const ALIGN: Record<string, string> = { left: 'text-left', center: 'text-center mx-auto', right: 'text-right ml-auto' };
const FLEX_ALIGN: Record<string, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };
const PAD: Record<string, string> = { none: 'py-0', sm: 'py-6', md: 'py-12', lg: 'py-20', xl: 'py-32' };
const WIDTH: Record<string, string> = { narrow: 'max-w-2xl', default: 'max-w-5xl', wide: 'max-w-7xl', full: 'max-w-none' };
const BG: Record<string, string> = { default: 'bg-site-bg text-site-fg', muted: 'bg-site-muted text-site-fg', primary: 'bg-site-primary text-site-on-primary', dark: 'bg-site-fg text-site-bg' };
const GAP: Record<string, string> = { sm: 'gap-4', md: 'gap-8', lg: 'gap-12' };
const V_ALIGN: Record<string, string> = { top: 'items-start', center: 'items-center', bottom: 'items-end' };
/** Row stacks vertically below its breakpoint; literal class strings so Tailwind can see them. */
const ROW_DIR: Record<string, string> = { sm: '@xl:flex-row', md: '@3xl:flex-row', lg: '@5xl:flex-row' };
const COL_BASIS: Record<string, string> = { sm: '@xl:basis-[var(--col)]', md: '@3xl:basis-[var(--col)]', lg: '@5xl:basis-[var(--col)]' };
const COL_WIDTH: Record<string, string> = { '1/4': '25%', '1/3': '33.333%', '1/2': '50%', '2/3': '66.667%', '3/4': '75%' };
const SPACER: Record<string, string> = { xs: 'h-4', sm: 'h-8', md: 'h-16', lg: 'h-24', xl: 'h-32' };
const STATS_COLS: Record<number, string> = { 1: '', 2: '@xl:grid-cols-2', 3: '@xl:grid-cols-3', 4: '@xl:grid-cols-2 @3xl:grid-cols-4', 5: '@xl:grid-cols-3 @4xl:grid-cols-5', 6: '@xl:grid-cols-3 @4xl:grid-cols-6' };
const FEATURE_COLS: Record<number, string> = { 2: '@2xl:grid-cols-2', 3: '@2xl:grid-cols-2 @4xl:grid-cols-3', 4: '@2xl:grid-cols-2 @5xl:grid-cols-4' };
const TONE: Record<string, string> = { primary: 'bg-site-primary text-site-on-primary', muted: 'bg-site-muted text-site-fg', dark: 'bg-site-fg text-site-bg' };

const ICON_SIZE: Record<string, { icon: string; circle: string }> = { sm: { icon: 'h-4 w-4', circle: 'h-8 w-8' }, md: { icon: 'h-6 w-6', circle: 'h-12 w-12' }, lg: { icon: 'h-9 w-9', circle: 'h-16 w-16' }, xl: { icon: 'h-12 w-12', circle: 'h-24 w-24' } };
const ICON_TONE: Record<string, string> = { primary: 'text-site-primary', foreground: 'text-site-fg', muted: 'text-site-fg/60' };
const BADGE_TONE: Record<string, string> = { primary: 'bg-site-primary text-site-on-primary', muted: 'bg-site-muted text-site-fg', outline: 'border border-current text-site-primary', dark: 'bg-site-fg text-site-bg' };
const IMAGE_FOCUS_CLASS: Record<string, string> = { center: 'object-center', top: 'object-top', bottom: 'object-bottom', left: 'object-left', right: 'object-right' };
const IMAGE_OVERLAY: Record<string, string | undefined> = { none: undefined, light: 'bg-white/40', dark: 'bg-black/45', brand: 'bg-gradient-to-t from-site-primary/60 to-transparent' };

const CONTAINERS = new Set(['section', 'row', 'column', 'group', 'canvas']);
const GROUP_LAYOUT: Record<string, string> = { stack: 'flex flex-col', row: 'flex flex-row flex-wrap', grid: 'grid' };
const GROUP_GAP: Record<string, string> = { none: 'gap-0', sm: 'gap-3', md: 'gap-6', lg: 'gap-10' };
const GROUP_ALIGN: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' };

export function BlockRenderer({
  node,
  ctx,
  isRoot = false,
  parent,
}: BlockRendererProps): ReactNode {
  // Hidden blocks never reach the site; the builder keeps them (dimmed) so they can be shown again.
  if (node.hidden && !ctx.editing) return null;
  const p = node.props as P;
  const a = {
    ...(ctx.editing ? { 'data-block-id': node.id, 'data-block-type': node.type, ...(CONTAINERS.has(node.type) ? { 'data-block-container': '' } : {}), ...(node.hidden ? { 'data-hidden': '' } : {}), ...(node.locked ? { 'data-locked': '' } : {}) } : {}),
    // Target of the compiled node styles (PageStyles); the block's own root element, no wrapper.
    ...(node.styles || node.animation?.type || node.type === 'canvas' ? { 'data-cn': node.id } : {}),
    // Entrances don't run while editing (the canvas replays them on request); hover effects do.
    ...(node.animation?.type && !ctx.editing ? { 'data-anim': node.animation.type, 'data-anim-trigger': node.animation.trigger ?? 'scroll' } : {}),
    ...(node.animation?.type && ctx.editing ? { 'data-anim-edit': node.animation.type } : {}),
    ...(node.animation?.hover ? { 'data-hover': node.animation.hover } : {}),
    ...(node.attrs?.ariaLabel ? { 'aria-label': node.attrs.ariaLabel } : {}),
    ...(node.attrs?.title ? { title: node.attrs.title } : {}),
    ...(node.attrs?.id && !ctx.editing ? { id: node.attrs.id } : {}),
  };
  // In the builder, text elements name the prop they show, so they can be edited in place.
  const F = (path: string) => (ctx.editing ? { 'data-field': path } : {});
  const children = () =>
    node.children.length === 0 && ctx.editing ? (
      <EmptyContainer label={label(ctx, node.type === 'row' ? 'addColumns' : isRoot ? 'emptyPage' : 'dropHere')} />
    ) : (
      node.children.map((c) => (ctx.Child ? <ctx.Child key={c.id} node={c} ctx={ctx} parent={node} /> : <BlockRenderer key={c.id} node={c} ctx={ctx} parent={node} />))
    );

  switch (node.type) {
    case 'section':
      // The root section frames the page (and is the query container); nested sections are bands.
      return (
        <section {...a} id={str(p.anchor) || (a as { id?: string }).id} className={`${isRoot ? '@container min-h-full' : ''} ${BG[str(p.background, 'default')] ?? BG.default} ${PAD[str(p.paddingY, 'lg')] ?? ''}`}>
          <div className={`mx-auto ${isRoot ? 'max-w-none' : `px-6 ${WIDTH[str(p.width, 'default')] ?? WIDTH.default}`} space-y-6`}>{children()}</div>
        </section>
      );

    case 'row': {
      const stack = str(p.stackBelow, 'md');
      return (
        <div {...a} className={`mx-auto flex max-w-6xl flex-col px-6 ${ROW_DIR[stack] ?? ROW_DIR.md} ${GAP[str(p.gap, 'md')] ?? GAP.md} ${V_ALIGN[str(p.verticalAlign, 'top')] ?? ''}`}>
          {children()}
        </div>
      );
    }

    case 'column': {
      const stack = str(parent?.props.stackBelow, 'md');
      const width = COL_WIDTH[str(p.width, 'auto')];
      // Columns already sit inside the row's padding, so nested blocks drop their own side padding.
      return (
        <div {...a} style={width ? ({ '--col': width } as CSSProperties) : undefined} className={`min-w-0 space-y-6 [&>*]:!px-0 ${width ? `grow-0 ${COL_BASIS[stack] ?? COL_BASIS.md}` : 'flex-1'}`}>
          {children()}
        </div>
      );
    }

    case 'group': {
      const layout = str(p.layout, 'stack');
      const cols = Math.min(6, Math.max(2, Number(p.columns) || 3));
      return (
        // One column in narrow containers, the chosen number from 768 px up; through a variable so a
      // per-breakpoint gridTemplateColumns style still wins over both.
      <div {...a} style={layout === 'grid' ? ({ '--grid-cols': cols } as CSSProperties) : undefined} className={`${GROUP_LAYOUT[layout] ?? GROUP_LAYOUT.stack} ${layout === 'grid' ? 'grid-cols-1 @3xl:[grid-template-columns:repeat(var(--grid-cols),minmax(0,1fr))]' : ''} ${GROUP_GAP[str(p.gap, 'md')] ?? GROUP_GAP.md} ${GROUP_ALIGN[str(p.align, 'stretch')] ?? ''} min-w-0`}>
          {children()}
        </div>
      );
    }

    case 'canvas': {
      // Free-form: children are positioned by their styles (left/top/width per breakpoint) inside
      // a frame — the centred 1200 px grid, or the full window. The height is a variable, so a
      // min-height override per breakpoint (style layer) still wins over it.
      const height = Math.min(4000, Math.max(80, Number(p.height) || 560));
      return (
        <section {...a} data-free-form="" style={{ '--free-h': `${height}px` } as CSSProperties} className={`relative isolate min-h-[var(--free-h)] overflow-hidden ${BG[str(p.background, 'default')] ?? BG.default}`}>
          {str(p.imageUrl) && <ExternalImage src={str(p.imageUrl)} className="absolute inset-0 -z-10 h-full w-full object-cover" />}
          {str(p.videoUrl) && <BackgroundVideo src={str(p.videoUrl)} poster={str(p.imageUrl) || undefined} editing={Boolean(ctx.editing)} />}
          {str(p.overlay, 'none') !== 'none' && <div aria-hidden className={`absolute inset-0 -z-10 ${str(p.overlay) === 'dark' ? 'bg-black/55' : 'bg-white/60'}`} />}
          <div data-free-frame="" className={`absolute inset-y-0 left-0 right-0 mx-auto ${str(p.frame) === 'window' ? '' : 'max-w-[1200px]'}`}>
            {node.children.length === 0 && ctx.editing ? <EmptyContainer label={label(ctx, 'dropHere')} /> : node.children.map((c) => (ctx.Child ? <ctx.Child key={c.id} node={c} ctx={ctx} parent={node} /> : <BlockRenderer key={c.id} node={c} ctx={ctx} parent={node} />))}
          </div>
        </section>
      );
    }

    case 'shape': {
      const kind = str(p.kind, 'rectangle');
      return <div {...a} aria-hidden className={kind === 'line' ? 'h-px w-40 bg-current opacity-30' : `h-32 w-48 bg-site-primary/20 ${kind === 'circle' ? 'rounded-full' : 'rounded-site'}`} />;
    }

    case 'component': {
      const tree = ctx.components?.[str(p.componentId)];
      if (!tree) return ctx.draft || ctx.editing ? <Placeholder a={a} label={label(ctx, str(p.componentId) ? 'componentDeleted' : 'chooseComponent')} /> : null;
      const expanded = expandInstance(node, tree);
      if (!ctx.editing) return <BlockRenderer node={expanded} ctx={ctx} parent={parent} />;
      // In the builder an instance is one block: its inner blocks are drawn but not selectable.
      const { 'data-cn': _cn, ...attrs } = a as typeof a & { 'data-cn'?: string };
      return (
        <div {...attrs} data-component-instance="">
          <BlockRenderer node={expanded} ctx={{ ...ctx, editing: false }} parent={parent} />
        </div>
      );
    }

    case 'hero': {
      const bg = ctx.media[str(p.mediaId)];
      const align = str(p.align, 'center');
      const hasMedia = Boolean(bg || str(p.imageUrl) || str(p.videoUrl));
      const overlay = hasMedia ? str(p.overlay, 'dark') : 'none';
      return (
        <section {...a} className={`relative isolate overflow-hidden ${hasMedia ? (overlay === 'dark' ? 'bg-black text-white' : 'bg-site-muted') : 'bg-site-muted'}`}>
          {bg ? <Picture media={bg} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover" sizes="100vw" priority /> : str(p.imageUrl) && <ExternalImage src={str(p.imageUrl)} className="absolute inset-0 -z-10 h-full w-full object-cover" priority />}
          {str(p.videoUrl) && <BackgroundVideo src={str(p.videoUrl)} poster={str(p.imageUrl) || undefined} editing={Boolean(ctx.editing)} />}
          {overlay !== 'none' && <div aria-hidden className={`absolute inset-0 -z-10 ${overlay === 'dark' ? 'bg-black/55' : 'bg-white/60'}`} />}
          <div className={`mx-auto max-w-4xl px-6 py-24 @3xl:py-32 ${ALIGN[align]}`}>
            {str(p.eyebrow) && <p {...F('eyebrow')} className="mb-4 text-sm font-semibold uppercase tracking-wider text-site-primary">{str(p.eyebrow)}</p>}
            <h1 {...F('title')} className="text-4xl font-bold tracking-tight @3xl:text-6xl">{str(p.title)}</h1>
            {str(p.subtitle) && <p {...F('subtitle')} className="mt-6 text-lg opacity-80 @3xl:text-xl">{str(p.subtitle)}</p>}
            {str(p.ctaLabel) && (
              <div className={`mt-10 flex ${FLEX_ALIGN[align]}`}>
                <CtaLink href={str(p.ctaHref, '/')} variant="primary" label={str(p.ctaLabel)} field={F('ctaLabel')} />
              </div>
            )}
          </div>
        </section>
      );
    }

    case 'heading': {
      const level = Number(p.level) || 2;
      const size = level === 1 ? 'text-4xl @3xl:text-5xl' : level === 2 ? 'text-3xl' : level === 3 ? 'text-2xl' : 'text-xl';
      const H = `h${Math.min(Math.max(level, 1), 4)}` as 'h1';
      return (
        <H {...a} {...F('text')} className={`mx-auto max-w-3xl px-6 font-bold tracking-tight ${size} ${ALIGN[str(p.align, 'left')]}`}>
          {str(p.text)}
        </H>
      );
    }

    case 'text':
      return (
        <div {...a} {...F('doc')} className={`mx-auto max-w-3xl px-6 text-lg leading-relaxed ${ALIGN[str(p.align, 'left')]}`}>
          <RichText doc={p.doc as RichTextDoc} facts={ctx.facts} showMissing={ctx.draft || Boolean(ctx.editing)} />
        </div>
      );

    case 'image': {
      const m = ctx.media[str(p.mediaId)];
      if (!m && !str(p.src)) return ctx.draft || ctx.editing ? <Placeholder a={a} label={label(ctx, 'chooseImage')} tall /> : null;
      const ratio = str(p.ratio, 'auto');
      const cropped = ratio !== 'auto';
      const fit = `${str(p.fit) === 'contain' ? 'object-contain' : 'object-cover'} ${IMAGE_FOCUS_CLASS[str(p.focus, 'center')] ?? ''}`;
      const round = p.rounded === false ? '' : 'rounded-site';
      const overlay = IMAGE_OVERLAY[str(p.overlay, 'none')];
      const img = m ? (
        <Picture media={m} alt={str(p.alt) || m.alt || ''} className={cropped ? `absolute inset-0 h-full w-full ${fit}` : round} sizes="(min-width: 1024px) 960px, 100vw" />
      ) : (
        <ExternalImage src={str(p.src)} alt={str(p.alt)} className={`h-full w-full ${fit} ${cropped ? 'absolute inset-0' : round}`} />
      );
      return (
        <figure {...a} className="mx-auto max-w-5xl px-6">
          {cropped || overlay ? (
            <div className={`relative overflow-hidden ${round}`} style={cropped ? { aspectRatio: ratio.replace('/', ' / ') } : undefined}>
              {img}
              {overlay && <div aria-hidden className={`pointer-events-none absolute inset-0 ${overlay}`} />}
            </div>
          ) : (
            img
          )}
          {str(p.caption) && <figcaption {...F('caption')} className="mt-2 text-center text-sm opacity-70">{str(p.caption)}</figcaption>}
        </figure>
      );
    }

    case 'video': {
      const file = str(p.fileUrl);
      if (file) {
        const loop = p.autoplay === true;
        return (
          <div {...a} className="mx-auto max-w-4xl px-6">
            <video src={file} title={str(p.title) || undefined} className="aspect-video w-full rounded-site bg-black object-cover" preload="metadata" playsInline {...(loop ? { autoPlay: !ctx.editing, muted: true, loop: true } : { controls: !ctx.editing })} />
          </div>
        );
      }
      const src = videoEmbedUrl(str(p.url));
      if (!src) return ctx.draft || ctx.editing ? <Placeholder a={a} label={label(ctx, 'pasteVideo')} tall /> : null;
      return (
        <div {...a} className="mx-auto max-w-4xl px-6">
          <div className="relative aspect-video overflow-hidden rounded-site bg-black">
            <iframe
              src={src}
              title={str(p.title) || 'Video'}
              loading="lazy"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              className={`absolute inset-0 h-full w-full ${ctx.editing ? 'pointer-events-none' : ''}`}
            />
          </div>
        </div>
      );
    }

    case 'button':
      return (
        <div {...a} className={`mx-auto flex max-w-3xl px-6 ${FLEX_ALIGN[str(p.align, 'left')]}`}>
          <CtaLink href={str(p.href, '/')} variant={str(p.variant, 'primary')} label={str(p.label)} field={F('label')} size={str(p.size, 'md')} />
        </div>
      );

    case 'cta': {
      const tone = str(p.tone, 'primary');
      return (
        <div {...a} className="mx-auto max-w-5xl px-6">
          <div className={`rounded-site px-8 py-14 text-center @3xl:px-16 ${TONE[tone] ?? TONE.primary}`}>
            <h2 {...F('title')} className="text-3xl font-bold tracking-tight @3xl:text-4xl">{str(p.title)}</h2>
            {str(p.text) && <p {...F('text')} className="mx-auto mt-4 max-w-2xl text-lg opacity-90">{str(p.text)}</p>}
            <div className="mt-8 flex justify-center">
              <CtaLink href={str(p.buttonHref, '/')} variant={tone === 'primary' ? 'inverse' : 'primary'} label={str(p.buttonLabel)} field={F('buttonLabel')} />
            </div>
          </div>
        </div>
      );
    }

    case 'features': {
      const items = list<{ title?: string; text?: string }>(p.items);
      return (
        <div {...a} className="mx-auto max-w-6xl px-6">
          {str(p.title) && <h2 {...F('title')} className="mb-10 text-center text-3xl font-bold tracking-tight">{str(p.title)}</h2>}
          <div className={`grid grid-cols-1 gap-6 ${FEATURE_COLS[Number(p.columns) || 3] ?? FEATURE_COLS[3]}`}>
            {items.map((f, i) => (
              <div key={i} className="rounded-site border border-site-fg/10 bg-site-bg p-6 text-site-fg">
                <div className="mb-4 h-9 w-9 rounded-site bg-site-primary/15" aria-hidden />
                <h3 {...F(`items.${i}.title`)} className="text-lg font-semibold">{str(f.title)}</h3>
                {str(f.text) && <p {...F(`items.${i}.text`)} className="mt-2 opacity-75">{str(f.text)}</p>}
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'stats': {
      const items = list<{ value?: string; label?: string }>(p.items);
      return (
        <dl {...a} className={`mx-auto grid max-w-5xl grid-cols-1 gap-8 px-6 text-center ${STATS_COLS[Math.min(items.length, 6)] ?? ''}`}>
          {items.map((s, i) => (
            <div key={i}>
              <dt className="sr-only">{str(s.label)}</dt>
              <dd {...F(`items.${i}.value`)} className="text-4xl font-bold tracking-tight text-site-primary">{str(s.value)}</dd>
              <dd {...F(`items.${i}.label`)} className="mt-1 text-sm uppercase tracking-wide opacity-70">{str(s.label)}</dd>
            </div>
          ))}
        </dl>
      );
    }

    case 'faq': {
      const items = list<{ q?: string; a?: string }>(p.items);
      // <details> works without JS and is indexable; the builder keeps every answer expanded.
      return (
        <div {...a} className="mx-auto max-w-3xl px-6">
          {str(p.title) && <h2 {...F('title')} className="mb-8 text-3xl font-bold tracking-tight">{str(p.title)}</h2>}
          <div className="divide-y divide-site-fg/10 border-y border-site-fg/10">
            {items.map((f, i) => (
              <details key={i} className="group py-4" open={ctx.editing || undefined}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                  <span {...F(`items.${i}.q`)}>{str(f.q)}</span>
                  <span className="text-xl leading-none transition-transform group-open:rotate-45" aria-hidden>
                    +
                  </span>
                </summary>
                <p {...F(`items.${i}.a`)} className="mt-3 whitespace-pre-line opacity-80">{str(f.a)}</p>
              </details>
            ))}
          </div>
        </div>
      );
    }

    case 'quote':
      return (
        <figure {...a} className="mx-auto max-w-3xl px-6">
          <blockquote className="border-l-4 border-site-primary pl-6 text-2xl font-medium leading-snug">
            “<span {...F('text')}>{str(p.text)}</span>”
          </blockquote>
          {(str(p.author) || str(p.role)) && (
            <figcaption className="mt-4 pl-7 text-sm opacity-70">
              {str(p.author)}
              {str(p.author) && str(p.role) ? ', ' : ''}
              {str(p.role)}
            </figcaption>
          )}
        </figure>
      );

    case 'testimonial': {
      const photo = ctx.media[str(p.mediaId)];
      return (
        <figure {...a} className="mx-auto max-w-3xl px-6 text-center">
          <blockquote className="text-xl leading-relaxed @3xl:text-2xl">
            “<span {...F('quote')}>{str(p.quote)}</span>”
          </blockquote>
          <figcaption className="mt-6 flex items-center justify-center gap-3">
            {photo && <Picture media={photo} alt={str(p.name)} className="h-12 w-12 rounded-full object-cover" sizes="48px" />}
            <span className="text-left">
              <span {...F('name')} className="block font-semibold">{str(p.name)}</span>
              {str(p.role) && <span {...F('role')} className="block text-sm opacity-70">{str(p.role)}</span>}
            </span>
          </figcaption>
        </figure>
      );
    }

    case 'spacer':
      return <div {...a} aria-hidden className={SPACER[str(p.size, 'md')] ?? SPACER.md} />;

    case 'icon': {
      const Icon = ICONS[str(p.name, 'star') as IconName] ?? ICONS.star;
      const size = ICON_SIZE[str(p.size, 'md')] ?? ICON_SIZE.md!;
      const color = ICON_TONE[str(p.tone, 'primary')] ?? ICON_TONE.primary;
      const lbl = str(p.label);
      return (
        <div {...a} className={`mx-auto flex max-w-3xl px-6 ${FLEX_ALIGN[str(p.align, 'left')]}`}>
          <span className={`inline-grid place-items-center ${color} ${p.circle ? `${size.circle} rounded-full [background-color:color-mix(in_srgb,currentColor_12%,transparent)]` : ''}`} {...(lbl ? { role: 'img', 'aria-label': lbl } : { 'aria-hidden': true })}>
            <Icon className={size.icon} strokeWidth={1.75} aria-hidden />
          </span>
        </div>
      );
    }

    case 'badge':
      return (
        <div {...a} className={`mx-auto flex max-w-3xl px-6 ${FLEX_ALIGN[str(p.align, 'left')]}`}>
          <span {...F('text')} className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold tracking-wide ${BADGE_TONE[str(p.tone, 'primary')] ?? BADGE_TONE.primary}`}>
            {str(p.text)}
          </span>
        </div>
      );

    case 'list': {
      const items = Array.isArray(p.items) ? (p.items as { text?: string }[]) : [];
      const marker = str(p.marker, 'check');
      const L = marker === 'number' ? 'ol' : 'ul';
      return (
        <div {...a} className={`mx-auto max-w-3xl px-6 ${ALIGN[str(p.align, 'left')]}`}>
          <L className={`space-y-2 text-lg leading-relaxed ${marker === 'bullet' ? 'list-disc pl-6' : marker === 'number' ? 'list-decimal pl-6' : ''} ${str(p.align) === 'center' ? 'inline-block text-left' : ''}`}>
            {items.map((it, i) => (
              <li key={i} className={marker === 'check' ? 'flex items-start gap-2' : ''}>
                {marker === 'check' && <ICONS.check className="mt-1.5 h-4 w-4 shrink-0 text-site-primary" strokeWidth={2.5} aria-hidden />}
                <span {...F(`items.${i}.text`)}>{it.text ?? ''}</span>
              </li>
            ))}
          </L>
        </div>
      );
    }

    case 'divider':
      return (
        <div {...a} className="mx-auto max-w-5xl px-6">
          <hr className={`border-t border-site-fg/15 ${str(p.style) === 'dashed' ? 'border-dashed' : str(p.style) === 'dotted' ? 'border-dotted' : ''}`} />
        </div>
      );

    case 'form': {
      const form = ctx.forms?.[str(p.formId)];
      if (!form || !form.isActive)
        return ctx.draft || ctx.editing ? (
          <Placeholder
            a={a}
            label={label(ctx, str(p.formId) ? 'formMissing' : 'chooseForm')}
          />
        ) : null;
      return (
        <FormView
          form={form}
          title={str(p.title)}
          intro={str(p.intro)}
          submitLabel={str(p.submitLabel, 'Send')}
          layout={str(p.layout, 'card')}
          inert={Boolean(ctx.editing)}
          attrs={a as Record<string, string>}
        />
      );
    }

    case 'buy': {
      const id = str(p.productId);
      const prod = ctx.products?.[id];
      const align = FLEX_ALIGN[str(p.align, 'left')] ?? FLEX_ALIGN.left;
      if (!prod) {
        if (!ctx.draft && !ctx.editing) return null;
        // On a product template the id is a token: show what the block will look like.
        return id.startsWith('{{') ? (
          <div {...a} className={`mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-6 ${align}`}>
            <span className="text-2xl font-bold opacity-60">€ —</span>
            <span className="rounded-site bg-site-primary px-6 py-3 font-semibold text-site-on-primary opacity-80">{str(p.label, 'Add to cart')}</span>
            <span className="w-full text-xs opacity-60">{label(ctx, 'buyTemplate')}</span>
          </div>
        ) : (
          <Placeholder a={a} label={label(ctx, 'buyMissing')} />
        );
      }
      const stockText = prod.stock === null ? '' : prod.available ? label(ctx, 'inStock').replace('{count}', String(prod.stock)) : label(ctx, 'soldOut');
      return (
        <div {...a} data-canon-buy={prod.id} data-title={prod.title} data-price={prod.price} data-currency={prod.currency} className={`mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-6 ${align}`}>
          {p.showPrice !== false && <span className="text-2xl font-bold">{formatMoney(prod.price, prod.currency, ctx.locale)}</span>}
          <button type="button" data-canon-add="" disabled={!prod.available || Boolean(ctx.editing)} className="rounded-site bg-site-primary px-6 py-3 font-semibold text-site-on-primary shadow hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {prod.available ? str(p.label, 'Add to cart') : label(ctx, 'soldOut')}
          </button>
          {p.showStock !== false && stockText && <span className="text-sm opacity-70">{stockText}</span>}
        </div>
      );
    }

    case 'cart': {
      if (!ctx.shop) return ctx.draft || ctx.editing ? <Placeholder a={a} label={label(ctx, 'noShop')} /> : null;
      if (ctx.editing) return <Placeholder a={a} label={`${str(p.title)} — ${label(ctx, 'cartPreview')}`} tall />;
      // The site's shop script fills this in (the cart lives in the visitor's browser).
      const config = { ...ctx.shop, locale: ctx.locale ?? 'en', title: str(p.title), emptyText: str(p.emptyText), checkoutLabel: str(p.checkoutLabel, 'Place order'), successText: str(p.successText), askAddress: p.askAddress !== false };
      return (
        <section {...a} id="cart" data-canon-cart={JSON.stringify(config)} className="mx-auto max-w-3xl px-6">
          <h2 className="mb-6 text-3xl font-bold tracking-tight">{str(p.title)}</h2>
          {/* Shown until the shop script takes over (and without JavaScript). */}
          <p data-canon-cart-fallback="" className="opacity-70">
            {str(p.emptyText)}
          </p>
          <div data-canon-cart-root="" />
        </section>
      );
    }

    case 'collection-list': {
      if (!str(p.collection)) return ctx.draft || ctx.editing ? <Placeholder a={a} label={label(ctx, 'chooseCollection')} /> : null;
      const items = ctx.lists?.[node.id] ?? [];
      const grid = str(p.layout, 'grid') === 'grid';
      const showDate = p.showDate !== false;
      return (
        <div {...a} className="mx-auto max-w-6xl px-6">
          {str(p.title) && <h2 {...F('title')} className="mb-8 text-3xl font-bold tracking-tight">{str(p.title)}</h2>}
          {items.length === 0 ? (
            <p {...F('emptyText')} className="rounded-site border border-dashed border-site-fg/20 p-8 text-center opacity-70">
              {ctx.editing ? label(ctx, 'noEntries') : str(p.emptyText)}
            </p>
          ) : (
            <ul className={grid ? `grid grid-cols-1 gap-6 ${FEATURE_COLS[Number(p.columns) || 3] ?? FEATURE_COLS[3]}` : 'divide-y divide-site-fg/10'}>
              {items.map((it) => {
                const m = it.mediaId ? ctx.media[it.mediaId] : undefined;
                const img = m ? <Picture media={m} alt="" className="aspect-[16/10] object-cover" sizes={grid ? '(min-width: 1024px) 380px, 100vw' : '240px'} /> : it.imageUrl ? <ExternalImage src={it.imageUrl} className="aspect-[16/10] h-full w-full object-cover" /> : null;
                const title = it.path && !ctx.editing ? <a href={it.path} className="hover:underline">{it.title}</a> : it.title;
                return (
                  <li key={it.id} className={grid ? 'flex flex-col overflow-hidden rounded-site border border-site-fg/10 bg-site-bg' : 'flex gap-5 py-5'}>
                    {img && <div className={grid ? 'overflow-hidden' : 'w-40 shrink-0 overflow-hidden rounded-site'}>{img}</div>}
                    <div className={grid ? 'flex flex-1 flex-col p-5' : 'min-w-0 flex-1'}>
                      {showDate && it.date && <time dateTime={it.date} className="text-xs uppercase tracking-wide opacity-60">{it.date}</time>}
                      <h3 className="mt-1 text-lg font-semibold">{title}</h3>
                      {it.text && <p className="mt-2 opacity-75">{it.text}</p>}
                      {it.path && str(p.linkLabel) && (
                        <a href={ctx.editing ? undefined : it.path} className="mt-auto pt-4 text-sm font-semibold text-site-primary" aria-label={`${str(p.linkLabel)}: ${it.title}`}>
                          {str(p.linkLabel)} →
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      );
    }

    default:
      // Registered-but-unrendered types (plugins, later phases) are visible only in preview/builder.
      return ctx.draft || ctx.editing ? <Placeholder a={a} label={label(ctx, 'noRenderer').replace('{type}', node.type)} /> : null;
  }
}

const BUTTON_PAD: Record<string, string> = { sm: 'px-4 py-2 text-sm', md: 'px-6 py-3', lg: 'px-8 py-4 text-lg' };

function CtaLink({ href, label, variant, field, size = 'md' }: { href: string; label: string; variant: string; field?: object; size?: string }) {
  const external = /^https?:/i.test(href);
  const pad = BUTTON_PAD[size] ?? BUTTON_PAD.md;
  const cls =
    variant === 'link'
      ? `font-semibold text-site-primary underline-offset-4 hover:underline ${size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-lg' : ''}`
      : variant === 'secondary'
        ? `rounded-site border border-current ${pad} font-semibold hover:bg-site-fg/5`
        : variant === 'inverse'
          ? `rounded-site bg-white ${pad} font-semibold text-site-primary shadow hover:opacity-90`
          : `rounded-site bg-site-primary ${pad} font-semibold text-site-on-primary shadow hover:opacity-90`;
  return (
    <a href={href} data-canon-event="cta_click" data-cn-el="" className={`inline-block ${cls}`} {...(external ? { rel: 'noopener noreferrer' } : {})} {...field}>
      {label}
    </a>
  );
}

/** <picture> with AVIF then WebP sources; intrinsic size reserves space (no layout shift). */
export function Picture({
  media,
  alt,
  className,
  sizes,
  priority = false,
}: {
  media: RenderMedia;
  alt: string;
  className?: string;
  sizes: string;
  priority?: boolean;
}) {
  const sources = media.variants?.sources ?? [];
  const set = (format: 'avif' | 'webp') =>
    sources
      .filter((s) => s.format === format)
      .map((s) => `${s.url} ${s.width}w`)
      .join(', ');
  const fallback = sources.filter((s) => s.format === 'webp').at(-1)?.url ?? media.url;
  return (
    <picture>
      {set('avif') && <source type="image/avif" srcSet={set('avif')} sizes={sizes} />}
      {set('webp') && <source type="image/webp" srcSet={set('webp')} sizes={sizes} />}
      <img
        src={fallback}
        alt={alt}
        width={media.width ?? undefined}
        height={media.height ?? undefined}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : undefined}
        decoding="async"
        className={`h-auto w-full ${className ?? ''}`}
        style={media.dominantColor ? { backgroundColor: media.dominantColor } : undefined}
      />
    </picture>
  );
}

/**
 * A stock photo by link (allow-listed hosts, validated on save). Lazy unless it is the first
 * screen; decoding async so a large photo doesn't block the page.
 */
function ExternalImage({ src, alt = '', className, priority = false }: { src: string; alt?: string; className?: string; priority?: boolean }) {
  return <img src={src} alt={alt} className={className} loading={priority ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" />;
}

/**
 * A silent looping background video. It only loads metadata until it plays, sits behind the
 * content, and is hidden for people who prefer reduced motion (the poster stays). In the builder
 * it shows the first frame instead of playing, so editing stays calm.
 */
function BackgroundVideo({ src, poster, editing }: { src: string; poster?: string; editing: boolean }) {
  return <video aria-hidden src={src} poster={poster} className="absolute inset-0 -z-10 h-full w-full object-cover motion-reduce:hidden" preload="metadata" muted loop playsInline autoPlay={!editing} />;
}

function Placeholder({ a, label, tall = false }: { a: object; label: string; tall?: boolean }) {
  return (
    <div {...a} className="mx-auto max-w-3xl px-6">
      <div className={`flex items-center justify-center rounded-site border-2 border-dashed border-current/25 p-4 text-center text-sm opacity-60 ${tall ? 'aspect-video' : ''}`}>{label}</div>
    </div>
  );
}

function EmptyContainer({ label }: { label: string }) {
  return <div className="flex min-h-24 items-center justify-center rounded border-2 border-dashed border-current/20 p-6 text-center text-sm opacity-50">{label}</div>;
}

/**
 * The compiled responsive styles of every node in the tree, as one <style> element. Values were
 * whitelisted by the style layer on save and are re-checked by the compiler, and none may contain
 * '<', so the CSS cannot break out of the element.
 */
export function PageStyles({ root }: { root: BlockNode }): ReactNode {
  const css = compileStyles(root);
  const animated = usesAnimation(root);
  const all = [animated ? ANIMATION_CSS : '', css].filter(Boolean).join('\n');
  return all ? <style data-canon-styles="" dangerouslySetInnerHTML={{ __html: all }} /> : null;
}

/** True when any block animates (entrance or hover): only then the page carries the animation CSS. */
export function usesAnimation(root: BlockNode): boolean {
  const walk = (n: BlockNode): boolean => Boolean(n.animation?.type || n.animation?.hover) || n.children.some(walk);
  return walk(root);
}

/** True when a block enters on scroll: the page then needs the small observer script. */
export function usesScrollAnimation(root: BlockNode): boolean {
  const walk = (n: BlockNode): boolean => (Boolean(n.animation?.type) && (n.animation?.trigger ?? 'scroll') === 'scroll') || n.children.some(walk);
  return walk(root);
}
