'use client';

import { getBlock } from '@canon/blocks';
import { BlockRenderer, siteThemeStyle, type RenderMedia, type SiteThemeInput } from '@canon/ui-blocks';
import { useDraggable } from '@dnd-kit/core';
import { ArrowDown, ArrowUp, ArrowUpLeft, Copy, GripVertical, Trash2 } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { findParent } from '../editor/tree-ops';
import { BlockAiMenu } from './block-ai';
import type { DropTarget } from './drop';
import { useBuilder, type Breakpoint } from './store';

const WIDTH: Record<Breakpoint, string> = { desktop: '100%', tablet: '768px', mobile: '390px' };

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
  const breakpoint = useBuilder((s) => s.breakpoint);
  const select = useBuilder((s) => s.select);
  const hover = useBuilder((s) => s.hover);
  const [rects, setRects] = useState<{ sel: Rect | null; hov: Rect | null }>({ sel: null, hov: null });

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
    setRects({ sel: rectOf(selectedId), hov: hoverId !== selectedId ? rectOf(hoverId) : null });
  }, [hostRef, root, selectedId, hoverId]);

  useLayoutEffect(() => {
    measure();
    const host = hostRef.current;
    if (!host) return;
    // Images loading, fonts swapping and breakpoint changes all resize the content.
    const ro = new ResizeObserver(() => measure());
    ro.observe(host);
    return () => ro.disconnect();
  }, [measure, hostRef, breakpoint]);

  const idAt = (target: EventTarget | null) => ((target as Element | null)?.closest?.('[data-block-id]') as HTMLElement | null)?.dataset.blockId ?? null;

  return (
    <div className="h-full overflow-auto bg-muted/40 p-4 md:p-8" onMouseLeave={() => hover(null)}>
      <div className="mx-auto transition-[max-width] duration-200" style={{ maxWidth: WIDTH[breakpoint] }}>
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
          <div style={siteThemeStyle(theme)} className="font-site text-site-fg">
            <BlockRenderer node={root} ctx={{ media, facts, draft: true, editing: true }} isRoot />
          </div>

          {/* Overlay: never intercepts the pointer except for the toolbar itself. */}
          <div className="pointer-events-none absolute inset-0">
            {rects.hov && !dragging && <Outline rect={rects.hov} className="border border-primary/50" />}
            {rects.sel && <Outline rect={rects.sel} className="border-2 border-primary" />}
            {rects.sel && selectedId && !dragging && !readOnly && <Toolbar rect={rects.sel} id={selectedId} siteId={siteId} pageId={pageId} />}
            {drop && (drop.box ? <Outline rect={drop.line} className="border-2 border-dashed border-primary bg-primary/10" /> : <div className="absolute rounded-full bg-primary" style={{ left: drop.line.x, top: drop.line.y, width: drop.line.w, height: drop.line.h }} />)}
          </div>
        </div>
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

function Btn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
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
