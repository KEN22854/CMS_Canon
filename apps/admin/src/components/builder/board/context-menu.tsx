'use client';

import { ArrowDownToLine, ArrowUpLeft, ArrowUpToLine, BringToFront, ClipboardPaste, Copy, CopyPlus, Eye, EyeOff, Group, Lock, Paintbrush, Scissors, SendToBack, Settings2, SquareDashedMousePointer, Trash2, Ungroup, Unlock, Wand2, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { MAX_NODES } from '@canon/blocks';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findNode } from '../../editor/tree-ops';
import { useBuilderStore } from '../store';
import { arrange, arrangeToEnd, selectParent, toggleHidden, toggleLocked } from './actions';

export interface MenuState {
  /** Viewport (client) coordinates of the right-click. */
  x: number;
  y: number;
  /** The block right-clicked, or null for the empty page/board. */
  blockId: string | null;
}

export interface MenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/**
 * Right-click menu of the canvas and the board: the block commands of the toolbar and shortcuts
 * in one list, each running the same store operation (one undo step). Rendered in a portal, so a
 * zoomed or panned board never displaces it.
 */
export function ContextMenu({ state, onClose, extra = [] }: { state: MenuState; siteId?: string; pageId?: string; onClose: () => void; extra?: MenuItem[] }) {
  const t = useT();
  const store = useBuilderStore();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const s = store.getState();
  const root = s.draft.content.root;
  const node = state.blockId ? findNode(root, state.blockId) : null;
  const count = s.selectedIds.length;
  const say = (key: MessageKey, n: number) => toast.success(t(key, { count: n }), { id: 'clipboard' });
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const items: (MenuItem | 'sep')[] = node
    ? [
        { key: 'content', label: t('board.menu.content'), icon: Settings2, onSelect: run(() => s.openInspector('block')) },
        { key: 'design', label: t('board.menu.design'), icon: Paintbrush, onSelect: run(() => s.openInspector('style')) },
        { key: 'ai', label: t('board.menu.ai'), icon: Wand2, onSelect: run(() => s.openInspector('ai')) },
        'sep',
        { key: 'copy', label: t('board.menu.copy'), icon: Copy, shortcut: `${mod}C`, onSelect: run(() => say('builder.copied', s.copy())) },
        { key: 'cut', label: t('board.menu.cut'), icon: Scissors, shortcut: `${mod}X`, disabled: Boolean(node.locked), onSelect: run(() => say('builder.cut', s.cut())) },
        { key: 'paste', label: t('board.menu.paste'), icon: ClipboardPaste, shortcut: `${mod}V`, onSelect: run(() => paste()) },
        { key: 'duplicate', label: t('board.menu.duplicate'), icon: CopyPlus, shortcut: `${mod}D`, onSelect: run(() => s.duplicateSelection()) },
        'sep',
        { key: 'group', label: t('board.menu.group'), icon: Group, shortcut: `${mod}G`, onSelect: run(() => void (s.group() || toast.error(t('builder.cantGroup')))) },
        ...(count === 1 && node.type === 'group' ? [{ key: 'ungroup', label: t('board.menu.ungroup'), icon: Ungroup, shortcut: `${mod}⇧G`, onSelect: run(() => s.ungroup(node.id)) }] : []),
        { key: 'parent', label: t('board.menu.parent'), icon: ArrowUpLeft, shortcut: 'Esc', onSelect: run(() => selectParent(store)) },
        'sep',
        { key: 'forward', label: t('board.menu.forward'), icon: ArrowUpToLine, shortcut: `${mod}]`, onSelect: run(() => void arrange(store, 1)) },
        { key: 'backward', label: t('board.menu.backward'), icon: ArrowDownToLine, shortcut: `${mod}[`, onSelect: run(() => void arrange(store, -1)) },
        { key: 'front', label: t('board.menu.front'), icon: BringToFront, onSelect: run(() => void arrangeToEnd(store, 'front')) },
        { key: 'back', label: t('board.menu.back'), icon: SendToBack, onSelect: run(() => void arrangeToEnd(store, 'back')) },
        'sep',
        { key: 'hide', label: node.hidden ? t('board.menu.show') : t('board.menu.hide'), icon: node.hidden ? Eye : EyeOff, shortcut: `${mod}⇧H`, onSelect: run(() => toggleHidden(store)) },
        { key: 'lock', label: node.locked ? t('board.menu.unlock') : t('board.menu.lock'), icon: node.locked ? Unlock : Lock, shortcut: `${mod}⇧L`, onSelect: run(() => toggleLocked(store)) },
        ...extra.map((e) => ({ ...e, onSelect: run(e.onSelect) })),
        'sep',
        { key: 'delete', label: count > 1 ? t('board.menu.deleteMany', { count }) : t('board.menu.delete'), icon: Trash2, shortcut: 'Del', danger: true, disabled: Boolean(node.locked), onSelect: run(() => s.removeSelection()) },
      ]
    : [
        { key: 'paste', label: t('board.menu.paste'), icon: ClipboardPaste, shortcut: `${mod}V`, onSelect: run(() => paste()) },
        { key: 'all', label: t('board.menu.selectAll'), icon: SquareDashedMousePointer, shortcut: `${mod}A`, onSelect: run(() => s.selectAll()) },
        ...extra.map((e) => ({ ...e, onSelect: run(e.onSelect) })),
      ];

  function paste() {
    const hit = store.getState().limitHit;
    const n = store.getState().paste();
    if (n) say('builder.pasted', n);
    else if (store.getState().limitHit !== hit) toast.error(t('builder.tooManyBlocks', { max: MAX_NODES }), { id: 'clipboard' });
    else toast(t('builder.nothingToPaste'), { id: 'clipboard' });
  }

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(state.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(state.y, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} role="menu" aria-label={t('board.menu.label')} data-builder-ui className="fixed z-[100] min-w-52 rounded-lg border bg-card p-1 text-card-foreground shadow-xl" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          i > 0 && items[i - 1] !== 'sep' ? <div key={`s${i}`} role="separator" className="my-1 h-px bg-border" /> : null
        ) : (
          <button key={it.key} type="button" role="menuitem" disabled={it.disabled} onClick={it.onSelect} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-40', it.danger && 'text-destructive')}>
            {it.icon ? <it.icon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden /> : <span className="w-3.5" />}
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <kbd className="font-sans text-[10px] text-muted-foreground">{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
