'use client';

import type { PageContent } from '@canon/blocks';
import { ImagePlus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { uploadMedia } from '@/lib/content';
import { formatUsd } from '@/lib/utils';
import { Alert, Button } from '../ui';
import { cloneWithIds } from '../editor/tree-ops';
import { useBuilderStore } from './store';

export interface GeneratedPage {
  title: string;
  description: string;
  content: PageContent;
  dropped: { type: string; issues: string[] }[];
  repaired: boolean;
  ai: { model: string; costUsd: number; calls: number };
}

const EXAMPLES = ['Pricing page for a B2B analytics tool with three plans and an FAQ', 'About us: our story, values and a team photo section', 'Landing page for a webinar on data privacy, with agenda and sign-up CTA'];

/**
 * "Generate page from prompt": the brief (and optional reference screenshot) goes to the API,
 * which validates every block; the result lands in the undoable store, so trying it is free.
 */
export function GeneratePageDialog({ siteId, pageId, locale, onClose }: { siteId: string; pageId: string; locale: string; onClose: () => void }) {
  const store = useBuilderStore();
  const empty = store.getState().draft.content.root.children.length === 0;
  const [brief, setBrief] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>(empty ? 'replace' : 'append');
  const [shot, setShot] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const m = await uploadMedia(siteId, f, '/ai-references');
      setShot({ id: m.id, name: f.name });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<GeneratedPage>(`/sites/${siteId}/ai/generate-page`, { body: { brief, locale, pageId, screenshotMediaId: shot?.id } });
      const { draft } = store.getState();
      const blocks = res.content.root.children.map(cloneWithIds);
      // The page frame (root section props) stays the editor's; only the blocks come from AI.
      const children = mode === 'replace' ? blocks : [...draft.content.root.children, ...blocks];
      store.getState().setContent({ root: { ...draft.content.root, children } });
      if (!draft.description && res.description) store.getState().setMeta({ description: res.description });
      toast.success(`Generated ${blocks.length} blocks${res.repaired ? ' (after one self-repair)' : ''} · ${formatUsd(res.ai.costUsd)}`, {
        description: res.dropped.length ? `${res.dropped.length} invalid block(s) were left out.` : undefined,
        action: { label: 'Undo', onClick: () => store.temporal.getState().undo() },
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="gen-title">
      <div className="w-full max-w-xl space-y-4 rounded-lg border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="gen-title" className="flex items-center gap-2 font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> Generate page with AI
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <textarea
          autoFocus
          rows={5}
          maxLength={4000}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Describe the page: audience, goal, sections you want…"
          aria-label="Page brief"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => setBrief(ex)} className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary hover:text-primary">
              {ex}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            {shot ? (
              <span className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
                Reference: {shot.name}
                <button type="button" aria-label="Remove reference" onClick={() => setShot(null)} className="rounded hover:bg-muted">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <Button type="button" size="sm" variant="outline" loading={uploading} onClick={() => file.current?.click()}>
                <ImagePlus className="h-3.5 w-3.5" /> Reference screenshot
              </Button>
            )}
          </div>
          {!empty && (
            <div className="flex rounded-md border p-0.5 text-xs" role="radiogroup" aria-label="Apply mode">
              {(['append', 'replace'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={mode === m ? 'rounded bg-primary px-2 py-1 text-primary-foreground' : 'px-2 py-1 text-muted-foreground'}>
                  {m === 'append' ? 'Add below' : 'Replace page'}
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <p className="text-[11px] text-muted-foreground">Uses the site’s brand voice and Canon facts (prices, numbers stay bound to the source of truth). Nothing is published; Ctrl+Z undoes it.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={brief.trim().length < 10} onClick={() => void generate()}>
            <Sparkles className="h-4 w-4" /> Generate
          </Button>
        </div>
      </div>
    </div>
  );
}
