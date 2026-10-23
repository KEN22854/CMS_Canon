import type { BlockNode, InlineNode, Mark, RichBlockNode, RichTextDoc } from '@canon/blocks';
import type { ReactNode } from 'react';
import type { DeliveryMedia } from '@/lib/delivery';

/**
 * Server components for the MVP block set. Props were validated (and defaulted) by the API on
 * save, so renderers trust shapes but still treat every string as text — nothing here injects HTML.
 */
export interface RenderContext {
  media: Record<string, DeliveryMedia>;
  facts: Record<string, string>;
  draft: boolean;
}

type P = Record<string, unknown>;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const ALIGN: Record<string, string> = { left: 'text-left', center: 'text-center mx-auto', right: 'text-right ml-auto' };
const FLEX_ALIGN: Record<string, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };
const PAD: Record<string, string> = { none: 'py-0', sm: 'py-6', md: 'py-12', lg: 'py-20', xl: 'py-32' };
const WIDTH: Record<string, string> = { narrow: 'max-w-2xl', default: 'max-w-5xl', wide: 'max-w-7xl', full: 'max-w-none' };
const BG: Record<string, string> = { default: 'bg-background text-foreground', muted: 'bg-muted text-foreground', primary: 'bg-primary text-white', dark: 'bg-foreground text-background' };

export function BlockRenderer({ node, ctx, isRoot = false }: { node: BlockNode; ctx: RenderContext; isRoot?: boolean }): ReactNode {
  const children = node.children.map((c) => <BlockRenderer key={c.id} node={c} ctx={ctx} />);
  const p = node.props as P;
  switch (node.type) {
    case 'section':
      // The root section frames the page; nested sections are full-bleed bands inside it.
      return (
        <section id={str(p.anchor) || undefined} className={`${BG[str(p.background, 'default')] ?? BG.default} ${PAD[str(p.paddingY, 'lg')] ?? ''}`}>
          <div className={`mx-auto px-6 ${isRoot ? 'max-w-none px-0' : (WIDTH[str(p.width, 'default')] ?? WIDTH.default)} space-y-6`}>{children}</div>
        </section>
      );
    case 'hero':
      return <Hero p={p} ctx={ctx} />;
    case 'heading': {
      const level = Number(p.level) || 2;
      const cls = `${ALIGN[str(p.align, 'left')]} font-bold tracking-tight ${level === 1 ? 'text-4xl md:text-5xl' : level === 2 ? 'text-3xl' : level === 3 ? 'text-2xl' : 'text-xl'}`;
      const H = `h${Math.min(Math.max(level, 1), 4)}` as 'h1';
      return <H className={`mx-auto max-w-3xl px-6 ${cls}`}>{str(p.text)}</H>;
    }
    case 'text':
      return (
        <div className={`mx-auto max-w-3xl px-6 text-lg leading-relaxed ${ALIGN[str(p.align, 'left')]}`}>
          <RichText doc={p.doc as RichTextDoc} facts={ctx.facts} />
        </div>
      );
    case 'image': {
      const m = ctx.media[str(p.mediaId)];
      if (!m) return ctx.draft ? <Missing label="Image not selected" /> : null;
      return (
        <figure className="mx-auto max-w-5xl px-6">
          <Picture media={m} alt={str(p.alt) || m.alt || ''} className={p.rounded === false ? '' : 'rounded-site'} sizes="(min-width: 1024px) 960px, 100vw" />
          {str(p.caption) && <figcaption className="mt-2 text-center text-sm opacity-70">{str(p.caption)}</figcaption>}
        </figure>
      );
    }
    case 'button':
      return (
        <div className={`mx-auto flex max-w-3xl px-6 ${FLEX_ALIGN[str(p.align, 'left')]}`}>
          <CtaLink href={str(p.href, '/')} variant={str(p.variant, 'primary')} label={str(p.label)} />
        </div>
      );
    default:
      // Blocks the renderer doesn't know yet (Phase 3, plugins) are visible only in preview.
      return ctx.draft ? <Missing label={`Block “${node.type}” is not rendered yet`} /> : null;
  }
}

function Hero({ p, ctx }: { p: P; ctx: RenderContext }) {
  const bg = ctx.media[str(p.mediaId)];
  const align = str(p.align, 'center');
  return (
    <section className="relative isolate overflow-hidden bg-muted">
      {bg && <Picture media={bg} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-40" sizes="100vw" priority />}
      <div className={`mx-auto max-w-4xl px-6 py-24 md:py-32 ${ALIGN[align]}`}>
        {str(p.eyebrow) && <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-primary">{str(p.eyebrow)}</p>}
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl">{str(p.title)}</h1>
        {str(p.subtitle) && <p className="mt-6 text-lg opacity-80 md:text-xl">{str(p.subtitle)}</p>}
        {str(p.ctaLabel) && (
          <div className={`mt-10 flex ${FLEX_ALIGN[align]}`}>
            <CtaLink href={str(p.ctaHref, '/')} variant="primary" label={str(p.ctaLabel)} />
          </div>
        )}
      </div>
    </section>
  );
}

function CtaLink({ href, label, variant }: { href: string; label: string; variant: string }) {
  const external = /^https?:/i.test(href);
  const cls =
    variant === 'link'
      ? 'font-semibold text-primary underline-offset-4 hover:underline'
      : variant === 'secondary'
        ? 'rounded-site border border-current px-6 py-3 font-semibold hover:bg-foreground/5'
        : 'rounded-site bg-primary px-6 py-3 font-semibold text-white shadow hover:opacity-90';
  return (
    <a href={href} className={`inline-block ${cls}`} {...(external ? { rel: 'noopener noreferrer' } : {})}>
      {label}
    </a>
  );
}

/** <picture> with AVIF then WebP sources; intrinsic size reserves space (no layout shift). */
function Picture({ media, alt, className, sizes, priority = false }: { media: DeliveryMedia; alt: string; className?: string; sizes: string; priority?: boolean }) {
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
      {/* eslint-disable-next-line @next/next/no-img-element -- variants are pre-generated; next/image would re-optimise them */}
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

export function RichText({ doc, facts }: { doc: RichTextDoc | undefined; facts: Record<string, string> }) {
  if (!doc?.content) return null;
  return <>{doc.content.map((b, i) => <RichBlock key={i} node={b} facts={facts} />)}</>;
}

function RichBlock({ node, facts }: { node: RichBlockNode; facts: Record<string, string> }): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p className="my-4">{inline(node.content, facts)}</p>;
    case 'heading': {
      const H = `h${node.attrs.level}` as 'h2';
      return <H className="mb-3 mt-8 font-bold">{inline(node.content, facts)}</H>;
    }
    case 'bulletList':
    case 'orderedList': {
      const L = node.type === 'bulletList' ? 'ul' : 'ol';
      return (
        <L className={`my-4 pl-6 ${node.type === 'bulletList' ? 'list-disc' : 'list-decimal'}`}>
          {node.content.map((li, i) => (
            <li key={i}>{li.content.map((c, j) => <RichBlock key={j} node={c} facts={facts} />)}</li>
          ))}
        </L>
      );
    }
    case 'blockquote':
      return <blockquote className="my-6 border-l-4 border-primary pl-4 italic">{node.content.map((c, j) => <RichBlock key={j} node={c} facts={facts} />)}</blockquote>;
  }
}

function inline(nodes: InlineNode[] | undefined, facts: Record<string, string>): ReactNode {
  return nodes?.map((n, i) => {
    if (n.type === 'hardBreak') return <br key={i} />;
    // Canon BOUND mention: value comes from the fact graph at publish time, never from stored text.
    if (n.type === 'factRef') return <span key={i} data-fact={n.attrs.factKey}>{facts[n.attrs.factKey] ?? ''}</span>;
    return <Marked key={i} text={n.text} marks={n.marks ?? []} />;
  });
}

function Marked({ text, marks }: { text: string; marks: Mark[] }): ReactNode {
  return marks.reduce<ReactNode>((acc, m) => {
    switch (m.type) {
      case 'bold':
        return <strong>{acc}</strong>;
      case 'italic':
        return <em>{acc}</em>;
      case 'code':
        return <code className="rounded bg-muted px-1">{acc}</code>;
      case 'strike':
        return <s>{acc}</s>;
      case 'link':
        return (
          <a href={m.attrs.href} target={m.attrs.target} rel={m.attrs.target === '_blank' ? 'noopener noreferrer' : undefined} className="text-primary underline">
            {acc}
          </a>
        );
    }
  }, text);
}

function Missing({ label }: { label: string }) {
  return <div className="mx-auto max-w-3xl rounded border-2 border-dashed border-current/30 p-4 text-center text-sm opacity-60">{label}</div>;
}
