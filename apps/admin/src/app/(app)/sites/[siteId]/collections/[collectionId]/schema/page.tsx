'use client';

import { collectionFieldsSchema, FIELD_TYPES, MULTI_TYPES, type CollectionAiSettings, type FieldDef, type FieldType } from '@canon/fields';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { collectionsKey, useCollection, useCollections, type Collection } from '@/lib/collections';
import { useTenantId } from '@/lib/queries';

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text (single line)',
  textarea: 'Long text',
  richtext: 'Rich text',
  number: 'Number',
  boolean: 'Yes / no',
  date: 'Date',
  datetime: 'Date & time',
  select: 'Choice',
  email: 'Email',
  url: 'URL',
  media: 'Image / file',
  relation: 'Reference',
  color: 'Colour',
  json: 'JSON',
};

const toName = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);

export default function SchemaPage() {
  const { siteId, collectionId } = useParams<{ siteId: string; collectionId: string }>();
  const col = useCollection(siteId, collectionId);
  if (col.isPending) return <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!col.data) return <Alert tone="error">{errorMessage(col.error)}</Alert>;
  return <Editor key={col.data.updatedAt} c={col.data} siteId={siteId} />;
}

function Editor({ c, siteId }: { c: Collection; siteId: string }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const router = useRouter();
  const ability = useAbility();
  const others = useCollections(siteId).data?.filter((x) => x.id !== c.id) ?? [];
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description ?? '');
  const [fields, setFields] = useState<FieldDef[]>(c.fields);
  const [titleField, setTitleField] = useState(c.settings.titleField ?? '');
  const [ai, setAi] = useState<CollectionAiSettings>(c.aiSettings);
  const [vocab, setVocab] = useState(c.aiSettings.tagVocabulary.join(', '));
  const [conflict, setConflict] = useState<{ field: string; from: string; to: string; entries: number }[] | null>(null);
  const [isNew] = useState(() => new Set<number>());

  const check = useMemo(() => collectionFieldsSchema.safeParse(fields), [fields]);
  const issues = check.success ? [] : check.error.issues.map((i) => `${fields[i.path[0] as number]?.label ?? 'Field'}: ${i.message}`);

  const save = useMutation({
    mutationFn: (force: boolean) =>
      api<Collection>(`/sites/${siteId}/collections/${c.id}`, {
        method: 'PATCH',
        body: {
          name,
          description: description || null,
          fields,
          settings: titleField ? { titleField } : {},
          aiSettings: { ...ai, tagVocabulary: vocab.split(',').map((t) => t.trim()).filter(Boolean) },
          force,
        },
      }),
    onSuccess: () => {
      setConflict(null);
      toast.success('Collection saved');
      void qc.invalidateQueries({ queryKey: ['collection', tid, c.id] });
      void qc.invalidateQueries({ queryKey: collectionsKey(tid, siteId) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'SCHEMA_CONFLICT') setConflict((err.details as { fields: typeof conflict }).fields);
      else toast.error(errorMessage(err));
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/sites/${siteId}/collections/${c.id}?force=true`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsKey(tid, siteId) });
      router.push(`/sites/${siteId}/collections`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const patch = (i: number, p: Partial<FieldDef>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const move = (i: number, d: -1 | 1) => setFields((fs) => {
    const next = [...fs];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    return next;
  });
  const add = () => {
    isNew.add(fields.length);
    setFields((fs) => [...fs, { name: `field${fs.length + 1}`, label: `Field ${fs.length + 1}`, type: 'text', required: false, unique: false, helpText: '', multiple: false, integer: false, ai: true }]);
  };
  const textFields = fields.filter((f) => f.type === 'text' || f.type === 'textarea');

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/sites/${siteId}/collections/${c.id}`} className="text-xs text-muted-foreground hover:underline">
          ← {c.name}
        </Link>
        <h2 className="text-lg font-semibold">Fields & AI</h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Name</Label>
            <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-title">Title field</Label>
            <Select id="c-title" className="w-full" value={titleField} onChange={(e) => setTitleField(e.target.value)}>
              <option value="">First text field</option>
              {textFields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="c-desc">Description</Label>
            <Input id="c-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            API: <code>/v1/content/sites/{siteId}/collections/{c.slug}/entries</code>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fields</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {fields.map((f, i) => (
            <div key={i} className="space-y-3 rounded-md border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor={`f-${i}-label`} className="text-xs">
                    Label
                  </Label>
                  <Input id={`f-${i}-label`} value={f.label} onChange={(e) => patch(i, { label: e.target.value, ...(isNew.has(i) ? { name: toName(e.target.value) || f.name } : {}) })} />
                </div>
                <div className="w-40 space-y-1">
                  <Label htmlFor={`f-${i}-name`} className="text-xs">
                    API name
                  </Label>
                  <Input id={`f-${i}-name`} className="font-mono text-xs" value={f.name} onChange={(e) => patch(i, { name: e.target.value })} />
                </div>
                <div className="w-44 space-y-1">
                  <Label htmlFor={`f-${i}-type`} className="text-xs">
                    Type
                  </Label>
                  <Select id={`f-${i}-type`} className="w-full" value={f.type} onChange={(e) => patch(i, { type: e.target.value as FieldType, multiple: MULTI_TYPES.has(e.target.value as FieldType) ? f.multiple : false })}>
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                </div>
                <span className="flex gap-0.5">
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn label="Move down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn label="Remove field" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </span>
              </div>
              {f.type === 'select' && (
                <div className="space-y-1">
                  <Label htmlFor={`f-${i}-opts`} className="text-xs">
                    Options (comma-separated)
                  </Label>
                  <Input id={`f-${i}-opts`} value={(f.options ?? []).join(', ')} onChange={(e) => patch(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })} />
                </div>
              )}
              {f.type === 'relation' && (
                <div className="space-y-1">
                  <Label htmlFor={`f-${i}-rel`} className="text-xs">
                    References entries of
                  </Label>
                  <Select id={`f-${i}-rel`} className="w-full" value={f.relation?.collectionId ?? ''} onChange={(e) => patch(i, { relation: e.target.value ? { collectionId: e.target.value } : undefined })}>
                    <option value="">Choose a collection…</option>
                    <option value={c.id}>{c.name} (this collection)</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <Check label="Required" checked={f.required} onChange={(v) => patch(i, { required: v })} />
                {['text', 'email', 'url', 'number', 'date'].includes(f.type) && !f.multiple && <Check label="Unique" checked={f.unique} onChange={(v) => patch(i, { unique: v })} />}
                {MULTI_TYPES.has(f.type) && <Check label="Multiple values" checked={f.multiple} onChange={(v) => patch(i, { multiple: v, unique: false })} />}
                {f.type === 'number' && <Check label="Whole numbers" checked={f.integer} onChange={(v) => patch(i, { integer: v })} />}
                <Check label="Use for AI" checked={f.ai} onChange={(v) => patch(i, { ai: v })} />
                {(f.type === 'text' || f.type === 'textarea' || f.type === 'number' || f.multiple) && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {f.type === 'number' ? 'min/max' : f.multiple ? 'items' : 'length'}
                    <Input aria-label="Minimum" className="h-7 w-16" type="number" value={f.min ?? ''} onChange={(e) => patch(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />
                    <Input aria-label="Maximum" className="h-7 w-16" type="number" value={f.max ?? ''} onChange={(e) => patch(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </span>
                )}
              </div>
              <Input aria-label="Help text" placeholder="Help text for editors (optional)" value={f.helpText} onChange={(e) => patch(i, { helpText: e.target.value })} className="h-8 text-xs" />
            </div>
          ))}
          <Button variant="outline" onClick={add}>
            <Plus className="h-4 w-4" /> Add field
          </Button>
          {issues.length > 0 && (
            <Alert tone="error">
              {issues.slice(0, 6).map((m) => (
                <p key={m}>{m}</p>
              ))}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI enrichment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">Runs in the background ~15 s after an entry is saved, only when its text changed. Costs go to the AI ledger.</p>
          <Check label="Auto-tag entries" checked={ai.autoTag} onChange={(v) => setAi({ ...ai, autoTag: v })} />
          <Check label="Write a short summary" checked={ai.autoSummary} onChange={(v) => setAi({ ...ai, autoSummary: v })} />
          <Check label="Score quality (0–100) with improvement hints" checked={ai.qualityScore} onChange={(v) => setAi({ ...ai, qualityScore: v })} />
          <Check label="Detect duplicates (works without AI keys; semantic when embeddings are available)" checked={ai.duplicateCheck} onChange={(v) => setAi({ ...ai, duplicateCheck: v })} />
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-1">
              <Label htmlFor="vocab">Tag vocabulary (comma-separated; empty = open)</Label>
              <Input id="vocab" value={vocab} onChange={(e) => setVocab(e.target.value)} placeholder="pricing, security, product" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="max-tags">Max tags</Label>
              <Input id="max-tags" type="number" min={1} max={15} value={ai.maxTags} onChange={(e) => setAi({ ...ai, maxTags: Math.min(15, Math.max(1, Number(e.target.value) || 1)) })} />
            </div>
          </div>
        </CardContent>
      </Card>

      {conflict && (
        <Alert tone="error">
          <p className="font-medium">These changes would invalidate existing values:</p>
          <ul className="my-2 list-disc pl-5">
            {conflict.map((f) => (
              <li key={f.field}>
                {f.field}: {f.from} → {f.to} ({f.entries} entr{f.entries === 1 ? 'y' : 'ies'} have a value)
              </li>
            ))}
          </ul>
          <p className="text-xs">Values that no longer fit are dropped when each entry is next saved. Export first if you need them.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="destructive" loading={save.isPending} onClick={() => save.mutate(true)}>
              Save anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
              Cancel
            </Button>
          </div>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        {ability.can('delete', 'Collection') ? (
          <Button variant="ghost" className="text-destructive" loading={remove.isPending} onClick={() => window.confirm(`Delete “${c.name}” and all its entries? This cannot be undone from the admin.`) && remove.mutate()}>
            <Trash2 className="h-4 w-4" /> Delete collection
          </Button>
        ) : (
          <span />
        )}
        <Button loading={save.isPending && !conflict} disabled={!check.success || !name.trim()} onClick={() => save.mutate(false)}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1.5 hover:bg-muted disabled:opacity-30">
      {children}
    </button>
  );
}
