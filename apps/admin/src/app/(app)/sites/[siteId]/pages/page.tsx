'use client';

import { subject } from '@casl/ability';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, FileText, Languages, Plus, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { STATUS_STYLE, usePages, useSite, type PageDetail, type PageSummary } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export default function PagesList() {
  const { siteId } = useParams<{ siteId: string }>();
  const site = useSite(siteId);
  const pages = usePages(siteId);
  const ability = useAbility();
  const tid = useTenantId();
  const qc = useQueryClient();
  const router = useRouter();
  const [locale, setLocale] = useState<string>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [parentId, setParentId] = useState('');

  const activeLocale = locale || site.data?.defaultLocale || '';
  const refresh = () => qc.invalidateQueries({ queryKey: ['pages', tid, siteId] });

  const visible = useMemo(
    () =>
      (pages.data ?? [])
        .filter((p) => !activeLocale || p.locale === activeLocale)
        .filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase()) || p.fullPath.includes(q.toLowerCase()))
        .sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    [pages.data, activeLocale, q],
  );

  const create = useMutation({
    mutationFn: () => api<PageDetail>(`/sites/${siteId}/pages`, { body: { title, slug, parentId: parentId || null, locale: activeLocale } }),
    onSuccess: (p) => {
      void refresh();
      router.push(`/sites/${siteId}/pages/${p.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const action = useMutation({
    mutationFn: ({ page, op }: { page: PageSummary; op: 'publish' | 'unpublish' | 'duplicate' | 'delete' }) =>
      op === 'delete' ? api(`/sites/${siteId}/pages/${page.id}`, { method: 'DELETE' }) : api(`/sites/${siteId}/pages/${page.id}/${op}`, { method: 'POST', body: {} }),
    onSuccess: (_, v) => {
      toast.success({ publish: 'Published', unpublish: 'Unpublished', duplicate: 'Duplicated', delete: 'Deleted' }[v.op]);
      void refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const depth = (p: PageSummary) => (p.fullPath === '/' ? 0 : p.fullPath.split('/').length - 2);
  const locales = site.data?.locales ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="locale-filter">Locale</Label>
          <Select id="locale-filter" value={activeLocale} onChange={(e) => setLocale(e.target.value)}>
            {locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[12rem] flex-1 space-y-1.5">
          <Label htmlFor="page-search">Search</Label>
          <Input id="page-search" placeholder="Title or path" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {ability.can('create', 'Page') && (
          <Button onClick={() => setCreating((c) => !c)}>
            <Plus className="h-4 w-4" /> New page
          </Button>
        )}
      </div>

      {creating && (
        <Card className="mb-4">
          <CardContent className="pt-5">
            <form
              className="grid gap-3 md:grid-cols-4"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="new-title">Title</Label>
                <Input
                  id="new-title"
                  autoFocus
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-slug">Slug</Label>
                <Input
                  id="new-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-parent">Parent</Label>
                <Select id="new-parent" className="w-full" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">— top level —</option>
                  {visible
                    .filter((p) => p.fullPath !== '/')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.fullPath}
                      </option>
                    ))}
                </Select>
              </div>
              <div className="md:col-span-4">
                <Button type="submit" loading={create.isPending} disabled={!title.trim() || !slug}>
                  Create {activeLocale && `(${activeLocale})`}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Page</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const own = subject('Page', { tenantId: tid, createdById: p.createdById });
                return (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <Link href={`/sites/${siteId}/pages/${p.id}`} className="flex items-center gap-2 font-medium hover:underline" style={{ paddingLeft: depth(p) * 16 }}>
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        {p.title}
                        {p.aiGenerated && <Sparkles className="h-3 w-3 text-primary" aria-label="AI-generated" />}
                      </Link>
                      <div className="text-xs text-muted-foreground" style={{ paddingLeft: depth(p) * 16 + 24 }}>
                        {p.fullPath}
                        {p.translationGroupId && <Languages className="ml-1 inline h-3 w-3" aria-label="Has translations" />}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge className={STATUS_STYLE[p.status]}>{p.status.toLowerCase()}</Badge>
                        {p.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">changes</Badge>}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{relativeTime(p.updatedAt)}</td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1">
                        {ability.can('publish', own) &&
                          (p.status === 'PUBLISHED' && !p.hasUnpublishedChanges ? (
                            <Button size="sm" variant="ghost" onClick={() => action.mutate({ page: p, op: 'unpublish' })}>
                              Unpublish
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => action.mutate({ page: p, op: 'publish' })}>
                              Publish
                            </Button>
                          ))}
                        {ability.can('create', 'Page') && (
                          <Button size="icon" variant="ghost" aria-label={`Duplicate ${p.title}`} onClick={() => action.mutate({ page: p, op: 'duplicate' })}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        )}
                        {ability.can('delete', own) && p.fullPath !== '/' && (
                          <Button size="icon" variant="ghost" aria-label={`Delete ${p.title}`} onClick={() => window.confirm(`Delete "${p.title}" and its sub-pages?`) && action.mutate({ page: p, op: 'delete' })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && !pages.isPending && <p className="p-5 text-sm text-muted-foreground">No pages in this locale yet.</p>}
      </Card>
    </>
  );
}
