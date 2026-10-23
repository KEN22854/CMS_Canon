'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatUsd } from '@/lib/utils';
import { Button } from '../ui';

const ACTIONS = [
  { id: 'rewrite', label: 'Improve' },
  { id: 'shorten', label: 'Shorten' },
  { id: 'expand', label: 'Expand' },
  { id: 'simplify', label: 'Simplify' },
  { id: 'formalize', label: 'More formal' },
  { id: 'fix', label: 'Fix grammar' },
] as const;

interface TextResult {
  text: string;
  status: 'SUCCEEDED' | 'DEGRADED' | 'BLOCKED' | 'FAILED';
  model: string;
  costUsd: number;
}

/**
 * ✨ next to a text field. Results are suggestions: the editor applies them explicitly, and the
 * gateway's degraded mode (all providers down) returns the original text with a notice.
 */
export function AiAssist({ value, onApply, siteId, pageId, disabled }: { value: string; onApply: (v: string) => void; siteId: string; pageId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<TextResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const run = async (action: string) => {
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      setResult(await api<TextResult>('/ai/text', { body: { action, text: value, siteId, related: { type: 'PAGE', id: pageId } } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled || !value.trim()}
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-primary hover:bg-primary/10 disabled:opacity-40"
        aria-label="AI writing assistant"
        title="AI writing assistant"
      >
        <Sparkles className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-80 rounded-md border bg-card p-2 shadow-lg">
          <div className="flex flex-wrap gap-1">
            {ACTIONS.map((a) => (
              <Button key={a.id} size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run(a.id)}>
                {busy === a.id && <Loader2 className="h-3 w-3 animate-spin" />}
                {a.label}
              </Button>
            ))}
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          {result && (
            <div className="mt-2 space-y-2">
              {result.status === 'DEGRADED' ? (
                <p className="text-xs text-warning">AI is temporarily unavailable — nothing changed.</p>
              ) : (
                <>
                  <p className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-sm">{result.text}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">
                      {result.model} · {formatUsd(result.costUsd)}
                    </span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                        Discard
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          onApply(result.text);
                          setOpen(false);
                          setResult(null);
                        }}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
