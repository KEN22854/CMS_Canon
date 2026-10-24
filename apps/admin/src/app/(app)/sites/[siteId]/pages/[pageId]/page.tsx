'use client';

import { subject } from '@casl/ability';
import type { RenderMedia, SiteThemeInput } from '@canon/ui-blocks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Eye, History, Languages, Loader2, Monitor, Redo2, Save, Settings2, Smartphone, Sparkles, Tablet, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCollab } from '@/components/builder/collab';
import { GeneratePageDialog } from '@/components/builder/generate-page';
import { Inspector } from '@/components/builder/inspector';
import { Presence } from '@/components/builder/presence';
import { useFacts } from '@/components/builder/rich-text-editor';
import { BuilderContext, createBuilderStore, selectedNode, useBuilder, useBuilderStore, useHistory, type Breakpoint, type Draft } from '@/components/builder/store';
import { Workspace } from '@/components/builder/workspace';
import { Alert, Badge, Button, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { STATUS_STYLE, useMedia, usePage, useSite, type PageDetail, type Site } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

type Panel = 'block' | 'page' | 'versions' | 'translate';
const AUTOSAVE_MS = 5_000;
const BREAKPOINTS = [
  ['desktop', Monitor],
  ['tablet', Tablet],
  ['mobile', Smartphone],
] as const;

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
  return <EditorRoot key={page.data.id} initial={page.data} site={site.data} />;
}

function EditorRoot({ initial, site }: { initial: PageDetail; site: Site }) {
  const [store] = useState(() => createBuilderStore(toDraft(initial)));
  return (
    <BuilderContext.Provider value={store}>
      <Editor initial={initial} site={site} />
    </BuilderContext.Provider>
  );
}

function Editor({ initial, site }: { initial: PageDetail; site: Site }) {
  const siteId = site.id;
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const store = useBuilderStore();
  const history = useHistory();
  const [meta, setMeta] = useState<PageDetail>(initial);
  const [version, setVersion] = useState(initial.version);
  const [panel, setPanel] = useState<Panel>('block');
  const [conflict, setConflict] = useState(false);
  const [generating, setGenerating] = useState(false);
  const saving = useRef(false);

  const draft = useBuilder((s) => s.draft);
  const dirty = useBuilder((s) => s.draft !== s.saved);
  const selected = useBuilder(selectedNode);
  const breakpoint = useBuilder((s) => s.breakpoint);
  const setBreakpoint = useBuilder((s) => s.setBreakpoint);
  const setDraftMeta = useBuilder((s) => s.setMeta);

  const own = subject('Page', { tenantId: tid, createdById: initial.createdById });
  const canEdit = ability.can('update', own);
  const canPublish = ability.can('publish', own);
  const canAi = ability.can('invoke', 'Ai');
  const me = useAuth((s) => s.user);
  const collab = useCollab({ store, pageId: initial.id, canEdit, onVersion: (v) => setVersion((cur) => Math.max(cur, v)) });
  // Presence changes often; reading the session through a ref keeps save() (and the autosave timer) stable.
  const live = useRef(collab);
  live.current = collab;

  const mediaQ = useMedia(siteId);
  const media = useMemo(() => Object.fromEntries((mediaQ.data ?? []).map((m) => [m.id, m as RenderMedia])), [mediaQ.data]);
  const factsQ = useFacts(siteId);
  const facts = useMemo(() => Object.fromEntries((factsQ.data ?? []).map((f) => [f.key, f.displayValue])), [factsQ.data]);

  /**
   * Optimistic: the canvas never waits for the server. Each save is a CAS on `version`; edits made
   * while a save is in flight stay dirty (the store compares draft references) and go next time.
   */
  const save = useCallback(async (): Promise<boolean> => {
    const s = store.getState();
    if (s.draft === s.saved) return true;
    if (saving.current || conflict) return false;
    const sending = s.draft;
    saving.current = true;
    const patch = (expectedVersion: number) =>
      api<PageDetail>(`/sites/${siteId}/pages/${initial.id}`, {
        method: 'PATCH',
        body: { expectedVersion, title: sending.title, slug: sending.slug, description: sending.description || null, seo: sending.seo, content: sending.content },
      });
    try {
      let res: PageDetail;
      try {
        res = await patch(version);
      } catch (err) {
        // In a live session the usual cause is a collaborator's save: the room already holds their
        // changes, so saving on top of their version loses nothing. Anyone else's write is a conflict.
        if (!(err instanceof ApiError && err.code === 'VERSION_CONFLICT') || live.current.status !== 'connected') throw err;
        const fresh = await api<PageDetail>(`/sites/${siteId}/pages/${initial.id}`);
        if (!fresh.updatedById || !live.current.peers.some((p) => p.canEdit && p.userId === fresh.updatedById)) throw err;
        res = await patch(fresh.version);
      }
      setVersion(res.version);
      setMeta(res);
      store.getState().markSaved(sending);
      live.current.announceSaved(res.version, sending);
      void qc.invalidateQueries({ queryKey: ['pages', tid, siteId] });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      else toast.error(errorMessage(err), { id: 'save-error' });
      return false;
    } finally {
      saving.current = false;
    }
  }, [store, conflict, siteId, initial.id, version, qc, tid]);

  /** Takes the server's latest draft — into the whole room when the session is live. */
  const loadLatest = useCallback(async () => {
    if (live.current.status !== 'connected') return window.location.reload();
    try {
      const fresh = await api<PageDetail>(`/sites/${siteId}/pages/${initial.id}`);
      live.current.replaceAll(toDraft(fresh));
      setVersion(fresh.version);
      setMeta(fresh);
      const s = store.getState();
      s.markSaved(s.draft);
      live.current.announceSaved(fresh.version, s.draft);
      setConflict(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [siteId, initial.id, store]);

  // Debounced autosave after the last edit. In a shared session only the leader autosaves; the
  // others follow its saved marker.
  useEffect(() => {
    if (!dirty || !canEdit || !collab.isLeader) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, draft, save, canEdit, collab.isLeader]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save().then((ok) => ok && toast.success('Saved'));
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (store.getState().draft !== store.getState().saved) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [save, store]);

  // Selecting a block on the canvas or in Layers brings its inspector forward.
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) setPanel('block');
  }, [selectedId]);

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

  return (
    <div className="flex h-dvh flex-col">
      {/* Toolbar */}
      <div className="z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <Link href={`/sites/${siteId}/pages`} className="rounded p-1.5 hover:bg-muted" aria-label="Back to pages">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <input aria-label="Page title" value={draft.title} disabled={!canEdit} onChange={(e) => setDraftMeta({ title: e.target.value }, 'title')} className="w-full truncate bg-transparent text-base font-semibold outline-none" />
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
            <span aria-live="polite">{dirty ? (collab.leaderName ? `Autosaved by ${collab.leaderName}…` : 'Unsaved…') : `Saved · v${version}`}</span>
          </div>
        </div>
        <Presence collab={collab} selfId={me?.id} />
        {canEdit && (
          <div className="flex items-center gap-0.5">
            <ToolBtn label="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>
              <Undo2 className="h-4 w-4" />
            </ToolBtn>
            <ToolBtn label="Redo (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={history.redo}>
              <Redo2 className="h-4 w-4" />
            </ToolBtn>
          </div>
        )}
        <div className="flex items-center rounded-md border p-0.5" role="radiogroup" aria-label="Preview width">
          {BREAKPOINTS.map(([b, Icon]) => (
            <button key={b} type="button" role="radio" aria-checked={breakpoint === b} aria-label={b} title={b} onClick={() => setBreakpoint(b as Breakpoint)} className={cn('rounded p-1', breakpoint === b ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
        {canEdit && canAi && (
          <Button size="sm" variant="outline" onClick={() => setGenerating(true)}>
            <Sparkles className="h-4 w-4 text-primary" /> Generate page
          </Button>
        )}
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
          Someone else changed this page. Your edits are kept here but can&apos;t be saved over theirs.{' '}
          <button type="button" className="font-medium underline" onClick={() => void loadLatest()}>
            Reload the latest version
          </button>
        </Alert>
      )}
      {!canEdit && <Alert className="mx-4 mt-3">Read-only: your role cannot edit this page.</Alert>}

      <Workspace
        siteId={siteId}
        pageId={initial.id}
        locale={meta.locale}
        theme={site.theme as SiteThemeInput}
        media={media}
        facts={facts}
        readOnly={!canEdit}
        inspector={
          <>
            <div className="sticky top-0 z-10 flex border-b bg-background text-sm">
              {(
                [
                  ['block', 'Block', Settings2],
                  ['page', 'Page & SEO', Sparkles],
                  ['versions', 'Versions', History],
                  ['translate', 'Translate', Languages],
                ] as const
              ).map(([id, label, Icon]) => (
                <button key={id} type="button" onClick={() => setPanel(id)} className={cn('flex flex-1 items-center justify-center gap-1 px-1 py-2 text-xs', panel === id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}>
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {panel === 'block' &&
                (selected && selected.id !== draft.content.root.id ? (
                  <Inspector node={selected} siteId={siteId} pageId={initial.id} readOnly={!canEdit} facts={facts} />
                ) : (
                  <p className="text-sm text-muted-foreground">Select a block on the canvas or in Layers. Drag blocks in from the palette, or generate the page with AI.</p>
                ))}
              {panel === 'page' && <PagePanel readOnly={!canEdit} siteId={siteId} pageId={initial.id} isHome={meta.fullPath === '/'} />}
              {panel === 'versions' && <VersionsPanel siteId={siteId} pageId={initial.id} canEdit={canEdit} onRestored={() => void loadLatest()} />}
              {panel === 'translate' && <TranslatePanel siteId={siteId} page={meta} locales={site.locales} onDone={(id) => router.push(`/sites/${siteId}/pages/${id}`)} beforeTranslate={save} />}
              {canPublish && panel === 'page' && <SchedulePanel siteId={siteId} page={meta} onChange={setMeta} />}
            </div>
          </>
        }
      />
      {generating && <GeneratePageDialog siteId={siteId} pageId={initial.id} locale={meta.locale} onClose={() => setGenerating(false)} />}
    </div>
  );
}

function PagePanel({ readOnly, siteId, pageId, isHome }: { readOnly: boolean; siteId: string; pageId: string; isHome: boolean }) {
  const draft = useBuilder((s) => s.draft);
  const setMeta = useBuilder((s) => s.setMeta);
  const suggest = useMutation({
    mutationFn: () => api<{ suggestion: { title: string; description: string; keywords: string[] }; costUsd: number; model: string }>(`/sites/${siteId}/pages/${pageId}/ai-seo`, { method: 'POST', body: {} }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="pg-slug">Slug</Label>
        <Input id="pg-slug" value={draft.slug} disabled={readOnly || isHome} onChange={(e) => setMeta({ slug: e.target.value.toLowerCase() }, 'slug')} />
        {isHome && <p className="text-[11px] text-muted-foreground">The home page always lives at /.</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pg-desc">Description</Label>
        <textarea id="pg-desc" rows={2} disabled={readOnly} value={draft.description} onChange={(e) => setMeta({ description: e.target.value }, 'description')} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
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
            <Button size="sm" onClick={() => (setMeta({ seo: { ...draft.seo, title: suggest.data!.suggestion.title, description: suggest.data!.suggestion.description } }), suggest.reset())}>
              Apply
            </Button>
          </div>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="seo-title">SEO title</Label>
        <Input id="seo-title" maxLength={120} disabled={readOnly} value={draft.seo.title ?? ''} onChange={(e) => setMeta({ seo: { ...draft.seo, title: e.target.value } }, 'seo.title')} />
        <p className="text-right text-[11px] text-muted-foreground">{(draft.seo.title ?? '').length}/60</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="seo-desc">Meta description</Label>
        <textarea id="seo-desc" rows={3} maxLength={320} disabled={readOnly} value={draft.seo.description ?? ''} onChange={(e) => setMeta({ seo: { ...draft.seo, description: e.target.value } }, 'seo.description')} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <p className="text-right text-[11px] text-muted-foreground">{(draft.seo.description ?? '').length}/155</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={readOnly} checked={Boolean(draft.seo.noindex)} onChange={(e) => setMeta({ seo: { ...draft.seo, noindex: e.target.checked } })} /> Hide from search engines
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

function ToolBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1.5 hover:bg-muted disabled:opacity-30">
      {children}
    </button>
  );
}

function toDraft(p: PageDetail): Draft {
  return { title: p.title, slug: p.slug, description: p.description ?? '', seo: p.seo ?? {}, content: p.content };
}
