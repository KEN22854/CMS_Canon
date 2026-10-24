'use client';

import { getBlock } from '@canon/blocks';
import type { RenderMedia, SiteThemeInput } from '@canon/ui-blocks';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { findParent, newBlock } from '../editor/tree-ops';
import { Canvas } from './canvas';
import { resolveCanvasDrop, resolveLayerDrop, type DragItem, type DropTarget } from './drop';
import { Layers } from './layers';
import { Palette } from './palette';
import { historyOf, useBuilderStore } from './store';

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
  const [tab, setTab] = useState<'blocks' | 'layers'>('blocks');
  const [active, setActive] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<{ zone: Zone; target: DropTarget } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useShortcuts(readOnly);

  const onMove = (e: DragMoveEvent) => {
    const item = e.active.data.current as DragItem | undefined;
    const start = e.activatorEvent as PointerEvent;
    if (!item || typeof start.clientX !== 'number') return;
    const x = start.clientX + e.delta.x;
    const y = start.clientY + e.delta.y;
    // The drag overlay follows the cursor, so look through it for the zone underneath.
    const under = document.elementsFromPoint(x, y).find((el) => layersRef.current?.contains(el) || canvasRef.current?.contains(el)) ?? null;
    const root = store.getState().draft.content.root;
    if (layersRef.current?.contains(under)) {
      const target = resolveLayerDrop(layersRef.current, x, y, root, item);
      return setDrop(target ? { zone: 'layers', target } : null);
    }
    if (canvasRef.current?.contains(under)) {
      const target = resolveCanvasDrop(canvasRef.current, x, y, root, item);
      return setDrop(target ? { zone: 'canvas', target } : null);
    }
    setDrop(null);
  };

  const onEnd = () => {
    const item = active;
    const target = drop?.target;
    setActive(null);
    setDrop(null);
    if (!item || !target) return;
    const s = store.getState();
    if (item.kind === 'new') s.insert(newBlock(item.type), { parentId: target.parentId, index: target.index });
    else {
      s.move(item.id, target.parentId, target.index);
      s.select(item.id);
    }
  };

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setActive((e.active.data.current as DragItem) ?? null)} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={() => (setActive(null), setDrop(null))}>
      <div className="flex min-h-0 flex-1">
        {!readOnly && (
          <aside className="hidden w-64 shrink-0 flex-col border-r bg-background lg:flex" aria-label="Blocks and layers">
            <div className="flex border-b text-sm">
              {(['blocks', 'layers'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} className={cn('flex-1 px-2 py-2 capitalize', tab === t ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}>
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{tab === 'blocks' ? <Palette siteId={siteId} pageId={pageId} locale={locale} /> : <Layers hostRef={layersRef} drop={drop?.zone === 'layers' ? drop.target : null} />}</div>
          </aside>
        )}
        <main className="min-w-0 flex-1">
          <Canvas media={media} facts={facts} theme={theme} hostRef={canvasRef} drop={drop?.zone === 'canvas' ? drop.target : null} dragging={Boolean(active)} siteId={siteId} pageId={pageId} readOnly={readOnly} />
        </main>
        <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background xl:w-96" aria-label="Inspector">
          {inspector}
        </aside>
      </div>
      <DragOverlay dropAnimation={null} className="pointer-events-none">{active && <div className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium shadow-lg">{getBlock(active.type)?.name ?? active.type}</div>}</DragOverlay>
    </DndContext>
  );
}

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/**
 * Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) drive the builder history everywhere except inside the rich-text
 * editor, which has its own; block shortcuts only apply when focus is not in a form field.
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
      const id = s.selectedId;
      if (!id) return;
      if (e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), s.remove(id));
      else if (mod && k === 'd') (e.preventDefault(), s.duplicate(id));
      else if (e.altKey && e.key === 'ArrowUp') (e.preventDefault(), s.nudge(id, -1));
      else if (e.altKey && e.key === 'ArrowDown') (e.preventDefault(), s.nudge(id, 1));
      else if (e.key === 'Escape') {
        const at = findParent(s.draft.content.root, id);
        s.select(at && at.parent.id !== s.draft.content.root.id ? at.parent.id : null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, readOnly]);
}
