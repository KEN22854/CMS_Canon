'use client';

import { COLLECTION_PRESETS, slugify, type FieldDef } from '@canon/fields';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, Plus, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { collectionsKey, useCollections, type Collection } from '@/lib/collections';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

export default function CollectionsPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const list = useCollections(siteId);
  const ability = useAbility();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Structured content — blog posts, products, team, FAQ — with a schema you define. Served headless at <code className="text-xs">/v1/content</code>.</p>
        {ability.can('create', 'Collection') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New collection
          </Button>
        )}
      </div>
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.map((c) => (
          <Link key={c.id} href={`/sites/${siteId}/collections/${c.id}`} className="group">
            <Card className="h-full transition-colors group-hover:border-primary">
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{c.name}</p>
                  <Badge>{c.entryCount ?? 0} entries</Badge>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{c.description || c.fields.map((f) => f.label).join(' · ')}</p>
                <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                  <span className="font-mono">/{c.slug}</span>·<span>{c.fields.length} fields</span>
                  {c.aiSettings.autoTag && <Badge className="border-primary/40 text-primary">auto-tag</Badge>}
                  {c.aiSettings.autoSummary && <Badge className="border-primary/40 text-primary">summary</Badge>}
                  {c.aiSettings.qualityScore && <Badge className="border-primary/40 text-primary">quality</Badge>}
                  <span className="ml-auto">{relativeTime(c.updatedAt)}</span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      {list.data?.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <Database className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">No collections yet. Start from a preset or describe your content and let AI draft the fields.</p>
        </div>
      )}
      {creating && <CreateDialog siteId={siteId} onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateDialog({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const [preset, setPreset] = useState('blog');
  const [name, setName] = useState('Blog posts');
  const [slug, setSlug] = useState('posts');
  const [slugTouched, setSlugTouched] = useState(false);
  const [fields, setFields] = useState<FieldDef[] | null>(null);
  const [description, setDescription] = useState('');

  const pick = (id: string) => {
    const p = COLLECTION_PRESETS.find((x) => x.id === id)!;
    setPreset(id);
    setFields(null);
    setName(p.name);
    setSlug(p.slug);
    setSlugTouched(false);
  };

  const suggest = useMutation({
    mutationFn: () => api<{ name: string; slug: string; fields: FieldDef[]; dropped: { name: string }[]; ai: { costUsd: number } }>(`/sites/${siteId}/collections/ai/suggest-schema`, { body: { description } }),
    onSuccess: (r) => {
      setPreset('ai');
      setFields(r.fields);
      if (r.name) setName(r.name);
      if (r.slug) setSlug(slugify(r.slug).slice(0, 60));
      toast.success(`Suggested ${r.fields.length} fields · ${formatUsd(r.ai.costUsd)}`, { description: r.dropped.length ? `${r.dropped.length} invalid field(s) left out` : undefined });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const create = useMutation({
    mutationFn: () => {
      const p = COLLECTION_PRESETS.find((x) => x.id === preset);
      return api<Collection>(`/sites/${siteId}/collections`, {
        body: { name, slug, fields: fields ?? p?.fields ?? [], settings: p ? { titleField: p.titleField } : {}, aiSettings: { duplicateCheck: true, ...(p?.ai ?? {}) } },
      });
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: collectionsKey(tid, siteId) });
      router.push(`/sites/${siteId}/collections/${c.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const shown = fields ?? (COLLECTION_PRESETS.find((p) => p.id === preset)?.fields as FieldDef[] | undefined) ?? [];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="new-col">
      <div className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="new-col" className="font-semibold">
            New collection
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {COLLECTION_PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => pick(p.id)} title={p.description} className={cn('rounded-md border px-2 py-2 text-left text-xs', preset === p.id ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:border-primary')}>
              {p.name}
            </button>
          ))}
        </div>
        {ability.can('invoke', 'Ai') && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <Label htmlFor="desc">…or describe your content</Label>
            <div className="flex gap-2">
              <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Events with date, venue, speakers and a registration link" />
              <Button variant="outline" loading={suggest.isPending} disabled={description.trim().length < 10} onClick={() => suggest.mutate()}>
                <Sparkles className="h-4 w-4 text-primary" /> Suggest
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Name</Label>
            <Input id="c-name" value={name} onChange={(e) => (setName(e.target.value), !slugTouched && setSlug(slugify(e.target.value).slice(0, 60)))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-slug">API slug</Label>
            <Input id="c-slug" value={slug} onChange={(e) => (setSlug(e.target.value.toLowerCase()), setSlugTouched(true))} />
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Fields (editable after creation)</p>
          <ul className="divide-y rounded-md border text-sm">
            {shown.map((f) => (
              <li key={f.name} className="flex items-center justify-between px-3 py-1.5">
                <span>
                  {f.label} <span className="font-mono text-[11px] text-muted-foreground">{f.name}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {f.type}
                  {f.multiple ? '[]' : ''}
                  {f.required ? ' · required' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!name.trim() || !slug || shown.length === 0} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
