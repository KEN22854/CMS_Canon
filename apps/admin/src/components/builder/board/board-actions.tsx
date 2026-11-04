'use client';

import { MAX_NODES } from '@canon/blocks';
import { AlignCenterVertical, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignVerticalSpaceAround, ArrowDownToLine, ArrowUpToLine, ClipboardPaste, Copy, CopyPlus, Group, PanelLeft, PanelRight, Trash2, Ungroup, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findNode } from '../../editor/tree-ops';
import { freeSelection } from '../free-board';
import { useBuilder, useBuilderStore } from '../store';
import { alignSelection, arrange, distributeSelection } from './actions';

/**
 * The board's edit bar: clipboard, duplicate/delete, group/ungroup, stacking order, align and
 * distribute — each button runs the same store command as its shortcut and the context menu.
 */
export function BoardActions({ hostRef, leftOpen, rightOpen, onToggleLeft, onToggleRight, readOnly }: { hostRef: React.RefObject<HTMLDivElement | null>; leftOpen: boolean; rightOpen: boolean; onToggleLeft: () => void; onToggleRight: () => void; readOnly: boolean }) {
  const t = useT();
  const store = useBuilderStore();
  const count = useBuilder((s) => s.selectedIds.length);
  const primary = useBuilder((s) => (s.selectedId ? findNode(s.draft.content.root, s.selectedId) : null));
  const free = useBuilder((s) => Boolean(freeSelection(s.draft.content.root, s.selectedIds)));
  const freeCount = useBuilder((s) => freeSelection(s.draft.content.root, s.selectedIds)?.ids.length ?? 0);
  const none = count === 0 || readOnly;
  const say = (key: MessageKey, n: number) => toast.success(t(key, { count: n }), { id: 'clipboard' });
  // Zoom of the active artboard: its rendered width over its CSS width.
  const scale = () => {
    const host = hostRef.current;
    const art = host?.closest<HTMLElement>('[data-artboard]');
    if (!host || !art) return 1;
    const w = Number(art.dataset.artboardWidth);
    return w ? host.getBoundingClientRect().width / w : 1;
  };
  const align = (how: Parameters<typeof alignSelection>[3]) => void (alignSelection(store, hostRef.current, scale(), how) || toast(t('board.alignNothing'), { id: 'align' }));
  const paste = () => {
    const s = store.getState();
    const hit = s.limitHit;
    const n = s.paste();
    if (n) say('builder.pasted', n);
    else if (store.getState().limitHit !== hit) toast.error(t('builder.tooManyBlocks', { max: MAX_NODES }), { id: 'clipboard' });
    else toast(t('builder.nothingToPaste'), { id: 'clipboard' });
  };

  return (
    <div data-board-ui className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-card px-2" role="toolbar" aria-label={t('board.actions')}>
      <Btn icon={PanelLeft} label={t('board.toggleLeft')} pressed={leftOpen} onClick={onToggleLeft} />
      <Sep />
      {!readOnly && (
        <>
          <Btn icon={Copy} label={t('board.menu.copy')} disabled={none} onClick={() => say('builder.copied', store.getState().copy())} />
          <Btn icon={ClipboardPaste} label={t('board.menu.paste')} onClick={paste} />
          <Btn icon={CopyPlus} label={t('board.menu.duplicate')} disabled={none} onClick={() => store.getState().duplicateSelection()} />
          <Btn icon={Trash2} label={t('board.menu.delete')} disabled={none || Boolean(primary?.locked && count === 1)} onClick={() => store.getState().removeSelection()} />
          <Sep />
          <Btn icon={Group} label={t('board.menu.group')} disabled={none} onClick={() => void (store.getState().group() || toast.error(t('builder.cantGroup')))} />
          <Btn icon={Ungroup} label={t('board.menu.ungroup')} disabled={none || count !== 1 || primary?.type !== 'group'} onClick={() => primary && store.getState().ungroup(primary.id)} />
          <Btn icon={ArrowUpToLine} label={t('board.menu.forward')} disabled={none} onClick={() => void arrange(store, 1)} />
          <Btn icon={ArrowDownToLine} label={t('board.menu.backward')} disabled={none} onClick={() => void arrange(store, -1)} />
          <Sep />
          <Btn icon={AlignStartVertical} label={t('board.alignLeft')} disabled={none} onClick={() => align('left')} />
          <Btn icon={AlignCenterVertical} label={t('board.alignHCenter')} disabled={none} onClick={() => align('hcenter')} />
          <Btn icon={AlignEndVertical} label={t('board.alignRight')} disabled={none} onClick={() => align('right')} />
          <Btn icon={AlignStartHorizontal} label={t('board.alignTop')} disabled={none || !free} onClick={() => align('top')} />
          <Btn icon={AlignCenterHorizontal} label={t('board.alignVCenter')} disabled={none || !free} onClick={() => align('vcenter')} />
          <Btn icon={AlignEndHorizontal} label={t('board.alignBottom')} disabled={none || !free} onClick={() => align('bottom')} />
          <Btn icon={AlignHorizontalSpaceAround} label={t('board.distributeX')} disabled={freeCount < 3} onClick={() => void distributeSelection(store, hostRef.current, scale(), 'x')} />
          <Btn icon={AlignVerticalSpaceAround} label={t('board.distributeY')} disabled={freeCount < 3} onClick={() => void distributeSelection(store, hostRef.current, scale(), 'y')} />
        </>
      )}
      <span className="ml-auto" />
      <Btn icon={PanelRight} label={t('board.toggleRight')} pressed={rightOpen} onClick={onToggleRight} />
    </div>
  );
}

function Btn({ icon: Icon, label, onClick, disabled, pressed }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean; pressed?: boolean }): ReactNode {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick} className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30', pressed ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
      <Icon className="h-4 w-4" />
    </button>
  );
}

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
