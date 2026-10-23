'use client';

import { subject } from '@casl/ability';
import type { EntryData } from '@canon/fields';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Copy, Loader2, Save, Sparkles, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useFacts } from '@/components/builder/rich-text-editor';
import { FieldInput } from '@/components/collections/field-input';
import { Alert, Badge, Button, Card, CardContent, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { entriesPath, qualityTone, useCollection, useEntry, type Collection, type DuplicateHit, type EntryDetail } from '@/lib/collections';
import { STATUS_STYLE } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

const AUTOSAVE_MS = 5_000;

export default function EntryPage() {
  const { siteId, collectionId, entryId } = useParams<{ siteId: string; collectionId: string; entryId: string }>();
  const col = useCollection(siteId, collectionId);
  const entry = useEntry(siteId, collectionId, entryId);
  if (col.isPending || entry.isPending) return <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!col.data || !entry.data) return <Alert tone="error">{errorMessage(col.error ?? entry.error)}</Alert>;
  return <EntryEditor key={entry.data.id} c={col.data} initial={entry.data} siteId={siteId} />;
}

type Issues = Record<string, string>;

function EntryEditor({ c, initial, siteId }: { c: Collection; initial: EntryDetail; siteId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const base = `${entriesPath(siteId, c.id)}/${initial.id}`;
  const [server, setServer] = useState(initial);
  const [data, setData] = useState<EntryData>(initial.data);
  const [slug, setSlug] = useState(initial.slug);
  const [tags, setTags] = useState(initial.tags);
  const [tagsTouched, setTagsTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issues>({});
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);
  const version = useRef(initial.version);

  const own = subject('Entry', { tenantId: tid, createdById: initial.createdById });
  const canEdit = ability.can('update', own);
  const canPublish = ability.can('publish', own);
  const canAi = ability.can('invoke', 'Ai');
  const factsQ = useFacts(siteId);
  const facts = useMemo(() => Object.fromEntries((factsQ.data ?? []).map((f) => [f.key, f.displayValue])), [factsQ.data]);

  const apply = (e: EntryDetail) => {
    setServer(e);
    version.current = e.version;
    if (!tagsTouched) setTags(e.tags);
    qc.setQueryData(['entry', tid, e.id], e);
  };

  const showIssues = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'INVALID_ENTRY') {
      const list = (err.details as { issues?: { field: string; message: string }[] })?.issues ?? [];
      setIssues(Object.fromEntries(list.map((i) => [i.field, i.message])));
      toast.error(err.message, { id: 'entry-error' });
      return true;
    }
    return false;
  };

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    if (saving.current || conflict) return false;
    saving.current = true;
    const sent = { data, slug, tags };
    try {
      // Tags go only when the editor changed them, so AI-applied tags aren't overwritten by a stale copy.
      const res = await api<EntryDetail>(base, { method: 'PATCH', body: { expectedVersion: version.current, data: sent.data, slug: sent.slug, ...(tagsTouched ? { tags: sent.tags } : {}) } });
      apply(res);
      // The server may assign the slug (placeholder slugs follow the title until first publish).
      if (res.slug !== sent.slug) setSlug(res.slug);
      setIssues({});
      setTagsTouched(false);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['entries', tid, c.id] });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!showIssues(err)) toast.error(errorMessage(err), { id: 'entry-error' });
      return false;
    } finally {
      saving.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply/showIssues are stable in effect
  }, [dirty, conflict, data, slug, tags, tagsTouched, base, qc, tid, c.id]);

  useEffect(() => {
    if (!dirty || !canEdit) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, data, slug, tags, save, canEdit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save().then((ok) => ok && toast.success('Saved'));
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => (window.removeEventListener('keydown', onKey), window.removeEventListener('beforeunload', onLeave));
  }, [save, dirty]);

  const edit = (name: string, v: unknown) => {
    setData((d) => {
      const next = { ...d };
      if (v === undefined) delete next[name];
      else next[name] = v;
      return next;
    });
    setIssues((i) => (i[name] ? { ...i, [name]: '' } : i));
    setDirty(true);
  };

  const lifecycle = useMutation({
    mutationFn: async (op: 'publish' | 'unpublish') => {
      if (op === 'publish' && !(await save())) throw new Error('Fix the errors before publishing');
      return api<EntryDetail>(`${base}/${op}`, { method: 'POST', body: {} });
    },
    onSuccess: (e, op) => (apply(e), toast.success(op === 'publish' ? 'Published' : 'Unpublished'), void qc.invalidateQueries({ queryKey: ['entries', tid, c.id] })),
    onError: (err) => showIssues(err) || toast.error(err instanceof ApiError || !(err instanceof Error) ? errorMessage(err) : err.message),
  });
  const enrich = useMutation({
    mutationFn: async () => {
      await save();
      return api<{ done: string[]; entry: EntryDetail; ai?: { costUsd: number; model: string } }>(`${base}/ai-enrich`, { body: { applyTags: canEdit } });
    },
    onSuccess: (r) => {
      setTagsTouched(false);
      setServer(r.entry);
      setTags(r.entry.tags);
      version.current = r.entry.version;
      toast.success(`AI: ${r.done.join(', ') || 'nothing to do'}${r.ai ? ` · ${formatUsd(r.ai.costUsd)}` : ''}`, { description: r.entry.aiMeta.lastError });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const duplicate = useMutation({
    mutationFn: () => api<EntryDetail>(`${base}/duplicate`, { method: 'POST', body: {} }),
    onSuccess: (e) => router.push(`/sites/${siteId}/collections/${c.id}/entries/${e.id}`),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (force: boolean) => api(`${base}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['entries', tid, c.id] }), router.push(`/sites/${siteId}/collections/${c.id}`)),
    onError: (err, force) => {
      if (!force && err instanceof ApiError && err.code === 'ENTRY_IN_USE' && window.confirm(`${err.message}. Delete anyway? References will point to nothing.`)) remove.mutate(true);
      else toast.error(errorMessage(err));
    },
  });

  // Live duplicate check while typing (database-only, no AI cost).
  const [liveDupes, setLiveDupes] = useState<DuplicateHit[] | null>(null);
  useEffect(() => {
    if (!c.aiSettings.duplicateCheck || !dirty) return;
    const t = setTimeout(() => {
      void api<{ duplicates: DuplicateHit[] }>(`/sites/${siteId}/collections/${c.id}/duplicates`, { body: { data, locale: server.locale, excludeId: server.id } })
        .then((r) => setLiveDupes(r.duplicates))
        .catch(() => undefined);
    }, 1_500);
    return () => clearTimeout(t);
  }, [data, dirty, c.id, c.aiSettings.duplicateCheck, siteId, server.id, server.locale]);
  const dupes = liveDupes ?? server.aiMeta.duplicates ?? [];

  const q = server.aiMeta.quality;
  const ctx = { siteId, entryId: server.id, readOnly: !canEdit, facts, related: server.related };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/sites/${siteId}/collections/${c.id}`} className="rounded p-1.5 hover:bg-muted" aria-label={`Back to ${c.name}`}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">{server.title || 'Untitled'}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{c.name}</span>·<span className="uppercase">{server.locale}</span>
            <Badge className={STATUS_STYLE[server.status]}>{server.status.toLowerCase()}</Badge>
            {server.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">unpublished changes</Badge>}
            <span aria-live="polite">{dirty ? 'Unsaved…' : `Saved · v${server.version}`}</span>
          </div>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={!dirty || conflict} onClick={() => void save().then((ok) => ok && toast.success('Saved'))}>
            <Save className="h-4 w-4" /> Save
          </Button>
        )}
        {canPublish && server.publishedVersion !== null && (
          <Button size="sm" variant="ghost" loading={lifecycle.isPending && lifecycle.variables === 'unpublish'} onClick={() => lifecycle.mutate('unpublish')}>
            Unpublish
          </Button>
        )}
        {canPublish && (
          <Button size="sm" loading={lifecycle.isPending && lifecycle.variables === 'publish'} disabled={conflict || (!dirty && server.status === 'PUBLISHED' && !server.hasUnpublishedChanges)} onClick={() => lifecycle.mutate('publish')}>
            Publish
          </Button>
        )}
      </div>

      {conflict && (
        <Alert tone="error">
          Someone else changed this entry. Your edits are kept here but can&apos;t be saved over theirs.{' '}
          <button type="button" className="font-medium underline" onClick={() => window.location.reload()}>
            Reload the latest version
          </button>
        </Alert>
      )}
      {dupes.length > 0 && (
        <Alert>
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4 text-warning" /> Possible duplicate{dupes.length > 1 ? 's' : ''}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {dupes.slice(0, 3).map((d) => (
              <li key={d.id}>
                <Link href={`/sites/${siteId}/collections/${c.id}/entries/${d.id}`} className="text-primary hover:underline">
                  {d.title || d.slug}
                </Link>{' '}
                — {Math.round(d.score * 100)}% similar ({d.method})
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardContent className="space-y-5 p-5">
            {c.fields.map((f) => (
              <FieldInput key={f.name} field={f} value={data[f.name]} error={issues[f.name] || undefined} onChange={(v) => edit(f.name, v)} ctx={ctx} />
            ))}
            {c.fields.length === 0 && <p className="text-sm text-muted-foreground">This collection has no fields yet.</p>}
            <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="e-slug">Slug</Label>
                <Input id="e-slug" value={slug} disabled={!canEdit} onChange={(e) => (setSlug(e.target.value.toLowerCase()), setDirty(true))} />
              </div>
              <TagInput tags={tags} readOnly={!canEdit} aiTags={server.aiMeta.tags?.ai ?? []} onChange={(t) => (setTags(t), setTagsTouched(true), setDirty(true))} />
            </div>
          </CardContent>
        </Card>

        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-1 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-primary" /> AI insights
                </p>
                {canAi && (
                  <Button size="sm" variant="outline" loading={enrich.isPending} onClick={() => enrich.mutate()}>
                    Run
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className={cn('grid h-12 w-12 place-items-center rounded-full border-2 text-sm font-semibold', qualityTone(server.qualityScore))} aria-label={`Quality score ${server.qualityScore ?? 'not scored'}`}>
                  {server.qualityScore ?? '—'}
                </span>
                <div className="text-xs text-muted-foreground">
                  <p>Quality score</p>
                  {q?.completeness !== undefined && <p>Completeness {Math.round(q.completeness * 100)}%</p>}
                </div>
              </div>
              {q?.issues && q.issues.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs">
                  {q.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              {q?.missing && q.missing.length > 0 && <p className="text-xs text-muted-foreground">Empty: {q.missing.map((m) => c.fields.find((f) => f.name === m)?.label ?? m).join(', ')}</p>}
              {server.summary && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Summary</p>
                  <p className="text-sm">{server.summary}</p>
                </div>
              )}
              {server.aiMeta.enrichedAt && <p className="text-[10px] text-muted-foreground">Updated {relativeTime(server.aiMeta.enrichedAt)}</p>}
              {!server.aiMeta.enrichedAt && <p className="text-xs text-muted-foreground">Not analysed yet. {c.aiSettings.autoTag || c.aiSettings.autoSummary || c.aiSettings.qualityScore ? 'Runs automatically after saving.' : 'Enable enrichment in the collection settings or press Run.'}</p>}
            </CardContent>
          </Card>

          {server.referencedBy.length > 0 && (
            <Card>
              <CardContent className="space-y-1 p-4 text-sm">
                <p className="font-medium">Used by</p>
                {server.referencedBy.map((r) => (
                  <Link key={`${r.entryId}-${r.field}`} href={`/sites/${siteId}/collections/${r.collectionId}/entries/${r.entryId}`} className="block truncate text-xs text-primary hover:underline">
                    {r.collectionName}: {r.title || r.entryId}
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          <Versions base={base} canEdit={canEdit} onRestored={apply} count={server.versionCount} />

          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" loading={duplicate.isPending} onClick={() => duplicate.mutate()}>
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </Button>
              {ability.can('delete', own) && (
                <Button size="sm" variant="ghost" className="text-destructive" loading={remove.isPending} onClick={() => window.confirm('Delete this entry?') && remove.mutate(false)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function TagInput({ tags, aiTags, readOnly, onChange }: { tags: string[]; aiTags: string[]; readOnly: boolean; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().toLowerCase().replace(/\s+/g, '-');
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor="e-tags">Tags</Label>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1">
        {tags.map((t) => (
          <span key={t} className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs', aiTags.includes(t) ? 'bg-primary/10 text-primary' : 'bg-muted')} title={aiTags.includes(t) ? 'Suggested by AI' : undefined}>
            {aiTags.includes(t) && <Sparkles className="h-2.5 w-2.5" aria-label="AI" />}
            {t}
            {!readOnly && (
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <input
            id="e-tags"
            className="min-w-20 flex-1 bg-transparent text-sm outline-none"
            value={draft}
            placeholder={tags.length ? '' : 'Add tag…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') (e.preventDefault(), add());
              else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
            }}
            onBlur={add}
          />
        )}
      </div>
    </div>
  );
}

function Versions({ base, canEdit, onRestored, count }: { base: string; canEdit: boolean; onRestored: (e: EntryDetail) => void; count: number }) {
  const versions = useQuery({
    queryKey: ['entry-versions', base, count],
    queryFn: () => api<{ version: number; title: string; comment: string | null; createdAt: string; createdBy: { name: string } | null; isPublished: boolean }[]>(`${base}/versions`),
    enabled: count > 0,
  });
  const restore = useMutation({
    mutationFn: (v: number) => api<EntryDetail>(`${base}/versions/${v}/restore`, { method: 'POST', body: {} }),
    onSuccess: (e) => (onRestored(e), toast.success('Restored into the draft'), window.location.reload()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!count) return null;
  return (
    <Card>
      <CardContent className="space-y-1.5 p-4">
        <p className="text-sm font-medium">Versions</p>
        {versions.data?.map((v) => (
          <div key={v.version} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              v{v.version} {v.isPublished && <Badge className="border-success/40 text-success">live</Badge>} · {relativeTime(v.createdAt)}
            </span>
            {canEdit && (
              <button type="button" className="text-primary hover:underline" onClick={() => window.confirm(`Replace the draft with v${v.version}?`) && restore.mutate(v.version)}>
                Restore
              </button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
