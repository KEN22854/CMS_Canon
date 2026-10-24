'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Pause, Play, Sparkles, Trophy } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PatchEditor, editableBlocks } from '@/components/experiences/patch-editor';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Progress } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { usePage } from '@/lib/content';
import { VERDICT, pct, signedPct, useExperiment, type ExperimentDetail, type Recommendation } from '@/lib/experiences';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

const DECISION: Record<Recommendation['decision'], string> = {
  declare_winner: 'Declare the winner',
  keep_running: 'Keep running',
  stop_no_effect: 'Stop — no meaningful effect',
  stop_control_wins: 'Stop — the original performs better',
};

export default function ExperimentPage() {
  const { siteId, experimentId } = useParams<{ siteId: string; experimentId: string }>();
  const tid = useTenantId();
  const qc = useQueryClient();
  const ability = useAbility();
  const q = useExperiment(experimentId);
  const e = q.data;
  const page = usePage(siteId, e?.pageId ?? '');
  const blocks = useMemo(() => (page.data ? editableBlocks(page.data.content.root) : []), [page.data]);
  const [applyToDraft, setApplyToDraft] = useState(true);

  const onDone = (res: ExperimentDetail) => {
    qc.setQueryData(['experiment', tid, experimentId], res);
    void qc.invalidateQueries({ queryKey: ['experiments', tid, siteId] });
  };
  const action = useMutation({
    mutationFn: (op: 'start' | 'pause') => api<ExperimentDetail>(`/experiments/${experimentId}/${op}`, { body: {} }),
    onSuccess: (res, op) => (onDone(res), toast.success(op === 'start' ? 'Running — visitors are being assigned at the edge' : 'Paused — everyone sees the original')),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const recommend = useMutation({
    mutationFn: () => api<ExperimentDetail>(`/experiments/${experimentId}/recommend`, { body: {} }),
    onSuccess: onDone,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const complete = useMutation({
    mutationFn: (winnerVariantId: string | undefined) => api<ExperimentDetail>(`/experiments/${experimentId}/complete`, { body: { winnerVariantId, applyToDraft } }),
    onSuccess: (res) => (onDone(res), toast.success(res.winnerVariantId && applyToDraft && res.winnerVariantId !== 'control' ? 'Completed — the winner is in the page draft; publish it from the editor' : 'Completed')),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (q.isPending) return <Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (q.isError || !e) return <Alert tone="error">{errorMessage(q.error)}</Alert>;
  const canManage = ability.can('update', 'AbTest');
  const r = e.results;
  const rec = e.aiRecommendation;
  const leader = r.variants.find((v) => v.id === r.leaderId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/sites/${siteId}/experiments`} className="flex items-center gap-1 text-xs text-muted-foreground hover:underline">
            <ArrowLeft className="h-3 w-3" /> Experiments
          </Link>
          <h2 className="mt-1 text-xl font-semibold">{e.name}</h2>
          <p className="text-sm text-muted-foreground">
            <Link href={`/sites/${siteId}/pages/${e.pageId}`} className="hover:underline">
              {e.page.title} · {e.page.fullPath}
            </Link>{' '}
            · goal <code>{e.goalMetric}</code> · {Math.round(e.trafficAllocation * 100)}% of traffic{e.startedAt && ` · started ${relativeTime(e.startedAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{e.status.toLowerCase()}</Badge>
          <Badge className={VERDICT[r.verdict].className}>{VERDICT[r.verdict].label}</Badge>
          {canManage && (e.status === 'DRAFT' || e.status === 'PAUSED') && (
            <Button size="sm" loading={action.isPending} onClick={() => action.mutate('start')}>
              <Play className="h-4 w-4" /> {e.status === 'DRAFT' ? 'Start' : 'Resume'}
            </Button>
          )}
          {canManage && e.status === 'RUNNING' && (
            <Button size="sm" variant="outline" loading={action.isPending} onClick={() => action.mutate('pause')}>
              <Pause className="h-4 w-4" /> Pause
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Results</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>Sample: {Math.round(r.progress * 100)}% of the planned {r.requiredPerVariant.toLocaleString()} visitors per variant</span>
              {leader && !leader.isControl && leader.conversions > 0 && <span>Leader: {leader.name}</span>}
            </div>
            <Progress value={r.progress * 100} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">Variant</th>
                  <th className="py-2 text-right font-medium">Visitors</th>
                  <th className="py-2 text-right font-medium">Conversions</th>
                  <th className="py-2 text-right font-medium">Rate (95% CI)</th>
                  <th className="py-2 text-right font-medium">Uplift</th>
                  <th className="py-2 text-right font-medium">Chance to beat original</th>
                  <th className="py-2 text-right font-medium">p-value</th>
                </tr>
              </thead>
              <tbody>
                {r.variants.map((v) => (
                  <tr key={v.id} className={cn('border-t', v.id === e.winnerVariantId && 'bg-success/5')}>
                    <td className="py-2 font-medium">
                      {v.name} {v.isControl && <span className="text-xs font-normal text-muted-foreground">(control)</span>} {v.id === e.winnerVariantId && <Trophy className="inline h-3.5 w-3.5 text-success" aria-label="winner" />}
                    </td>
                    <td className="py-2 text-right tabular-nums">{v.exposures.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{v.conversions.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">
                      {pct(v.rate)} <span className="text-xs text-muted-foreground">({pct(v.ci95[0])}–{pct(v.ci95[1])})</span>
                    </td>
                    <td className={cn('py-2 text-right tabular-nums', v.uplift !== null && (v.uplift > 0 ? 'text-success' : v.uplift < 0 ? 'text-destructive' : ''))}>{v.isControl ? '—' : signedPct(v.uplift)}</td>
                    <td className="py-2 text-right tabular-nums">{v.probBeatControl === null ? '—' : pct(v.probBeatControl, 0)}</td>
                    <td className="py-2 text-right tabular-nums">{v.pValue === null ? '—' : v.pValue < 0.001 ? '<0.001' : v.pValue.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">Two-sided z-test at α = 0.05 with a 10% minimum detectable effect. Peeking is safe: the verdict stays “collecting” until the planned sample is reached.</p>
        </CardContent>
      </Card>

      {e.status !== 'DRAFT' && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Recommendation
            </CardTitle>
            {ability.can('invoke', 'Ai') && e.status !== 'COMPLETED' && (
              <Button size="sm" variant="outline" loading={recommend.isPending} onClick={() => recommend.mutate()}>
                {rec ? 'Refresh' : 'Ask AI'}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!rec && <p className="text-muted-foreground">AI reads the statistics above (never raw visitor data) and proposes what to do next; a statistical guard overrides it if it calls a winner too early.</p>}
            {rec && (
              <>
                <p className="font-medium">
                  {DECISION[rec.decision]}
                  {rec.winnerVariantId && ` — ${r.variants.find((v) => v.id === rec.winnerVariantId)?.name ?? rec.winnerVariantId}`}
                </p>
                <p>{rec.reasoning}</p>
                {rec.overridden && <Alert>{rec.overridden}</Alert>}
                {rec.nextSteps.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {rec.nextSteps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {rec.generatedBy === 'ai' ? 'AI' : 'Rules'} · {relativeTime(rec.at)}
                </p>
              </>
            )}
            {canManage && e.status !== 'COMPLETED' && (
              <div className="flex flex-wrap items-center gap-3 border-t pt-3">
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={applyToDraft} onChange={(ev) => setApplyToDraft(ev.target.checked)} /> Write the winner into the page draft
                </label>
                {r.variants
                  .filter((v) => !v.isControl)
                  .map((v) => (
                    <Button key={v.id} size="sm" variant={v.id === (rec?.winnerVariantId ?? r.leaderId) ? 'default' : 'outline'} loading={complete.isPending && complete.variables === v.id} onClick={() => window.confirm(`Complete the test with “${v.name}” as the winner?`) && complete.mutate(v.id)}>
                      <Trophy className="h-4 w-4" /> {v.name} wins
                    </Button>
                  ))}
                <Button size="sm" variant="ghost" loading={complete.isPending && complete.variables === undefined} onClick={() => window.confirm('Stop the test and keep the original?') && complete.mutate(undefined)}>
                  Keep the original
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What each variant changes</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {e.variants
            .filter((v) => v.id !== 'control')
            .map((v) => (
              <div key={v.id} className="space-y-2">
                <p className="text-sm font-medium">{v.name}</p>
                <PatchEditor blocks={blocks} patch={v.patch} onChange={() => undefined} disabled />
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
