'use client';

import { cloneWithIds, expandInstance, overridableFields, type BlockNode, type ComponentOverrides } from '@canon/blocks';
import { useQueryClient } from '@tanstack/react-query';
import { Boxes, ExternalLink, RotateCcw, Unlink } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { componentsKey, useComponents, type SiteComponent } from '@/lib/components';
import { useT } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Alert, Badge, Button, Input, Label } from '../ui';
import { useBlockLabels } from './labels';
import { useBuilder } from './store';

/**
 * "Make a component": the block goes to the site's component library and is replaced on this page
 * by an instance. The first version is published straight away, because the block was already
 * part of the page; later edits to the component need their own publish.
 */
export function MakeComponent({ node, siteId }: { node: BlockNode; siteId: string }) {
  const t = useT();
  const L = useBlockLabels();
  const qc = useQueryClient();
  const tid = useTenantId();
  const replace = useBuilder((s) => s.replace);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { locked: _l, ...tree } = node;
      const c = await api<SiteComponent>(`/sites/${siteId}/components`, { body: { name: name.trim(), tree } });
      // Authors may create but not publish; the component then waits for an editor.
      await api(`/components/${c.id}/publish`, { method: 'POST', body: {} }).catch(() => undefined);
      replace(node.id, { id: node.id, type: 'component', props: { componentId: c.id, overrides: {} }, children: [] });
      void qc.invalidateQueries({ queryKey: componentsKey(tid, siteId) });
      toast.success(t('component.created', { name: c.name }));
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          title={t('component.createHint')}
          onClick={() => {
            setName(node.name ?? L.name(node.type));
            setOpen(true);
          }}
        >
          <Boxes className="h-3.5 w-3.5" /> {t('component.create')}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2">
      <Label htmlFor={`mk-${node.id}`}>{t('component.namePrompt')}</Label>
      <Input id={`mk-${node.id}`} autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
      <p className="text-[11px] text-muted-foreground">{t('component.createHint')}</p>
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
          {t('common.create')}
        </Button>
      </div>
    </div>
  );
}

/** An instance: which component, its status, page-level overrides, edit and detach. */
export function ComponentInspector({ node, siteId, readOnly }: { node: BlockNode; siteId: string; readOnly: boolean }) {
  const t = useT();
  const L = useBlockLabels();
  const list = useComponents(siteId);
  const updateProps = useBuilder((s) => s.updateProps);
  const replace = useBuilder((s) => s.replace);
  const componentId = String(node.props.componentId ?? '');
  const comp = list.data?.find((c) => c.id === componentId);
  const overrides = (node.props.overrides ?? {}) as ComponentOverrides;

  if (list.isPending) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (!comp) {
    return (
      <div className="space-y-3">
        <Alert tone="error">{t('component.missing')}</Alert>
        {!readOnly && (
          <select aria-label={t('component.choose')} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value="" onChange={(e) => e.target.value && updateProps(node.id, { componentId: e.target.value, overrides: {} })}>
            <option value="">{t('component.choose')}</option>
            {list.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  const fields = overridableFields(comp.tree);
  const setOverride = (nodeId: string, field: string, value: string | undefined) => {
    const forNode = { ...(overrides[nodeId] ?? {}) };
    if (value === undefined) delete forNode[field];
    else forNode[field] = value;
    const next = { ...overrides, [nodeId]: forNode };
    if (!Object.keys(forNode).length) delete next[nodeId];
    updateProps(node.id, { overrides: next }, `${node.id}.override.${nodeId}.${field}`);
  };
  const detach = () => {
    // The page gets the blocks as they look here (overrides applied), with ids of its own.
    replace(node.id, cloneWithIds(expandInstance(node, comp.tree)));
    toast.success(t('component.detached'));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t('component.instanceOf', { name: comp.name })}</p>
          {comp.description && <p className="text-xs text-muted-foreground">{comp.description}</p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {comp.publishedVersion ? <Badge className="border-success/40 text-success">{t('component.live', { version: comp.publishedVersion })}</Badge> : <Badge className="border-warning/40 text-warning">{t('component.notPublished')}</Badge>}
            {comp.publishedVersion !== null && comp.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">{t('component.unpublished')}</Badge>}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Link href={`/sites/${siteId}/components/${comp.id}`} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted">
          <ExternalLink className="h-3.5 w-3.5" /> {t('component.edit')}
        </Link>
        {!readOnly && (
          <Button size="sm" variant="outline" className="flex-1" title={t('component.detachHint')} onClick={detach}>
            <Unlink className="h-3.5 w-3.5" /> {t('component.detach')}
          </Button>
        )}
      </div>
      {fields.length > 0 && (
        <fieldset className="space-y-3 border-t pt-3">
          <legend className="text-sm font-medium">{t('component.overrides')}</legend>
          <p className="text-[11px] text-muted-foreground">{t('component.overridesHint')}</p>
          {fields.map((f) => {
            const own = overrides[f.nodeId]?.[f.field];
            const id = `ov-${node.id}-${f.nodeId}-${f.field}`;
            const value = typeof own === 'string' ? own : typeof f.value === 'string' ? f.value : '';
            return (
              <div key={`${f.nodeId}.${f.field}`} className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <Label htmlFor={id} className={cn('text-xs', own !== undefined && 'text-primary')}>
                    {L.name(f.type)} · {L.field(f.type, f.field)}
                    {own !== undefined && <span className="ml-1 text-[10px]">({t('component.overridden')})</span>}
                  </Label>
                  {own !== undefined && !readOnly && (
                    <button type="button" aria-label={t('component.resetOverride')} title={t('component.resetOverride')} onClick={() => setOverride(f.nodeId, f.field, undefined)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {f.kind === 'textarea' ? (
                  <textarea id={id} rows={2} disabled={readOnly} value={value} onChange={(e) => setOverride(f.nodeId, f.field, e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
                ) : (
                  <Input id={id} className="h-8" disabled={readOnly} value={value} onChange={(e) => setOverride(f.nodeId, f.field, e.target.value)} />
                )}
              </div>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
