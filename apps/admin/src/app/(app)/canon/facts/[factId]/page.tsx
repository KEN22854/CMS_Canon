'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Braces, History, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ValueInput } from '@/components/canon/value-input';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { STATE_STYLE, entityHref, useFact, useImpact, type Fact } from '@/lib/canon';
import { useSites } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

export default function FactPage() {
  const { factId } = useParams<{ factId: string }>();
  const fact = useFact(factId);
  if (fact.isPending) return <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!fact.data) return <Alert tone="error">{errorMessage(fact.error)}</Alert>;
  return <FactView key={`${fact.data.id}:${fact.data.version}`} fact={fact.data} />;
}

function FactView({ fact }: { fact: Fact }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const sites = useSites();
  const impact = useImpact(fact.id);
  const versions = useQuery({
    queryKey: ['canon-versions', tid, fact.id, fact.version],
    queryFn: () => api<{ version: number; displayValue: string; origin: string; reason: string | null; validFrom: string; changedBy: { name: string } | null }[]>(`/canon/facts/${fact.id}/versions`),
  });
  const [value, setValue] = useState(fact.value);
  const [unit, setUnit] = useState(fact.unit ?? '');
  const [reason, setReason] = useState('');
  const canEdit = ability.can('update', 'Fact');
  const dirty = JSON.stringify(value) !== JSON.stringify(fact.value) || unit !== (fact.unit ?? '');

  const refresh = () => {
    for (const k of ['canon-fact', 'canon-impact', 'canon-facts', 'canon-conflicts', 'canon-versions']) void qc.invalidateQueries({ queryKey: [k, tid] });
  };
  const save = useMutation({
    mutationFn: () => api<{ changed: boolean; impact: { totals: { bound: number; stale: number; conflicts: number } } }>(`/canon/facts/${fact.id}`, { method: 'PATCH', body: { value, unit: unit || null, reason: reason || undefined } }),
    onSuccess: (r) => {
      toast.success(r.changed ? 'New version saved' : 'Saved', {
        description: r.changed ? `${r.impact.totals.bound} bound mention(s) update automatically; ${r.impact.totals.stale + r.impact.totals.conflicts} need a rewrite — propagate to let the agents propose it.` : undefined,
      });
      setReason('');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const propagate = useMutation({
    mutationFn: (siteId: string) => api<{ branchId: string; mentions: number; reused: boolean }>(`/canon/facts/${fact.id}/propagate`, { body: { siteId } }),
    onSuccess: (r) => router.push(`/canon/branches/${r.branchId}`),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : errorMessage(err)),
  });

  // Sites that have something to propagate, from the impact view.
  const pending = useMemo(() => {
    const by = new Map<string, number>();
    for (const g of impact.data?.entities ?? []) {
      const n = g.mentions.filter((m) => m.kind === 'DETECTED' && (m.state === 'STALE' || m.state === 'CONFLICT')).length;
      if (n) by.set(g.entity.siteId, (by.get(g.entity.siteId) ?? 0) + n);
    }
    return [...by.entries()];
  }, [impact.data]);

  const t = impact.data?.totals;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/canon" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> Canon
        </Link>
        <h1 className="flex items-center gap-2 font-mono text-xl font-semibold">
          <Braces className="h-5 w-5 text-primary" /> {fact.key}
        </h1>
        <p className="text-sm text-muted-foreground">
          {fact.subject.name} ({fact.subject.type}) · {fact.predicate.replace(/_/g, ' ')} · v{fact.version} · valid from {new Date(fact.validFrom).toLocaleDateString()}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Canonical value</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-3xl font-semibold tracking-tight">{fact.displayValue}</p>
              {canEdit && (
                <>
                  <ValueInput type={fact.valueType} value={value} onChange={setValue} unit={unit} onUnit={setUnit} />
                  <div className="space-y-1.5">
                    <Label htmlFor="reason">Why it changed (shown in history and to the agents)</Label>
                    <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 2027 price update" />
                  </div>
                  <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                    Save new value
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Where it appears</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {t && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge>{t.mentions} mentions</Badge>
                  <Badge>{t.entities} pages/entries</Badge>
                  <Badge className="border-primary/40 text-primary">{t.bound} bound (live)</Badge>
                  {t.conflicts > 0 && <Badge className={STATE_STYLE.CONFLICT}>{t.conflicts} contradict</Badge>}
                  {t.stale > 0 && <Badge className={STATE_STYLE.STALE}>{t.stale} outdated</Badge>}
                  {t.locales.length > 0 && <Badge>{t.locales.map((l) => l.toUpperCase()).join(' · ')}</Badge>}
                </div>
              )}
              {impact.data?.entities.map((g) => (
                <div key={`${g.entity.type}:${g.entity.id}`} className="rounded-md border p-3">
                  <Link href={entityHref(g.entity)} className="text-sm font-medium hover:text-primary hover:underline">
                    {g.entity.collectionName ? `${g.entity.collectionName}: ` : ''}
                    {g.entity.title}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {g.entity.path} · {g.entity.locale.toUpperCase()}
                  </span>
                  <ul className="mt-2 space-y-1">
                    {g.mentions.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-xs">
                        <Badge className={STATE_STYLE[m.state]}>{m.kind === 'BOUND' ? 'bound' : m.state.toLowerCase().replace('_', ' ')}</Badge>
                        <span className="font-mono">{m.kind === 'BOUND' ? `{{fact:${fact.key}}}` : `“${m.surfaceText}”`}</span>
                        <span className="text-muted-foreground">{m.fieldPath}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {impact.data?.entities.length === 0 && <p className="text-sm text-muted-foreground">Not mentioned anywhere yet. Insert it in a text block with “Fact”, or pages that state the value will be detected on their next save.</p>}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="flex items-center gap-1 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-primary" /> Propagate
              </p>
              {pending.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing outdated. Bound mentions already show {fact.displayValue}.</p>
              ) : (
                pending.map(([siteId, n]) => (
                  <Button key={siteId} className="w-full" loading={propagate.isPending && propagate.variables === siteId} disabled={!ability.can('create', 'Branch')} onClick={() => propagate.mutate(siteId)}>
                    {n} span{n === 1 ? '' : 's'} on {sites.data?.find((s) => s.id === siteId)?.name ?? 'site'}
                  </Button>
                ))
              )}
              <p className="text-[11px] text-muted-foreground">The Strategist plans, the Copywriter/Translator rewrite each span in context, the Fact-Checker verifies — in a branch you review before anything changes.</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 p-4">
              <p className="flex items-center gap-1 text-sm font-medium">
                <History className="h-4 w-4" /> History
              </p>
              {versions.data?.map((v) => (
                <div key={v.version} className="text-xs">
                  <p>
                    <span className="font-medium">v{v.version}</span> · {v.displayValue} <Badge>{v.origin.toLowerCase()}</Badge>
                  </p>
                  <p className="text-muted-foreground">
                    {v.reason ?? '—'} · {v.changedBy?.name ?? 'system'} · {relativeTime(v.validFrom)}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
