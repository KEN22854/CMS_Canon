'use client';

import type { BlockPatch } from '@canon/edge';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PatchEditor, SuggestButton, editableBlocks } from '@/components/experiences/patch-editor';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Progress, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { usePage, usePages } from '@/lib/content';
import { GOALS, VERDICT, useExperiments, type ExperimentDetail } from '@/lib/experiences';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

const STATUS: Record<string, string> = {
  DRAFT: 'border-muted-foreground/30 text-muted-foreground',
  RUNNING: 'border-success/40 text-success',
  PAUSED: 'border-warning/40 text-warning',
  COMPLETED: 'border-primary/40 text-primary',
};

export default function Experiments() {
  const { siteId } = useParams<{ siteId: string }>();
  const ability = useAbility();
  const list = useExperiments(siteId);
  const [creating, setCreating] = useState(false);
  const canCreate = ability.can('create', 'AbTest');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Variants are changes over the published page, assigned at the edge per visitor and cached per variant — no flicker, no client script. Results use exposures and goal conversions; Canon only declares a winner once the planned sample size is reached.
        </p>
        {canCreate && !creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New experiment
          </Button>
        )}
      </div>
      {creating && <CreateExperiment siteId={siteId} onClose={() => setCreating(false)} />}
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <div className="grid gap-3">
        {list.data?.map((e) => (
          <Link key={e.id} href={`/sites/${siteId}/experiments/${e.id}`} className="block">
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="flex flex-wrap items-center gap-4 p-4">
                <FlaskConical className="h-5 w-5 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{e.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {e.page.title} · {e.page.fullPath} · goal <code>{e.goalMetric}</code> · {e.variants.length} variants · {relativeTime(e.createdAt)}
                  </p>
                </div>
                <Badge className={STATUS[e.status]}>{e.status.toLowerCase()}</Badge>
                {e.results && <Badge className={VERDICT[e.results.verdict].className}>{VERDICT[e.results.verdict].label}</Badge>}
                {e.results && (
                  <div className="w-32">
                    <Progress value={Math.round(e.results.progress * 100)} />
                    <p className="mt-1 text-right text-[10px] text-muted-foreground">{e.results.exposures.toLocaleString()} visitors</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
        {list.data?.length === 0 && !creating && <p className="py-10 text-center text-sm text-muted-foreground">No experiments yet. Test a headline or a call to action on a published page.</p>}
      </div>
    </div>
  );
}

interface DraftVariant {
  id: string;
  name: string;
  weight: number;
  patch: BlockPatch;
}

function CreateExperiment({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const pages = usePages(siteId);
  const published = (pages.data ?? []).filter((p) => p.publishedVersion !== null);
  const [pageId, setPageId] = useState('');
  const page = usePage(siteId, pageId);
  const blocks = useMemo(() => (page.data ? editableBlocks(page.data.content.root) : []), [page.data]);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('cta_click');
  const [traffic, setTraffic] = useState(100);
  const [variants, setVariants] = useState<DraftVariant[]>([{ id: 'b', name: 'Variant B', weight: 1, patch: {} }]);

  const create = useMutation({
    mutationFn: () =>
      api<ExperimentDetail>(`/sites/${siteId}/pages/${pageId}/experiments`, {
        body: { name, goalMetric: goal, trafficAllocation: traffic / 100, variants: [{ id: 'control', name: 'Original', weight: 1, patch: {} }, ...variants] },
      }),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['experiments', tid, siteId] });
      toast.success('Experiment created — review it and start when ready');
      router.push(`/sites/${siteId}/experiments/${e.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const nextId = () => String.fromCharCode(98 + variants.length); // b, c, d…
  const valid = pageId && name.trim() && variants.length > 0 && variants.every((v) => Object.keys(v.patch).length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New experiment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ex-page">Page</Label>
            <Select id="ex-page" value={pageId} onChange={(e) => (setPageId(e.target.value), setVariants([{ id: 'b', name: 'Variant B', weight: 1, patch: {} }]))}>
              <option value="">Choose a published page…</option>
              {published.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.locale} · {p.fullPath}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ex-name">Name</Label>
            <Input id="ex-name" value={name} placeholder="Benefit-led hero headline" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ex-goal">Goal (conversion event)</Label>
            <Select id="ex-goal" value={goal} onChange={(e) => setGoal(e.target.value)}>
              {GOALS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-muted-foreground">cta_click is tracked on every button automatically; custom events via window.canon.track(&apos;name&apos;).</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ex-traffic">Traffic in the test: {traffic}%</Label>
            <input id="ex-traffic" type="range" min={5} max={100} step={5} value={traffic} onChange={(e) => setTraffic(Number(e.target.value))} className="w-full" />
          </div>
        </div>

        {pageId && page.data && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Variants (the original page is the control)</p>
              {ability.can('invoke', 'Ai') && (
                <SuggestButton
                  siteId={siteId}
                  pageId={pageId}
                  blocks={blocks}
                  goal={goal}
                  onPick={(s) => {
                    setVariants(s.slice(0, 4).map((x, i) => ({ id: String.fromCharCode(98 + i), name: x.name, weight: 1, patch: x.patch })));
                    if (!name.trim() && s[0]) setName(s[0].hypothesis.slice(0, 120) || s[0].name);
                  }}
                />
              )}
            </div>
            {variants.map((v, i) => (
              <div key={v.id} className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <Input aria-label="Variant name" value={v.name} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="max-w-xs" />
                  <span className="text-xs text-muted-foreground">id {v.id}</span>
                  <button type="button" aria-label="Remove variant" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <PatchEditor blocks={blocks} patch={v.patch} onChange={(patch) => setVariants(variants.map((x, j) => (j === i ? { ...x, patch } : x)))} />
              </div>
            ))}
            {variants.length < 4 && (
              <Button size="sm" variant="ghost" onClick={() => setVariants([...variants, { id: nextId(), name: `Variant ${nextId().toUpperCase()}`, weight: 1, patch: {} }])}>
                <Plus className="h-4 w-4" /> Add variant
              </Button>
            )}
          </div>
        )}
        {published.length === 0 && pages.data && <Alert>Publish a page first — experiments run against the live version.</Alert>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Create experiment
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
