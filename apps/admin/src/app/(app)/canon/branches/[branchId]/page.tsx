'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Check, ChevronDown, ChevronRight, GitBranch, GitMerge, Loader2, Pencil, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, Input } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { VERDICT_STYLE, entityHref, useBranch, type AgentRun, type Branch, type SpanResult } from '@/lib/canon';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

export default function BranchPage() {
  const { branchId } = useParams<{ branchId: string }>();
  const branch = useBranch(branchId);
  if (branch.isPending) return <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!branch.data) return <Alert tone="error">{errorMessage(branch.error)}</Alert>;
  return <BranchView b={branch.data} />;
}

function BranchView({ b }: { b: Branch }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const [publish, setPublish] = useState(false);
  const open = b.status === 'OPEN' || b.status === 'IN_REVIEW' || b.status === 'CONFLICTED';
  const working = b.run?.status === 'QUEUED' || b.run?.status === 'RUNNING';
  const set = (data: Branch) => qc.setQueryData(['branch', tid, b.id], data);

  const review = useMutation({
    mutationFn: (x: { changeId: string; status: 'ACCEPTED' | 'REJECTED' | 'PROPOSED'; overrides?: Record<string, string> }) => api<Branch>(`/branches/${b.id}/changes/${x.changeId}`, { method: 'PATCH', body: { status: x.status, overrides: x.overrides } }),
    onSuccess: set,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const merge = useMutation({
    mutationFn: () => api<{ results: { ok: boolean; error?: string }[]; branch: Branch }>(`/branches/${b.id}/merge`, { body: { publish } }),
    onSuccess: (r) => {
      set(r.branch);
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(`${failed.length} change(s) could not be applied`, { description: failed.map((f) => f.error).join('; ') });
      else toast.success(publish ? 'Merged and published — the site updates within seconds' : 'Merged into the drafts');
      for (const k of ['canon-conflicts', 'canon-facts', 'canon-impact']) void qc.invalidateQueries({ queryKey: [k, tid] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const close = useMutation({ mutationFn: () => api<Branch>(`/branches/${b.id}/close`, { body: {} }), onSuccess: set, onError: (err) => toast.error(errorMessage(err)) });

  const s = b.summary ?? {};
  const accepted = b.changes.filter((c) => c.status === 'ACCEPTED' && c.applicable).length;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/canon?tab=branches" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> Branches
        </Link>
        <h1 className="flex items-center gap-2 font-mono text-xl font-semibold">
          <GitBranch className="h-5 w-5 text-primary" /> {b.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {b.description} · {b.createdBy ?? 'system'} · {relativeTime(b.createdAt)} · <Badge>{b.status.toLowerCase().replace('_', ' ')}</Badge>
        </p>
      </div>

      {working && (
        <Alert>
          <p className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> The agent team is working: planning, rewriting each span in context and fact-checking…
          </p>
        </Alert>
      )}
      {s.error && <Alert tone="error">The run failed: {s.error}</Alert>}
      {!working && s.proposed !== undefined && (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge className="border-success/40 text-success">{s.proposed} rewrites proposed</Badge>
          {!!s.escalated && <Badge className="border-warning/40 text-warning">{s.escalated} need a human</Badge>}
          {!!s.failed && <Badge className="border-destructive/40 text-destructive">{s.failed} failed fact-check</Badge>}
          {!!s.bound && <Badge className="border-primary/40 text-primary">{s.bound} bound — already live</Badge>}
          <Badge>
            {s.from} → {s.to}
          </Badge>
          {b.run && (
            <Badge>
              {b.run.totalTokens} tokens · {formatUsd(b.run.costUsd)}
            </Badge>
          )}
        </div>
      )}

      {b.changes.map((c) => (
        <Card key={c.id} className={cn(c.status === 'ACCEPTED' && 'border-success/50', c.status === 'REJECTED' && 'opacity-60')}>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              {c.entity ? (
                <Link href={entityHref(c.entity)} className="font-medium hover:text-primary hover:underline">
                  {c.entity.collectionName ? `${c.entity.collectionName}: ` : ''}
                  {c.explanation.title}
                </Link>
              ) : (
                <span className="font-medium">{c.explanation.title}</span>
              )}
              <span className="text-xs text-muted-foreground">
                {c.explanation.path} · {c.explanation.locale.toUpperCase()} · base v{c.baseVersion}
              </span>
              <Badge className="ml-auto">{c.status.toLowerCase()}</Badge>
              {open && ability.can('update', 'Branch') && (
                <span className="flex gap-1">
                  <Button size="sm" variant={c.status === 'ACCEPTED' ? 'default' : 'outline'} disabled={!c.applicable} onClick={() => review.mutate({ changeId: c.id, status: c.status === 'ACCEPTED' ? 'PROPOSED' : 'ACCEPTED' })}>
                    <Check className="h-3.5 w-3.5" /> Accept
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => review.mutate({ changeId: c.id, status: c.status === 'REJECTED' ? 'PROPOSED' : 'REJECTED' })}>
                    <X className="h-3.5 w-3.5" /> Reject
                  </Button>
                </span>
              )}
            </div>
            <ul className="space-y-2">
              {c.explanation.spans.map((sp) => (
                <SpanRow key={sp.mentionId} sp={sp} editable={open && ability.can('update', 'Branch')} onOverride={(text) => review.mutate({ changeId: c.id, status: 'ACCEPTED', overrides: { [sp.mentionId]: text } })} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}

      {open && !working && ability.can('update', 'Branch') && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={publish} disabled={!ability.can('publish', 'Page')} onChange={(e) => setPublish(e.target.checked)} /> Publish pages that are live
          </label>
          <div className="flex gap-2">
            <Button variant="ghost" loading={close.isPending} onClick={() => window.confirm('Close this branch without merging?') && close.mutate()}>
              Close branch
            </Button>
            <Button loading={merge.isPending} disabled={accepted === 0} onClick={() => merge.mutate()}>
              <GitMerge className="h-4 w-4" /> Merge {accepted} change{accepted === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
      {b.mergedAt && <p className="text-sm text-muted-foreground">Merged by {b.mergedBy ?? 'someone'} {relativeTime(b.mergedAt)}.</p>}
      {b.run && <RunTimeline runId={b.run.id} live={working} />}
    </div>
  );
}

function SpanRow({ sp, editable, onOverride }: { sp: SpanResult; editable: boolean; onOverride: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(sp.after ?? '');
  return (
    <li className="rounded-md border p-3 text-sm">
      <p className="leading-relaxed">
        <span className="text-muted-foreground">…{sp.context.before}</span>
        <del className="rounded bg-destructive/10 px-0.5 text-destructive">{sp.before}</del>
        {sp.after && <ins className="ml-0.5 rounded bg-success/10 px-0.5 text-success no-underline">{sp.after}</ins>}
        <span className="text-muted-foreground">{sp.context.after}…</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge className={VERDICT_STYLE[sp.verdict]}>{sp.verdict === 'escalated' ? 'needs a human' : sp.verdict}</Badge>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Bot className="h-3 w-3" /> {sp.agent} · {sp.locale.toUpperCase()} · {sp.fieldLabel}
        </span>
        {sp.explanation && <span className="text-muted-foreground">— {sp.explanation}</span>}
        {editable && (
          <button type="button" className="ml-auto flex items-center gap-1 text-primary hover:underline" onClick={() => setEditing((e) => !e)}>
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      {sp.issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-warning">
          {sp.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="mt-2 flex gap-2">
          <Input aria-label="Replacement text" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" disabled={!text.trim()} onClick={() => (onOverride(text.trim()), setEditing(false))}>
            Use & accept
          </Button>
        </div>
      )}
    </li>
  );
}

function RunTimeline({ runId, live }: { runId: string; live: boolean }) {
  const tid = useTenantId();
  const [open, setOpen] = useState(false);
  const run = useQuery({ queryKey: ['agent-run', tid, runId], queryFn: () => api<AgentRun>(`/canon/runs/${runId}`), enabled: open, refetchInterval: open && live ? 1_500 : false });
  const runs = run.data ? [run.data, ...(run.data.children ?? [])] : [];
  return (
    <Card>
      <CardContent className="p-4">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-sm font-medium">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Agent run
        </button>
        {open && (
          <div className="mt-3 space-y-3">
            {runs.map((r) => (
              <div key={r.id}>
                <p className="text-xs font-medium">
                  {r.agent.name} <Badge>{r.status.toLowerCase().replace('_', ' ')}</Badge>{' '}
                  <span className="text-muted-foreground">
                    {r.totalTokens} tokens · {formatUsd(Number(r.costUsd))}
                  </span>
                </p>
                <ol className="mt-1 space-y-1 border-l pl-3">
                  {r.steps.map((st) => (
                    <li key={st.id} className="text-xs">
                      <span className="font-mono text-muted-foreground">#{st.stepNumber}</span> {st.node} {st.toolName && <span className="font-mono">{st.toolName}</span>}{' '}
                      <span className="text-muted-foreground">
                        · {st.durationMs} ms · {st.tokens} tok
                      </span>
                      <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1 text-[10px]">{JSON.stringify(st.toolOutput)}</pre>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
