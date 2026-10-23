'use client';

import { getBlock, type BlockNode } from '@canon/blocks';
import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { DropTarget } from './drop';
import { blockSummary } from './palette';
import { useBuilder } from './store';

/** Tree view of the page; rows are drag sources and (via data-layer-id) drop targets. */
export function Layers({ hostRef, drop }: { hostRef: React.RefObject<HTMLDivElement | null>; drop: DropTarget | null }) {
  const root = useBuilder((s) => s.draft.content.root);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed((c) => (c.has(id) ? (c.delete(id), new Set(c)) : new Set(c.add(id))));
  return (
    <div ref={hostRef} className="relative p-2" role="tree" aria-label="Layers">
      {root.children.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">No blocks yet.</p>}
      {root.children.map((c) => (
        <Row key={c.id} node={c} depth={0} collapsed={collapsed} toggle={toggle} />
      ))}
      {drop && !drop.box && <div className="pointer-events-none absolute rounded-full bg-primary" style={{ left: drop.line.x, top: drop.line.y, width: drop.line.w, height: drop.line.h }} />}
    </div>
  );
}

function Row({ node, depth, collapsed, toggle }: { node: BlockNode; depth: number; collapsed: Set<string>; toggle: (id: string) => void }) {
  const selected = useBuilder((s) => s.selectedId === node.id);
  const hovered = useBuilder((s) => s.hoverId === node.id);
  const select = useBuilder((s) => s.select);
  const hover = useBuilder((s) => s.hover);
  const drag = useDraggable({ id: `layer-${node.id}`, data: { kind: 'move', id: node.id, type: node.type } });
  const open = !collapsed.has(node.id);
  const hasKids = node.children.length > 0;
  return (
    <div role="treeitem" aria-selected={selected} aria-expanded={hasKids ? open : undefined}>
      <div
        data-layer-id={node.id}
        data-depth={depth}
        onClick={() => select(node.id)}
        onMouseEnter={() => hover(node.id)}
        style={{ paddingLeft: 4 + depth * 14 }}
        className={cn('group flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-xs', selected ? 'bg-primary/10 text-primary' : hovered ? 'bg-muted' : 'hover:bg-muted', drag.isDragging && 'opacity-40')}
      >
        <button type="button" aria-label={open ? 'Collapse' : 'Expand'} onClick={(e) => (e.stopPropagation(), toggle(node.id))} className={cn('rounded p-0.5', !hasKids && 'invisible')}>
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <span className="w-16 shrink-0 truncate font-medium">{getBlock(node.type)?.name ?? node.type}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{blockSummary(node)}</span>
        <span ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} aria-label="Drag to move" className="cursor-grab rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100">
          <GripVertical className="h-3 w-3" />
        </span>
      </div>
      {open && node.children.map((c) => <Row key={c.id} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />)}
    </div>
  );
}
