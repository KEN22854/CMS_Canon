'use client';

import { getSectionPreset, PAGE_TEMPLATES, STOCK_PHOTOS, type BlockNode, type ResponsiveStyles } from '@canon/blocks';
import { useDraggable } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlignLeft,
  Badge as BadgeIcon,
  Boxes,
  Columns3,
  Component,
  FileText,
  Film,
  Grid2x2,
  Heading,
  Image as ImageIcon,
  LayoutGrid,
  LayoutPanelTop,
  Link2,
  List,
  ListOrdered,
  Minus,
  MousePointerClick,
  MoveVertical,
  PanelBottom,
  PanelTop,
  Pilcrow,
  Quote,
  Rows3,
  Search,
  ShoppingBag,
  Sparkle,
  Square,
  SquareDashed,
  Star,
  StretchHorizontal,
  Type,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { useComponents } from '@/lib/components';
import { uploadMedia, useMedia } from '@/lib/content';
import { useLocale, useT, translate, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { cloneWithIds, newBlock } from '../../editor/tree-ops';
import { GenerateBlock } from '../palette';
import { SectionLibrary } from '../sections';
import { useBuilder } from '../store';

/**
 * The board's library: everything that can go on a page, by kind — layout containers, single
 * elements, ready components, templates and the site's media. Click adds next to the selection;
 * drag drops exactly where the indicator shows on the artboard (or in Layers). Every entry is a
 * tree of regular blocks, so what lands is editable with the usual tools.
 */

type Tab = 'layout' | 'elements' | 'components' | 'templates' | 'media';
const TABS: { id: Tab; icon: LucideIcon }[] = [
  { id: 'layout', icon: LayoutGrid },
  { id: 'elements', icon: Type },
  { id: 'components', icon: Component },
  { id: 'templates', icon: LayoutPanelTop },
  { id: 'media', icon: ImageIcon },
];

const node = (type: string, props: Record<string, unknown> = {}, styles?: ResponsiveStyles, children: BlockNode[] = [], name?: string): BlockNode => {
  const b = newBlock(type);
  return { ...b, props: { ...b.props, ...props }, ...(styles ? { styles } : {}), ...(children.length ? { children } : {}), ...(name ? { name } : {}) };
};
const doc = (...paras: string[]) => ({ type: 'doc', content: paras.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) });

interface Entry {
  key: string;
  icon: LucideIcon;
  /** Message key of the name; the block registry name is the fallback. */
  label: MessageKey;
  build: () => BlockNode;
}

const LAYOUT: Entry[] = [
  { key: 'section', icon: PanelTop, label: 'board.lib.section', build: () => node('section') },
  { key: 'container', icon: SquareDashed, label: 'board.lib.container', build: () => node('group', { layout: 'stack', gap: 'md' }, { base: { width: '100%', maxWidth: '1200px', marginLeft: 'auto', marginRight: 'auto', paddingLeft: '24px', paddingRight: '24px' } }, [], 'Container') },
  { key: 'grid', icon: Grid2x2, label: 'board.lib.grid', build: () => node('group', { layout: 'grid', columns: 3, gap: 'md' }, undefined, [], 'Grid') },
  { key: 'flex', icon: StretchHorizontal, label: 'board.lib.flex', build: () => node('group', { layout: 'row', gap: 'md', align: 'center' }, undefined, [], 'Flexbox') },
  { key: 'columns', icon: Columns3, label: 'board.lib.columns', build: () => newBlock('row') },
  { key: 'rows', icon: Rows3, label: 'board.lib.rows', build: () => node('group', { layout: 'stack', gap: 'lg' }, undefined, [], 'Rows') },
  { key: 'stack', icon: AlignLeft, label: 'board.lib.stack', build: () => node('group', { layout: 'stack', gap: 'sm' }, undefined, [], 'Stack') },
  { key: 'spacer', icon: MoveVertical, label: 'board.lib.spacer', build: () => node('spacer') },
  { key: 'freeform', icon: Square, label: 'board.lib.freeform', build: () => node('canvas') },
];

const ELEMENTS: Entry[] = [
  { key: 'heading', icon: Heading, label: 'board.lib.heading', build: () => node('heading') },
  { key: 'paragraph', icon: Pilcrow, label: 'board.lib.paragraph', build: () => node('text', { doc: doc('Write a short paragraph that explains the idea in one or two sentences.') }) },
  { key: 'richtext', icon: FileText, label: 'board.lib.richtext', build: () => node('text', { doc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'A subheading' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Text with ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'bold' }, { type: 'text', text: ' and ' }, { type: 'text', marks: [{ type: 'italic' }], text: 'italic' }, { type: 'text', text: ' words.' }] }, { type: 'bulletList', content: ['First point', 'Second point'].map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) }] } }) },
  { key: 'button', icon: MousePointerClick, label: 'board.lib.button', build: () => node('button') },
  { key: 'link', icon: Link2, label: 'board.lib.link', build: () => node('button', { label: 'Read more →', variant: 'link' }, undefined, [], 'Link') },
  { key: 'image', icon: ImageIcon, label: 'board.lib.image', build: () => node('image', { src: STOCK_PHOTOS.workspace, alt: '' }) },
  { key: 'video', icon: Film, label: 'board.lib.video', build: () => node('video') },
  { key: 'icon', icon: Star, label: 'board.lib.icon', build: () => node('icon') },
  { key: 'divider', icon: Minus, label: 'board.lib.divider', build: () => node('divider') },
  { key: 'badge', icon: BadgeIcon, label: 'board.lib.badge', build: () => node('badge') },
  { key: 'list', icon: List, label: 'board.lib.list', build: () => node('list') },
  { key: 'numbered', icon: ListOrdered, label: 'board.lib.numbered', build: () => node('list', { marker: 'number' }) },
  { key: 'quote', icon: Quote, label: 'board.lib.quote', build: () => node('quote') },
  { key: 'shape', icon: Sparkle, label: 'board.lib.shape', build: () => node('shape') },
];

/** Ready components: section presets of the template library plus a few compositions of elements. */
const preset = (key: string, locale: string) => () => getSectionPreset(key)!.build(locale, 'light');
const productCard = (title: string, price: string, photo: string) =>
  node('group', { layout: 'stack', gap: 'sm' }, { base: { paddingTop: '16px', paddingBottom: '20px', paddingLeft: '16px', paddingRight: '16px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.08)', borderRadius: '16px', backgroundColor: 'token:background' } }, [node('image', { src: photo, ratio: '4/3' }), node('badge', { text: 'New' }), node('heading', { text: title, level: 3 }), node('text', { doc: doc(price) }), node('button', { label: 'Add to cart', href: '/shop' })], 'Product card');
const COMPONENTS = (locale: string): Entry[] => [
  { key: 'navbar', icon: PanelTop, label: 'board.lib.navbar', build: preset('header', locale) },
  { key: 'header', icon: PanelTop, label: 'board.lib.header', build: preset('header-centered', locale) },
  { key: 'hero', icon: LayoutPanelTop, label: 'board.lib.hero', build: preset('hero-split', locale) },
  { key: 'features', icon: Grid2x2, label: 'board.lib.features', build: preset('features-3', locale) },
  { key: 'pricing', icon: Columns3, label: 'board.lib.pricing', build: preset('pricing-3', locale) },
  { key: 'testimonials', icon: Quote, label: 'board.lib.testimonials', build: preset('testimonials-3', locale) },
  { key: 'faq', icon: List, label: 'board.lib.faq', build: preset('faq', locale) },
  { key: 'gallery', icon: ImageIcon, label: 'board.lib.gallery', build: preset('gallery', locale) },
  { key: 'contact', icon: FileText, label: 'board.lib.contact', build: preset('contact', locale) },
  { key: 'cta', icon: MousePointerClick, label: 'board.lib.cta', build: preset('cta-band', locale) },
  {
    key: 'products',
    icon: ShoppingBag,
    label: 'board.lib.products',
    build: () => node('section', { paddingY: 'lg', width: 'wide' }, undefined, [node('heading', { text: 'Bestsellers', level: 2 }), node('group', { layout: 'grid', columns: 3, gap: 'md' }, undefined, [productCard('Linen shirt', '$49', STOCK_PHOTOS.interior), productCard('Ceramic vase', '$32', STOCK_PHOTOS.plant), productCard('Desk lamp', '$75', STOCK_PHOTOS.workspace)])], 'Products'),
  },
  { key: 'blog', icon: Boxes, label: 'board.lib.blog', build: () => node('section', { paddingY: 'lg', width: 'wide' }, undefined, [node('heading', { text: 'From the blog', level: 2 }), node('collection-list')], 'Blog') },
  { key: 'footer', icon: PanelBottom, label: 'board.lib.footer', build: preset('footer', locale) },
];

export function BoardLibrary({ siteId, pageId, locale }: { siteId: string; pageId: string; locale: string }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('elements');
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const ui = useLocale();
  const match = (...texts: string[]) => !needle || texts.some((x) => x.toLowerCase().includes(needle));
  const components = useMemo(() => COMPONENTS(locale), [locale]);
  // Searching looks through every tab at once.
  const groups = useMemo(() => {
    const filter = (list: Entry[]) => list.filter((e) => match(translate(ui, e.label), e.key));
    return { layout: filter(LAYOUT), elements: filter(ELEMENTS), components: filter(components) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, ui, components]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-2">
        {/* Canon AI: describe a section, get real editable blocks (the same endpoint as the palette). */}
        {pageId && <GenerateBlock siteId={siteId} pageId={pageId} locale={locale} />}
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('board.lib.search')} aria-label={t('board.lib.search')} className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs" />
        </label>
        {!needle && (
          <div className="grid grid-cols-5 gap-0.5" role="tablist" aria-label={t('board.lib.label')}>
            {TABS.map(({ id, icon: Icon }) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} title={t(`board.lib.tab.${id}`)} className={cn('flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px]', tab === id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <Icon className="h-4 w-4" aria-hidden />
                <span className="w-full truncate">{t(`board.lib.tab.${id}`)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
        {(needle || tab === 'layout') && <Grid title={needle ? t('board.lib.tab.layout') : undefined} entries={groups.layout} />}
        {(needle || tab === 'elements') && <Grid title={needle ? t('board.lib.tab.elements') : undefined} entries={groups.elements} />}
        {(needle || tab === 'components') && (
          <>
            <Grid title={needle ? t('board.lib.tab.components') : undefined} entries={groups.components} wide />
            <SavedComponents siteId={siteId} filter={match} />
          </>
        )}
        {(needle || tab === 'templates') && (
          <>
            <PageTemplates locale={locale} filter={match} />
            <SectionLibrary locale={locale} filter={match} />
          </>
        )}
        {!needle && tab === 'media' && <MediaTab siteId={siteId} />}
        {needle && !groups.layout.length && !groups.elements.length && !groups.components.length && <p className="pt-4 text-center text-xs text-muted-foreground">{t('palette.noMatches', { q })}</p>}
      </div>
      <p className="border-t px-3 py-2 text-[10px] text-muted-foreground">{t('board.lib.hint')}</p>
    </div>
  );
}

function Grid({ title, entries, wide }: { title?: string; entries: Entry[]; wide?: boolean }) {
  const t = useT();
  if (!entries.length) return null;
  return (
    <div>
      {title && <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>}
      <div className={cn('grid gap-1.5', wide ? 'grid-cols-2' : 'grid-cols-3')}>
        {entries.map((e) => (
          <LibraryItem key={e.key} id={e.key} build={e.build} icon={e.icon} label={t(e.label)} />
        ))}
      </div>
    </div>
  );
}

/** One library entry: click inserts, drag places. The tree gets fresh ids every time it lands. */
function LibraryItem({ id, build, icon: Icon, label, children }: { id: string; build: () => BlockNode; icon?: LucideIcon; label: string; children?: ReactNode }) {
  const insert = useBuilder((s) => s.insert);
  const sample = useMemo(build, [build]);
  const drag = useDraggable({ id: `lib-${id}`, data: { kind: 'new', type: sample.type, node: sample } });
  return (
    <button
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      type="button"
      title={label}
      data-library-item={id}
      onClick={() => insert(cloneWithIds(build()))}
      className={cn('group flex flex-col items-center gap-1 rounded-lg border bg-card px-1 py-2 text-center text-[11px] font-medium leading-tight transition hover:-translate-y-px hover:border-primary hover:text-primary hover:shadow-sm', drag.isDragging && 'opacity-40')}
    >
      {children ?? (Icon && <Icon className="h-4 w-4 text-muted-foreground group-hover:text-primary" aria-hidden />)}
      <span className="line-clamp-2 w-full">{label}</span>
    </button>
  );
}

function SavedComponents({ siteId, filter }: { siteId: string; filter: (...texts: string[]) => boolean }) {
  const t = useT();
  const list = useComponents(siteId);
  const items = (list.data ?? []).filter((c) => filter(c.name, c.description ?? ''));
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('board.lib.saved')}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((c) => (
          <LibraryItem key={c.id} id={`component-${c.id}`} icon={Boxes} label={c.name} build={() => ({ ...newBlock('component'), props: { componentId: c.id, overrides: {} } })} />
        ))}
      </div>
    </div>
  );
}

function PageTemplates({ locale, filter }: { locale: string; filter: (...texts: string[]) => boolean }) {
  const t = useT();
  const applyMany = useBuilder((s) => s.applyMany);
  const root = useBuilder((s) => s.draft.content.root);
  const items = PAGE_TEMPLATES.filter((p) => filter(p.name, p.description));
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-0.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('board.lib.pages')}</p>
      <p className="mb-1.5 px-0.5 text-[10px] text-muted-foreground">{t('board.lib.pagesHint')}</p>
      <div className="grid grid-cols-2 gap-1">
        {items.map((p) => (
          <button
            key={p.key}
            type="button"
            title={p.description}
            onClick={() => {
              // One undo step for the whole page; appended after what is already there.
              const nodes = p.build(locale, 'light');
              const r = applyMany([{ op: 'NODE_INSERT', parentId: root.id, index: root.children.length, nodes }]);
              if (r.applied) toast.success(t('board.lib.pageAdded', { name: p.name, count: nodes.length }));
            }}
            className="rounded-md border border-dashed bg-card px-2 py-1.5 text-left text-[11px] font-medium hover:border-primary hover:text-primary"
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The site's media library: click or drag an image onto the page; upload new ones here. */
function MediaTab({ siteId }: { siteId: string }) {
  const t = useT();
  const [q, setQ] = useState('');
  const media = useMedia(siteId, q);
  const qc = useQueryClient();
  const tid = useTenantId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const images = (media.data ?? []).filter((m) => m.mimeType.startsWith('image/') && m.status !== 'FAILED');
  const upload = async (files: FileList) => {
    setBusy(true);
    try {
      for (const f of [...files].slice(0, 10)) await uploadMedia(siteId, f);
      void qc.invalidateQueries({ queryKey: ['media', tid, siteId] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('board.lib.mediaSearch')} aria-label={t('board.lib.mediaSearch')} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files?.length && void upload(e.target.files)} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:border-primary hover:text-primary disabled:opacity-50">
          <Upload className="h-3.5 w-3.5" /> {busy ? t('board.lib.uploading') : t('board.lib.upload')}
        </button>
      </div>
      {!images.length && <p className="py-6 text-center text-xs text-muted-foreground">{t('board.lib.noMedia')}</p>}
      <div className="grid grid-cols-2 gap-1.5">
        {images.map((m) => (
          <LibraryItem key={m.id} id={`media-${m.id}`} label={m.alt || m.originalName} build={() => node('image', { mediaId: m.id })}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.thumbnailUrl ?? m.url} alt="" loading="lazy" className="aspect-[4/3] w-full rounded object-cover" />
          </LibraryItem>
        ))}
      </div>
    </div>
  );
}
