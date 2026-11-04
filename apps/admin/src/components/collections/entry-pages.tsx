'use client';

import { newId, type BlockNode } from '@canon/blocks';
import type { CollectionRoute, FieldDef } from '@canon/fields';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Input, Label, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { Collection } from '@/lib/collections';
import { usePages } from '@/lib/content';
import { useT } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';

const BASE_RE = /^(?:\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?){1,4}$/;
const tok = (name: string) => `{{entry.${name}}}`;
const para = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** A first template from the collection's fields: title, intro, image, body — every value a token. */
function templateContent(fields: readonly FieldDef[]): { root: BlockNode } {
  const n = (type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id: newId(), type, props, children });
  const intro = fields.find((f) => f.type === 'textarea');
  const image = fields.find((f) => f.type === 'media' || (f.type === 'url' && /image|photo|cover|picture/i.test(f.name)));
  const body = fields.find((f) => f.type === 'richtext');
  const blocks: BlockNode[] = [
    n('heading', { text: tok('title'), level: 1, align: 'left' }),
    n('text', { doc: para(intro ? tok(intro.name) : tok('summary')), align: 'left' }),
  ];
  if (image) blocks.push(image.type === 'media' ? n('image', { mediaId: tok(image.name), alt: tok('title'), caption: '', rounded: true }) : n('image', { mediaId: '', src: tok(image.name), alt: tok('title'), caption: '', rounded: true }));
  if (body) blocks.push(n('text', { doc: para(tok(body.name)), align: 'left' }));
  return { root: n('section', {}, [n('section', { background: 'default', paddingY: 'lg', width: 'narrow' }, blocks)]) };
}

/**
 * Entry pages for one collection: the address entries are served at and the template page that
 * renders them. Saving replaces the collection's settings with the new route (other settings kept).
 */
export function EntryPagesCard({ siteId, collection, canEdit }: { siteId: string; collection: Collection; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const tid = useTenantId();
  const pages = usePages(siteId);
  const route = collection.settings.route;
  const [editing, setEditing] = useState(false);
  const [basePath, setBasePath] = useState(route?.basePath ?? `/${collection.slug}`);
  const [templateId, setTemplateId] = useState(route?.templatePageId ?? '');
  const template = pages.data?.find((p) => p.id === route?.templatePageId);
  const valid = BASE_RE.test(basePath) && Boolean(templateId);

  const saveRoute = useMutation({
    mutationFn: (next: CollectionRoute | undefined) => {
      const { route: _old, ...rest } = collection.settings;
      return api<Collection>(`/sites/${siteId}/collections/${collection.id}`, { method: 'PATCH', body: { settings: next ? { ...rest, route: next } : rest } });
    },
    onSuccess: (_c, next) => {
      toast.success(t(next ? 'cms.route.saved' : 'cms.route.removed'));
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['collection', tid, collection.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // A new page with tokens for the collection's fields, published so entry pages work at once.
  const createTemplate = useMutation({
    mutationFn: async () => {
      const page = await api<{ id: string; version: number }>(`/sites/${siteId}/pages`, { body: { title: t('cms.route.templateName', { name: collection.name }), slug: `${collection.slug}-template` } });
      const saved = await api<{ version: number }>(`/sites/${siteId}/pages/${page.id}`, { method: 'PATCH', body: { expectedVersion: page.version, content: templateContent(collection.fields) } });
      void saved;
      await api(`/sites/${siteId}/pages/${page.id}/publish`, { body: {} });
      return page.id;
    },
    onSuccess: (id) => {
      setTemplateId(id);
      void qc.invalidateQueries({ queryKey: ['pages', tid, siteId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const fields = ['title', 'summary', ...collection.fields.map((f) => f.name)].map((f) => `{{entry.${f}}}`).slice(0, 6).join(', ');

  return (
    <section aria-labelledby="entry-pages-title" className="mb-4 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="entry-pages-title" className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-primary" /> {t('cms.route.title')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{route ? t('cms.route.on', { path: `${route.basePath}/…` }) : t('cms.route.off')}</p>
          {route && template && !template.publishedVersion && <p className="mt-1 text-xs text-warning">{t('cms.route.templateDraft')}</p>}
        </div>
        {canEdit && !editing && (
          <div className="flex gap-2">
            {route && template && (
              <Link href={`/sites/${siteId}/pages/${template.id}`}>
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4" /> {t('cms.route.openTemplate')}
                </Button>
              </Link>
            )}
            <Button size="sm" variant={route ? 'outline' : 'default'} onClick={() => setEditing(true)}>
              {route ? t('cms.route.edit') : t('cms.route.title')}
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="route-base">{t('cms.route.basePath')}</Label>
              <Input id="route-base" value={basePath} onChange={(e) => setBasePath(e.target.value.trim().toLowerCase())} aria-invalid={!BASE_RE.test(basePath)} />
              <p className="text-[11px] text-muted-foreground">{t('cms.route.example', { path: `${BASE_RE.test(basePath) ? basePath : '/blog'}/my-first-post` })}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="route-template">{t('cms.route.template')}</Label>
              <Select id="route-template" className="w-full" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">{t('cms.route.chooseTemplate')}</option>
                {pages.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.fullPath})
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="sm" className="px-0 text-primary" loading={createTemplate.isPending} onClick={() => createTemplate.mutate()}>
                {t('cms.route.create')}
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('cms.route.hint', { fields })}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!valid} loading={saveRoute.isPending} onClick={() => saveRoute.mutate({ basePath, templatePageId: templateId })}>
              {t('cms.route.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('cms.route.cancel')}
            </Button>
            {route && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => saveRoute.mutate(undefined)}>
                {t('cms.route.remove')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
