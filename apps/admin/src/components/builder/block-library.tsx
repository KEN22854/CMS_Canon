'use client';

import { BLOCKS, PAGE_TEMPLATES, SECTION_CATEGORIES, SECTION_PRESETS, SECTION_TONES, type BlockNode, type SectionTone } from '@canon/blocks';
import type { VendorPreset } from '@canon/blocks/dist/vendor';
import { BlockRenderer, PageStyles, siteThemeStyle, type SiteThemeInput } from '@canon/ui-blocks';
import { Boxes, LayoutTemplate, Search, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useComponents } from '@/lib/components';
import { useLocale, translate, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { cloneWithIds, newBlock } from '../editor/tree-ops';
import { useBlockLabels } from './labels';
import { useBuilder, useBuilderStore } from './store';

type Category = 'pages' | 'basic' | (typeof SECTION_CATEGORIES)[number] | 'components';

interface Item {
  key: string;
  category: Category;
  name: string;
  search: string;
  build: () => BlockNode[];
  /** Page templates replace the page's blocks instead of inserting one. */
  page?: boolean;
  /** Converted from an open-source template: shown with its author and licence. */
  source?: VendorPreset['source'];
}

const TONE_SWATCH: Record<SectionTone, string> = {
  light: 'bg-white ring-1 ring-border',
  muted: 'bg-slate-200',
  dark: 'bg-slate-900',
  brand: 'bg-gradient-to-br from-[#8B7CFF] to-[#42C8E8]',
};
const HIDDEN_BASIC = new Set(['column', 'component']);

/**
 * The block library of the simple editor: categories on the left, real previews (the site's own
 * renderer and theme, scaled down) on the right. A click inserts the block at the "+" that opened
 * the library; page templates replace the whole page (undoable).
 */
export function BlockLibrary({ siteId, locale, theme }: { siteId: string; locale: string; theme: SiteThemeInput | undefined }) {
  const store = useBuilderStore();
  const library = useBuilder((s) => s.library);
  const L = useBlockLabels();
  const t = L.t;
  const ui = useLocale();
  const components = useComponents(siteId);
  const [cat, setCat] = useState<Category>('hero');
  const [tone, setTone] = useState<SectionTone>('light');
  const [q, setQ] = useState('');
  // ~250 converted open-source sections live in their own chunk, loaded when the library opens.
  const [vendor, setVendor] = useState<VendorPreset[]>([]);
  useEffect(() => {
    if (!library || vendor.length) return;
    let live = true;
    void import('@canon/blocks/dist/vendor').then((m) => m.loadVendorSections()).then((list) => live && setVendor(list));
    return () => {
      live = false;
    };
  }, [library, vendor.length]);

  useEffect(() => {
    if (!library) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && store.getState().closeLibrary();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [library, store]);

  const items = useMemo<Item[]>(() => {
    const name = (key: string, fallback: string) => translate(ui, key as MessageKey) || fallback;
    const out: Item[] = [];
    for (const p of PAGE_TEMPLATES) {
      const n = name(`pageTemplate.${p.key}`, p.name);
      out.push({ key: `page:${p.key}`, category: 'pages', name: n, search: `${n} ${p.name} ${p.description}`, build: () => p.build(locale, tone), page: true });
    }
    // Photo and video heroes lead their category: they are what people look for first.
    const media = (key: string) => (/^(hero-video|hero-photo|free-video)-/.test(key) ? 1 : 0);
    for (const p of [...SECTION_PRESETS].sort((a, b) => media(b.key) - media(a.key))) {
      const n = name(`section.${p.key}`, ui === 'ru' && p.nameRu ? p.nameRu : p.name);
      out.push({ key: p.key, category: p.category, name: n, search: `${n} ${p.name} ${p.description}`, build: () => [p.build(locale, tone)] });
    }
    for (const v of vendor) {
      const n = ui === 'ru' ? v.nameRu : v.name;
      out.push({ key: v.key, category: v.category as Category, name: n, search: `${n} ${v.name} ${v.source.name}`, build: () => [v.build(locale)], source: v.source });
    }
    for (const b of BLOCKS) {
      if (HIDDEN_BASIC.has(b.type)) continue;
      out.push({ key: `block:${b.type}`, category: 'basic', name: L.name(b.type), search: `${L.name(b.type)} ${b.name} ${b.description}`, build: () => [newBlock(b.type)] });
    }
    for (const c of components.data ?? []) {
      out.push({ key: `component:${c.id}`, category: 'components', name: c.name, search: c.name, build: () => [{ ...newBlock('component'), props: { componentId: c.id, overrides: {} } }] });
    }
    return out;
  }, [ui, locale, tone, L, components.data, vendor]);

  if (!library) return null;
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.search.toLowerCase().includes(needle)) : items.filter((i) => i.category === cat);
  const count = (c: Category) => items.filter((i) => i.category === c).length;
  const cats: Category[] = ['pages', ...SECTION_CATEGORIES, 'basic', ...(count('components') ? (['components'] as const) : [])];
  const catLabel = (c: Category) => (c === 'pages' ? t('library.pages') : c === 'basic' ? t('library.basic') : c === 'components' ? t('library.components') : t(`section.cat.${c}` as MessageKey));

  const pick = (item: Item) => {
    const s = store.getState();
    const root = s.draft.content.root;
    if (item.page) {
      if (root.children.length && !window.confirm(t('library.applyPageConfirm'))) return;
      s.setContent({ root: { ...root, children: item.build().map(cloneWithIds) } });
    } else {
      const [block] = item.build();
      s.insert(block!, { parentId: root.id, index: Math.min(library.index, root.children.length) });
    }
    s.closeLibrary();
  };

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label={t('library.title')}>
      <div className="flex h-full w-full max-w-[880px] flex-col border-r bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <LayoutTemplate className="h-5 w-5 text-primary" aria-hidden />
          <h2 className="font-semibold">{t('library.title')}</h2>
          <label className="relative ml-auto w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('library.search')} aria-label={t('library.search')} className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm" />
          </label>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t('library.tone')}>
            {SECTION_TONES.map((x) => (
              <button key={x} type="button" role="radio" aria-checked={tone === x} aria-label={t(`section.tone.${x}`)} title={t(`section.tone.${x}`)} onClick={() => setTone(x)} className={cn('h-5 w-5 rounded-full', TONE_SWATCH[x], tone === x && 'ring-2 ring-primary ring-offset-2 ring-offset-background')} />
            ))}
          </div>
          <button type="button" aria-label={t('library.close')} onClick={() => store.getState().closeLibrary()} className="rounded p-1.5 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="w-52 shrink-0 overflow-y-auto border-r p-2" aria-label={t('library.title')}>
            {cats.map((c) => (
              <button key={c} type="button" aria-current={!needle && cat === c ? 'true' : undefined} onClick={() => (setQ(''), setCat(c))} className={cn('flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm', !needle && cat === c ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <span className="flex items-center gap-1.5 truncate">
                  {c === 'components' && <Boxes className="h-3.5 w-3.5" aria-hidden />}
                  {catLabel(c)}
                </span>
                <span className="text-[11px] tabular-nums opacity-70">{count(c)}</span>
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {shown.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t('library.empty')}</p>}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {shown.map((item) => (
                <button key={`${item.key}:${tone}`} type="button" onClick={() => pick(item)} aria-label={item.page ? `${t('library.applyPage')}: ${item.name}` : t('library.insert', { name: item.name })} className="group overflow-hidden rounded-lg border bg-card text-left transition hover:border-primary hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary">
                  <Preview build={item.build} theme={theme} page={item.page} />
                  <span className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm font-medium group-hover:text-primary">
                    <span className="truncate">{item.name}</span>
                    {item.source && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground" title={`${item.source.url} · ${item.source.file}`}>
                        {item.source.name} · {item.source.license}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <button type="button" aria-label={t('library.close')} className="flex-1 bg-black/40 backdrop-blur-[1px]" onClick={() => store.getState().closeLibrary()} />
    </div>
  );
}

const PREVIEW_WIDTH = 1200;

/** The block drawn by the site renderer at desktop width, scaled into the card. */
const Preview = memo(function Preview({ build, theme, page }: { build: () => BlockNode[]; theme: SiteThemeInput | undefined; page?: boolean }) {
  const blocks = useMemo(build, [build]);
  const root = useMemo<BlockNode>(() => ({ id: 'preview-root', type: 'section', props: { background: 'default', paddingY: 'none', width: 'full', anchor: '' }, children: blocks }), [blocks]);
  // Desktop width scaled to the card, so the whole block is visible whatever the card's width.
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / PREVIEW_WIDTH || 0.3);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={cn('relative overflow-hidden bg-white', page ? 'h-72' : 'h-44')} aria-hidden>
      <div className="pointer-events-none origin-top-left" style={{ width: PREVIEW_WIDTH, zoom: scale }}>
        <div style={siteThemeStyle(theme)} className="font-site text-site-fg">
          <PageStyles root={root} />
          <BlockRenderer node={root} ctx={{ media: {}, facts: {}, draft: false }} isRoot />
        </div>
      </div>
    </div>
  );
});
