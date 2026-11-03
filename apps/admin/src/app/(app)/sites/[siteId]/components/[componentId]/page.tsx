'use client';

import { emptyPageContent, STYLE_BREAKPOINTS, type BlockNode } from '@canon/blocks';
import { siteThemeStyle, type RenderMedia, type SiteThemeInput } from '@canon/ui-blocks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Boxes, Laptop, Loader2, Monitor, Paintbrush, Redo2, Save, Settings2, Smartphone, Tablet, Undo2, UploadCloud } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useFacts } from '@/components/builder/rich-text-editor';
import { Inspector } from '@/components/builder/inspector';
import { useBlockLabels } from '@/components/builder/labels';
import { BuilderContext, createBuilderStore, selectedNode, useBuilder, useBuilderStore, useHistory, type Breakpoint, type Draft } from '@/components/builder/store';
import { StylePanel } from '@/components/builder/style-panel';
import { Workspace } from '@/components/builder/workspace';
import { Alert, Badge, Button } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { componentsKey, type SiteComponent } from '@/lib/components';
import { useMedia, useSite, type Site } from '@/lib/content';
import { useT } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn } from '@/lib/utils';

const BREAKPOINTS = [
  ['base', Monitor],
  ['laptop', Laptop],
  ['tablet', Tablet],
  ['mobileL', Smartphone],
  ['mobileS', Smartphone],
] as const;

/** The component's tree is edited as the only child of a frame section, like a one-block page. */
const FRAME_ID = '__component';
const toDraft = (c: SiteComponent): Draft => ({ title: c.name, slug: '', description: c.description ?? '', seo: {}, content: { root: { ...emptyPageContent().root, id: FRAME_ID, children: [c.tree] } } });

export default function ComponentEditorPage() {
  const { siteId, componentId } = useParams<{ siteId: string; componentId: string }>();
  const tid = useTenantId();
  const site = useSite(siteId);
  const comp = useQuery({ queryKey: ['component', tid, componentId], queryFn: () => api<SiteComponent>(`/components/${componentId}`), enabled: Boolean(tid), staleTime: Infinity });
  if (comp.isPending || site.isPending) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      </div>
    );
  }
  if (comp.isError || !comp.data || !site.data) return <Alert tone="error">{errorMessage(comp.error ?? site.error)}</Alert>;
  return <EditorRoot key={comp.data.id} initial={comp.data} site={site.data} />;
}

function EditorRoot({ initial, site }: { initial: SiteComponent; site: Site }) {
  const [store] = useState(() => createBuilderStore(toDraft(initial)));
  return (
    <BuilderContext.Provider value={store}>
      <ComponentEditor initial={initial} site={site} />
    </BuilderContext.Provider>
  );
}

function ComponentEditor({ initial, site }: { initial: SiteComponent; site: Site }) {
  const t = useT();
  const L = useBlockLabels();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const store = useBuilderStore();
  const history = useHistory();
  const [meta, setMeta] = useState(initial);
  const [panel, setPanel] = useState<'block' | 'style'>('block');
  const draft = useBuilder((s) => s.draft);
  const dirty = useBuilder((s) => s.draft !== s.saved);
  const selected = useBuilder(selectedNode);
  const breakpoint = useBuilder((s) => s.breakpoint);
  const setBreakpoint = useBuilder((s) => s.setBreakpoint);
  const canEdit = ability.can('update', 'Page');
  const canPublish = ability.can('publish', 'Page');
  const mediaQ = useMedia(site.id);
  const media = useMemo(() => Object.fromEntries((mediaQ.data ?? []).map((m) => [m.id, m as RenderMedia])), [mediaQ.data]);
  const factsQ = useFacts(site.id);
  const facts = useMemo(() => Object.fromEntries((factsQ.data ?? []).map((f) => [f.key, f.displayValue])), [factsQ.data]);

  const save = useCallback(async (): Promise<boolean> => {
    const s = store.getState();
    if (s.draft === s.saved) return true;
    const kids = s.draft.content.root.children;
    if (!kids.length) return false;
    // Blocks added next to the component's root become part of it, wrapped in a group.
    const tree: BlockNode = kids.length === 1 ? kids[0]! : { id: kids[0]!.id === 'g' ? 'g2' : 'g', type: 'group', props: { layout: 'stack', gap: 'md', align: 'stretch', columns: 3 }, children: kids };
    const sending = s.draft;
    try {
      const res = await api<SiteComponent>(`/components/${meta.id}`, { method: 'PATCH', body: { version: meta.version, name: sending.title.trim() || meta.name, tree } });
      setMeta(res);
      store.getState().markSaved(sending);
      void qc.invalidateQueries({ queryKey: componentsKey(tid, site.id) });
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError && err.status === 409 ? err.message : errorMessage(err), { id: 'save-error' });
      return false;
    }
  }, [store, meta, qc, tid, site.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save().then((ok) => ok && toast.success(t('builder.saved')));
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => store.getState().draft !== store.getState().saved && e.preventDefault();
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => (window.removeEventListener('keydown', onKey), window.removeEventListener('beforeunload', onLeave));
  }, [save, store, t]);

  const publish = useMutation({
    mutationFn: async () => {
      if (!(await save())) throw new Error(t('builder.saveBeforePublish'));
      return api<SiteComponent>(`/components/${meta.id}/publish`, { method: 'POST', body: {} });
    },
    onSuccess: (res) => (setMeta(res), toast.success(t('component.publishedToast')), void qc.invalidateQueries({ queryKey: componentsKey(tid, site.id) })),
    onError: (err) => toast.error(err instanceof Error ? err.message : errorMessage(err)),
  });

  const bpTitle = (b: Breakpoint) => {
    const info = STYLE_BREAKPOINTS.find((x) => x.id === b)!;
    return info.max === null ? L.bp(b) : `${L.bp(b)} (≤ ${info.max}px)`;
  };

  return (
    <div className="flex h-dvh flex-col">
      <div className="z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <Link href={`/sites/${site.id}/components`} className="rounded p-1.5 hover:bg-muted" aria-label={t('component.listTitle')}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Boxes className="h-4 w-4 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <input aria-label={t('component.namePrompt')} value={draft.title} disabled={!canEdit} onChange={(e) => store.getState().setMeta({ title: e.target.value }, 'title')} className="w-full truncate bg-transparent text-base font-semibold outline-none" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {meta.publishedVersion ? <Badge className="border-success/40 text-success">{t('component.live', { version: meta.publishedVersion })}</Badge> : <Badge className="border-warning/40 text-warning">{t('component.notPublished')}</Badge>}
            {meta.publishedVersion !== null && meta.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">{t('component.unpublished')}</Badge>}
            <span aria-live="polite">{dirty ? t('builder.unsaved') : t('builder.savedVersion', { version: meta.version })}</span>
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-0.5">
            <button type="button" aria-label={t('builder.undo')} title={t('builder.undo')} disabled={!history.canUndo} onClick={history.undo} className="rounded p-1.5 hover:bg-muted disabled:opacity-30">
              <Undo2 className="h-4 w-4" />
            </button>
            <button type="button" aria-label={t('builder.redo')} title={t('builder.redo')} disabled={!history.canRedo} onClick={history.redo} className="rounded p-1.5 hover:bg-muted disabled:opacity-30">
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex items-center rounded-md border p-0.5" role="radiogroup" aria-label={t('builder.previewWidth')}>
          {BREAKPOINTS.map(([b, Icon]) => (
            <button key={b} type="button" role="radio" aria-checked={breakpoint === b} aria-label={bpTitle(b)} title={bpTitle(b)} onClick={() => setBreakpoint(b)} className={cn('rounded p-1', breakpoint === b ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <Icon className={b === 'mobileS' ? 'h-3 w-3' : 'h-4 w-4'} />
            </button>
          ))}
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={!dirty} onClick={() => void save().then((ok) => ok && toast.success(t('builder.saved')))}>
            <Save className="h-4 w-4" /> {t('builder.save')}
          </Button>
        )}
        {canPublish && (
          <Button size="sm" loading={publish.isPending} disabled={!dirty && !meta.hasUnpublishedChanges} onClick={() => publish.mutate()}>
            <UploadCloud className="h-4 w-4" /> {t('component.publish')}
          </Button>
        )}
      </div>
      <Alert className="mx-4 mt-3">{t('component.usage')}</Alert>
      <Workspace
        siteId={site.id}
        pageId=""
        locale={site.defaultLocale}
        theme={site.theme as SiteThemeInput}
        media={media}
        facts={facts}
        readOnly={!canEdit}
        inspector={
          <>
            <div className="sticky top-0 z-10 flex border-b bg-background text-sm">
              {(
                [
                  ['block', t('builder.panel.block'), Settings2],
                  ['style', t('builder.panel.style'), Paintbrush],
                ] as const
              ).map(([id, label, Icon]) => (
                <button key={id} type="button" onClick={() => setPanel(id)} aria-pressed={panel === id} className={cn('flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs', panel === id ? 'border-b-2 border-primary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {selected && selected.id !== FRAME_ID ? (
                panel === 'block' ? (
                  <Inspector node={selected} siteId={site.id} pageId="" readOnly={!canEdit} facts={facts} />
                ) : (
                  <div style={siteThemeStyle(site.theme as SiteThemeInput)}>
                    <StylePanel node={selected} readOnly={!canEdit} />
                  </div>
                )
              ) : (
                <p className="text-sm text-muted-foreground">{panel === 'block' ? t('builder.selectToEdit') : t('builder.selectToStyle')}</p>
              )}
            </div>
          </>
        }
      />
    </div>
  );
}
