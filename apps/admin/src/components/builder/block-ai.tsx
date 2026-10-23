'use client';

import type { BlockNode } from '@canon/blocks';
import { collectTextFields } from '@canon/blocks';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, formatUsd } from '@/lib/utils';
import { findNode } from '../editor/tree-ops';
import { useBuilderStore } from './store';

export const BLOCK_ACTIONS = [
  { id: 'rewrite', label: 'Improve' },
  { id: 'shorten', label: 'Shorten' },
  { id: 'expand', label: 'Expand' },
  { id: 'simplify', label: 'Simplify' },
  { id: 'formalize', label: 'More formal' },
  { id: 'fix', label: 'Fix grammar' },
] as const;

interface ImproveResult {
  block: BlockNode;
  changed: number;
  model: string;
  costUsd: number;
  status: string;
}

/**
 * Applies an AI rewrite to the block (or one rich-text field of it) and immediately puts the
 * result in the undoable store: one Ctrl+Z reverts it. The server rewrites text leaves in place,
 * so formatting, links and Canon fact tokens are never touched.
 */
export function useImproveBlock(siteId: string, pageId: string) {
  const store = useBuilderStore();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, action: string, fields?: string[]) => {
    const block = findNode(store.getState().draft.content.root, id);
    if (!block) return;
    setBusy(action);
    try {
      const res = await api<ImproveResult>(`/sites/${siteId}/ai/improve-block`, { body: { block, action, fields, pageId } });
      // The user may have kept typing meanwhile: apply onto the current block, keep its children.
      const current = findNode(store.getState().draft.content.root, id);
      if (!current) return;
      store.getState().replace(id, { ...current, props: res.block.props });
      toast.success(`Rewrote ${res.changed} text${res.changed === 1 ? '' : 's'} · ${formatUsd(res.costUsd)}`, {
        action: { label: 'Undo', onClick: () => store.temporal.getState().undo() },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

export function BlockAiMenu({ id, siteId, pageId, variant, fields }: { id: string; siteId: string; pageId: string; variant: 'toolbar' | 'inline'; fields?: string[] }) {
  const store = useBuilderStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { run, busy } = useImproveBlock(siteId, pageId);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const node = findNode(store.getState().draft.content.root, id);
  const hasText = node ? collectTextFields({ root: { ...node, children: [] } }).some((f) => !fields || fields.includes(f.prop)) : false;
  if (!hasText) return null;

  return (
    <div className="relative" ref={ref} data-builder-ui>
      <button
        type="button"
        aria-label="AI: rewrite this block"
        title="AI: rewrite this block"
        onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}
        className={cn('flex items-center gap-1 rounded p-0.5', variant === 'toolbar' ? 'hover:bg-white/15' : 'p-1 text-primary hover:bg-primary/10')}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-44 rounded-md border bg-card p-1 text-card-foreground shadow-lg">
          {BLOCK_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={Boolean(busy)}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                void run(id, a.id, fields);
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
