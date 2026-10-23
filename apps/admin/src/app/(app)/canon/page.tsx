'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Braces, GitBranch, Link2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ValueInput, emptyValue } from '@/components/canon/value-input';
import { Alert, Badge, Button, Card, CardContent, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { STATE_STYLE, entityHref, useConflicts, useFacts, type Fact, type ValueType } from '@/lib/canon';
import { useSites } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

type Tab = 'facts' | 'inbox' | 'branches';

export default function CanonPageRoute() {
  return (
    <Suspense>
      <CanonPage />
    </Suspense>
  );
}

function CanonPage() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get('tab') as Tab) || 'facts';
  const sites = useSites();
  const [siteId, setSiteId] = useState('');
  useEffect(() => {
    if (!siteId && sites.data?.[0]) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);
  const conflicts = useConflicts(siteId || undefined);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Braces className="h-6 w-6 text-primary" /> Canon
          </h1>
          <p className="text-sm text-muted-foreground">Change a fact once — the site rewrites itself. Facts render live where they are bound, and the agent team proposes rewrites everywhere else.</p>
        </div>
        {(sites.data?.length ?? 0) > 1 && (
          <Select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <nav className="flex gap-1 border-b" aria-label="Canon">
        {(
          [
            ['facts', 'Facts'],
            ['inbox', `Inbox${conflicts.data?.length ? ` (${conflicts.data.length})` : ''}`],
            ['branches', 'Branches'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => router.replace(`/canon?tab=${id}`)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'facts' && <FactsTab siteId={siteId} />}
      {tab === 'inbox' && <InboxTab siteId={siteId} />}
      {tab === 'branches' && siteId && <BranchesTab siteId={siteId} />}
    </div>
  );
}

function FactsTab({ siteId }: { siteId: string }) {
  const [q, setQ] = useState('');
  const facts = useFacts(siteId || undefined, q || undefined);
  const ability = useAbility();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Input className="h-9 w-72" placeholder="Search key, subject or value" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search facts" />
        {ability.can('create', 'Fact') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New fact
          </Button>
        )}
      </div>
      {facts.isError && <Alert tone="error">{errorMessage(facts.error)}</Alert>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Fact</th>
              <th className="px-3 py-2 font-medium">Value</th>
              <th className="px-3 py-2 font-medium">Mentions</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {facts.data?.map((f) => (
              <tr key={f.id} className="hover:bg-muted/30">
                <td className="px-3 py-2">
                  <Link href={`/canon/facts/${f.id}`} className="font-mono text-xs font-medium hover:text-primary hover:underline">
                    {f.key}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {f.subject.name} · {f.predicate.replace(/_/g, ' ')}
                  </p>
                </td>
                <td className="px-3 py-2 font-medium">
                  {f.displayValue} <span className="text-[10px] text-muted-foreground">v{f.version}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Badge>{f.mentions.total}</Badge>
                    {f.mentions.conflict > 0 && <Badge className={STATE_STYLE.CONFLICT}>{f.mentions.conflict} conflict</Badge>}
                    {f.mentions.stale > 0 && <Badge className={STATE_STYLE.STALE}>{f.mentions.stale} stale</Badge>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{relativeTime(f.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {facts.data?.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No facts yet. Add the prices, numbers and names your site states, then bind them in the editor with “Fact”.</p>}
      </div>
      {creating && <NewFactDialog siteId={siteId} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewFactDialog({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const [subject, setSubject] = useState('');
  const [subjectType, setSubjectType] = useState('product');
  const [predicate, setPredicate] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<ValueType>('MONEY');
  const [value, setValue] = useState<Record<string, unknown>>(emptyValue('MONEY'));
  const [unit, setUnit] = useState('');
  const [siteScoped, setSiteScoped] = useState(false);
  const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  useEffect(() => {
    if (!keyTouched && subject && predicate) setKey(`${slug(subject)}.${slug(predicate)}`);
  }, [subject, predicate, keyTouched]);
  const create = useMutation({
    mutationFn: () => api<Fact>('/canon/facts', { body: { key, subject: { type: subjectType, name: subject }, predicate: slug(predicate), valueType: type, value, unit: unit || undefined, siteId: siteScoped ? siteId : null } }),
    onSuccess: (f) => (void qc.invalidateQueries({ queryKey: ['canon-facts', tid] }), router.push(`/canon/facts/${f.id}`)),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="nf-title">
      <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="nf-title" className="font-semibold">
            New fact
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <div className="space-y-1.5">
            <Label htmlFor="nf-subject">About (subject)</Label>
            <Input id="nf-subject" placeholder="Pro plan" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nf-stype">Kind</Label>
            <Select id="nf-stype" className="w-full" value={subjectType} onChange={(e) => setSubjectType(e.target.value)}>
              {['product', 'plan', 'organization', 'person', 'place', 'policy'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="nf-pred">What (predicate)</Label>
            <Input id="nf-pred" placeholder="monthly price" value={predicate} onChange={(e) => setPredicate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nf-key">Key</Label>
            <Input id="nf-key" className="font-mono text-xs" value={key} onChange={(e) => (setKey(e.target.value), setKeyTouched(true))} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nf-type">Value</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Select id="nf-type" value={type} onChange={(e) => (setType(e.target.value as ValueType), setValue(emptyValue(e.target.value as ValueType)))}>
              {['MONEY', 'NUMBER', 'PERCENT', 'DATE', 'TEXT', 'BOOLEAN', 'URL', 'LIST'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <ValueInput type={type} value={value} onChange={setValue} unit={unit} onUnit={setUnit} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={siteScoped} onChange={(e) => setSiteScoped(e.target.checked)} /> Only for the selected site (default: all sites of the workspace)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!subject.trim() || !predicate.trim() || !key} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}

function InboxTab({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const conflicts = useConflicts(siteId || undefined);
  const refresh = () => (void qc.invalidateQueries({ queryKey: ['canon-conflicts', tid] }), void qc.invalidateQueries({ queryKey: ['canon-facts', tid] }));
  const act = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'bind' | 'dismiss' }) => api(`/canon/mentions/${id}/${op}`, { body: {} }),
    onSuccess: (_, v) => (toast.success(v.op === 'bind' ? 'Bound to the fact — it now renders the canonical value' : 'Dismissed'), refresh()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (conflicts.data?.length === 0) return <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">Everything your content says agrees with Canon.</p>;
  return (
    <ul className="space-y-2">
      {conflicts.data?.map((m) => (
        <li key={m.id}>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <AlertTriangle className={cn('h-4 w-4', m.state === 'CONFLICT' ? 'text-destructive' : 'text-warning')} aria-hidden />
              <div className="min-w-0 flex-1">
                <p>
                  <span className="rounded bg-destructive/10 px-1 font-medium text-destructive line-through decoration-1">{m.surfaceText}</span> → <span className="rounded bg-success/10 px-1 font-medium text-success">{m.fact.displayValue}</span>{' '}
                  <Link href={`/canon/facts/${m.fact.id}`} className="font-mono text-xs text-muted-foreground hover:underline">
                    {m.fact.key}
                  </Link>
                </p>
                <p className="text-xs text-muted-foreground">
                  <Link href={entityHref(m.entity)} className="hover:underline">
                    {m.entity.collectionName ? `${m.entity.collectionName}: ` : ''}
                    {m.entity.title}
                  </Link>{' '}
                  · {m.entity.path} · {m.locale.toUpperCase()} · <Badge className={STATE_STYLE[m.state]}>{m.state === 'STALE' ? 'outdated' : 'contradicts'}</Badge>
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => act.mutate({ id: m.id, op: 'bind' })} title="Replace the text with a live fact token">
                <Link2 className="h-3.5 w-3.5" /> Bind
              </Button>
              <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: m.id, op: 'dismiss' })}>
                Dismiss
              </Button>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function BranchesTab({ siteId }: { siteId: string }) {
  const tid = useTenantId();
  const branches = useQuery({ queryKey: ['branches', tid, siteId], queryFn: () => api<{ id: string; name: string; status: string; changes: number; summary: { proposed?: number; escalated?: number; to?: string } | null; createdAt: string; createdBy: string | null }[]>(`/sites/${siteId}/branches`) });
  if (branches.data?.length === 0) return <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No branches yet. Change a fact and press “Propagate” to let the agent team propose rewrites.</p>;
  return (
    <ul className="divide-y rounded-md border">
      {branches.data?.map((b) => (
        <li key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
          <Link href={`/canon/branches/${b.id}`} className="font-mono text-xs font-medium hover:text-primary hover:underline">
            {b.name}
          </Link>
          <Badge>{b.status.toLowerCase().replace('_', ' ')}</Badge>
          <span className="text-xs text-muted-foreground">
            {b.changes} page{b.changes === 1 ? '' : 's'}
            {b.summary?.proposed !== undefined ? ` · ${b.summary.proposed} rewrites` : ''}
            {b.summary?.escalated ? ` · ${b.summary.escalated} escalated` : ''}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {b.createdBy ?? 'system'} · {relativeTime(b.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
