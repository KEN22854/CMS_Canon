'use client';

import { getBlock, type BlockNode } from '@canon/blocks';
import type { BlockPatch } from '@canon/edge';
import { useMutation } from '@tanstack/react-query';
import { EyeOff, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Input, Label, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatUsd } from '@/lib/utils';

const HIDDEN = '__hidden';

export interface EditableBlock {
  id: string;
  type: string;
  name: string;
  /** Short AI-rewritable text fields: what a variant may change. */
  fields: { key: string; label: string; multiline: boolean; value: string }[];
}

/** Blocks a variant can change: anything with plain text fields (titles, buttons, quotes…). */
export function editableBlocks(root: BlockNode): EditableBlock[] {
  const out: EditableBlock[] = [];
  const walk = (n: BlockNode) => {
    const def = getBlock(n.type);
    if (def && n.id !== root.id) {
      const fields = Object.entries(def.fields)
        .filter(([, f]) => f.ai && (f.kind === 'text' || f.kind === 'textarea'))
        .map(([key, f]) => ({ key, label: f.label, multiline: f.kind === 'textarea', value: typeof n.props[key] === 'string' ? (n.props[key] as string) : '' }));
      const preview = fields.find((f) => f.value)?.value;
      out.push({ id: n.id, type: n.type, name: `${def.name}${preview ? ` — ${preview.slice(0, 40)}` : ''}`, fields });
    }
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export interface Suggestion {
  name: string;
  hypothesis: string;
  patch: BlockPatch;
}

/**
 * Edits one variant's patch: per block, override text fields or hide the block. Empty overrides
 * are dropped, so the patch only ever holds real changes.
 */
export function PatchEditor({ blocks, patch, onChange, disabled }: { blocks: EditableBlock[]; patch: BlockPatch; onChange: (p: BlockPatch) => void; disabled?: boolean }) {
  const touched = Object.keys(patch);
  const addable = blocks.filter((b) => !touched.includes(b.id));
  const set = (blockId: string, key: string, value: unknown) => {
    const props = { ...(patch[blockId] ?? {}) };
    if (value === '' || value === false || value === undefined) delete props[key];
    else props[key] = value;
    const next = { ...patch };
    if (Object.keys(props).length) next[blockId] = props;
    else delete next[blockId];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {touched.map((id) => {
        const b = blocks.find((x) => x.id === id);
        if (!b) return null;
        const props = patch[id] ?? {};
        const hidden = props[HIDDEN] === true;
        return (
          <div key={id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{b.name}</p>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" disabled={disabled} checked={hidden} onChange={(e) => set(id, HIDDEN, e.target.checked)} /> <EyeOff className="h-3 w-3" aria-hidden /> Hide
                </label>
                {!disabled && (
                  <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => onChange(Object.fromEntries(Object.entries(patch).filter(([k]) => k !== id)))}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            {!hidden &&
              b.fields.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs" htmlFor={`${id}-${f.key}`}>
                    {f.label} <span className="font-normal text-muted-foreground">· original: {f.value || '—'}</span>
                  </Label>
                  {f.multiline ? (
                    <textarea id={`${id}-${f.key}`} rows={2} disabled={disabled} value={typeof props[f.key] === 'string' ? (props[f.key] as string) : ''} placeholder={f.value} onChange={(e) => set(id, f.key, e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
                  ) : (
                    <Input id={`${id}-${f.key}`} disabled={disabled} value={typeof props[f.key] === 'string' ? (props[f.key] as string) : ''} placeholder={f.value} onChange={(e) => set(id, f.key, e.target.value)} />
                  )}
                </div>
              ))}
          </div>
        );
      })}
      {!disabled && addable.length > 0 && (
        <Select aria-label="Change a block" value="" onChange={(e) => e.target.value && onChange({ ...patch, [e.target.value]: {} })}>
          <option value="">+ Change a block…</option>
          {addable.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/** "Write variants for this block": validated AI patches the user can adopt as-is or edit. */
export function SuggestButton({ siteId, pageId, blocks, goal, segmentId, onPick, label = 'Suggest with AI' }: { siteId: string; pageId: string; blocks: EditableBlock[]; goal?: string; segmentId?: string; onPick: (s: Suggestion[]) => void; label?: string }) {
  const candidates = useMemo(() => blocks.filter((b) => b.fields.some((f) => f.value)), [blocks]);
  const [picked, setPicked] = useState<string | null>(null);
  const blockId = picked ?? candidates[0]?.id;
  const suggest = useMutation({
    mutationFn: (blockId: string) => api<{ variants: Suggestion[]; ai: { model: string; costUsd: number } }>(`/sites/${siteId}/pages/${pageId}/experiments/suggest`, { body: { blockId, count: segmentId ? 1 : 2, goal, segmentId } }),
    onSuccess: (r) => {
      onPick(r.variants);
      toast.success(`${r.variants.length} suggestion${r.variants.length === 1 ? '' : 's'} · ${formatUsd(r.ai.costUsd)}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!candidates.length) return null;
  return (
    <div className="flex items-center gap-2">
      <Select aria-label="Block to rewrite" className="max-w-xs" value={blockId} onChange={(e) => setPicked(e.target.value)}>
        {candidates.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
      <Button type="button" size="sm" variant="outline" loading={suggest.isPending} onClick={() => blockId && suggest.mutate(blockId)}>
        <Sparkles className="h-4 w-4 text-primary" /> {label}
      </Button>
    </div>
  );
}
