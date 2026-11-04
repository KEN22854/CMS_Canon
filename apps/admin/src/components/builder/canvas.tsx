'use client';

import { ANIMATION_CSS, compileStyles, expandComponents, STYLE_BREAKPOINTS, type BlockNode } from '@canon/blocks';
import { BlockRenderer, DEFAULT_RENDER_LABELS, siteThemeStyle, type BlockRendererProps, type RenderContext, type RenderLabels, type RenderMedia, type SiteThemeInput } from '@canon/ui-blocks';
import { useDraggable } from '@dnd-kit/core';
import { ArrowDown, ArrowUp, ArrowUpLeft, Copy, Group, GripVertical, Lock, Minus, Plus, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { findNode, findParent } from '../editor/tree-ops';
import { BlockAiMenu } from './block-ai';
import { distances, type Box } from './board/geometry';
import { ContextMenu, type MenuState } from './board/context-menu';
import { SimpleOverlay, useInlineEditing } from './simple';
import type { DropTarget } from './drop';
import { useBlockLabels } from './labels';
import { useBuilder, useBuilderStore, ZOOM_STEPS, type Breakpoint, type RemoteSelection } from './store';
import { useComponentTrees } from '@/lib/components';
import { toRenderForms, useForms } from '@/lib/forms';
import { useListPreview } from '@/lib/collections';
import { toast } from 'sonner';
import { useT, type MessageKey } from '@/lib/i18n';

/**
 * Every breakpoint renders at its real CSS width (Desktop 1280 px) so container queries see the size
 * the visitor will; the frame is scaled down to fit the workspace and the zoom controls scale on top.
 */
/** Skips blocks whose node, parent and context are unchanged: an edit re-renders one path, not the page. */
const MemoBlock = memo(function MemoBlock(props: BlockRendererProps) {
  return <BlockRenderer {...props} />;
});

/**
 * The page's compiled styles as one <style> per top-level block. A style edit then replaces one
 * small sheet instead of re-parsing the whole page's CSS (hundreds of KB at 3 000 blocks). The
 * site keeps a single sheet (PageStyles); the rules are the same.
 */
const SectionStyles = memo(function SectionStyles({ node }: { node: BlockNode }) {
  const css = compileStyles(node, false);
  return css ? <style data-canon-styles="" dangerouslySetInnerHTML={{ __html: css }} /> : null;
});

/** The page's styles; rules target [data-cn] ids, so one copy serves every artboard on a board. */
export function CanvasStyles({ root }: { root: BlockNode }) {
  // The root's own rules (desktop-only: it is the query container), then each section's.
  const own = useMemo(() => compileStyles({ ...root, children: [] }), [root]);
  return (
    <>
      <style data-canon-anim="" dangerouslySetInnerHTML={{ __html: ANIMATION_CSS }} />
      {own && <style data-canon-styles="" dangerouslySetInnerHTML={{ __html: own }} />}
      {root.children.map((c) => (
        <SectionStyles key={c.id} node={c} />
      ))}
    </>
  );
}

/** The page tree with component instances expanded, so their inner blocks get styles too. */
export function useStyledRoot(siteId: string): BlockNode {
  const root = useBuilder((s) => s.draft.content.root);
  const components = useComponentTrees(siteId);
  return useMemo(() => expandComponents({ root }, components).root, [root, components]);
}

const PREVIEW: Record<Breakpoint, number> = Object.fromEntries(STYLE_BREAKPOINTS.map((b) => [b.id, b.preview])) as Record<Breakpoint, number>;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameProps {
  locale: string;
  media: Record<string, RenderMedia>;
  facts: Record<string, string>;
  theme: SiteThemeInput | undefined;
  siteId: string;
  pageId: string;
  readOnly: boolean;
  dragging: boolean;
}

/**
 * The scrolling single-page workspace of the simple and pro editors: one frame at the breakpoint
 * being edited, fitted to the available width, with zoom and status in a bottom bar.
 */
export function Canvas(props: FrameProps & { hostRef: React.RefObject<HTMLDivElement | null>; drop: DropTarget | null }) {
  const t = useT();
  const L = useBlockLabels();
  const root = useBuilder((s) => s.draft.content.root);
  const selectedIds = useBuilder((s) => s.selectedIds);
  const selectedNode = useBuilder((s) => (s.selectedId ? findNode(s.draft.content.root, s.selectedId) : null));
  const breakpoint = useBuilder((s) => s.breakpoint);
  const zoom = useBuilder((s) => s.zoom);
  const setZoom = useBuilder((s) => s.setZoom);
  const hover = useBuilder((s) => s.hover);
  const simple = useBuilder((s) => s.mode === 'simple');
  const openLibrary = useBuilder((s) => s.openLibrary);
  const styledRoot = useStyledRoot(props.siteId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const cs = getComputedStyle(el);
      setAvail(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const preview = PREVIEW[breakpoint];
  const fit = avail > 0 ? Math.min(1, avail / preview) : 1;
  const scale = zoom * fit;
  const zoomBy = (dir: -1 | 1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
    setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? ZOOM_STEPS.length - 1 : i) + dir))]!);
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4 md:p-8" onMouseLeave={() => hover(null)}>
        <CanvasStyles root={styledRoot} />
        {/* Zoom scales the frame; the content inside keeps the breakpoint's CSS width, so container queries see the real size. */}
        <div className="mx-auto transition-[width] duration-200" style={{ width: preview * scale }}>
          <CanvasFrame
            {...props}
            bp={breakpoint}
            width={preview}
            scale={scale}
            active
            onContextMenu={props.readOnly ? undefined : (e, id) => setMenu({ x: e.clientX, y: e.clientY, blockId: id })}
            footer={
              simple && !props.readOnly ? (
                // Tilda-style: the page ends with a big "add block" that opens the library.
                <div data-builder-ui className="flex flex-col items-center gap-2 border-t border-dashed border-border/60 bg-muted/20 py-8">
                  <button type="button" onClick={(e) => (e.stopPropagation(), openLibrary(root.children.length))} className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-md transition hover:scale-[1.02]">
                    <Plus className="h-4 w-4" /> {t('simple.addBlock')}
                  </button>
                  <p className="text-xs text-muted-foreground">{root.children.length ? t('simple.editHint') : t('simple.emptyPage')}</p>
                </div>
              ) : null
            }
            className="min-h-[60vh] rounded-md shadow-sm ring-1 ring-border"
          />
        </div>
      </div>
      {menu && <ContextMenu state={menu} siteId={props.siteId} pageId={props.pageId} onClose={() => setMenu(null)} />}
      {/* Bottom bar: zoom, viewport and selection. */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t bg-card px-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-0.5" role="group" aria-label={t('builder.zoom')}>
          <button type="button" aria-label={t('builder.zoomOut')} disabled={zoom <= ZOOM_STEPS[0]} onClick={() => zoomBy(-1)} className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-40">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label={t('builder.zoomReset')} title={fit < 1 ? t('builder.zoomFitHint') : t('builder.zoomReset')} onClick={() => setZoom(1)} className="w-12 rounded px-1 py-0.5 text-center tabular-nums hover:bg-muted hover:text-foreground">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" aria-label={t('builder.zoomIn')} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={() => zoomBy(1)} className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-40">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="tabular-nums" aria-label={t('builder.viewport')}>
          {L.bp(breakpoint)} · {preview} px{fit < 1 ? ` · ${t('builder.fit')}` : ''}
        </span>
        <SelectionStatus count={selectedIds.length} node={selectedNode} />
      </div>
    </div>
  );
}

export function SelectionStatus({ count, node }: { count: number; node: BlockNode | null }) {
  const t = useT();
  const L = useBlockLabels();
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1 truncate" aria-live="polite">
      {count > 1 ? (
        t('builder.selectedCount', { count })
      ) : node ? (
        <>
          {node.locked && <Lock className="h-3 w-3" aria-label={t('builder.locked')} />}
          {node.name ?? L.name(node.type)}
          {node.styles && <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">{t('builder.styled')}</span>}
        </>
      ) : (
        t('builder.nothingSelected')
      )}
    </span>
  );
}

/** Holds while Alt/Option is pressed (distances between the selection and the hovered block). */
function useAltHeld(enabled: boolean) {
  const [alt, setAlt] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => setAlt(e.altKey);
    const off = () => setAlt(false);
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('keyup', on);
      window.removeEventListener('blur', off);
    };
  }, [enabled]);
  return alt;
}

function InlineEditing({ hostRef, readOnly }: { hostRef: React.RefObject<HTMLDivElement | null>; readOnly: boolean }) {
  useInlineEditing(hostRef, readOnly);
  return null;
}

/**
 * One rendering of the page at one viewport width: the real site renderers (@canon/ui-blocks) and
 * the site's theme, plus an overlay for hover/selection outlines, the block toolbar, drop
 * indicators, distances and collaborators. Blocks carry data-block-id, so all interaction is
 * event delegation + DOM rects — no wrapper elements that would distort the layout being edited.
 *
 * Only the `active` frame is interactive (on a board, the artboard of the breakpoint being
 * edited); the others mirror the page and the selection, and a click on them activates them.
 */
export function CanvasFrame({
  media,
  facts,
  theme,
  hostRef,
  drop,
  dragging,
  siteId,
  pageId,
  locale,
  readOnly,
  bp,
  width,
  scale,
  active,
  onActivate,
  onContextMenu,
  overlay,
  footer,
  className,
}: FrameProps & {
  hostRef?: React.RefObject<HTMLDivElement | null>;
  drop?: DropTarget | null;
  /** The breakpoint this frame shows (cursors and the active frame's edits). */
  bp: Breakpoint;
  /** CSS width the page renders at. */
  width: number;
  scale: number;
  active: boolean;
  /** Inactive frames: a click activates the frame and selects the block under it (null: none). */
  onActivate?: (blockId: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, blockId: string | null) => void;
  /** Extra overlay content of the active frame (the board's free-form controls). */
  overlay?: (ctx: { hostRef: React.RefObject<HTMLDivElement | null>; scale: number }) => ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = (active && hostRef) || ownRef;
  const store = useBuilderStore();
  const root = useBuilder((s) => s.draft.content.root);
  const selectedId = useBuilder((s) => s.selectedId);
  const selectedIds = useBuilder((s) => s.selectedIds);
  const components = useComponentTrees(siteId);
  const t = useT();
  const labels = useMemo(() => Object.fromEntries(Object.keys(DEFAULT_RENDER_LABELS).map((k) => [k, t(`canvas.${k}` as MessageKey)])) as RenderLabels, [t]);
  const hoverId = useBuilder((s) => (active ? s.hoverId : null));
  const remote = useBuilder((s) => s.remoteSelections);
  const cursors = useBuilder((s) => s.remoteCursors);
  const formsQ = useForms(siteId);
  const forms = useMemo(() => toRenderForms(formsQ.data), [formsQ.data]);
  const listsQ = useListPreview(siteId, root, locale);
  const renderCtx = useMemo<RenderContext>(() => ({ media, facts, forms, components, labels, lists: listsQ.data, draft: true, editing: true, Child: MemoBlock }), [media, facts, forms, components, labels, listsQ.data]);
  const select = useBuilder((s) => s.select);
  const toggleSelect = useBuilder((s) => s.toggleSelect);
  const hover = useBuilder((s) => s.hover);
  const mode = useBuilder((s) => s.mode);
  const simple = mode === 'simple';
  const alt = useAltHeld(active);
  const [rects, setRects] = useState<{
    sel: Rect | null;
    /** Other blocks of a multi-selection. */
    more: Rect[];
    hov: Rect | null;
    remote: (RemoteSelection & { rect: Rect })[];
  }>({ sel: null, more: [], hov: null, remote: [] });

  const measure = useCallback(() => {
    const host = ref.current;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const rectOf = (id: string | null): Rect | null => {
      if (!id || id === root.id) return null;
      const el = host.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
    };
    setRects({
      sel: rectOf(selectedId),
      more: selectedIds.filter((id) => id !== selectedId).flatMap((id) => rectOf(id) ?? []),
      hov: hoverId !== selectedId ? rectOf(hoverId) : null,
      remote: remote.flatMap((r) => {
        const rect = rectOf(r.blockId);
        return rect ? [{ ...r, rect }] : [];
      }),
    });
  }, [ref, root, selectedId, selectedIds, hoverId, remote]);

  useLayoutEffect(() => {
    measure();
    const host = ref.current;
    if (!host) return;
    // Images loading, fonts swapping and breakpoint changes all resize the content.
    const ro = new ResizeObserver(() => measure());
    ro.observe(host);
    return () => ro.disconnect();
  }, [measure, ref, width, scale]);

  // Locked blocks are skipped: a click selects the nearest unlocked ancestor.
  const idAt = (target: EventTarget | null) => ((target as Element | null)?.closest?.('[data-block-id]:not([data-locked])') as HTMLElement | null)?.dataset.blockId ?? null;
  const cursorAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { bp, x: Math.round((e.clientX - r.left) / scale), y: Math.round((e.clientY - r.top) / scale) };
  };

  return (
    <div
      ref={ref}
      role={active ? 'application' : 'img'}
      aria-label={active ? t('builder.canvas') : undefined}
      data-frame-bp={bp}
      data-frame-active={active ? '' : undefined}
      className={cn('relative overflow-hidden bg-white', className)}
      style={{ width: width * scale }}
      // Links, forms and summaries on the canvas must not navigate or toggle while editing.
      onClickCapture={(e) => {
        if ((e.target as Element).closest('[data-builder-ui]')) return;
        e.preventDefault();
        const id = idAt(e.target);
        const block = id && id !== root.id ? id : null;
        if (!active) {
          e.stopPropagation();
          return onActivate?.(block);
        }
        // Ctrl/Cmd/Shift+click adds to the selection (group, delete, copy several blocks).
        if (block && (e.ctrlKey || e.metaKey || e.shiftKey)) toggleSelect(block);
        else select(block);
      }}
      onContextMenu={(e) => {
        if (!onContextMenu || (e.target as Element).closest('[data-builder-ui]')) return;
        e.preventDefault();
        const id = idAt(e.target);
        const block = id && id !== root.id ? id : null;
        if (!active) onActivate?.(block);
        // Right-click on a block outside the selection selects it, like any editor.
        else if (block && !store.getState().selectedIds.includes(block)) select(block);
        onContextMenu(e, block);
      }}
      // A modifier click adds to the selection; it must not also extend the browser's text selection.
      onMouseDown={(e) => {
        if ((e.shiftKey || e.ctrlKey || e.metaKey) && !(e.target as HTMLElement).isContentEditable) e.preventDefault();
      }}
      // Moving onto the builder's own controls (block bar, "+") keeps the block they belong to.
      onMouseOver={(e) => active && !dragging && !(e.target as Element).closest('[data-builder-ui]') && hover(idAt(e.target))}
      onPointerMove={(e) => active && store.getState().setLocalCursor(cursorAt(e))}
      onPointerLeave={() => active && store.getState().setLocalCursor(null)}
    >
      {active && <InlineEditing hostRef={ref} readOnly={readOnly} />}
      <div style={{ ...siteThemeStyle(theme), zoom: scale }} className="font-site text-site-fg [&_[data-hidden]]:opacity-30">
        <BlockRenderer node={root} ctx={renderCtx} isRoot />
      </div>
      {footer}

      {/* Overlay: never intercepts the pointer except for the toolbar itself. */}
      <div className="pointer-events-none absolute inset-0">
        {rects.remote.map((r) => (
          <div key={r.name + r.blockId} className="absolute rounded-sm border-2" style={{ left: r.rect.x, top: r.rect.y, width: r.rect.w, height: r.rect.h, borderColor: r.color }}>
            <span className="absolute -bottom-5 right-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: r.color }}>
              {r.name}
            </span>
          </div>
        ))}
        {rects.hov && !dragging && <Outline rect={rects.hov} className="border border-primary/50" />}
        {rects.more.map((r, i) => (
          <Outline key={i} rect={r} className={cn('border-2', active ? 'border-primary/70' : 'border-primary/40')} />
        ))}
        {rects.sel && <Outline rect={rects.sel} className={cn('border-2', active ? 'border-primary' : 'border-dashed border-primary/60')} />}
        {active && alt && rects.sel && rects.hov && <Distances a={rects.sel} b={rects.hov} scale={scale} />}
        {active && rects.sel && selectedId && !dragging && !readOnly && (selectedIds.length > 1 ? <MultiToolbar rect={union([rects.sel, ...rects.more])} count={selectedIds.length} /> : simple && root.children.some((c) => c.id === selectedId) ? null : <Toolbar rect={rects.sel} id={selectedId} siteId={siteId} pageId={pageId} />)}
        {active && simple && !dragging && <SimpleOverlay hostRef={ref} scale={scale} readOnly={readOnly} />}
        {active && !dragging && overlay?.({ hostRef: ref, scale })}
        {active && drop && (drop.box ? <Outline rect={drop.line} className="border-2 border-dashed border-primary bg-primary/10" /> : <div className="absolute rounded-full bg-primary" style={{ left: drop.line.x, top: drop.line.y, width: drop.line.w, height: drop.line.h }} />)}
        {cursors
          .filter((c) => c.bp === bp)
          .map((c) => (
            <div key={c.clientId} className="absolute z-40 transition-[left,top] duration-75" style={{ left: c.x * scale, top: c.y * scale }} data-remote-cursor={c.name}>
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="drop-shadow">
                <path d="M2 1.5 15.5 8l-6 1.6L7 15.8z" fill={c.color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <span className="ml-3 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow" style={{ background: c.color }}>
                {c.name}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Red measurement lines with px labels between the selection and the hovered block (Alt held). */
function Distances({ a, b, scale }: { a: Box; b: Box; scale: number }) {
  return (
    <>
      <Outline rect={b} className="border border-pink-500" />
      {distances(a, b).map((g, i) => (
        <div key={i}>
          <div className="absolute bg-pink-500" style={g.axis === 'x' ? { left: g.x1, top: g.y1, width: g.x2 - g.x1, height: 1 } : { left: g.x1, top: g.y1, width: 1, height: g.y2 - g.y1 }} />
          <span className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-pink-500 px-1 text-[10px] font-semibold tabular-nums text-white" style={{ left: (g.x1 + g.x2) / 2, top: (g.y1 + g.y2) / 2 }} data-distance>
            {Math.round(g.value / scale)}
          </span>
        </div>
      ))}
    </>
  );
}

/** The box around all selected blocks (the multi-selection toolbar sits on top of it). */
const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

function Outline({ rect, className }: { rect: Rect; className: string }) {
  return <div className={cn('absolute rounded-sm', className)} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />;
}

/** Toolbar for a multi-selection: group, duplicate and delete all of it. */
function MultiToolbar({ rect, count }: { rect: Rect; count: number }) {
  const t = useT();
  const group = useBuilder((s) => s.group);
  const duplicate = useBuilder((s) => s.duplicateSelection);
  const remove = useBuilder((s) => s.removeSelection);
  const top = rect.y >= 34 ? rect.y - 32 : rect.y + 4;
  return (
    <div data-builder-ui className="pointer-events-auto absolute z-10 flex items-center gap-0.5 rounded-md bg-primary px-1 py-0.5 text-primary-foreground shadow-md" style={{ left: Math.max(4, rect.x), top }} onClick={(e) => e.stopPropagation()}>
      <span className="px-1 text-[11px] font-medium">{t('builder.selectedCount', { count })}</span>
      <Btn label={t('builder.group')} onClick={() => void (group() || toast.error(t('builder.cantGroup')))}>
        <Group className="h-3.5 w-3.5" />
      </Btn>
      <Btn label={t('builder.duplicate')} onClick={duplicate}>
        <Copy className="h-3.5 w-3.5" />
      </Btn>
      <Btn label={t('builder.delete')} onClick={remove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Btn>
    </div>
  );
}

function Toolbar({ rect, id, siteId, pageId }: { rect: Rect; id: string; siteId: string; pageId: string }) {
  const root = useBuilder((s) => s.draft.content.root);
  const node = useMemo(() => findParent(root, id), [root, id]);
  const type = node?.parent.children[node.index]?.type ?? '';
  const isRootChild = node?.parent.id === root.id;
  const select = useBuilder((s) => s.select);
  const nudge = useBuilder((s) => s.nudge);
  const duplicate = useBuilder((s) => s.duplicate);
  const remove = useBuilder((s) => s.remove);
  const drag = useDraggable({ id: `canvas-move-${id}`, data: { kind: 'move', id, type } });
  const L = useBlockLabels();
  const t = L.t;
  if (!node) return null;
  const top = rect.y >= 34 ? rect.y - 32 : rect.y + 4;
  return (
    <div
      data-builder-ui
      className="pointer-events-auto absolute z-10 flex items-center gap-0.5 rounded-md bg-primary px-1 py-0.5 text-primary-foreground shadow-md"
      style={{ left: Math.max(4, rect.x), top }}
      onClick={(e) => e.stopPropagation()}
    >
      <span ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} className="cursor-grab rounded p-0.5 hover:bg-white/15" aria-label={t('builder.dragToMove')} title={t('builder.dragToMove')}>
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      <span className="px-1 text-[11px] font-medium">{L.name(type)}</span>
      {!isRootChild && (
        <Btn label={t('builder.selectParent')} onClick={() => select(node.parent.id)}>
          <ArrowUpLeft className="h-3.5 w-3.5" />
        </Btn>
      )}
      <Btn label={t('builder.moveUp')} disabled={node.index === 0} onClick={() => nudge(id, -1)}>
        <ArrowUp className="h-3.5 w-3.5" />
      </Btn>
      <Btn label={t('builder.moveDown')} disabled={node.index === node.parent.children.length - 1} onClick={() => nudge(id, 1)}>
        <ArrowDown className="h-3.5 w-3.5" />
      </Btn>
      <Btn label={t('builder.duplicate')} onClick={() => duplicate(id)}>
        <Copy className="h-3.5 w-3.5" />
      </Btn>
      <BlockAiMenu id={id} siteId={siteId} pageId={pageId} variant="toolbar" />
      <Btn label={t('builder.delete')} onClick={() => remove(id)}>
        <Trash2 className="h-3.5 w-3.5" />
      </Btn>
    </div>
  );
}

function Btn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-0.5 hover:bg-white/15 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
