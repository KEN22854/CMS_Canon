import { videoEmbedUrl, type BlockNode, type RichTextDoc } from '@canon/blocks';
import type { CSSProperties, ReactNode } from 'react';
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
}

type P = Record<string, unknown>;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const ALIGN: Record<string, string> = { left: 'text-left', center: 'text-center mx-auto', right: 'text-right ml-auto' };
const FLEX_ALIGN: Record<string, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };
const PAD: Record<string, string> = { none: 'py-0', sm: 'py-6', md: 'py-12', lg: 'py-20', xl: 'py-32' };
const WIDTH: Record<string, string> = { narrow: 'max-w-2xl', default: 'max-w-5xl', wide: 'max-w-7xl', full: 'max-w-none' };
const BG: Record<string, string> = { default: 'bg-site-bg text-site-fg', muted: 'bg-site-muted text-site-fg', primary: 'bg-site-primary text-white', dark: 'bg-site-fg text-site-bg' };
const GAP: Record<string, string> = { sm: 'gap-4', md: 'gap-8', lg: 'gap-12' };
const V_ALIGN: Record<string, string> = { top: 'items-start', center: 'items-center', bottom: 'items-end' };
/** Row stacks vertically below its breakpoint; literal class strings so Tailwind can see them. */
const ROW_DIR: Record<string, string> = { sm: '@xl:flex-row', md: '@3xl:flex-row', lg: '@5xl:flex-row' };
const COL_BASIS: Record<string, string> = { sm: '@xl:basis-[var(--col)]', md: '@3xl:basis-[var(--col)]', lg: '@5xl:basis-[var(--col)]' };
const COL_WIDTH: Record<string, string> = { '1/4': '25%', '1/3': '33.333%', '1/2': '50%', '2/3': '66.667%', '3/4': '75%' };
const SPACER: Record<string, string> = { xs: 'h-4', sm: 'h-8', md: 'h-16', lg: 'h-24', xl: 'h-32' };
const STATS_COLS: Record<number, string> = { 1: '', 2: '@xl:grid-cols-2', 3: '@xl:grid-cols-3', 4: '@xl:grid-cols-2 @3xl:grid-cols-4', 5: '@xl:grid-cols-3 @4xl:grid-cols-5', 6: '@xl:grid-cols-3 @4xl:grid-cols-6' };
const FEATURE_COLS: Record<number, string> = { 2: '@2xl:grid-cols-2', 3: '@2xl:grid-cols-2 @4xl:grid-cols-3', 4: '@2xl:grid-cols-2 @5xl:grid-cols-4' };
const TONE: Record<string, string> = { primary: 'bg-site-primary text-white', muted: 'bg-site-muted text-site-fg', dark: 'bg-site-fg text-site-bg' };

const CONTAINERS = new Set(['section', 'row', 'column']);

export function BlockRenderer({ node, ctx, isRoot = false, parent }: { node: BlockNode; ctx: RenderContext; isRoot?: boolean; parent?: BlockNode }): ReactNode {
  const p = node.props as P;
  const a = ctx.editing ? { 'data-block-id': node.id, 'data-block-type': node.type, ...(CONTAINERS.has(node.type) ? { 'data-block-container': '' } : {}) } : {};
  const children = () =>
    node.children.length === 0 && ctx.editing ? (
      <EmptyContainer label={node.type === 'row' ? 'Add columns' : isRoot ? 'Drag blocks here, or generate a page with AI' : 'Drop blocks here'} />
    ) : (
      node.children.map((c) => <BlockRenderer key={c.id} node={c} ctx={ctx} parent={node} />)
    );

  switch (node.type) {
    case 'section':
      // The root section frames the page (and is the query container); nested sections are bands.
      return (
        <section {...a} id={str(p.anchor) || undefined} className={`${isRoot ? '@container min-h-full' : ''} ${BG[str(p.background, 'default')] ?? BG.default} ${PAD[str(p.paddingY, 'lg')] ?? ''}`}>
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

    case 'hero': {
      const bg = ctx.media[str(p.mediaId)];
      const align = str(p.align, 'center');
      return (
        <section {...a} className="relative isolate overflow-hidden bg-site-muted">
          {bg && <Picture media={bg} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-40" sizes="100vw" priority />}
          <div className={`mx-auto max-w-4xl px-6 py-24 @3xl:py-32 ${ALIGN[align]}`}>
            {str(p.eyebrow) && <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-site-primary">{str(p.eyebrow)}</p>}
            <h1 className="text-4xl font-bold tracking-tight @3xl:text-6xl">{str(p.title)}</h1>
            {str(p.subtitle) && <p className="mt-6 text-lg opacity-80 @3xl:text-xl">{str(p.subtitle)}</p>}
            {str(p.ctaLabel) && (
              <div className={`mt-10 flex ${FLEX_ALIGN[align]}`}>
                <CtaLink href={str(p.ctaHref, '/')} variant="primary" label={str(p.ctaLabel)} />
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
        <H {...a} className={`mx-auto max-w-3xl px-6 font-bold tracking-tight ${size} ${ALIGN[str(p.align, 'left')]}`}>
          {str(p.text)}
        </H>
      );
    }

    case 'text':
      return (
        <div {...a} className={`mx-auto max-w-3xl px-6 text-lg leading-relaxed ${ALIGN[str(p.align, 'left')]}`}>
          <RichText doc={p.doc as RichTextDoc} facts={ctx.facts} showMissing={ctx.draft || Boolean(ctx.editing)} />
        </div>
      );

    case 'image': {
      const m = ctx.media[str(p.mediaId)];
      if (!m) return ctx.draft || ctx.editing ? <Placeholder a={a} label="Choose an image" tall /> : null;
      return (
        <figure {...a} className="mx-auto max-w-5xl px-6">
          <Picture media={m} alt={str(p.alt) || m.alt || ''} className={p.rounded === false ? '' : 'rounded-site'} sizes="(min-width: 1024px) 960px, 100vw" />
          {str(p.caption) && <figcaption className="mt-2 text-center text-sm opacity-70">{str(p.caption)}</figcaption>}
        </figure>
      );
    }

    case 'video': {
      const src = videoEmbedUrl(str(p.url));
      if (!src) return ctx.draft || ctx.editing ? <Placeholder a={a} label="Paste a YouTube or Vimeo link" tall /> : null;
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
          <CtaLink href={str(p.href, '/')} variant={str(p.variant, 'primary')} label={str(p.label)} />
        </div>
      );

    case 'cta': {
      const tone = str(p.tone, 'primary');
      return (
        <div {...a} className="mx-auto max-w-5xl px-6">
          <div className={`rounded-site px-8 py-14 text-center @3xl:px-16 ${TONE[tone] ?? TONE.primary}`}>
            <h2 className="text-3xl font-bold tracking-tight @3xl:text-4xl">{str(p.title)}</h2>
            {str(p.text) && <p className="mx-auto mt-4 max-w-2xl text-lg opacity-90">{str(p.text)}</p>}
            <div className="mt-8 flex justify-center">
              <CtaLink href={str(p.buttonHref, '/')} variant={tone === 'primary' ? 'inverse' : 'primary'} label={str(p.buttonLabel)} />
            </div>
          </div>
        </div>
      );
    }

    case 'features': {
      const items = list<{ title?: string; text?: string }>(p.items);
      return (
        <div {...a} className="mx-auto max-w-6xl px-6">
          {str(p.title) && <h2 className="mb-10 text-center text-3xl font-bold tracking-tight">{str(p.title)}</h2>}
          <div className={`grid grid-cols-1 gap-6 ${FEATURE_COLS[Number(p.columns) || 3] ?? FEATURE_COLS[3]}`}>
            {items.map((f, i) => (
              <div key={i} className="rounded-site border border-site-fg/10 bg-site-bg p-6 text-site-fg">
                <div className="mb-4 h-9 w-9 rounded-site bg-site-primary/15" aria-hidden />
                <h3 className="text-lg font-semibold">{str(f.title)}</h3>
                {str(f.text) && <p className="mt-2 opacity-75">{str(f.text)}</p>}
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
              <dd className="text-4xl font-bold tracking-tight text-site-primary">{str(s.value)}</dd>
              <dd className="mt-1 text-sm uppercase tracking-wide opacity-70">{str(s.label)}</dd>
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
          {str(p.title) && <h2 className="mb-8 text-3xl font-bold tracking-tight">{str(p.title)}</h2>}
          <div className="divide-y divide-site-fg/10 border-y border-site-fg/10">
            {items.map((f, i) => (
              <details key={i} className="group py-4" open={ctx.editing || undefined}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                  {str(f.q)}
                  <span className="text-xl leading-none transition-transform group-open:rotate-45" aria-hidden>
                    +
                  </span>
                </summary>
                <p className="mt-3 whitespace-pre-line opacity-80">{str(f.a)}</p>
              </details>
            ))}
          </div>
        </div>
      );
    }

    case 'quote':
      return (
        <figure {...a} className="mx-auto max-w-3xl px-6">
          <blockquote className="border-l-4 border-site-primary pl-6 text-2xl font-medium leading-snug">“{str(p.text)}”</blockquote>
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
          <blockquote className="text-xl leading-relaxed @3xl:text-2xl">“{str(p.quote)}”</blockquote>
          <figcaption className="mt-6 flex items-center justify-center gap-3">
            {photo && <Picture media={photo} alt={str(p.name)} className="h-12 w-12 rounded-full object-cover" sizes="48px" />}
            <span className="text-left">
              <span className="block font-semibold">{str(p.name)}</span>
              {str(p.role) && <span className="block text-sm opacity-70">{str(p.role)}</span>}
            </span>
          </figcaption>
        </figure>
      );
    }

    case 'spacer':
      return <div {...a} aria-hidden className={SPACER[str(p.size, 'md')] ?? SPACER.md} />;

    case 'divider':
      return (
        <div {...a} className="mx-auto max-w-5xl px-6">
          <hr className={`border-t border-site-fg/15 ${str(p.style) === 'dashed' ? 'border-dashed' : str(p.style) === 'dotted' ? 'border-dotted' : ''}`} />
        </div>
      );

    default:
      // Registered-but-unrendered types (plugins, later phases) are visible only in preview/builder.
      return ctx.draft || ctx.editing ? <Placeholder a={a} label={`Block “${node.type}” has no renderer yet`} /> : null;
  }
}

function CtaLink({ href, label, variant }: { href: string; label: string; variant: string }) {
  const external = /^https?:/i.test(href);
  const cls =
    variant === 'link'
      ? 'font-semibold text-site-primary underline-offset-4 hover:underline'
      : variant === 'secondary'
        ? 'rounded-site border border-current px-6 py-3 font-semibold hover:bg-site-fg/5'
        : variant === 'inverse'
          ? 'rounded-site bg-white px-6 py-3 font-semibold text-site-primary shadow hover:opacity-90'
          : 'rounded-site bg-site-primary px-6 py-3 font-semibold text-white shadow hover:opacity-90';
  return (
    <a href={href} className={`inline-block ${cls}`} {...(external ? { rel: 'noopener noreferrer' } : {})}>
      {label}
    </a>
  );
}

/** <picture> with AVIF then WebP sources; intrinsic size reserves space (no layout shift). */
export function Picture({ media, alt, className, sizes, priority = false }: { media: RenderMedia; alt: string; className?: string; sizes: string; priority?: boolean }) {
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
