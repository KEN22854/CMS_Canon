'use client';

import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@/components/ui';
import { useAiUsage, type Bucket } from '@/lib/queries';
import { formatNumber, formatUsd } from '@/lib/utils';

export default function AiUsagePage() {
  const { data, isError, isPending } = useAiUsage();
  if (isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !data) return <Alert tone="error">AI usage is not available for your role.</Alert>;

  const { month, limits, totals } = data;
  const pct = month.budgetUsedPct ?? 0;
  const maxDay = Math.max(...data.byDay.map((d) => d.requests), 1);

  return (
    <>
      <PageHeader title="AI usage" description={`This month · ${limits.plan} plan`} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Spend</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatUsd(month.spentUsd)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {month.budgetUsd !== null ? (
              <>
                <Progress value={pct} tone={pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'default'} />
                <p className="text-xs text-muted-foreground">
                  {pct}% of {formatUsd(month.budgetUsd)} budget · {limits.hardLimit ? 'hard stop' : 'alerts at 50/80/100%'}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No budget cap</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Month-end forecast</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatUsd(month.forecastUsd)}</CardTitle>
          </CardHeader>
          <CardContent>{month.forecastOverBudget ? <Badge className="border-warning/40 text-warning">over budget</Badge> : <p className="text-xs text-muted-foreground">Linear projection</p>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Requests</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatNumber(totals.requests)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Math.round(totals.cacheHitRate * 100)}% cache hits · {totals.degraded} degraded · {totals.blocked} blocked
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Requests per day</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byDay.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI requests yet this month.</p>
          ) : (
            <div className="flex h-32 items-end gap-1" role="img" aria-label="Requests per day">
              {data.byDay.map((d) => (
                <div key={d.key} className="flex-1 rounded-t bg-primary/70" style={{ height: `${(d.requests / maxDay) * 100}%` }} title={`${d.key}: ${d.requests} requests, ${formatUsd(d.costUsd)}`} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <BucketTable title="By feature" rows={data.byFeature} />
        <BucketTable title="By model" rows={data.byModel} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Plan limits</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Limit label="Tokens / month" value={formatNumber(limits.tokensPerMonth)} />
            <Limit label="Requests / min (workspace)" value={String(limits.requestsPerMin)} />
            <Limit label="Requests / min (per user)" value={String(limits.requestsPerUserPerMin)} />
            <Limit label="Parallel requests" value={String(limits.concurrentRequests)} />
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">Model tiers: {limits.modelTiers.join(', ')}</p>
        </CardContent>
      </Card>
    </>
  );
}

function BucketTable({ title, rows }: { title: string; rows: Bucket[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 text-right font-medium">Requests</th>
              <th className="pb-2 text-right font-medium">Tokens</th>
              <th className="pb-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="py-1.5">{r.key}</td>
                <td className="py-1.5 text-right">{formatNumber(r.requests)}</td>
                <td className="py-1.5 text-right">{formatNumber(r.tokens)}</td>
                <td className="py-1.5 text-right">{formatUsd(r.costUsd)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-muted-foreground">
                  No data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
