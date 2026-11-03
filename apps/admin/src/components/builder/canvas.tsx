'use client';

import { getBlock, STYLE_BREAKPOINTS } from '@canon/blocks';
import { BlockRenderer, PageStyles, siteThemeStyle, type RenderMedia, type SiteThemeInput } from '@canon/ui-blocks';
import { useDraggable } from '@dnd-kit/core';
import { ArrowDown, ArrowUp, ArrowUpLeft, Copy, GripVertical, Lock, Minus, Plus, Trash2 } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { findNode, findParent } from '../editor/tree-ops';
import { BlockAiMenu } from './block-ai';
import type { DropTarget } from './drop';
import { useBuilder, ZOOM_STEPS, type Breakpoint, type RemoteSelection } from './store';
import { toRenderForms, useForms } from '@/lib/forms';

/**
 * Every breakpoint renders at its real CSS width (Desktop 1280 px) so container queries see the size
 * the visitor will; the frame is scaled down to fit the workspace and the zoom controls scale on top.
 */
const PREVIEW: Record<Breakpoint, number> = Object.fromEntries(STYLE_BREAKPOINTS.map((b) => [b.id, b.preview])) as Record<Breakpoint, number>;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The page rendered with the real site renderers (@canon/ui-blocks) and the site's theme, plus an
 * overlay layer for hover/selection outlines, the block toolbar and drop indicators. Blocks carry
 * data-block-id, so all interaction is event delegation + DOM rects — no wrapper elements that
 * would distort the layout being edited.
 */
export function Canvas({
  media,
  facts,
  theme,
  hostRef,
  drop,
  dragging,
  siteId,
  pageId,
  readOnly,
}: {
  media: Record<string, RenderMedia>;
  facts: Record<string, string>;
  theme: SiteThemeInput | undefined;
  hostRef: React.RefObject<HTMLDivElement | null>;
  drop: DropTarget | null;
  dragging: boolean;
  siteId: string;
  pageId: string;
  readOnly: boolean;
}) {
  const root = useBuilder((s) => s.draft.content.root);
  const selectedId = useBuilder((s) => s.selectedId);
  const hoverId = useBuilder((s) => s.hoverId);
  const remote = useBuilder((s) => s.remoteSelections);
  const formsQ = useForms(siteId);
  const forms = useMemo(() => toRenderForms(formsQ.data), [formsQ.data]);
  const breakpoint = useBuilder((s) => s.breakpoint);
  const zoom = useBuilder((s) => s.zoom);
  const setZoom = useBuilder((s) => s.setZoom);
  const selectedNode = useBuilder((s) => (s.selectedId ? findNode(s.draft.content.root, s.selectedId) : null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
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
  const select = useBuilder((s) => s.select);
  const hover = useBuilder((s) => s.hover);
  const [rects, setRects] = useState<{
    sel: Rect | null;
    hov: Rect | null;
    remote: (RemoteSelection & { rect: Rect })[];
  }>({ sel: null, hov: null, remote: [] });

  const measure = useCallback(() => {
    const host = hostRef.current;
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
      hov: hoverId !== selectedId ? rectOf(hoverId) : null,
      remote: remote.flatMap((r) => {
        const rect = rectOf(r.blockId);
        return rect ? [{ ...r, rect }] : [];
      }),
    });
  }, [hostRef, root, selectedId, hoverId, remote]);

  useLayoutEffect(() => {
    measure();
    const host = hostRef.current;
    if (!host) return;
    // Images loading, fonts swapping and breakpoint changes all resize the content.
    const ro = new ResizeObserver(() => measure());
    ro.observe(host);
    return () => ro.disconnect();
  }, [measure, hostRef, breakpoint, scale]);

  // Locked blocks are skipped: a click selects the nearest unlocked ancestor.
  const idAt = (target: EventTarget | null) => ((target as Element | null)?.closest?.('[data-block-id]:not([data-locked])') as HTMLElement | null)?.dataset.blockId ?? null;
  const zoomBy = (dir: -1 | 1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
    setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? ZOOM_STEPS.length - 1 : i) + dir))]!);
  };

  return (
    <div className="flex h-full flex-col">
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4 md:p-8" onMouseLeave={() => hover(null)}>
      {/* Zoom scales the frame; the content inside keeps the breakpoint's CSS width, so container queries see the real size. */}
      <div className="mx-auto transition-[width] duration-200" style={{ width: preview * scale }}>
        <div
          ref={hostRef}
          role="application"
          aria-label="Page canvas"
          className="relative min-h-[60vh] overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-border"
          // Links, forms and summaries on the canvas must not navigate or toggle while editing.
          onClickCapture={(e) => {
            if ((e.target as Element).closest('[data-builder-ui]')) return;
            e.preventDefault();
            const id = idAt(e.target);
            select(id && id !== root.id ? id : null);
          }}
          onMouseOver={(e) => !dragging && hover(idAt(e.target))}
        >
          <div style={{ ...siteThemeStyle(theme), zoom: scale }} className="font-site text-site-fg [&_[data-hidden]]:opacity-30">
            <PageStyles root={root} />
            <BlockRenderer node={root} ctx={{ media, facts, forms, draft: true, editing: true }} isRoot />
          </div>

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
            {rects.sel && <Outline rect={rects.sel} className="border-2 border-primary" />}
            {rects.sel && selectedId && !dragging && !readOnly && <Toolbar rect={rects.sel} id={selectedId} siteId={siteId} pageId={pageId} />}
            {drop && (drop.box ? <Outline rect={drop.line} className="border-2 border-dashed border-primary bg-primary/10" /> : <div className="absolute rounded-full bg-primary" style={{ left: drop.line.x, top: drop.line.y, width: drop.line.w, height: drop.line.h }} />)}
          </div>
        </div>
      </div>
    </div>
      {/* Bottom bar: zoom, viewport and selection. */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t bg-card px-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" disabled={zoom <= ZOOM_STEPS[0]} onClick={() => zoomBy(-1)} className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-40">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Reset zoom to 100%" title={fit < 1 ? 'Scaled to fit the window. Click for 100% of the fitted size.' : 'Reset to 100%'} onClick={() => setZoom(1)} className="w-12 rounded px-1 py-0.5 text-center tabular-nums hover:bg-muted hover:text-foreground">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={() => zoomBy(1)} className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-40">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="tabular-nums" aria-label="Viewport">
          {STYLE_BREAKPOINTS.find((b) => b.id === breakpoint)?.label} · {preview} px{fit < 1 ? ' · fit' : ''}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1 truncate" aria-live="polite">
          {selectedNode ? (
            <>
              {selectedNode.locked && <Lock className="h-3 w-3" aria-label="Locked" />}
              {selectedNode.name ?? getBlock(selectedNode.type)?.name ?? selectedNode.type}
              {selectedNode.styles && <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">styled</span>}
            </>
          ) : (
            'Nothing selected'
          )}
        </span>
      </div>
    </div>
  );
}


function Outline({ rect, className }: { rect: Rect; className: string }) {
  return <div className={cn('absolute rounded-sm', className)} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />;
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
  if (!node) return null;
  const top = rect.y >= 34 ? rect.y - 32 : rect.y + 4;
  return (
    <div
      data-builder-ui
      className="pointer-events-auto absolute z-10 flex items-center gap-0.5 rounded-md bg-primary px-1 py-0.5 text-primary-foreground shadow-md"
      style={{ left: Math.max(4, rect.x), top }}
      onClickCapture={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} className="cursor-grab rounded p-0.5 hover:bg-white/15" aria-label="Drag to move" title="Drag to move">
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      <span className="px-1 text-[11px] font-medium">{getBlock(type)?.name ?? type}</span>
      {!isRootChild && (
        <Btn label="Select parent" onClick={() => select(node.parent.id)}>
          <ArrowUpLeft className="h-3.5 w-3.5" />
        </Btn>
      )}
      <Btn label="Move up (Alt+↑)" disabled={node.index === 0} onClick={() => nudge(id, -1)}>
        <ArrowUp className="h-3.5 w-3.5" />
      </Btn>
      <Btn label="Move down (Alt+↓)" disabled={node.index === node.parent.children.length - 1} onClick={() => nudge(id, 1)}>
        <ArrowDown className="h-3.5 w-3.5" />
      </Btn>
      <Btn label="Duplicate (Ctrl+D)" onClick={() => duplicate(id)}>
        <Copy className="h-3.5 w-3.5" />
      </Btn>
      <BlockAiMenu id={id} siteId={siteId} pageId={pageId} variant="toolbar" />
      <Btn label="Delete (Del)" onClick={() => remove(id)}>
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
