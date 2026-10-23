'use client';

import { subject } from '@casl/ability';
import { BLOCKS, type PageContent } from '@canon/blocks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, CalendarClock, Copy, Eye, History, Languages, Loader2, Plus, Save, Settings2, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Inspector } from '@/components/editor/inspector';
import { duplicateBlock, findNode, insertBlock, moveBlock, newBlock, outline, removeBlock, updateProps } from '@/components/editor/tree-ops';
import { Alert, Badge, Button, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { STATUS_STYLE, usePage, useSite, type PageDetail } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

interface Draft {
  title: string;
  slug: string;
  description: string;
  seo: PageDetail['seo'];
  content: PageContent;
}

type Panel = 'block' | 'page' | 'versions' | 'translate';
const AUTOSAVE_MS = 5_000;

export default function PageEditor() {
  const { siteId, pageId } = useParams<{ siteId: string; pageId: string }>();
  const page = usePage(siteId, pageId);
  const site = useSite(siteId);
  if (page.isPending || site.isPending) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (page.isError || !page.data || !site.data) return <Alert tone="error">{errorMessage(page.error)}</Alert>;
  // Keyed by page id so switching pages (e.g. after translating) resets all editor state.
  return <Editor key={page.data.id} initial={page.data} siteId={siteId} locales={site.data.locales} />;
}

function Editor({ initial, siteId, locales }: { initial: PageDetail; siteId: string; locales: string[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const [meta, setMeta] = useState<PageDetail>(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [version, setVersion] = useState(initial.version);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(initial.content.root.children[0]?.id ?? null);
  const [panel, setPanel] = useState<Panel>('block');
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);

  const own = subject('Page', { tenantId: tid, createdById: initial.createdById });
  const canEdit = ability.can('update', own);
  const canPublish = ability.can('publish', own);

  const edit = useCallback((fn: (d: Draft) => Draft) => {
    setDraft((d) => fn(d));
    setDirty(true);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty || saving.current || conflict) return !dirty;
    saving.current = true;
    try {
      const res = await api<PageDetail>(`/sites/${siteId}/pages/${initial.id}`, {
        method: 'PATCH',
        body: { expectedVersion: version, title: draft.title, slug: draft.slug, description: draft.description || null, seo: draft.seo, content: draft.content },
      });
      setVersion(res.version);
      setMeta(res);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['pages', tid, siteId] });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      else toast.error(errorMessage(err));
      return false;
    } finally {
      saving.current = false;
    }
  }, [dirty, conflict, siteId, initial.id, version, draft, qc, tid]);

  // Debounced autosave; every save is a CAS on `version`, so two tabs can't clobber each other.
  useEffect(() => {
    if (!dirty || !canEdit) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, draft, save, canEdit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save().then((ok) => ok && toast.success('Saved'));
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [save, dirty]);

  const lifecycle = useMutation({
    mutationFn: async (op: 'publish' | 'unpublish') => {
      if (op === 'publish' && !(await save())) throw new Error('Save failed — fix the error before publishing');
      return api<PageDetail>(`/sites/${siteId}/pages/${initial.id}/${op}`, { method: 'POST', body: {} });
    },
    onSuccess: (res, op) => {
      setMeta(res);
      toast.success(op === 'publish' ? 'Published — the site updates within seconds' : 'Unpublished');
      void qc.invalidateQueries({ queryKey: ['pages', tid, siteId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : errorMessage(err)),
  });

  const preview = async () => {
    // Open the tab synchronously (popup blockers), then point it at the signed preview link.
    const win = window.open('about:blank', '_blank');
    try {
      await save();
      const { url } = await api<{ url: string }>(`/sites/${siteId}/pages/${initial.id}/preview`, { method: 'POST', body: {} });
      if (win) win.location.href = url;
    } catch (err) {
      win?.close();
      toast.error(errorMessage(err));
    }
  };

  const items = useMemo(() => outline(draft.content.root), [draft.content]);
  const selectedNode = selected ? findNode(draft.content.root, selected) : null;

  const addBlock = (type: string) => {
    const block = newBlock(type);
    const sel = selected ? items.find((i) => i.node.id === selected) : undefined;
    // Into a selected section, otherwise after the selected block, otherwise at the end.
    edit((d) => {
      if (sel?.node.type === 'section') return { ...d, content: insertBlock(d.content, sel.node.id, sel.node.children.length, block) };
      if (sel) return { ...d, content: insertBlock(d.content, sel.parentId, sel.index + 1, block) };
      return { ...d, content: insertBlock(d.content, d.content.root.id, d.content.root.children.length, block) };
    });
    setSelected(block.id);
    setPanel('block');
  };

  return (
    <div className="-mx-4 -my-8 flex min-h-screen flex-col md:-mx-8">
      {/* Toolbar */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <Link href={`/sites/${siteId}/pages`} className="rounded p-1.5 hover:bg-muted" aria-label="Back to pages">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <input
            aria-label="Page title"
            value={draft.title}
            disabled={!canEdit}
            onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))}
            className="w-full truncate bg-transparent text-base font-semibold outline-none"
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{meta.locale}</span>·<span>{meta.fullPath}</span>
            <Badge className={STATUS_STYLE[meta.status]}>{meta.status.toLowerCase()}</Badge>
            {meta.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">unpublished changes</Badge>}
            {meta.schedule && (
              <Badge className="border-primary/40 text-primary">
                <CalendarClock className="mr-1 h-3 w-3" />
                {meta.schedule.action.toLowerCase()} {new Date(meta.schedule.at).toLocaleString()}
              </Badge>
            )}
            <span aria-live="polite">{dirty ? 'Unsaved…' : `Saved · v${version}`}</span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void preview()}>
          <Eye className="h-4 w-4" /> Preview
        </Button>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={!dirty || conflict} onClick={() => void save().then((ok) => ok && toast.success('Saved'))}>
            <Save className="h-4 w-4" /> Save
          </Button>
        )}
        {canPublish && meta.publishedVersion !== null && (
          <Button size="sm" variant="ghost" loading={lifecycle.isPending && lifecycle.variables === 'unpublish'} onClick={() => lifecycle.mutate('unpublish')}>
            Unpublish
          </Button>
        )}
        {canPublish && (
          <Button size="sm" loading={lifecycle.isPending && lifecycle.variables === 'publish'} disabled={conflict || (!dirty && meta.status === 'PUBLISHED' && !meta.hasUnpublishedChanges)} onClick={() => lifecycle.mutate('publish')}>
            Publish
          </Button>
        )}
      </div>

      {conflict && (
        <Alert tone="error" className="mx-4 mt-3">
          Someone else changed this page. Your edits are kept here but can't be saved over theirs.{' '}
          <button type="button" className="font-medium underline" onClick={() => window.location.reload()}>
            Reload the latest version
          </button>
        </Alert>
      )}
      {!canEdit && <Alert className="mx-4 mt-3">Read-only: your role cannot edit this page.</Alert>}

      <div className="flex flex-1 flex-col md:flex-row">
        {/* Outline */}
        <section className="flex-1 space-y-2 p-4" aria-label="Blocks">
          {items.map(({ node, depth, index, siblings }) => (
            <div
              key={node.id}
              role="button"
              tabIndex={0}
              onClick={() => (setSelected(node.id), setPanel('block'))}
              onKeyDown={(e) => e.key === 'Enter' && (setSelected(node.id), setPanel('block'))}
              style={{ marginLeft: depth * 20 }}
              className={cn('group flex items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm', selected === node.id && 'border-primary ring-1 ring-primary')}
            >
              <span className="w-20 shrink-0 text-xs font-medium uppercase text-muted-foreground">{node.type}</span>
              <span className="min-w-0 flex-1 truncate">{blockSummary(node.props)}</span>
              {canEdit && (
                <span className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <IconBtn label="Move up" disabled={index === 0} onClick={() => edit((d) => ({ ...d, content: moveBlock(d.content, node.id, -1) }))}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn label="Move down" disabled={index === siblings - 1} onClick={() => edit((d) => ({ ...d, content: moveBlock(d.content, node.id, 1) }))}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn label="Duplicate" onClick={() => edit((d) => ({ ...d, content: duplicateBlock(d.content, node.id) }))}>
                    <Copy className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn
                    label="Delete"
                    onClick={() => {
                      edit((d) => ({ ...d, content: removeBlock(d.content, node.id) }));
                      if (selected === node.id) setSelected(null);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </span>
              )}
            </div>
          ))}
          {items.length === 0 && <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">This page is empty — add a block.</p>}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
              {BLOCKS.map((b) => (
                <Button key={b.type} size="sm" variant="outline" onClick={() => addBlock(b.type)}>
                  {b.name}
                </Button>
              ))}
            </div>
          )}
        </section>

        {/* Side panel */}
        <aside className="w-full border-t md:w-96 md:border-l md:border-t-0" aria-label="Inspector">
          <div className="flex border-b text-sm">
            {(
              [
                ['block', 'Block', Settings2],
                ['page', 'Page & SEO', Sparkles],
                ['versions', 'Versions', History],
                ['translate', 'Translate', Languages],
              ] as const
            ).map(([id, label, Icon]) => (
              <button key={id} type="button" onClick={() => setPanel(id)} className={cn('flex flex-1 items-center justify-center gap-1 px-2 py-2', panel === id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}>
                <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
              </button>
            ))}
          </div>
          <div className="p-4">
            {panel === 'block' &&
              (selectedNode && selectedNode.id !== draft.content.root.id ? (
                <Inspector node={selectedNode} siteId={siteId} pageId={initial.id} readOnly={!canEdit} onChange={(patch) => edit((d) => ({ ...d, content: updateProps(d.content, selectedNode.id, patch) }))} />
              ) : (
                <p className="text-sm text-muted-foreground">Select a block to edit it.</p>
              ))}
            {panel === 'page' && <PagePanel draft={draft} edit={edit} readOnly={!canEdit} siteId={siteId} pageId={initial.id} isHome={meta.fullPath === '/'} />}
            {panel === 'versions' && <VersionsPanel siteId={siteId} pageId={initial.id} canEdit={canEdit} onRestored={() => window.location.reload()} />}
            {panel === 'translate' && <TranslatePanel siteId={siteId} page={meta} locales={locales} onDone={(id) => router.push(`/sites/${siteId}/pages/${id}`)} beforeTranslate={save} />}
            {canPublish && panel === 'page' && <SchedulePanel siteId={siteId} page={meta} onChange={setMeta} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function PagePanel({ draft, edit, readOnly, siteId, pageId, isHome }: { draft: Draft; edit: (fn: (d: Draft) => Draft) => void; readOnly: boolean; siteId: string; pageId: string; isHome: boolean }) {
  const suggest = useMutation({
    mutationFn: () => api<{ suggestion: { title: string; description: string; keywords: string[] }; costUsd: number; model: string }>(`/sites/${siteId}/pages/${pageId}/ai-seo`, { method: 'POST', body: {} }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="pg-slug">Slug</Label>
        <Input id="pg-slug" value={draft.slug} disabled={readOnly || isHome} onChange={(e) => edit((d) => ({ ...d, slug: e.target.value.toLowerCase() }))} />
        {isHome && <p className="text-[11px] text-muted-foreground">The home page always lives at /.</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pg-desc">Description</Label>
        <textarea id="pg-desc" rows={2} disabled={readOnly} value={draft.description} onChange={(e) => edit((d) => ({ ...d, description: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <hr />
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Search & social</p>
        {!readOnly && (
          <Button size="sm" variant="outline" loading={suggest.isPending} onClick={() => suggest.mutate()}>
            <Sparkles className="h-3.5 w-3.5" /> Suggest
          </Button>
        )}
      </div>
      {suggest.data && (
        <Alert>
          <p className="font-medium">{suggest.data.suggestion.title}</p>
          <p className="text-xs">{suggest.data.suggestion.description}</p>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {suggest.data.model} · {formatUsd(suggest.data.costUsd)}
            </span>
            <Button size="sm" onClick={() => (edit((d) => ({ ...d, seo: { ...d.seo, title: suggest.data!.suggestion.title, description: suggest.data!.suggestion.description } })), suggest.reset())}>
              Apply
            </Button>
          </div>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="seo-title">SEO title</Label>
        <Input id="seo-title" maxLength={120} disabled={readOnly} value={draft.seo.title ?? ''} onChange={(e) => edit((d) => ({ ...d, seo: { ...d.seo, title: e.target.value } }))} />
        <p className="text-right text-[11px] text-muted-foreground">{(draft.seo.title ?? '').length}/60</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="seo-desc">Meta description</Label>
        <textarea id="seo-desc" rows={3} maxLength={320} disabled={readOnly} value={draft.seo.description ?? ''} onChange={(e) => edit((d) => ({ ...d, seo: { ...d.seo, description: e.target.value } }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <p className="text-right text-[11px] text-muted-foreground">{(draft.seo.description ?? '').length}/155</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={readOnly} checked={Boolean(draft.seo.noindex)} onChange={(e) => edit((d) => ({ ...d, seo: { ...d.seo, noindex: e.target.checked } }))} /> Hide from search engines
      </label>
    </div>
  );
}

function SchedulePanel({ siteId, page, onChange }: { siteId: string; page: PageDetail; onChange: (p: PageDetail) => void }) {
  const [at, setAt] = useState('');
  const schedule = useMutation({
    mutationFn: () => api<PageDetail>(`/sites/${siteId}/pages/${page.id}/schedule`, { body: { at: new Date(at).toISOString(), action: 'PUBLISH', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }),
    onSuccess: (p) => (onChange(p), toast.success('Scheduled')),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const cancel = useMutation({ mutationFn: () => api<PageDetail>(`/sites/${siteId}/pages/${page.id}/schedule`, { method: 'DELETE' }), onSuccess: onChange });
  return (
    <div className="mt-6 space-y-2 border-t pt-4">
      <p className="text-sm font-medium">Schedule publish</p>
      {page.schedule ? (
        <div className="flex items-center justify-between text-sm">
          <span>{new Date(page.schedule.at).toLocaleString()}</span>
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input type="datetime-local" aria-label="Publish at" value={at} onChange={(e) => setAt(e.target.value)} />
          <Button size="sm" disabled={!at} loading={schedule.isPending} onClick={() => schedule.mutate()}>
            Schedule
          </Button>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">The current draft is published at that time (save your changes first).</p>
    </div>
  );
}

function VersionsPanel({ siteId, pageId, canEdit, onRestored }: { siteId: string; pageId: string; canEdit: boolean; onRestored: () => void }) {
  const versions = useQuery({
    queryKey: ['versions', pageId],
    queryFn: () => api<{ version: number; comment: string | null; createdAt: string; createdBy: { name: string } | null; isPublished: boolean }[]>(`/sites/${siteId}/pages/${pageId}/versions`),
  });
  const restore = useMutation({
    mutationFn: (v: number) => api(`/sites/${siteId}/pages/${pageId}/versions/${v}/restore`, { method: 'POST', body: {} }),
    onSuccess: () => (toast.success('Restored into the draft'), onRestored()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <ul className="space-y-2">
      {versions.data?.map((v) => (
        <li key={v.version} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="font-medium">
              v{v.version} {v.isPublished && <Badge className="ml-1 border-success/40 text-success">live</Badge>}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {v.comment} · {v.createdBy?.name ?? 'system'} · {relativeTime(v.createdAt)}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" variant="ghost" loading={restore.isPending && restore.variables === v.version} onClick={() => window.confirm(`Replace the draft with v${v.version}?`) && restore.mutate(v.version)}>
              Restore
            </Button>
          )}
        </li>
      ))}
      {versions.data?.length === 0 && <p className="text-sm text-muted-foreground">Versions are created on publish and on restore.</p>}
    </ul>
  );
}

function TranslatePanel({ siteId, page, locales, onDone, beforeTranslate }: { siteId: string; page: PageDetail; locales: string[]; onDone: (id: string) => void; beforeTranslate: () => Promise<boolean> }) {
  const targets = locales.filter((l) => l !== page.locale);
  const [target, setTarget] = useState(targets[0] ?? '');
  const existing = page.translations.find((t) => t.locale === target);
  const translate = useMutation({
    mutationFn: async () => {
      await beforeTranslate();
      return api<{ page: PageDetail; ai: { strings: number; costUsd: number; models: string[] } }>(`/sites/${siteId}/pages/${page.id}/ai-translate`, { body: { targetLocale: target, overwrite: Boolean(existing) } });
    },
    onSuccess: (r) => {
      toast.success(`Translated ${r.ai.strings} strings · ${formatUsd(r.ai.costUsd)}`);
      onDone(r.page.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (targets.length === 0) return <p className="text-sm text-muted-foreground">Add more locales in the site settings to translate pages.</p>;
  return (
    <div className="space-y-4">
      {page.translations.length > 0 && (
        <ul className="space-y-1 text-sm">
          {page.translations.map((t) => (
            <li key={t.id}>
              <Link href={`/sites/${siteId}/pages/${t.id}`} className="text-primary hover:underline">
                {t.locale.toUpperCase()} · {t.fullPath}
              </Link>{' '}
              <Badge className={STATUS_STYLE[t.status]}>{t.status.toLowerCase()}</Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="tr-target">Target locale</Label>
          <Select id="tr-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <Button loading={translate.isPending} onClick={() => translate.mutate()}>
          <Languages className="h-4 w-4" /> {existing ? 'Re-translate draft' : 'Translate with AI'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Creates a draft in the target locale using the site glossary and brand voice. Structure, images, links and Canon facts are kept; review before publishing.</p>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1 hover:bg-muted disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function toDraft(p: PageDetail): Draft {
  return { title: p.title, slug: p.slug, description: p.description ?? '', seo: p.seo ?? {}, content: p.content };
}

function blockSummary(props: Record<string, unknown>): string {
  for (const k of ['title', 'text', 'label', 'caption', 'alt']) if (typeof props[k] === 'string' && props[k]) return props[k] as string;
  const doc = props.doc as { content?: { content?: { text?: string }[] }[] } | undefined;
  const t = doc?.content?.[0]?.content?.map((n) => n.text ?? '…').join('');
  return t || '—';
}
