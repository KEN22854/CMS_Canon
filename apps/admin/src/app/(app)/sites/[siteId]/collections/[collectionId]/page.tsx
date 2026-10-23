'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Settings2, Sparkles, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Input, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, download, errorMessage } from '@/lib/api';
import { entriesPath, qualityTone, useCollection, useEntries, type EntryDetail, type EntryQuery } from '@/lib/collections';
import { STATUS_STYLE, useSite } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

const PAGE = 25;

interface ImportReport {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  published: number;
  errors: { line: number; slug?: string; issues: { field: string; message: string }[] }[];
  warnings: string[];
}

export default function CollectionEntries() {
  const { siteId, collectionId } = useParams<{ siteId: string; collectionId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const site = useSite(siteId);
  const col = useCollection(siteId, collectionId);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [query, setQuery] = useState<EntryQuery>({ sort: 'updated', order: 'desc', offset: 0, limit: PAGE });
  const entries = useEntries(siteId, collectionId, { ...query, q: debounced });
  const [pending, setPending] = useState<{ file: File; report: ImportReport } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => (setDebounced(q.trim()), setQuery((s) => ({ ...s, offset: 0 }))), 300);
    return () => clearTimeout(t);
  }, [q]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['entries', tid, collectionId] });
  const create = useMutation({
    mutationFn: () => api<EntryDetail>(entriesPath(siteId, collectionId), { body: { data: {}, locale: query.locale || site.data?.defaultLocale } }),
    onSuccess: (e) => router.push(`/sites/${siteId}/collections/${collectionId}/entries/${e.id}`),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const runImport = async (file: File, dryRun: boolean) => {
    const form = new FormData();
    form.set('file', file);
    return api<ImportReport>(`/sites/${siteId}/collections/${collectionId}/import?mode=upsert&dryRun=${dryRun}`, { form });
  };
  const preview = useMutation({ mutationFn: (file: File) => runImport(file, true).then((report) => ({ file, report })), onSuccess: setPending, onError: (err) => toast.error(errorMessage(err)) });
  const commit = useMutation({
    mutationFn: (file: File) => runImport(file, false),
    onSuccess: (r) => {
      setPending(null);
      toast.success(`Imported: ${r.created} created, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} rows skipped` : ''}`);
      void refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const set = (patch: Partial<EntryQuery>) => setQuery((s) => ({ ...s, offset: 0, ...patch }));
  const total = entries.data?.total ?? 0;
  const c = col.data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/sites/${siteId}/collections`} className="text-xs text-muted-foreground hover:underline">
            Collections
          </Link>
          <h2 className="text-lg font-semibold">{c?.name ?? '…'}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {ability.can('update', 'Collection') && (
            <Link href={`/sites/${siteId}/collections/${collectionId}/schema`}>
              <Button variant="outline" size="sm">
                <Settings2 className="h-4 w-4" /> Fields & AI
              </Button>
            </Link>
          )}
          <Button variant="outline" size="sm" onClick={() => void download(`/sites/${siteId}/collections/${collectionId}/export?format=csv`, `${c?.slug ?? 'entries'}.csv`).catch((e) => toast.error(errorMessage(e)))}>
            <Download className="h-4 w-4" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void download(`/sites/${siteId}/collections/${collectionId}/export?format=json`, `${c?.slug ?? 'entries'}.json`).catch((e) => toast.error(errorMessage(e)))}>
            <Download className="h-4 w-4" /> JSON
          </Button>
          {ability.can('create', 'Entry') && (
            <>
              <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => (e.target.files?.[0] && preview.mutate(e.target.files[0]), (e.target.value = ''))} />
              <Button variant="outline" size="sm" loading={preview.isPending} onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Import
              </Button>
              <Button size="sm" loading={create.isPending} onClick={() => create.mutate()}>
                <Plus className="h-4 w-4" /> New entry
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="h-9 w-64" placeholder="Search title and content" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entries" />
        <Select className="h-9" aria-label="Status" value={query.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
          <option value="">All statuses</option>
          {['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </Select>
        {(site.data?.locales.length ?? 0) > 1 && (
          <Select className="h-9" aria-label="Locale" value={query.locale ?? ''} onChange={(e) => set({ locale: e.target.value || undefined })}>
            <option value="">All locales</option>
            {site.data?.locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        )}
        <Select className="h-9" aria-label="Sort" value={`${query.sort}:${query.order}`} onChange={(e) => {
          const [sort, order] = e.target.value.split(':') as [EntryQuery['sort'], EntryQuery['order']];
          set({ sort, order });
        }}>
          <option value="updated:desc">Recently updated</option>
          <option value="created:desc">Newest</option>
          <option value="title:asc">Title A–Z</option>
          <option value="quality:asc">Lowest quality first</option>
          <option value="quality:desc">Highest quality first</option>
        </Select>
      </div>
      {entries.data && entries.data.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {entries.data.tags.slice(0, 20).map((t) => (
            <button key={t.tag} type="button" onClick={() => set({ tag: query.tag === t.tag ? undefined : t.tag })} className={cn('rounded-full border px-2 py-0.5 text-xs', query.tag === t.tag ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary')}>
              #{t.tag} <span className="opacity-60">{t.count}</span>
            </button>
          ))}
        </div>
      )}

      {entries.isError && <Alert tone="error">{errorMessage(entries.error)}</Alert>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Tags</th>
              <th className="px-3 py-2 font-medium" title="AI quality score (0–100)">
                <Sparkles className="inline h-3 w-3" /> Quality
              </th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {entries.data?.items.map((e) => (
              <tr key={e.id} className="hover:bg-muted/30">
                <td className="max-w-md px-3 py-2">
                  <Link href={`/sites/${siteId}/collections/${collectionId}/entries/${e.id}`} className="font-medium hover:text-primary hover:underline">
                    {e.title || <span className="italic text-muted-foreground">Untitled</span>}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{e.summary ?? `/${e.slug}`}</p>
                </td>
                <td className="px-3 py-2">
                  <Badge className={STATUS_STYLE[e.status]}>{e.status.toLowerCase()}</Badge>
                  {e.hasUnpublishedChanges && <Badge className="ml-1 border-warning/40 text-warning">changes</Badge>}
                  {(site.data?.locales.length ?? 0) > 1 && <span className="ml-1 text-xs uppercase text-muted-foreground">{e.locale}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex max-w-56 flex-wrap gap-1">
                    {e.tags.slice(0, 4).map((t) => (
                      <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Badge className={qualityTone(e.qualityScore)} title={e.qualityIssues.join('\n')}>
                    {e.qualityScore ?? '—'}
                  </Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{relativeTime(e.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.data?.items.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">{debounced || query.tag || query.status ? 'Nothing matches these filters.' : 'No entries yet — create one or import a CSV.'}</p>}
      </div>
      {total > PAGE && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {(query.offset ?? 0) + 1}–{Math.min(total, (query.offset ?? 0) + PAGE)} of {total}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!query.offset} onClick={() => setQuery((s) => ({ ...s, offset: Math.max(0, (s.offset ?? 0) - PAGE) }))}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={(query.offset ?? 0) + PAGE >= total} onClick={() => setQuery((s) => ({ ...s, offset: (s.offset ?? 0) + PAGE }))}>
              Next
            </Button>
          </div>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="imp-title">
          <div className="max-h-[85vh] w-full max-w-xl space-y-3 overflow-y-auto rounded-lg border bg-card p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 id="imp-title" className="font-semibold">
                Import “{pending.file.name}”
              </h2>
              <button type="button" aria-label="Close" onClick={() => setPending(null)} className="rounded p-1 hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm">
              {pending.report.rows} rows: <strong>{pending.report.created}</strong> new, <strong>{pending.report.updated}</strong> updated (matched by slug), <strong>{pending.report.errors.length}</strong> with errors.
            </p>
            {pending.report.warnings.map((w) => (
              <Alert key={w}>{w}</Alert>
            ))}
            {pending.report.errors.length > 0 && (
              <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
                {pending.report.errors.slice(0, 100).map((e) => (
                  <li key={e.line}>
                    <span className="font-mono text-muted-foreground">line {e.line}</span> {e.slug && <span className="font-mono">{e.slug}</span>}: {e.issues.map((i) => i.message).join('; ')}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">Rows with errors are skipped. Existing entries keep values for columns that aren’t in the file.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button loading={commit.isPending} disabled={pending.report.created + pending.report.updated === 0} onClick={() => commit.mutate(pending.file)}>
                Import {pending.report.created + pending.report.updated} rows
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
