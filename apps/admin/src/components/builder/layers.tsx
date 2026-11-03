'use client';

import { getBlock, type BlockNode } from '@canon/blocks';
import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, GripVertical, Lock, Paintbrush, Trash2, Unlock } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { DropTarget } from './drop';
import { blockSummary } from './palette';
import { useBuilder } from './store';

/**
 * Tree view of the page; rows are drag sources and (via data-layer-id) drop targets. Double-click a
 * name to rename it; the row actions hide, lock, duplicate and delete.
 */
export function Layers({ hostRef, drop, readOnly = false }: { hostRef: React.RefObject<HTMLDivElement | null>; drop: DropTarget | null; readOnly?: boolean }) {
  const root = useBuilder((s) => s.draft.content.root);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed((c) => (c.has(id) ? (c.delete(id), new Set(c)) : new Set(c.add(id))));
  return (
    <div ref={hostRef} className="relative p-2" role="tree" aria-label="Layers">
      {root.children.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">No blocks yet.</p>}
      {root.children.map((c) => (
        <Row key={c.id} node={c} depth={0} collapsed={collapsed} toggle={toggle} readOnly={readOnly} parentHidden={false} />
      ))}
      {drop && !drop.box && <div className="pointer-events-none absolute rounded-full bg-primary" style={{ left: drop.line.x, top: drop.line.y, width: drop.line.w, height: drop.line.h }} />}
    </div>
  );
}

function Row({ node, depth, collapsed, toggle, readOnly, parentHidden }: { node: BlockNode; depth: number; collapsed: Set<string>; toggle: (id: string) => void; readOnly: boolean; parentHidden: boolean }) {
  const selected = useBuilder((s) => s.selectedId === node.id);
  const hovered = useBuilder((s) => s.hoverId === node.id);
  const select = useBuilder((s) => s.select);
  const hover = useBuilder((s) => s.hover);
  const updateNode = useBuilder((s) => s.updateNode);
  const duplicate = useBuilder((s) => s.duplicate);
  const remove = useBuilder((s) => s.remove);
  const drag = useDraggable({ id: `layer-${node.id}`, data: { kind: 'move', id: node.id, type: node.type }, disabled: readOnly || node.locked });
  const [renaming, setRenaming] = useState(false);
  const open = !collapsed.has(node.id);
  const hasKids = node.children.length > 0;
  const typeName = getBlock(node.type)?.name ?? node.type;
  const label = node.name ?? typeName;
  const dimmed = node.hidden || parentHidden;

  const commitName = (value: string) => {
    setRenaming(false);
    const v = value.trim().slice(0, 60);
    if (v !== (node.name ?? '')) updateNode(node.id, { name: v && v !== typeName ? v : undefined });
  };

  return (
    <div role="treeitem" aria-selected={selected} aria-expanded={hasKids ? open : undefined} aria-label={label}>
      <div
        data-layer-id={node.id}
        data-depth={depth}
        onClick={() => select(node.id)}
        onDoubleClick={() => !readOnly && setRenaming(true)}
        onMouseEnter={() => hover(node.id)}
        style={{ paddingLeft: 4 + depth * 14 }}
        className={cn('group flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-xs', selected ? 'bg-primary/15 text-foreground' : hovered ? 'bg-muted' : 'hover:bg-muted', drag.isDragging && 'opacity-40')}
      >
        <button type="button" aria-label={open ? 'Collapse' : 'Expand'} onClick={(e) => (e.stopPropagation(), toggle(node.id))} className={cn('rounded p-0.5', !hasKids && 'invisible')}>
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <div className={cn('flex min-w-0 flex-1 items-center gap-1.5', dimmed && 'opacity-45')}>
          {renaming ? (
            <input
              autoFocus
              aria-label="Layer name"
              defaultValue={label}
              maxLength={60}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName(e.currentTarget.value);
                if (e.key === 'Escape') setRenaming(false);
                e.stopPropagation();
              }}
              className="h-5 min-w-0 flex-1 rounded border border-primary bg-background px-1 text-xs outline-none"
            />
          ) : (
            <>
              <span className={cn('shrink-0 truncate font-medium', node.name ? 'max-w-[9rem]' : 'w-16')} title={node.name ? `${node.name} (${typeName})` : typeName}>
                {label}
              </span>
              {!node.name && <span className="min-w-0 flex-1 truncate text-muted-foreground">{blockSummary(node)}</span>}
              {node.name && <span className="min-w-0 flex-1 truncate text-muted-foreground">{typeName}</span>}
            </>
          )}
          {node.styles && <Paintbrush className="h-3 w-3 shrink-0 text-primary" aria-label="Has styles" />}
        </div>
        {!readOnly && !renaming && (
          <span className={cn('flex shrink-0 items-center', !(node.hidden || node.locked) && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100', selected && 'opacity-100')}>
            <RowBtn label={node.hidden ? `Show ${label}` : `Hide ${label}`} pressed={Boolean(node.hidden)} onClick={() => updateNode(node.id, { hidden: !node.hidden || undefined })}>
              {node.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </RowBtn>
            <RowBtn label={node.locked ? `Unlock ${label}` : `Lock ${label}`} pressed={Boolean(node.locked)} onClick={() => updateNode(node.id, { locked: !node.locked || undefined })}>
              {node.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </RowBtn>
            <RowBtn label={`Duplicate ${label}`} onClick={() => duplicate(node.id)}>
              <Copy className="h-3 w-3" />
            </RowBtn>
            <RowBtn label={`Delete ${label}`} disabled={node.locked} onClick={() => remove(node.id)}>
              <Trash2 className="h-3 w-3" />
            </RowBtn>
            <span ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} aria-label="Drag to move" className={cn('cursor-grab rounded p-0.5 hover:bg-muted', node.locked && 'cursor-not-allowed opacity-30')}>
              <GripVertical className="h-3 w-3" />
            </span>
          </span>
        )}
      </div>
      {open && node.children.map((c) => <Row key={c.id} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} readOnly={readOnly} parentHidden={dimmed} />)}
    </div>
  );
}

function RowBtn({ label, onClick, pressed, disabled, children }: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={(e) => (e.stopPropagation(), onClick())}
      className={cn('rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30', pressed && 'text-primary')}
    >
      {children}
    </button>
  );
}
