'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Braces, RefreshCw, Search, Sparkles } from 'lucide-react';
import { useParams } from 'next/navigation';
import { Fragment, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, Input } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage, refreshSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

interface Hit {
  id: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
  title: string;
  path: string;
  heading: string | null;
  collection: string | null;
  snippet: string;
  score: number;
  via: ('lexical' | 'semantic')[];
}
interface Citation {
  n: number;
  title: string;
  heading: string | null;
  url: string;
  snippet: string;
}
interface FactRef {
  ref: string;
  key: string;
  subject: string;
  predicate: string;
  displayValue: string;
}

/** ts_headline marks matches with << >>; render them as <mark> without injecting HTML. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(<<.*?>>)/g).map((part, i) => (part.startsWith('<<') ? <mark key={i} className="rounded bg-primary/15 px-0.5 text-foreground">{part.slice(2, -2)}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

export default function SiteSearch() {
  const { siteId } = useParams<{ siteId: string }>();
  const tid = useTenantId();
  const ability = useAbility();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const stats = useQuery({ queryKey: ['knowledge-stats', tid, siteId], queryFn: () => api<{ chunks: number; embedded: number; entities: number; updatedAt: string | null }>(`/sites/${siteId}/knowledge/stats`), enabled: Boolean(tid) });
  const results = useQuery({ queryKey: ['search', tid, siteId, submitted], queryFn: () => api<{ semantic: boolean; hits: Hit[] }>(`/sites/${siteId}/search?q=${encodeURIComponent(submitted)}`), enabled: Boolean(tid && submitted) });
  const reindex = useMutation({ mutationFn: () => api<{ pages: number; entries: number }>(`/sites/${siteId}/knowledge/reindex`, { body: {} }), onSuccess: (r) => toast.success(`Queued ${r.pages} pages and ${r.entries} entries`), onError: (err) => toast.error(errorMessage(err)) });

  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<{ citations: Citation[]; facts: FactRef[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const ask = async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setAnswer('');
    setSources(null);
    setAsking(true);
    try {
      const send = () =>
        fetch(`/api/v1/sites/${siteId}/ask/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${useAuth.getState().accessToken ?? ''}` },
          body: JSON.stringify({ question: submitted || q }),
          signal: ctrl.signal,
        });
      let res = await send();
      if (res.status === 401 && (await refreshSession())) res = await send();
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null');
          if (event === 'sources') setSources(data);
          else if (event === 'delta') setAnswer((a) => a + (data as { text: string }).text);
          else if (event === 'error') throw new Error((data as { message: string }).message);
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) toast.error(err instanceof Error ? err.message : 'Ask failed');
    } finally {
      setAsking(false);
    }
  };

  const cited = new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Index: {stats.data?.entities ?? 0} published pages/entries · {stats.data?.chunks ?? 0} chunks · {stats.data?.embedded ?? 0} with embeddings{stats.data?.updatedAt ? ` · updated ${relativeTime(stats.data.updatedAt)}` : ''}
        </span>
        {ability.can('update', 'Site') && (
          <Button size="sm" variant="outline" loading={reindex.isPending} onClick={() => reindex.mutate()}>
            <RefreshCw className="h-3.5 w-3.5" /> Rebuild index
          </Button>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <Input aria-label="Search the site" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search published content, or ask a question" />
        <Button type="submit" variant="outline" disabled={!q.trim()}>
          <Search className="h-4 w-4" /> Search
        </Button>
        {ability.can('invoke', 'Ai') && (
          <Button type="button" loading={asking} disabled={!q.trim()} onClick={() => (setSubmitted(q.trim()), void ask())}>
            <Sparkles className="h-4 w-4" /> Ask
          </Button>
        )}
      </form>

      {(answer || sources) && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <p className="flex items-center gap-1 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" /> Answer
            </p>
            <p className="whitespace-pre-wrap text-sm" aria-live="polite">
              {answer || (asking ? '…' : '')}
            </p>
            {sources && sources.facts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {sources.facts.map((f) => (
                  <Badge key={f.ref} className={answer.includes(`[${f.ref}]`) ? 'border-primary/40 text-primary' : ''}>
                    <Braces className="mr-1 h-3 w-3" />
                    {f.ref} {f.subject}: {f.displayValue}
                  </Badge>
                ))}
              </div>
            )}
            {sources && sources.citations.length > 0 && (
              <ol className="space-y-1 text-xs">
                {sources.citations
                  .filter((c) => !cited.size || cited.has(c.n))
                  .map((c) => (
                    <li key={c.n}>
                      [{c.n}]{' '}
                      <a href={c.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {c.title}
                        {c.heading && c.heading !== c.title ? ` — ${c.heading}` : ''}
                      </a>
                    </li>
                  ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}

      {results.isError && <Alert tone="error">{errorMessage(results.error)}</Alert>}
      {results.data && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {results.data.hits.length} results · {results.data.semantic ? 'hybrid (full-text + semantic)' : 'full-text (no embedding model configured)'}
          </p>
          {results.data.hits.map((h) => (
            <Card key={h.id}>
              <CardContent className="space-y-1 p-3">
                <p className="text-sm font-medium">
                  {h.title} <span className="font-normal text-muted-foreground">{h.path}</span>
                </p>
                {h.heading && h.heading !== h.title && <p className="text-xs text-muted-foreground">{h.heading}</p>}
                <p className="text-sm">
                  <Snippet text={h.snippet} />
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {h.entityType === 'ENTRY' ? `entry · ${h.collection}` : 'page'} · {h.via.join(' + ')} · score {h.score}
                </p>
              </CardContent>
            </Card>
          ))}
          {results.data.hits.length === 0 && <p className="text-sm text-muted-foreground">No published content matches. Drafts are never searchable.</p>}
        </div>
      )}
    </div>
  );
}
