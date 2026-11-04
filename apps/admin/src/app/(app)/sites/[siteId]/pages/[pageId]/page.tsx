'use client';

import { subject } from '@casl/ability';
import { siteThemeStyle, type RenderMedia, type SiteThemeInput } from '@canon/ui-blocks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  Eye,
  History,
  Languages,
  Loader2,
  MessageSquare,
  Monitor,
  Redo2,
  Save,
  Settings2,
  Smartphone,
  Sparkles,
  Tablet,
  Undo2,
  Laptop,
  Paintbrush,
  Wand2,
} from 'lucide-react';
import { STYLE_BREAKPOINTS } from '@canon/blocks';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCollab } from '@/components/builder/collab';
import { AiPlanPanel } from '@/components/builder/ai-plan';
import { GeneratePageDialog } from '@/components/builder/generate-page';
import { Inspector } from '@/components/builder/inspector';
import { useBlockLabels } from '@/components/builder/labels';
import { Presence } from '@/components/builder/presence';
import { useFacts } from '@/components/builder/rich-text-editor';
import { BuilderContext, createBuilderStore, selectedNode, useBuilder, useBuilderStore, useHistory, type Breakpoint, type Draft } from '@/components/builder/store';
import { StylePanel } from '@/components/builder/style-panel';
import { Workspace } from '@/components/builder/workspace';
import { findNode } from '@/components/editor/tree-ops';
import { ReviewPanel } from '@/components/review-panel';
import { Alert, Badge, Button, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { STATUS_STYLE, useMedia, usePage, usePages, useSite, type PageDetail, type Site } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { translate, currentLocale, useT } from '@/lib/i18n';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

type Panel = 'block' | 'style' | 'ai' | 'page' | 'versions' | 'translate' | 'review';
const AUTOSAVE_MS = 5_000;
/** The five style breakpoints of @canon/blocks; editing one only overrides it and smaller ones. */
const BREAKPOINTS = [
  ['base', Monitor],
  ['laptop', Laptop],
  ['tablet', Tablet],
  ['mobileL', Smartphone],
  ['mobileS', Smartphone],
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
  const params = useSearchParams();
  // Links from review and mention notifications open the review panel.
  const [panel, setPanel] = useState<Panel>(
    params.get('review') || params.get('comment') ? 'review' : 'block',
  );
  const [conflict, setConflict] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** The save in flight, so a Ctrl+S during an autosave waits for it instead of doing nothing. */
  const inflight = useRef<Promise<boolean> | null>(null);
  // Read by save() through a ref: a save that waited for another must use the version it produced.
  const versionRef = useRef(version);
  versionRef.current = Math.max(versionRef.current, version);

  const draft = useBuilder((s) => s.draft);
  const dirty = useBuilder((s) => s.draft !== s.saved);
  const selected = useBuilder(selectedNode);
  const breakpoint = useBuilder((s) => s.breakpoint);
  const setBreakpoint = useBuilder((s) => s.setBreakpoint);
  const setDraftMeta = useBuilder((s) => s.setMeta);
  const selectedCount = useBuilder((s) => s.selectedIds.length);
  const mode = useBuilder((s) => s.mode);
  const setMode = useBuilder((s) => s.setMode);
  const inspectorRequest = useBuilder((s) => s.inspector);
  const L = useBlockLabels();
  const t = L.t;
  const bpTitle = (b: Breakpoint) => {
    const info = STYLE_BREAKPOINTS.find((x) => x.id === b)!;
    return info.max === null ? L.bp(b) : `${L.bp(b)} (≤ ${info.max}px)`;
  };

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
    if (conflict) return false;
    // Edits made during that save are still dirty: wait for it, then send them.
    while (inflight.current) await inflight.current;
    const s = store.getState();
    if (s.draft === s.saved) return true;
    const sending = s.draft;
    const patch = (expectedVersion: number) =>
      api<PageDetail>(`/sites/${siteId}/pages/${initial.id}`, {
        method: 'PATCH',
        body: { expectedVersion, title: sending.title, slug: sending.slug, description: sending.description || null, seo: sending.seo, content: sending.content },
      });
    const run = async (): Promise<boolean> => {
      let res: PageDetail;
      try {
        res = await patch(versionRef.current);
      } catch (err) {
        // In a live session the usual cause is a collaborator's save: the room already holds their
        // changes, so saving on top of their version loses nothing. Anyone else's write is a conflict.
        if (!(err instanceof ApiError && err.code === 'VERSION_CONFLICT') || live.current.status !== 'connected') throw err;
        const fresh = await api<PageDetail>(`/sites/${siteId}/pages/${initial.id}`);
        if (!fresh.updatedById || !live.current.peers.some((p) => p.canEdit && p.userId === fresh.updatedById)) throw err;
        res = await patch(fresh.version);
      }
      versionRef.current = res.version;
      setVersion(res.version);
      setMeta(res);
      store.getState().markSaved(sending);
      live.current.announceSaved(res.version, sending);
      void qc.invalidateQueries({ queryKey: ['pages', tid, siteId] });
      return true;
    };
    const p = run()
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
        else toast.error(errorMessage(err), { id: 'save-error' });
        return false;
      })
      .finally(() => {
        if (inflight.current === p) inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, [store, conflict, siteId, initial.id, qc, tid]);

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
        void save().then((ok) => ok && toast.success(translate(currentLocale(), 'builder.saved')));
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
    if (selectedId) setPanel((p) => (p === 'review' || p === 'style' || p === 'ai' ? p : 'block'));
  }, [selectedId]);
  const selectBlock = useBuilder((s) => s.select);
  useEffect(() => {
    if (inspectorRequest.n) setPanel(inspectorRequest.panel);
  }, [inspectorRequest.n, inspectorRequest.panel]);
  const focusBlock = params.get('block');
  useEffect(() => {
    if (focusBlock && findNode(store.getState().draft.content.root, focusBlock)) {
      selectBlock(focusBlock);
      // Wait for the canvas to lay out, then bring the block into view.
      requestAnimationFrame(() => document.querySelector(`[data-block-id="${CSS.escape(focusBlock)}"]`)?.scrollIntoView({ block: 'center' }));
    }
  }, [focusBlock, selectBlock, store]);
  const blockLabel = useCallback(
    (id: string) => {
      const n = findNode(store.getState().draft.content.root, id);
      return n ? (n.name ?? L.name(n.type)) : undefined;
    },
    [store, L],
  );

  const lifecycle = useMutation({
    mutationFn: async (op: 'publish' | 'unpublish') => {
      if (op === 'publish' && !(await save()))
        throw new Error(t('builder.saveBeforePublish'));
      const run = (body: object) =>
        api<PageDetail>(`/sites/${siteId}/pages/${initial.id}/${op}`, { method: 'POST', body });
      try {
        return await run({});
      } catch (err) {
        // Sites with required review: owners/admins may knowingly publish anyway (audited).
        if (!(err instanceof ApiError && err.code === 'REVIEW_REQUIRED')) throw err;
        setPanel('review');
        if (
          (err.details as { canOverride?: boolean } | undefined)?.canOverride &&
          window.confirm(`${err.message}\n\n${translate(currentLocale(), 'review.publishAnyway')}`)
        )
          return run({ overrideReview: true });
        throw err;
      }
    },
    onSuccess: (res, op) => {
      setMeta(res);
      toast.success(op === 'publish' ? t('builder.published') : t('builder.unpublished'));
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
        <Link href={`/sites/${siteId}/pages`} className="rounded p-1.5 hover:bg-muted" aria-label={t('builder.back')}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <input aria-label={t('builder.pageTitle')} value={draft.title} disabled={!canEdit} onChange={(e) => setDraftMeta({ title: e.target.value }, 'title')} className="w-full truncate bg-transparent text-base font-semibold outline-none" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{site.name}</span>·<span>{meta.locale}</span>·<PageSwitcher siteId={siteId} pageId={initial.id} fullPath={meta.fullPath} />
            <Badge className={STATUS_STYLE[meta.status]}>{t(`status.${meta.status}`)}</Badge>
            {meta.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">{t('builder.unpublishedChanges')}</Badge>}
            {meta.schedule && (
              <Badge className="border-primary/40 text-primary">
                <CalendarClock className="mr-1 h-3 w-3" />
                {meta.schedule.action.toLowerCase()} {new Date(meta.schedule.at).toLocaleString()}
              </Badge>
            )}
            <span aria-live="polite">{dirty ? (collab.leaderName ? t('builder.autosavedBy', { name: collab.leaderName }) : t('builder.unsaved')) : t('builder.savedVersion', { version })}</span>
          </div>
        </div>
        <Presence collab={collab} selfId={me?.id} />
        {canEdit && (
          <div className="flex items-center gap-0.5">
            <ToolBtn label={t('builder.undo')} disabled={!history.canUndo} onClick={history.undo}>
              <Undo2 className="h-4 w-4" />
            </ToolBtn>
            <ToolBtn label={t('builder.redo')} disabled={!history.canRedo} onClick={history.redo}>
              <Redo2 className="h-4 w-4" />
            </ToolBtn>
          </div>
        )}
        <div className="flex items-center rounded-md border p-0.5 text-xs" role="radiogroup" aria-label={t('simple.mode')} title={t('simple.modeHint')}>
          {(['board', 'pro', 'simple'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn('rounded px-2 py-1', mode === m ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {t(`simple.mode.${m}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center rounded-md border p-0.5" role="radiogroup" aria-label={t('builder.previewWidth')}>
          {BREAKPOINTS.map(([b, Icon]) => (
            <button key={b} type="button" role="radio" aria-checked={breakpoint === b} aria-label={bpTitle(b)} title={bpTitle(b)} onClick={() => setBreakpoint(b)} className={cn('rounded p-1', breakpoint === b ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <Icon className={b === 'mobileS' ? 'h-3 w-3' : 'h-4 w-4'} />
            </button>
          ))}
        </div>
        {canEdit && canAi && (
          <Button size="sm" variant="outline" onClick={() => setGenerating(true)}>
            <Sparkles className="h-4 w-4 text-primary" /> {t('builder.generatePage')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void preview()}>
          <Eye className="h-4 w-4" /> {t('builder.preview')}
        </Button>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={!dirty || conflict} onClick={() => void save().then((ok) => ok && toast.success(t('builder.saved')))}>
            <Save className="h-4 w-4" /> {t('builder.save')}
          </Button>
        )}
        {canPublish && meta.publishedVersion !== null && (
          <Button size="sm" variant="ghost" loading={lifecycle.isPending && lifecycle.variables === 'unpublish'} onClick={() => lifecycle.mutate('unpublish')}>
            {t('builder.unpublish')}
          </Button>
        )}
        {canPublish && (
          <Button size="sm" loading={lifecycle.isPending && lifecycle.variables === 'publish'} disabled={conflict || (!dirty && meta.status === 'PUBLISHED' && !meta.hasUnpublishedChanges)} onClick={() => lifecycle.mutate('publish')}>
            {t('builder.publish')}
          </Button>
        )}
      </div>

      {conflict && (
        <Alert tone="error" className="mx-4 mt-3">
          {t('builder.conflict')}{' '}
          <button type="button" className="font-medium underline" onClick={() => void loadLatest()}>
            {t('builder.reloadLatest')}
          </button>
        </Alert>
      )}
      {!canEdit && <Alert className="mx-4 mt-3">{t('builder.readOnly')}</Alert>}

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
                  ['block', Settings2],
                  ['style', Paintbrush],
                  ...(canEdit && canAi ? ([['ai', Wand2]] as const) : []),
                  ['page', Sparkles],
                  ['versions', History],
                  ['translate', Languages],
                  ['review', MessageSquare],
                ] as const
              ).map(([id, Icon]) => (
                <button key={id} type="button" onClick={() => setPanel(id)} aria-pressed={panel === id} className={cn('flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-1.5 text-[10px] leading-tight', panel === id ? 'border-b-2 border-primary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {t(`builder.panel.${id}`)}
                </button>
              ))}
            </div>
            <div className="p-4">
              {panel === 'block' && selectedCount > 1 && <p className="text-sm text-muted-foreground">{t('builder.multiSelected', { count: selectedCount })}</p>}
              {panel === 'block' && selectedCount <= 1 &&
                (selected && selected.id !== draft.content.root.id ? (
                  <Inspector node={selected} siteId={siteId} pageId={initial.id} readOnly={!canEdit} facts={facts} />
                ) : (
                  <p className="text-sm text-muted-foreground">{t('builder.selectToEdit')}</p>
                ))}
              {panel === 'style' &&
                (selected && selected.id !== draft.content.root.id ? (
                  // Site colour variables, so the theme chips show this site's colours.
                  <div style={siteThemeStyle(site.theme as SiteThemeInput)}>
                    <StylePanel node={selected} readOnly={!canEdit} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('builder.selectToStyle')}</p>
                ))}
              {panel === 'ai' && <AiPlanPanel siteId={siteId} pageId={initial.id} locale={meta.locale} />}
              {panel === 'page' && (
                <PagePanel
                  readOnly={!canEdit}
                  siteId={siteId}
                  pageId={initial.id}
                  isHome={meta.fullPath === '/'}
                />
              )}
              {panel === 'versions' && (
                <VersionsPanel
                  siteId={siteId}
                  pageId={initial.id}
                  canEdit={canEdit}
                  onRestored={() => void loadLatest()}
                />
              )}
              {panel === 'translate' && (
                <TranslatePanel
                  siteId={siteId}
                  page={meta}
                  locales={site.locales}
                  onDone={(id) => router.push(`/sites/${siteId}/pages/${id}`)}
                  beforeTranslate={save}
                />
              )}
              {panel === 'review' && (
                <ReviewPanel
                  siteId={siteId}
                  entityType="PAGE"
                  entityId={initial.id}
                  beforeRequest={save}
                  blockId={selected && selected.id !== draft.content.root.id ? selected.id : null}
                  blockLabel={blockLabel}
                  onSelectBlock={selectBlock}
                />
              )}
              {canPublish && panel === 'page' && (
                <SchedulePanel siteId={siteId} page={meta} onChange={setMeta} />
              )}
            </div>
          </>
        }
      />
      {generating && <GeneratePageDialog siteId={siteId} pageId={initial.id} locale={meta.locale} onClose={() => setGenerating(false)} />}
    </div>
  );
}

function PagePanel({
  readOnly,
  siteId,
  pageId,
  isHome,
}: {
  readOnly: boolean;
  siteId: string;
  pageId: string;
  isHome: boolean;
}) {
  const t = useT();
  const draft = useBuilder((s) => s.draft);
  const setMeta = useBuilder((s) => s.setMeta);
  const suggest = useMutation({
    mutationFn: () =>
      api<{
        suggestion: { title: string; description: string; keywords: string[] };
        costUsd: number;
        model: string;
      }>(`/sites/${siteId}/pages/${pageId}/ai-seo`, { method: 'POST', body: {} }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="pg-slug">{t('page.slug')}</Label>
        <Input id="pg-slug" value={draft.slug} disabled={readOnly || isHome} onChange={(e) => setMeta({ slug: e.target.value.toLowerCase() }, 'slug')} />
        {isHome && <p className="text-[11px] text-muted-foreground">{t('page.homeSlug')}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pg-desc">{t('page.description')}</Label>
        <textarea id="pg-desc" rows={2} disabled={readOnly} value={draft.description} onChange={(e) => setMeta({ description: e.target.value }, 'description')} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <hr />
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t('page.searchSocial')}</p>
        {!readOnly && (
          <Button size="sm" variant="outline" loading={suggest.isPending} onClick={() => suggest.mutate()}>
            <Sparkles className="h-3.5 w-3.5" /> {t('page.suggest')}
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
              {t('page.apply')}
            </Button>
          </div>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="seo-title">{t('page.seoTitle')}</Label>
        <Input id="seo-title" maxLength={120} disabled={readOnly} value={draft.seo.title ?? ''} onChange={(e) => setMeta({ seo: { ...draft.seo, title: e.target.value } }, 'seo.title')} />
        <p className="text-right text-[11px] text-muted-foreground">{(draft.seo.title ?? '').length}/60</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="seo-desc">{t('page.metaDescription')}</Label>
        <textarea id="seo-desc" rows={3} maxLength={320} disabled={readOnly} value={draft.seo.description ?? ''} onChange={(e) => setMeta({ seo: { ...draft.seo, description: e.target.value } }, 'seo.description')} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <p className="text-right text-[11px] text-muted-foreground">{(draft.seo.description ?? '').length}/155</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={readOnly}
          checked={Boolean(draft.seo.noindex)}
          onChange={(e) => setMeta({ seo: { ...draft.seo, noindex: e.target.checked } })}
        />{' '}
        {t('page.noindex')}
      </label>
    </div>
  );
}

function SchedulePanel({
  siteId,
  page,
  onChange,
}: {
  siteId: string;
  page: PageDetail;
  onChange: (p: PageDetail) => void;
}) {
  const t = useT();
  const [at, setAt] = useState('');
  const schedule = useMutation({
    mutationFn: () => api<PageDetail>(`/sites/${siteId}/pages/${page.id}/schedule`, { body: { at: new Date(at).toISOString(), action: 'PUBLISH', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }),
    onSuccess: (p) => (onChange(p), toast.success(t('page.scheduled'))),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const cancel = useMutation({ mutationFn: () => api<PageDetail>(`/sites/${siteId}/pages/${page.id}/schedule`, { method: 'DELETE' }), onSuccess: onChange });
  return (
    <div className="mt-6 space-y-2 border-t pt-4">
      <p className="text-sm font-medium">{t('page.schedulePublish')}</p>
      {page.schedule ? (
        <div className="flex items-center justify-between text-sm">
          <span>{new Date(page.schedule.at).toLocaleString()}</span>
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input type="datetime-local" aria-label={t('page.publishAt')} value={at} onChange={(e) => setAt(e.target.value)} />
          <Button size="sm" disabled={!at} loading={schedule.isPending} onClick={() => schedule.mutate()}>
            {t('page.schedule')}
          </Button>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t('page.scheduleHint')}</p>
    </div>
  );
}

function VersionsPanel({
  siteId,
  pageId,
  canEdit,
  onRestored,
}: {
  siteId: string;
  pageId: string;
  canEdit: boolean;
  onRestored: () => void;
}) {
  const t = useT();
  const versions = useQuery({
    queryKey: ['versions', pageId],
    queryFn: () =>
      api<
        {
          version: number;
          comment: string | null;
          createdAt: string;
          createdBy: { name: string } | null;
          isPublished: boolean;
        }[]
      >(`/sites/${siteId}/pages/${pageId}/versions`),
  });
  const restore = useMutation({
    mutationFn: (v: number) => api(`/sites/${siteId}/pages/${pageId}/versions/${v}/restore`, { method: 'POST', body: {} }),
    onSuccess: () => (toast.success(t('page.restored')), onRestored()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <ul className="space-y-2">
      {versions.data?.map((v) => (
        <li key={v.version} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="font-medium">
              v{v.version}{' '}
              {v.isPublished && <Badge className="ml-1 border-success/40 text-success">{t('page.live')}</Badge>}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {v.comment} · {v.createdBy?.name ?? t('page.system')} · {relativeTime(v.createdAt)}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" variant="ghost" loading={restore.isPending && restore.variables === v.version} onClick={() => window.confirm(t('page.restoreConfirm', { version: v.version })) && restore.mutate(v.version)}>
              {t('page.restore')}
            </Button>
          )}
        </li>
      ))}
      {versions.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('page.noVersions')}</p>}
    </ul>
  );
}

function TranslatePanel({
  siteId,
  page,
  locales,
  onDone,
  beforeTranslate,
}: {
  siteId: string;
  page: PageDetail;
  locales: string[];
  onDone: (id: string) => void;
  beforeTranslate: () => Promise<boolean>;
}) {
  const t = useT();
  const targets = locales.filter((l) => l !== page.locale);
  const [target, setTarget] = useState(targets[0] ?? '');
  const existing = page.translations.find((t) => t.locale === target);
  const translate = useMutation({
    mutationFn: async () => {
      await beforeTranslate();
      return api<{ page: PageDetail; ai: { strings: number; costUsd: number; models: string[] } }>(`/sites/${siteId}/pages/${page.id}/ai-translate`, { body: { targetLocale: target, overwrite: Boolean(existing) } });
    },
    onSuccess: (r) => {
      toast.success(t('page.translated', { count: r.ai.strings, cost: formatUsd(r.ai.costUsd) }));
      onDone(r.page.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (targets.length === 0) return <p className="text-sm text-muted-foreground">{t('page.needLocales')}</p>;
  return (
    <div className="space-y-4">
      {page.translations.length > 0 && (
        <ul className="space-y-1 text-sm">
          {page.translations.map((tr) => (
            <li key={tr.id}>
              <Link href={`/sites/${siteId}/pages/${tr.id}`} className="text-primary hover:underline">
                {tr.locale.toUpperCase()} · {tr.fullPath}
              </Link>{' '}
              <Badge className={STATUS_STYLE[tr.status]}>{t(`status.${tr.status}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="tr-target">{t('page.targetLocale')}</Label>
          <Select id="tr-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <Button loading={translate.isPending} onClick={() => translate.mutate()}>
          <Languages className="h-4 w-4" /> {existing ? t('page.retranslate') : t('page.translateAi')}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('page.translateHint')}</p>
    </div>
  );
}

function ToolBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1.5 hover:bg-muted disabled:opacity-30">
      {children}
    </button>
  );
}

function toDraft(p: PageDetail): Draft {
  return { title: p.title, slug: p.slug, description: p.description ?? '', seo: p.seo ?? {}, content: p.content };
}

/** The site's pages: switch the board to another page (unsaved edits are saved first). */
function PageSwitcher({ siteId, pageId, fullPath }: { siteId: string; pageId: string; fullPath: string }) {
  const t = useT();
  const router = useRouter();
  const pages = usePages(siteId);
  const store = useBuilderStore();
  const list = pages.data ?? [];
  if (list.length < 2) return <span>{fullPath}</span>;
  return (
    <select
      aria-label={t('builder.switchPage')}
      value={pageId}
      onChange={(e) => {
        const s = store.getState();
        // The editor asks before leaving with unsaved edits (beforeunload); inside the app, warn the same way.
        if (s.draft !== s.saved && !window.confirm(t('builder.leaveUnsaved'))) return;
        router.push(`/sites/${siteId}/pages/${e.target.value}`);
      }}
      className="max-w-56 truncate rounded border-0 bg-transparent py-0 pl-0 pr-5 text-xs text-muted-foreground hover:text-foreground focus:ring-1 focus:ring-ring"
    >
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.fullPath} — {p.title}
        </option>
      ))}
    </select>
  );
}
