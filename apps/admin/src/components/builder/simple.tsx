'use client';

import { STYLE_BREAKPOINTS, type BlockNode, type EditorOperation, type RichTextDoc, type StyleBreakpoint } from '@canon/blocks';
import { AlignLeft, ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripHorizontal, Image as ImageIcon, LayoutGrid, MousePointerClick, Paintbrush, Plus, Settings2, Square, Trash2, Type, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findNode, findParent, isSimpleDoc, newBlock, plainToDoc } from '../editor/tree-ops';
import { FreeSelection, freeSelection, useFreeKeyboard } from './free-board';
import { useBlockLabels } from './labels';
import { useBuilder, useBuilderStore } from './store';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 8;
const snap = (v: number, on: boolean) => (on ? Math.round(v / GRID) * GRID : Math.round(v));

export function rectOf(host: HTMLElement, id: string): Rect | null {
  const el = host.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const hr = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
}

/** The top-level block (page section) that contains `id`. */
export function topLevelOf(root: BlockNode, id: string | null): BlockNode | null {
  if (!id || id === root.id) return null;
  let cur = id;
  for (;;) {
    const at = findParent(root, cur);
    if (!at) return null;
    if (at.parent.id === root.id) return at.parent.children[at.index]!;
    cur = at.parent.id;
  }
}

/**
 * The simple editor's overlay on top of the canvas: per-block actions (content, settings, move,
 * duplicate, hide, delete), "+" inserters between blocks, and the free-form block's controls
 * (drag, resize, height, add elements). Coordinates are measured from the DOM, so it works at any
 * zoom and breakpoint; drags preview with a CSS transform and commit one undoable edit on release.
 */
export function SimpleOverlay({ hostRef, scale, readOnly }: { hostRef: React.RefObject<HTMLDivElement | null>; scale: number; readOnly: boolean }) {
  const store = useBuilderStore();
  const root = useBuilder((s) => s.draft.content.root);
  const hoverId = useBuilder((s) => s.hoverId);
  const selectedId = useBuilder((s) => s.selectedId);
  const breakpoint = useBuilder((s) => s.breakpoint);
  const [tick, setTick] = useState(0);
  // The block the controls belong to: the hovered one, else the selected one.
  const active = topLevelOf(root, hoverId) ?? topLevelOf(root, selectedId);
  const index = active ? root.children.findIndex((c) => c.id === active.id) : -1;
  const [rect, setRect] = useState<Rect | null>(null);
  const selectedIds = useBuilder((s) => s.selectedIds);
  // Elements of one free-form block selected together (Shift/Ctrl+click adds), primary last.
  const free = freeSelection(root, selectedIds);
  useFreeKeyboard(store, hostRef, readOnly);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      setRect(active ? rectOf(host, active.id) : null);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef, active, root, breakpoint, scale, tick]);

  if (readOnly) return null;
  return (
    <>
      {active && rect && <BlockBar node={active} index={index} total={root.children.length} rect={rect} />}
      {active && rect && (
        <>
          <Inserter y={rect.y} index={index} />
          <Inserter y={rect.y + rect.h} index={index + 1} />
        </>
      )}
      {active?.type === 'canvas' && rect && <FreeFormBar node={active} rect={rect} breakpoint={breakpoint} hostRef={hostRef} scale={scale} onChange={() => setTick((n) => n + 1)} />}
      {free && <FreeSelection key={free.ids.join(',') + tick} canvas={free.canvas} ids={free.ids} hostRef={hostRef} scale={scale} breakpoint={breakpoint} store={store} onDone={() => setTick((n) => n + 1)} />}
    </>
  );
}

function Bar({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div data-builder-ui className={cn('pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-lg border bg-card/95 p-0.5 text-card-foreground shadow-lg backdrop-blur', className)} style={style} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

function BarBtn({ label, onClick, disabled, children, danger }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; danger?: boolean }) {
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
      className={cn('flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-30', danger && 'hover:text-destructive')}
    >
      {children}
    </button>
  );
}

/** Actions of one page block, at its top-right corner (Tilda-style: content, settings, order). */
function BlockBar({ node, index, total, rect }: { node: BlockNode; index: number; total: number; rect: Rect }) {
  const store = useBuilderStore();
  const L = useBlockLabels();
  const t = L.t;
  const s = store.getState();
  const open = (panel: 'block' | 'style' | 'ai') => {
    s.select(node.id);
    s.openInspector(panel);
  };
  const top = Math.max(4, rect.y + 8);
  return (
    <>
      <Bar className="px-2 py-1 text-[11px]" style={{ left: rect.x + 8, top }}>
        <span className="font-semibold">{node.name ?? L.name(node.type)}</span>
      </Bar>
      <Bar style={{ right: 8, top }}>
        <BarBtn label={t('simple.content')} onClick={() => open('block')}>
          <Settings2 className="h-3.5 w-3.5" /> <span className="hidden md:inline">{t('simple.content')}</span>
        </BarBtn>
        <BarBtn label={t('simple.design')} onClick={() => open('style')}>
          <Paintbrush className="h-3.5 w-3.5" /> <span className="hidden md:inline">{t('simple.design')}</span>
        </BarBtn>
        <BarBtn label={t('builder.panel.ai')} onClick={() => open('ai')}>
          <Wand2 className="h-3.5 w-3.5" />
        </BarBtn>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <BarBtn label={t('builder.moveUp')} disabled={index === 0 || node.locked} onClick={() => s.nudge(node.id, -1)}>
          <ArrowUp className="h-3.5 w-3.5" />
        </BarBtn>
        <BarBtn label={t('builder.moveDown')} disabled={index === total - 1 || node.locked} onClick={() => s.nudge(node.id, 1)}>
          <ArrowDown className="h-3.5 w-3.5" />
        </BarBtn>
        <BarBtn label={t('builder.duplicate')} onClick={() => s.duplicate(node.id)}>
          <Copy className="h-3.5 w-3.5" />
        </BarBtn>
        <BarBtn label={node.hidden ? t('layers.show', { name: L.name(node.type) }) : t('layers.hide', { name: L.name(node.type) })} onClick={() => s.updateNode(node.id, { hidden: !node.hidden || undefined })}>
          {node.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </BarBtn>
        <BarBtn label={t('builder.delete')} danger disabled={node.locked} onClick={() => s.remove(node.id)}>
          <Trash2 className="h-3.5 w-3.5" />
        </BarBtn>
      </Bar>
    </>
  );
}

/** "+" on the boundary between blocks: opens the block library to insert exactly there. */
function Inserter({ y, index }: { y: number; index: number }) {
  const store = useBuilderStore();
  const t = useT();
  return (
    <div data-builder-ui className="pointer-events-none absolute inset-x-0 z-20 flex justify-center" style={{ top: y - 14 }}>
      <button
        type="button"
        aria-label={t('simple.addHere')}
        title={t('simple.addHere')}
        onClick={(e) => (e.stopPropagation(), store.getState().openLibrary(index))}
        className="pointer-events-auto grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background transition-transform hover:scale-110"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Elements a free-form block offers, each with a starting size. */
const FREE_ELEMENTS = [
  { type: 'heading', icon: Type, styles: { width: '480px' } },
  { type: 'text', icon: AlignLeft, styles: { width: '420px' } },
  { type: 'button', icon: MousePointerClick, styles: { width: '220px' } },
  { type: 'image', icon: ImageIcon, styles: { width: '360px' } },
  { type: 'shape', icon: Square, styles: { width: '240px', height: '160px' } },
] as const;

/** The free-form block: add elements, set the height for this breakpoint, auto-arrange. */
export function FreeFormBar({ node, rect, breakpoint, hostRef, scale, onChange }: { node: BlockNode; rect: Rect; breakpoint: StyleBreakpoint; hostRef: React.RefObject<HTMLDivElement | null>; scale: number; onChange: () => void }) {
  const store = useBuilderStore();
  const L = useBlockLabels();
  const t = L.t;
  const suppress = useRef(false);

  const add = (type: (typeof FREE_ELEMENTS)[number]['type'], at?: { left: number; top: number }) => {
    const spec = FREE_ELEMENTS.find((e) => e.type === type)!;
    const el = newBlock(type);
    // Cascade new elements so they don't land on top of each other (unless dropped at a point).
    const offset = 40 + (node.children.length % 6) * 24;
    const left = at ? at.left : offset;
    const top = at ? at.top : offset;
    el.styles = { base: { position: 'absolute', left: `${left}px`, top: `${top}px`, maxWidth: 'none', marginTop: '0px', paddingLeft: '0px', paddingRight: '0px', ...spec.styles } };
    store.getState().insert(el, { parentId: node.id, index: node.children.length });
  };

  // Drag an element from the bar onto the block: a chip follows the pointer, release places it.
  const dragNew = (type: (typeof FREE_ELEMENTS)[number]['type'], label: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let chip: HTMLDivElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!chip && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) {
        chip = document.createElement('div');
        chip.textContent = label;
        chip.className = 'pointer-events-none fixed z-[60] rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-lg';
        document.body.appendChild(chip);
      }
      if (chip) {
        chip.style.left = '0px';
        chip.style.top = '0px';
        chip.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!chip) return; // a click: handled by onClick
      chip.remove();
      suppress.current = true;
      const frame = hostRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(node.id)}"] [data-free-frame]`);
      const fr = frame?.getBoundingClientRect();
      if (!fr || ev.clientX < fr.left || ev.clientX > fr.right || ev.clientY < fr.top || ev.clientY > fr.bottom) return;
      add(type, { left: snap((ev.clientX - fr.left) / scale, !ev.altKey), top: snap((ev.clientY - fr.top) / scale, !ev.altKey) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };


  // Height: drag the bottom edge. Desktop sets the block's height; smaller screens a min-height override.
  const startHeight = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = hostRef.current;
    const el = host?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(node.id)}"]`);
    if (!el) return;
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height / scale;
    const move = (ev: PointerEvent) => (el.style.minHeight = `${Math.max(80, startH + (ev.clientY - startY) / scale)}px`);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.style.minHeight = '';
      const h = snap(Math.max(80, startH + (ev.clientY - startY) / scale), !ev.altKey);
      const s = store.getState();
      if (breakpoint === 'base') s.updateProps(node.id, { height: h });
      else s.apply({ op: 'STYLE_SET', id: node.id, breakpoint, property: 'minHeight', value: `${h}px` });
      onChange();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Stack the elements in reading order for this (small) breakpoint: one undo step.
  const arrange = () => {
    const host = hostRef.current;
    if (!host || breakpoint === 'base') return;
    const frame = host.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(node.id)}"] [data-free-frame]`);
    const width = frame ? frame.getBoundingClientRect().width / scale : STYLE_BREAKPOINTS.find((b) => b.id === breakpoint)!.preview;
    const items = node.children
      .map((c) => ({ c, r: host.querySelector(`[data-block-id="${CSS.escape(c.id)}"]`)?.getBoundingClientRect() }))
      .filter((x): x is { c: BlockNode; r: DOMRect } => Boolean(x.r))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    let y = 24;
    const ops: EditorOperation[] = [];
    for (const { c, r } of items) {
      const h = r.height / scale;
      const w = Math.min(width - 32, r.width / scale);
      ops.push({ op: 'STYLE_SET', id: c.id, breakpoint, property: 'left', value: `${Math.round((width - w) / 2)}px` }, { op: 'STYLE_SET', id: c.id, breakpoint, property: 'top', value: `${Math.round(y)}px` }, { op: 'STYLE_SET', id: c.id, breakpoint, property: 'width', value: `${Math.round(w)}px` });
      y += h + 16;
    }
    ops.push({ op: 'STYLE_SET', id: node.id, breakpoint, property: 'minHeight', value: `${Math.round(y + 8)}px` });
    const { applied } = store.getState().applyMany(ops);
    if (applied) toast.success(t('simple.arranged', { bp: L.bp(breakpoint) }));
    onChange();
  };

  return (
    <>
      <Bar style={{ left: rect.x + 8, top: Math.max(4, rect.y + 44) }}>
        <span className="px-1.5 text-[11px] text-muted-foreground">{t('simple.addElement')}</span>
        {FREE_ELEMENTS.map(({ type, icon: Icon }) => (
          <span key={type} onPointerDown={dragNew(type, L.name(type))}>
            <BarBtn label={`${L.name(type)} — ${t('board.dragHint')}`} onClick={() => {
                // The click that ends a drag must not add a second element.
                if (suppress.current) suppress.current = false;
                else add(type);
              }}>
              <Icon className="h-3.5 w-3.5" />
            </BarBtn>
          </span>
        ))}
        {breakpoint !== 'base' && node.children.length > 0 && (
          <>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <BarBtn label={t('simple.arrange', { bp: L.bp(breakpoint) })} onClick={arrange}>
              <LayoutGrid className="h-3.5 w-3.5" /> <span className="hidden lg:inline">{t('simple.arrangeShort')}</span>
            </BarBtn>
          </>
        )}
      </Bar>
      <div
        data-builder-ui
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('simple.height')}
        title={t('simple.height')}
        onPointerDown={startHeight}
        className="pointer-events-auto absolute z-20 flex cursor-ns-resize items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground shadow"
        style={{ left: rect.x + 16, top: rect.y + rect.h - 10 }}
      >
        {/* Left of the "+" inserter in the middle, so both stay reachable. */}
        <GripHorizontal className="h-3 w-3" aria-hidden /> {t('simple.heightShort')}
      </div>
    </>
  );
}

/**
 * Text editing in place: double-click a text element ([data-field] from the renderer), type, and
 * Enter/blur saves it as one prop edit (Shift+Enter: new line where the field allows it); Escape
 * cancels. Rich text is edited in place when it is plain paragraphs, otherwise in the panel.
 */
export function useInlineEditing(hostRef: React.RefObject<HTMLDivElement | null>, readOnly: boolean) {
  const store = useBuilderStore();
  const t = useT();
  const start = useCallback(
    (el: HTMLElement) => {
      const blockEl = el.closest<HTMLElement>('[data-block-id]');
      const id = blockEl?.dataset.blockId;
      const path = el.dataset.field;
      if (!id || !path || blockEl.hasAttribute('data-locked')) return;
      const node = findNode(store.getState().draft.content.root, id);
      if (!node) return;
      const rich = path === 'doc';
      if (rich && !isSimpleDoc(node.props.doc as RichTextDoc)) {
        store.getState().select(id);
        store.getState().openInspector('block');
        toast(t('simple.richInPanel'));
        return;
      }
      const before = el.innerText;
      el.contentEditable = 'plaintext-only';
      el.dataset.editing = '';
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const multiline = rich || /(^|\.)(text|subtitle|a|quote|intro)$/.test(path);
      const finish = (save: boolean) => {
        el.removeEventListener('keydown', onKey);
        el.removeEventListener('blur', onBlur);
        el.contentEditable = 'false';
        el.removeAttribute('contenteditable');
        delete el.dataset.editing;
        const text = el.innerText.replace(/\n+$/, '');
        if (!save || text === before) {
          el.innerText = before;
          return;
        }
        store.getState().updateProps(id, patchFor(node, path, rich ? text.replace(/\n(?!\n)/g, '\n\n') : text));
      };
      const onKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
          el.blur();
        } else if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
          e.preventDefault();
          finish(true);
        }
      };
      const onBlur = () => finish(true);
      el.addEventListener('keydown', onKey);
      el.addEventListener('blur', onBlur);
    },
    [store, t],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || readOnly) return;
    const onDbl = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-field]');
      if (el && host.contains(el) && !el.closest('[data-component-instance]')) {
        e.preventDefault();
        start(el);
      }
    };
    host.addEventListener('dblclick', onDbl);
    return () => host.removeEventListener('dblclick', onDbl);
  }, [hostRef, readOnly, start]);
}

/** "items.2.title" → a props patch replacing that list item's field; "doc" → rich text. */
function patchFor(node: BlockNode, path: string, text: string): Record<string, unknown> {
  if (path === 'doc') return { doc: plainToDoc(text) };
  const [list, i, field] = path.split('.');
  if (field !== undefined && list && i !== undefined) {
    const items = Array.isArray(node.props[list]) ? [...(node.props[list] as Record<string, unknown>[])] : [];
    items[Number(i)] = { ...(items[Number(i)] ?? {}), [field]: text };
    return { [list]: items };
  }
  return { [path]: text };
}
