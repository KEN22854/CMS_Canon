'use client';

import { BLOCKS, getBlock, richTextToPlain, type BlockNode, type RichTextDoc } from '@canon/blocks';
import { useDraggable } from '@dnd-kit/core';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, formatUsd } from '@/lib/utils';
import { Button, Select } from '../ui';
import { cloneWithIds, newBlock } from '../editor/tree-ops';
import { useBuilder, useBuilderStore } from './store';

const CATEGORIES: { id: (typeof BLOCKS)[number]['category']; label: string }[] = [
  { id: 'layout', label: 'Layout' },
  { id: 'content', label: 'Content' },
  { id: 'media', label: 'Media' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'navigation', label: 'Navigation' },
];

/** Click inserts next to the selection; drag drops anywhere on the canvas or into the layers list. */
export function Palette({ siteId, pageId, locale }: { siteId: string; pageId: string; locale: string }) {
  const insert = useBuilder((s) => s.insert);
  return (
    <div className="space-y-5 p-3">
      <GenerateBlock siteId={siteId} pageId={pageId} locale={locale} />
      {CATEGORIES.map((c) => {
        const blocks = BLOCKS.filter((b) => b.category === c.id && b.type !== 'column');
        if (!blocks.length) return null;
        return (
          <div key={c.id}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {blocks.map((b) => (
                <PaletteItem key={b.type} type={b.type} name={b.name} description={b.description} onAdd={() => insert(newBlock(b.type))} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PaletteItem({ type, name, description, onAdd }: { type: string; name: string; description: string; onAdd: () => void }) {
  const drag = useDraggable({ id: `palette-${type}`, data: { kind: 'new', type } });
  return (
    <button
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      type="button"
      title={description}
      onClick={onAdd}
      className={cn('rounded-md border bg-card px-2 py-2 text-left text-xs font-medium hover:border-primary hover:text-primary', drag.isDragging && 'opacity-40')}
    >
      {name}
    </button>
  );
}

function GenerateBlock({ siteId, pageId, locale }: { siteId: string; pageId: string; locale: string }) {
  const store = useBuilderStore();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const root = store.getState().draft.content.root;
      const res = await api<{ block: BlockNode; ai: { costUsd: number; model: string } }>(`/sites/${siteId}/ai/generate-block`, {
        body: { brief, type: type || undefined, locale, outline: outlineOf(root.children), pageId },
      });
      store.getState().insert(cloneWithIds(res.block));
      toast.success(`Added ${getBlock(res.block.type)?.name ?? res.block.type} · ${formatUsd(res.ai.costUsd)}`, { action: { label: 'Undo', onClick: () => store.temporal.getState().undo() } });
      setBrief('');
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <Sparkles className="h-3.5 w-3.5 text-primary" /> Generate a block
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border bg-card p-2">
      <textarea
        autoFocus
        rows={3}
        value={brief}
        maxLength={2000}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && brief.trim().length >= 3 && void generate()}
        placeholder="e.g. Three reasons teams switch to us"
        aria-label="Describe the block"
        className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm"
      />
      <Select aria-label="Block type" value={type} onChange={(e) => setType(e.target.value)} className="h-8 w-full text-xs">
        <option value="">Any block type</option>
        {BLOCKS.filter((b) => b.type !== 'column' && b.type !== 'spacer' && b.type !== 'divider').map((b) => (
          <option key={b.type} value={b.type}>
            {b.name}
          </option>
        ))}
      </Select>
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" loading={busy} disabled={brief.trim().length < 3} onClick={() => void generate()}>
          Generate
        </Button>
      </div>
    </div>
  );
}

/** "hero: Ship faster" lines so generated blocks fit the page instead of repeating it. */
export function outlineOf(blocks: BlockNode[]): string[] {
  return blocks.slice(0, 60).map((b) => `${b.type}: ${blockSummary(b).slice(0, 120)}`);
}

export function blockSummary(b: BlockNode): string {
  const p = b.props;
  for (const k of ['title', 'text', 'label', 'quote', 'caption', 'alt', 'name']) if (typeof p[k] === 'string' && p[k]) return p[k] as string;
  if (p.doc && typeof p.doc === 'object') return richTextToPlain(p.doc as RichTextDoc).slice(0, 80) || '—';
  if (Array.isArray(p.items)) return `${p.items.length} item${p.items.length === 1 ? '' : 's'}`;
  if (b.children.length) return `${b.children.length} block${b.children.length === 1 ? '' : 's'}`;
  return '—';
}
