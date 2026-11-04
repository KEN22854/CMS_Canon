'use client';

import { VIEW_FILTER_OPS, type CollectionView, type ViewFilter } from '@canon/fields';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Bookmark, Download, EyeOff, Filter, Plus, Send, Settings2, Sparkles, Tag, Trash2, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EntryPagesCard } from '@/components/collections/entry-pages';
import { ShopCard } from '@/components/collections/shop-card';
import { Alert, Badge, Button, Input, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, download, errorMessage } from '@/lib/api';
import { entriesPath, qualityTone, useCollection, useEntries, type BulkResult, type Collection, type EntryDetail, type EntryQuery } from '@/lib/collections';
import { STATUS_STYLE, useSite } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';

const PAGE = 25;
type BulkAction = 'publish' | 'unpublish' | 'archive' | 'delete' | 'addTag' | 'removeTag';

interface ImportReport {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  published: number;
  errors: { line: number; slug?: string; issues: { field: string; message: string }[] }[];
  warnings: string[];
}

const BASE_QUERY: EntryQuery = { sort: 'updated', order: 'desc', offset: 0, limit: PAGE, filters: [] };

export default function CollectionEntries() {
  const t = useT();
  const { siteId, collectionId } = useParams<{ siteId: string; collectionId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const site = useSite(siteId);
  const col = useCollection(siteId, collectionId);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [query, setQuery] = useState<EntryQuery>(BASE_QUERY);
  const [viewId, setViewId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const entries = useEntries(siteId, collectionId, { ...query, q: debounced });
  const [pending, setPending] = useState<{ file: File; report: ImportReport } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => (setDebounced(q.trim()), setQuery((s) => ({ ...s, offset: 0 }))), 300);
    return () => clearTimeout(timer);
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

  // One action on the selected entries; per-entry failures (permissions, review, validation) are reported, not fatal.
  const bulk = useMutation({
    mutationFn: (body: { action: BulkAction; tag?: string }) => api<BulkResult>(`${entriesPath(siteId, collectionId)}/bulk`, { body: { ...body, ids: [...selected] } }),
    onSuccess: (r) => {
      if (r.failed.length) toast.error(t('cms.bulk.someFailed', { done: r.done, failed: r.failed.length, first: r.failed[0]!.message }));
      else toast.success(t('cms.bulk.done', { done: r.done }));
      setSelected(new Set(r.failed.map((f) => f.id)));
      void refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const runBulk = (action: BulkAction) => {
    if (action === 'delete' && !window.confirm(t('cms.bulk.deleteConfirm', { count: selected.size }))) return;
    if (action === 'addTag' || action === 'removeTag') {
      const tag = window.prompt(t('cms.bulk.tagPrompt'))?.trim();
      if (tag) bulk.mutate({ action, tag });
      return;
    }
    bulk.mutate({ action });
  };

  const c = col.data;
  const views = c?.settings.views ?? [];
  const saveViews = useMutation({
    mutationFn: (next: CollectionView[]) => api<Collection>(`/sites/${siteId}/collections/${collectionId}`, { method: 'PATCH', body: { settings: { ...c!.settings, views: next } } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['collection', tid, collectionId] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const applyView = (v: CollectionView | null) => {
    setViewId(v?.id ?? null);
    setSelected(new Set());
    setQ(v?.q ?? '');
    setQuery(v ? { ...BASE_QUERY, status: v.status, tag: v.tag, sort: v.sort, order: v.order, filters: v.filters } : BASE_QUERY);
  };
  const saveCurrentView = () => {
    const name = window.prompt(t('cms.view.namePrompt'))?.trim();
    if (!name || !c) return;
    const view: CollectionView = { id: Math.random().toString(36).slice(2, 10), name: name.slice(0, 60), q: q.trim() || undefined, status: query.status as CollectionView['status'], tag: query.tag, sort: query.sort ?? 'updated', order: query.order ?? 'desc', filters: query.filters ?? [] };
    saveViews.mutate([...views, view], { onSuccess: () => (setViewId(view.id), toast.success(t('cms.view.saved', { name }))) });
  };
  const deleteView = (v: CollectionView) => {
    if (!window.confirm(t('cms.view.deleteConfirm', { name: v.name }))) return;
    saveViews.mutate(
      views.filter((x) => x.id !== v.id),
      { onSuccess: () => viewId === v.id && applyView(null) },
    );
  };

  const set = (patch: Partial<EntryQuery>) => {
    setSelected(new Set());
    setQuery((s) => ({ ...s, offset: 0, ...patch }));
  };
  const total = entries.data?.total ?? 0;
  const items = entries.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((e) => selected.has(e.id));
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const filtered = Boolean(debounced || query.tag || query.status || query.filters?.length);
  const canPublish = ability.can('publish', 'Entry');
  const canUpdate = ability.can('update', 'Entry');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/sites/${siteId}/collections`} className="text-xs text-muted-foreground hover:underline">
            {t('cms.collections')}
          </Link>
          <h2 className="text-lg font-semibold">{c?.name ?? '…'}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {ability.can('update', 'Collection') && (
            <Link href={`/sites/${siteId}/collections/${collectionId}/schema`}>
              <Button variant="outline" size="sm">
                <Settings2 className="h-4 w-4" /> {t('cms.fieldsAi')}
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
                <Upload className="h-4 w-4" /> {t('cms.import')}
              </Button>
              <Button size="sm" loading={create.isPending} onClick={() => create.mutate()}>
                <Plus className="h-4 w-4" /> {t('cms.newEntry')}
              </Button>
            </>
          )}
        </div>
      </div>

      {c && <EntryPagesCard siteId={siteId} collection={c} canEdit={ability.can('update', 'Collection')} />}
      {c && <ShopCard siteId={siteId} collection={c} canEdit={ability.can('update', 'Collection')} />}

      {/* Saved views: shared filters of this table. */}
      <nav aria-label={t('cms.views')} className="mb-3 flex flex-wrap items-center gap-1 border-b">
        <ViewTab active={viewId === null} onClick={() => applyView(null)}>
          {t('cms.view.all')}
        </ViewTab>
        {views.map((v) => (
          <span key={v.id} className="group flex items-center">
            <ViewTab active={viewId === v.id} onClick={() => applyView(v)}>
              <Bookmark className="h-3 w-3" /> {v.name}
            </ViewTab>
            {ability.can('update', 'Collection') && (
              <button type="button" aria-label={t('cms.view.delete', { name: v.name })} title={t('cms.view.delete', { name: v.name })} onClick={() => deleteView(v)} className="-ml-1 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {ability.can('update', 'Collection') && filtered && !viewId && (
          <Button variant="ghost" size="sm" className="ml-auto text-primary" loading={saveViews.isPending} onClick={saveCurrentView}>
            <Bookmark className="h-3.5 w-3.5" /> {t('cms.view.save')}
          </Button>
        )}
      </nav>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="h-9 w-64" placeholder={t('cms.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('cms.searchLabel')} />
        <Select className="h-9" aria-label={t('cms.status')} value={query.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
          <option value="">{t('cms.allStatuses')}</option>
          {['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}` as MessageKey)}
            </option>
          ))}
        </Select>
        {(site.data?.locales.length ?? 0) > 1 && (
          <Select className="h-9" aria-label={t('cms.locale')} value={query.locale ?? ''} onChange={(e) => set({ locale: e.target.value || undefined })}>
            <option value="">{t('cms.allLocales')}</option>
            {site.data?.locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        )}
        <Select
          className="h-9"
          aria-label={t('cms.sort')}
          value={`${query.sort}:${query.order}`}
          onChange={(e) => {
            const [sort, order] = e.target.value.split(':') as [EntryQuery['sort'], EntryQuery['order']];
            set({ sort, order });
          }}
        >
          <option value="updated:desc">{t('cms.sort.updated')}</option>
          <option value="created:desc">{t('cms.sort.created')}</option>
          <option value="title:asc">{t('cms.sort.title')}</option>
          <option value="quality:asc">{t('cms.sort.qualityAsc')}</option>
          <option value="quality:desc">{t('cms.sort.qualityDesc')}</option>
        </Select>
        {c && <FilterAdder fields={c.fields} disabled={(query.filters?.length ?? 0) >= 5} onAdd={(f) => set({ filters: [...(query.filters ?? []), f] })} />}
      </div>

      {(query.filters?.length ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {query.filters!.map((f, i) => {
            const label = c?.fields.find((x) => x.name === f.field)?.label ?? f.field;
            return (
              <span key={`${f.field}${i}`} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {label} {t(`cms.filter.op.${f.op}` as MessageKey)} {f.op === 'eq' || f.op === 'contains' ? `“${f.value ?? ''}”` : ''}
                <button type="button" aria-label={t('cms.filter.remove', { field: label })} onClick={() => set({ filters: query.filters!.filter((_, j) => j !== i) })} className="rounded-full hover:bg-primary/20">
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {entries.data && entries.data.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {entries.data.tags.slice(0, 20).map((tg) => (
            <button key={tg.tag} type="button" onClick={() => set({ tag: query.tag === tg.tag ? undefined : tg.tag })} className={cn('rounded-full border px-2 py-0.5 text-xs', query.tag === tg.tag ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary')}>
              #{tg.tag} <span className="opacity-60">{tg.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Bulk bar: appears while entries are selected. */}
      {selected.size > 0 && (
        <div role="toolbar" aria-label={t('cms.bulk.selected', { count: selected.size })} className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-1.5 rounded-md border border-primary/40 bg-card p-2 shadow-md">
          <span className="px-1 text-sm font-medium">{t('cms.bulk.selected', { count: selected.size })}</span>
          {canPublish && (
            <>
              <Button size="sm" loading={bulk.isPending && bulk.variables?.action === 'publish'} onClick={() => runBulk('publish')}>
                <Send className="h-3.5 w-3.5" /> {t('cms.bulk.publish')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => runBulk('unpublish')}>
                <EyeOff className="h-3.5 w-3.5" /> {t('cms.bulk.unpublish')}
              </Button>
            </>
          )}
          {canUpdate && (
            <>
              <Button size="sm" variant="outline" onClick={() => runBulk('addTag')}>
                <Tag className="h-3.5 w-3.5" /> {t('cms.bulk.addTag')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => runBulk('removeTag')}>
                {t('cms.bulk.removeTag')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => runBulk('archive')}>
                <Archive className="h-3.5 w-3.5" /> {t('cms.bulk.archive')}
              </Button>
            </>
          )}
          {ability.can('delete', 'Entry') && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => runBulk('delete')}>
              <Trash2 className="h-3.5 w-3.5" /> {t('cms.bulk.delete')}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            {t('cms.bulk.clear')}
          </Button>
        </div>
      )}

      {entries.isError && <Alert tone="error">{errorMessage(entries.error)}</Alert>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2">
                <input type="checkbox" aria-label={t('cms.bulk.selectAll')} checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(items.map((e) => e.id)))} />
              </th>
              <th className="px-3 py-2 font-medium">{t('cms.col.title')}</th>
              <th className="px-3 py-2 font-medium">{t('cms.col.status')}</th>
              <th className="px-3 py-2 font-medium">{t('cms.col.tags')}</th>
              <th className="px-3 py-2 font-medium" title={t('cms.col.qualityHint')}>
                <Sparkles className="inline h-3 w-3" /> {t('cms.col.quality')}
              </th>
              <th className="px-3 py-2 font-medium">{t('cms.col.updated')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((e) => (
              <tr key={e.id} className={cn('hover:bg-muted/30', selected.has(e.id) && 'bg-primary/5')}>
                <td className="px-3 py-2">
                  <input type="checkbox" aria-label={t('cms.bulk.select', { title: e.title || e.slug })} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                </td>
                <td className="max-w-md px-3 py-2">
                  <Link href={`/sites/${siteId}/collections/${collectionId}/entries/${e.id}`} className="font-medium hover:text-primary hover:underline">
                    {e.title || <span className="italic text-muted-foreground">{t('cms.untitled')}</span>}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{e.summary ?? (c?.settings.route ? `${c.settings.route.basePath}/${e.slug}` : `/${e.slug}`)}</p>
                </td>
                <td className="px-3 py-2">
                  <Badge className={STATUS_STYLE[e.status]}>{t(`status.${e.status}` as MessageKey)}</Badge>
                  {e.hasUnpublishedChanges && <Badge className="ml-1 border-warning/40 text-warning">{t('cms.changes')}</Badge>}
                  {(site.data?.locales.length ?? 0) > 1 && <span className="ml-1 text-xs uppercase text-muted-foreground">{e.locale}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex max-w-56 flex-wrap gap-1">
                    {e.tags.slice(0, 4).map((tg) => (
                      <span key={tg} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                        {tg}
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
        {entries.data?.items.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">{filtered ? t('cms.emptyFiltered') : t('cms.empty')}</p>}
      </div>
      {total > PAGE && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('cms.range', { from: (query.offset ?? 0) + 1, to: Math.min(total, (query.offset ?? 0) + PAGE), total })}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!query.offset} onClick={() => setQuery((s) => ({ ...s, offset: Math.max(0, (s.offset ?? 0) - PAGE) }))}>
              {t('cms.prev')}
            </Button>
            <Button size="sm" variant="outline" disabled={(query.offset ?? 0) + PAGE >= total} onClick={() => setQuery((s) => ({ ...s, offset: (s.offset ?? 0) + PAGE }))}>
              {t('cms.next')}
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

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-current={active ? 'true' : undefined} onClick={onClick} className={cn('-mb-px flex items-center gap-1 border-b-2 px-3 py-1.5 text-sm', active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
      {children}
    </button>
  );
}

/** "Add filter": field, condition, value — added as a chip; the server checks the field exists. */
function FilterAdder({ fields, disabled, onAdd }: { fields: Collection['fields']; disabled: boolean; onAdd: (f: ViewFilter) => void }) {
  const t = useT();
  const usable = fields.filter((f) => f.type !== 'json' && f.type !== 'relation');
  const [open, setOpen] = useState(false);
  const [field, setField] = useState('');
  const [op, setOp] = useState<ViewFilter['op']>('eq');
  const [value, setValue] = useState('');
  if (!usable.length) return null;
  const current = usable.find((f) => f.name === field) ?? usable[0]!;
  const needsValue = op === 'eq' || op === 'contains';
  const submit = () => {
    if (needsValue && !value.trim()) return;
    onAdd({ field: current.name, op, ...(needsValue ? { value: value.trim() } : {}) });
    setValue('');
    setOpen(false);
  };
  if (!open)
    return (
      <Button variant="outline" size="sm" className="h-9" disabled={disabled} onClick={() => setOpen(true)}>
        <Filter className="h-3.5 w-3.5" /> {t('cms.filter.add')}
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-1.5 rounded-md border bg-card p-1"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Select className="h-8" aria-label={t('cms.filter.field')} value={current.name} onChange={(e) => setField(e.target.value)}>
        {usable.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select className="h-8" aria-label={t('cms.filter.op')} value={op} onChange={(e) => setOp(e.target.value as ViewFilter['op'])}>
        {VIEW_FILTER_OPS.map((o) => (
          <option key={o} value={o}>
            {t(`cms.filter.op.${o}` as MessageKey)}
          </option>
        ))}
      </Select>
      {needsValue &&
        (current.type === 'select' && current.options?.length ? (
          <Select className="h-8" aria-label={t('cms.filter.value')} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="" />
            {current.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        ) : (
          <Input className="h-8 w-40" aria-label={t('cms.filter.value')} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        ))}
      <Button type="submit" size="sm" className="h-8">
        {t('cms.filter.apply')}
      </Button>
      <button type="button" aria-label={t('cms.route.cancel')} onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}
