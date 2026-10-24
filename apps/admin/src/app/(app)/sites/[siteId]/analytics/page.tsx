'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, CircleAlert, CircleCheck, Info, Lightbulb, Radio, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { pct, type Dimension, type Insights, type Report, type Totals } from '@/lib/experiences';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd } from '@/lib/utils';

const RANGES = [7, 30, 90] as const;
const DIMS: [Dimension, string][] = [
  ['referrer', 'Sources'],
  ['utm_source', 'Campaigns'],
  ['country', 'Countries'],
  ['device', 'Devices'],
  ['browser', 'Browsers'],
  ['os', 'Systems'],
];

const day = (d: Date) => d.toISOString().slice(0, 10);
function range(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: day(from), to: day(to) };
}

export default function SiteAnalytics() {
  const { siteId } = useParams<{ siteId: string }>();
  const tid = useTenantId();
  const ability = useAbility();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const { from, to } = useMemo(() => range(days), [days]);
  const report = useQuery({ queryKey: ['analytics', tid, siteId, from, to], queryFn: () => api<Report>(`/sites/${siteId}/analytics?from=${from}&to=${to}`), enabled: Boolean(tid), refetchInterval: 60_000 });
  const realtime = useQuery({ queryKey: ['analytics-rt', tid, siteId], queryFn: () => api<{ visitors: number; pages: { path: string; visitors: number }[] }>(`/sites/${siteId}/analytics/realtime`), enabled: Boolean(tid), refetchInterval: 15_000 });
  const insights = useMutation({
    mutationFn: (ai: boolean) => api<Insights>(`/sites/${siteId}/analytics/insights`, { body: { from, to, ai } }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (report.isError) return <Alert tone="error">{errorMessage(report.error)}</Alert>;
  const r = report.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center rounded-md border p-0.5" role="radiogroup" aria-label="Date range">
          {RANGES.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} onClick={() => setDays(d)} className={cn('rounded px-3 py-1 text-sm', days === d ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
              {d} days
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm" aria-live="polite">
          <Radio className={cn('h-4 w-4', realtime.data?.visitors ? 'text-success' : 'text-muted-foreground')} aria-hidden />
          <span className="font-medium">{realtime.data?.visitors ?? 0}</span> <span className="text-muted-foreground">visitors right now</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Views" t={r} k="views" format={(n) => n.toLocaleString()} />
        <Kpi label="Visitors" t={r} k="visitors" format={(n) => n.toLocaleString()} />
        <Kpi label="Sessions" t={r} k="sessions" format={(n) => n.toLocaleString()} />
        <Kpi label="Bounce rate" t={r} k="bounceRate" format={(n) => pct(n, 0)} lowerIsBetter />
        <Kpi label="Engaged time / view" t={r} k="avgEngagedSec" format={(n) => `${Math.round(n)}s`} />
        <Kpi label="Conversions" t={r} k="conversions" format={(n) => n.toLocaleString()} sub={r ? `${r.totals.conversionRate.toFixed(2)} per visitor` : undefined} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily views</CardTitle>
        </CardHeader>
        <CardContent>{r ? <ViewsChart series={r.series} /> : <div className="h-48 animate-pulse rounded bg-muted" />}</CardContent>
      </Card>

      <InsightsCard insights={insights.data} loading={insights.isPending} canAi={ability.can('invoke', 'Ai')} onRun={(ai) => insights.mutate(ai)} siteId={siteId} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Top pages</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">Page</th>
                  <th className="py-2 text-right font-medium">Views</th>
                  <th className="py-2 text-right font-medium">Visitors</th>
                  <th className="py-2 text-right font-medium">Bounce</th>
                  <th className="py-2 text-right font-medium">Engaged</th>
                  <th className="py-2 text-right font-medium">Conv.</th>
                </tr>
              </thead>
              <tbody>
                {r?.pages.map((p) => (
                  <tr key={p.path} className="border-t">
                    <td className="max-w-[16rem] py-2">
                      <p className="truncate font-medium">{p.title ?? p.path}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.path}</p>
                    </td>
                    <td className="py-2 text-right tabular-nums">{p.views.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{p.visitors.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{pct(p.bounceRate, 0)}</td>
                    <td className="py-2 text-right tabular-nums">{Math.round(p.avgEngagedSec)}s</td>
                    <td className="py-2 text-right tabular-nums">{p.conversions}</td>
                  </tr>
                ))}
                {r && r.pages.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      No visits in this period yet. Views appear within a minute of a visit.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Right now</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {realtime.data?.pages.map((p) => (
                <li key={p.path} className="flex justify-between gap-2">
                  <span className="truncate">{p.path}</span>
                  <span className="tabular-nums text-muted-foreground">{p.visitors}</span>
                </li>
              ))}
              {realtime.data && realtime.data.pages.length === 0 && <li className="text-muted-foreground">Nobody in the last 5 minutes.</li>}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {DIMS.map(([dim, label]) => (
          <DimCard key={dim} label={label} rows={r?.dims[dim] ?? []} />
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, t, k, format, lowerIsBetter, sub }: { label: string; t: Report | undefined; k: keyof Totals; format: (n: number) => string; lowerIsBetter?: boolean; sub?: string }) {
  const change = t?.change[k] ?? null;
  const good = change !== null && (lowerIsBetter ? change < 0 : change > 0);
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{t ? format(t.totals[k]) : '—'}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          {change !== null && change !== 0 && (
            <span className={cn('flex items-center font-medium', good ? 'text-success' : 'text-destructive')}>
              {change > 0 ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ArrowDownRight className="h-3 w-3" aria-hidden />}
              {Math.abs(Math.round(change * 100))}%
            </span>
          )}
          {change === null ? (sub ?? 'no previous data') : (sub ?? 'vs previous period')}
        </p>
      </CardContent>
    </Card>
  );
}

/** One series (views per day): single hue, rounded bar tops on a zero baseline, hover for values. */
function ViewsChart({ series }: { series: Report['series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s.views));
  const H = 180;
  const ticks = [...new Set([0, 0.5, 1].map((f) => Math.round(max * f)))];
  const h = hover !== null ? series[hover] : null;
  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="flex h-[180px] flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground" aria-hidden>
          {[...ticks].reverse().map((t) => (
            <span key={t}>{t.toLocaleString()}</span>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
            {ticks.map((t) => (
              <div key={t} className="border-t border-border/60" />
            ))}
          </div>
          <div className="relative flex h-[180px] items-end gap-[2px]" role="img" aria-label={`Daily views, ${series[0]?.day} to ${series.at(-1)?.day}`} onMouseLeave={() => setHover(null)}>
            {series.map((s, i) => (
              <div key={s.day} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
                <div className={cn('w-full rounded-t bg-primary transition-opacity', hover !== null && hover !== i && 'opacity-50')} style={{ height: s.views ? Math.max(2, (s.views / max) * H) : 0 }} />
              </div>
            ))}
          </div>
          {h && (
            <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-card px-2 py-1 text-xs shadow" style={{ left: `${((hover! + 0.5) / series.length) * 100}%` }}>
              <p className="font-medium">{new Date(`${h.day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</p>
              <p className="tabular-nums">
                {h.views.toLocaleString()} views · {h.visitors.toLocaleString()} visitors · {h.conversions} conv.
              </p>
            </div>
          )}
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground" aria-hidden>
            <span>{series[0]?.day}</span>
            <span>{series.at(-1)?.day}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DimCard({ label, rows }: { label: string; rows: { value: string; views: number; conversions: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm">
          {rows.slice(0, 8).map((r) => (
            <li key={r.value} className="relative flex justify-between gap-2 rounded px-2 py-1">
              <span className="absolute inset-y-0 left-0 rounded bg-primary/10" style={{ width: `${(r.views / max) * 100}%` }} aria-hidden />
              <span className="relative truncate">{r.value}</span>
              <span className="relative tabular-nums text-muted-foreground">
                {r.views.toLocaleString()}
                {r.conversions > 0 && <span className="ml-2 text-success">{r.conversions} conv.</span>}
              </span>
            </li>
          ))}
          {rows.length === 0 && <li className="text-muted-foreground">No data yet.</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

const SEVERITY = {
  positive: [CircleCheck, 'text-success'],
  warning: [CircleAlert, 'text-warning'],
  info: [Info, 'text-muted-foreground'],
} as const;

const ACTION_LINK: Record<string, string> = { ab_test: 'experiments', personalize: 'audiences' };

function InsightsCard({ insights, loading, canAi, onRun, siteId }: { insights: Insights | undefined; loading: boolean; canAi: boolean; onRun: (ai: boolean) => void; siteId: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4 text-primary" aria-hidden /> Insights
        </CardTitle>
        <div className="flex gap-2">
          {canAi && (
            <Button size="sm" loading={loading} onClick={() => onRun(true)}>
              <Sparkles className="h-4 w-4" /> Explain with AI
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={loading} onClick={() => onRun(false)}>
            <RefreshCw className="h-4 w-4" /> Quick scan
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!insights && <p className="text-sm text-muted-foreground">Canon computes the signals (changes, anomalies, weak pages, new sources) and AI turns them into plain-language findings with next steps. Numbers never come from the model.</p>}
        {insights && (
          <div className="space-y-4">
            <p className="text-sm">{insights.summary}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <ul className="space-y-2">
                {insights.insights.map((i) => {
                  const [Icon, cls] = SEVERITY[i.severity];
                  return (
                    <li key={i.title} className="flex gap-2 text-sm">
                      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', cls)} aria-label={i.severity} />
                      <div>
                        <p className="font-medium">{i.title}</p>
                        <p className="text-muted-foreground">{i.detail}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <ul className="space-y-2">
                {insights.recommendations.map((rec) => (
                  <li key={rec.title} className="rounded-md border p-3 text-sm">
                    <p className="font-medium">{rec.title}</p>
                    <p className="text-muted-foreground">{rec.detail}</p>
                    {ACTION_LINK[rec.action] && (
                      <Link href={`/sites/${siteId}/${ACTION_LINK[rec.action]}`} className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
                        {rec.action === 'ab_test' ? 'Set up an A/B test →' : 'Personalize for an audience →'}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-[11px] text-muted-foreground">
              <Badge>{insights.generatedBy === 'ai' ? 'AI' : 'rules'}</Badge> {insights.ai && `${insights.ai.model} · ${formatUsd(insights.ai.costUsd)}`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
