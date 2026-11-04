'use client';

import type { RenderMedia, SiteThemeInput } from '@canon/ui-blocks';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { MAX_NODES, type BlockNode } from '@canon/blocks';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { translate, currentLocale, type MessageKey } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';
import { cloneWithIds, findNode, findParent, newBlock } from '../editor/tree-ops';
import { Board } from './board/board';
import { BoardActions } from './board/board-actions';
import { BoardLibrary } from './board/library';
import { dropFreely, placesFreely } from './board/free-place';
import { BlockLibrary } from './block-library';
import { Canvas } from './canvas';
import { useBlockLabels } from './labels';
import { resolveCanvasDrop, resolveLayerDrop, type DragItem, type DropTarget } from './drop';
import { Layers } from './layers';
import { Palette } from './palette';
import { historyOf, useBuilder, useBuilderStore } from './store';
import { X } from 'lucide-react';

type Zone = 'canvas' | 'layers';

/**
 * Builder layout: palette/layers | live canvas | inspector (passed in). Owns drag & drop — dnd-kit
 * supplies sensors and the drag overlay, while drop positions are resolved from the rendered DOM
 * (see drop.ts) so dropping works into any container the renderers draw, at any breakpoint.
 */
export function Workspace({ siteId, pageId, locale, theme, media, facts, readOnly, inspector }: { siteId: string; pageId: string; locale: string; theme: SiteThemeInput | undefined; media: Record<string, RenderMedia>; facts: Record<string, string>; readOnly: boolean; inspector: ReactNode }) {
  const store = useBuilderStore();
  const canvasRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'blocks' | 'layers' | 'history'>('blocks');
  const L = useBlockLabels();
  const t = L.t;
  const simple = useBuilder((s) => s.mode === 'simple');
  const board = useBuilder((s) => s.mode === 'board');
  const [boardTab, setBoardTab] = useState<'add' | 'layers' | 'history'>('add');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const inspectorOpen = useBuilder((s) => s.inspector.open);
  const closeInspector = useBuilder((s) => s.closeInspector);
  const [active, setActive] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<{ zone: Zone; target: DropTarget } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useShortcuts(readOnly);

  const onMove = (e: DragMoveEvent) => {
    const item = e.active.data.current as DragItem | undefined;
    const start = e.activatorEvent as PointerEvent;
    if (!item || typeof start.clientX !== 'number') return;
    const x = start.clientX + e.delta.x;
    pointer.current = { x, y: start.clientY + e.delta.y };
    const y = start.clientY + e.delta.y;
    // The drag overlay follows the cursor, so look through it for the zone underneath.
    const under = document.elementsFromPoint(x, y).find((el) => layersRef.current?.contains(el) || canvasRef.current?.contains(el)) ?? null;
    const root = store.getState().draft.content.root;
    if (layersRef.current?.contains(under)) {
      const target = resolveLayerDrop(layersRef.current, x, y, root, item);
      return setDrop(target ? { zone: 'layers', target } : null);
    }
    if (canvasRef.current?.contains(under)) {
      // Free placement: a new object goes exactly under the pointer, no insertion line.
      const st = store.getState();
      if (st.mode === 'board' && st.freePlacement && item.kind === 'new' && placesFreely(item.node ?? newBlock(item.type))) return setDrop(null);
      const target = resolveCanvasDrop(canvasRef.current, x, y, root, item);
      return setDrop(target ? { zone: 'canvas', target } : null);
    }
    setDrop(null);
  };

  const pointer = useRef({ x: 0, y: 0 });
  const onEnd = () => {
    const item = active;
    const target = drop?.target;
    setActive(null);
    setDrop(null);
    const st = store.getState();
    const host = canvasRef.current;
    if (item?.kind === 'new' && st.mode === 'board' && st.freePlacement && host) {
      const r = host.getBoundingClientRect();
      const p = pointer.current;
      const inside = p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
      if (inside && dropFreely(store, host, item.node ? cloneWithIds(item.node) : newBlock(item.type), p)) return;
    }
    if (!item || !target) return;
    const s = store.getState();
    if (item.kind === 'new') {
      const block = item.node ? cloneWithIds(item.node) : newBlock(item.type);
      // Into a free-form area: the element lands where it was dropped, like on a design board.
      const parent = findNode(s.draft.content.root, target.parentId);
      const placed = parent?.type === 'canvas' && canvasRef.current ? placeInFreeForm(block, canvasRef.current, parent.id, pointer.current, s.snap) : block;
      s.insert(placed, { parentId: target.parentId, index: target.index });
    }
    else {
      s.move(item.id, target.parentId, target.index);
      s.select(item.id);
    }
  };

  if (board) {
    // The infinite canvas: library/layers | edit bar + board | inspector, panels collapsible.
    return (
      <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setActive((e.active.data.current as DragItem) ?? null)} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={() => (setActive(null), setDrop(null))}>
        <div className="flex min-h-0 flex-1">
          {!readOnly && leftOpen && (
            <aside className="flex w-72 shrink-0 flex-col border-r bg-background" aria-label={t('builder.sidebar')}>
              <div className="flex border-b text-xs" role="tablist">
                {(['add', 'layers', 'history'] as const).map((id) => (
                  <button key={id} type="button" role="tab" aria-selected={boardTab === id} onClick={() => setBoardTab(id)} className={cn('flex-1 px-2 py-2', boardTab === id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
                    {t(`board.tab.${id}`)}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto" data-board-scroll>
                {boardTab === 'add' ? <BoardLibrary siteId={siteId} pageId={pageId} locale={locale} /> : boardTab === 'layers' ? <Layers hostRef={layersRef} drop={drop?.zone === 'layers' ? drop.target : null} readOnly={readOnly} /> : <OperationHistory />}
              </div>
            </aside>
          )}
          <main className="flex min-w-0 flex-1 flex-col">
            <BoardActions hostRef={canvasRef} leftOpen={leftOpen && !readOnly} rightOpen={rightOpen} onToggleLeft={() => setLeftOpen(!leftOpen)} onToggleRight={() => setRightOpen(!rightOpen)} readOnly={readOnly} />
            <div className="min-h-0 flex-1">
              <Board media={media} facts={facts} theme={theme} hostRef={canvasRef} drop={drop?.zone === 'canvas' ? drop.target : null} dragging={Boolean(active)} siteId={siteId} pageId={pageId} locale={locale} readOnly={readOnly} />
            </div>
          </main>
          {rightOpen && (
            <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background xl:w-96" aria-label={t('builder.inspector')} data-board-scroll>
              {inspector}
            </aside>
          )}
        </div>
        <BlockLibrary siteId={siteId} locale={locale} theme={theme} />
        <DragOverlay dropAnimation={null} className="pointer-events-none">{active && <div className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium shadow-lg">{active.kind === 'new' && active.node?.name ? active.node.name : L.name(active.type)}</div>}</DragOverlay>
      </DndContext>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setActive((e.active.data.current as DragItem) ?? null)} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={() => (setActive(null), setDrop(null))}>
      <div className="flex min-h-0 flex-1">
        {!readOnly && !simple && (
          <aside className="hidden w-64 shrink-0 flex-col border-r bg-background lg:flex" aria-label={t('builder.sidebar')}>
            <div className="flex border-b text-sm">
              {(['blocks', 'layers', 'history'] as const).map((id) => (
                <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={cn('flex-1 px-2 py-2', tab === id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}>
                  {t(`builder.tab.${id}`)}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{tab === 'blocks' ? <Palette siteId={siteId} pageId={pageId} locale={locale} /> : tab === 'layers' ? <Layers hostRef={layersRef} drop={drop?.zone === 'layers' ? drop.target : null} readOnly={readOnly} /> : <OperationHistory />}</div>
          </aside>
        )}
        <main className="min-w-0 flex-1">
          <Canvas media={media} facts={facts} theme={theme} hostRef={canvasRef} drop={drop?.zone === 'canvas' ? drop.target : null} dragging={Boolean(active)} siteId={siteId} pageId={pageId} locale={locale} readOnly={readOnly} />
        </main>
        {simple ? (
          // Simple mode: the inspector is a drawer that opens from a block's Content / Design buttons.
          inspectorOpen && (
            <aside className="relative w-80 shrink-0 overflow-y-auto border-l bg-background shadow-xl xl:w-96" aria-label={t('builder.inspector')}>
              <button type="button" aria-label={t('simple.closePanel')} title={t('simple.closePanel')} onClick={closeInspector} className="absolute right-2 top-1.5 z-20 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
              {inspector}
            </aside>
          )
        ) : (
          <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background xl:w-96" aria-label={t('builder.inspector')}>
            {inspector}
          </aside>
        )}
      </div>
      <BlockLibrary siteId={siteId} locale={locale} theme={theme} />
      <DragOverlay dropAnimation={null} className="pointer-events-none">{active && <div className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium shadow-lg">{L.name(active.type)}</div>}</DragOverlay>
    </DndContext>
  );
}

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/**
 * Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) drive the builder history everywhere except inside the rich-text
 * editor, which has its own; block shortcuts only apply when focus is not in a form field:
 * Delete, Ctrl+D duplicate, Ctrl+C/X/V copy/cut/paste (across pages), Ctrl+G group, Ctrl+Shift+G
 * ungroup, Ctrl+A select all, Alt+↑/↓ reorder, Ctrl+Shift+H hide, Ctrl+Shift+L lock, Ctrl+=/−/0 zoom,
 * Esc parent. Delete, duplicate and copy act on the whole multi-selection.
 */
function useShortcuts(readOnly: boolean) {
  const store = useBuilderStore();
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const inRich = (e.target as HTMLElement | null)?.closest?.('.ProseMirror');
      const k = e.key.toLowerCase();
      if (mod && !inRich && (k === 'z' || k === 'y')) {
        e.preventDefault();
        const t = historyOf(store);
        if (k === 'y' || e.shiftKey) t.redo();
        else t.undo();
        return;
      }
      if (editable(e.target)) return;
      const s = store.getState();
      // Canvas zoom: Ctrl/Cmd + = / - / 0 (the browser zoom stays on the browser menu); the board zooms itself.
      if (mod && (k === '=' || k === '+' || k === '-' || k === '0') && s.mode !== 'board') {
        e.preventDefault();
        s.setZoom(k === '0' ? 1 : s.zoom + (k === '-' ? -0.1 : 0.1));
        return;
      }
      const act = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      const say = (key: MessageKey, count: number) => toast.success(translate(currentLocale(), key, { count }), { id: 'clipboard' });
      if (mod && k === 'v' && !e.shiftKey) {
        // The browser's own paste stays in text fields (handled above); here it pastes blocks.
        return act(() => {
          const hit = s.limitHit;
          const n = s.paste();
          if (n) say('builder.pasted', n);
          else if (store.getState().limitHit !== hit) toast.error(translate(currentLocale(), 'builder.tooManyBlocks', { max: MAX_NODES }), { id: 'clipboard' });
          else toast(translate(currentLocale(), 'builder.nothingToPaste'), { id: 'clipboard' });
        });
      }
      if (mod && k === 'a' && !e.shiftKey) return act(() => s.selectAll());
      const id = s.selectedId;
      if (!id) return;
      if (e.key === 'Delete' || e.key === 'Backspace') act(() => s.removeSelection());
      else if (mod && k === 'd') act(() => s.duplicateSelection());
      else if (mod && k === 'c' && !e.shiftKey) act(() => say('builder.copied', s.copy()));
      else if (mod && k === 'x' && !e.shiftKey) act(() => say('builder.cut', s.cut()));
      else if (mod && k === 'g' && e.shiftKey) act(() => s.ungroup(id));
      else if (mod && k === 'g') act(() => void (s.group() || toast.error(translate(currentLocale(), 'builder.cantGroup'), { id: 'clipboard' })));
      else if (mod && e.shiftKey && k === 'h') act(() => s.updateNode(id, { hidden: !findNode(s.draft.content.root, id)?.hidden || undefined }));
      else if (mod && e.shiftKey && k === 'l') act(() => s.updateNode(id, { locked: !findNode(s.draft.content.root, id)?.locked || undefined }));
      else if (e.altKey && e.key === 'ArrowUp') act(() => s.nudge(id, -1));
      else if (e.altKey && e.key === 'ArrowDown') act(() => s.nudge(id, 1));
      else if (e.key === 'Escape') {
        const at = findParent(s.draft.content.root, id);
        s.select(at && at.parent.id !== s.draft.content.root.id ? at.parent.id : null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, readOnly]);
}

/** The typed operations of this session, newest first (the same log Canon AI and audit read). */
function OperationHistory() {
  const log = useBuilder((s) => s.opLog);
  const { t } = useBlockLabels();
  if (!log.length) return <p className="p-4 text-center text-xs text-muted-foreground">{t('builder.history.empty')}</p>;
  return (
    <div className="space-y-2 p-2">
      <p className="px-1 text-[11px] text-muted-foreground">{t('builder.history.hint')}</p>
      <ol className="space-y-0.5" aria-label={t('builder.tab.history')}>
        {[...log].reverse().map((e, i) => (
          <li key={log.length - i} className="flex items-baseline gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
            <code className="shrink-0 rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">{e.op}</code>
            <span className="min-w-0 flex-1 truncate" title={e.label}>
              {e.label}
            </span>
            <time className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(new Date(e.at).toISOString())}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Starting widths of elements dropped into a free-form area (the same as its own add bar). */
const FREE_WIDTH: Record<string, { width: string; height?: string }> = { heading: { width: '480px' }, text: { width: '420px' }, button: { width: '220px' }, image: { width: '360px' }, shape: { width: '240px', height: '160px' } };

/** Absolute position (desktop layer, frame CSS px) at the drop point; the 8 px grid when snapping. */
function placeInFreeForm(block: BlockNode, host: HTMLElement, canvasId: string, at: { x: number; y: number }, snap: boolean): BlockNode {
  const frame = host.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(canvasId)}"] [data-free-frame]`);
  if (!frame) return block;
  // The page content carries the artboard's zoom (CanvasFrame), so frame px = screen px / zoom.
  const zoom = parseFloat(host.querySelector<HTMLElement>(':scope > [style*="zoom"]')?.style.zoom ?? '1') || 1;
  const fr = frame.getBoundingClientRect();
  const g = (v: number) => (snap ? Math.round(v / 8) * 8 : Math.round(v));
  const left = g(Math.max(0, (at.x - fr.left) / zoom));
  const top = g(Math.max(0, (at.y - fr.top) / zoom));
  const size = FREE_WIDTH[block.type] ?? { width: '320px' };
  return { ...block, styles: { ...(block.styles ?? {}), base: { ...(block.styles?.base ?? {}), position: 'absolute', left: `${left}px`, top: `${top}px`, maxWidth: 'none', marginTop: '0px', paddingLeft: '0px', paddingRight: '0px', ...size } } };
}
