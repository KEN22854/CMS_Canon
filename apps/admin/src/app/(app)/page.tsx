'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@/components/ui';
import { useAuth } from '@/lib/auth-store';
import { useAiUsage, useQuota } from '@/lib/queries';
import { formatNumber, formatUsd } from '@/lib/utils';

function Meter({ label, used, limit, format = formatNumber }: { label: string; used: number; limit: number | null; format?: (v: number | null) => string }) {
  const pct = limit ? (used / limit) * 100 : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {format(used)} / {format(limit)}
        </span>
      </div>
      {limit !== null && <Progress value={pct} tone={pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'default'} />}
    </div>
  );
}

export default function DashboardPage() {
  const user = useAuth((s) => s.user);
  const tenant = useAuth((s) => s.tenant);
  const quota = useQuota();
  const ai = useAiUsage();

  if (!tenant) {
    return (
      <>
        <PageHeader title={`Welcome, ${user?.name ?? ''}`} />
        <Alert>
          You are not in a workspace yet.{' '}
          <Link className="font-medium underline" href="/workspaces/new">
            Create one
          </Link>
          .
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title={tenant.name} description={`${tenant.plan} plan · you are ${tenant.role.toLowerCase()}`} />
      {ai.data?.month.forecastOverBudget && (
        <Alert tone="warning" className="mb-4">
          At the current pace this workspace will spend {formatUsd(ai.data.month.forecastUsd)} on AI this month — above its {formatUsd(ai.data.month.budgetUsd ?? 0)} budget.
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Plan usage</CardTitle>
            <CardDescription>Limits of the {tenant.plan} plan</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {quota.data ? (
              <>
                <Meter label="Members (incl. pending invites)" used={quota.data.usage.members + quota.data.usage.pendingInvites} limit={quota.data.limits.members} />
                <Meter label="Sites" used={quota.data.usage.sites} limit={quota.data.limits.sites} />
                <Meter label="Pages" used={quota.data.usage.pages} limit={quota.data.limits.pages} />
                <Meter label="Storage (MB)" used={quota.data.usage.storageMb} limit={quota.data.limits.storageMb} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{quota.isError ? 'Could not load usage.' : 'Loading…'}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>AI this month</CardTitle>
            <CardDescription>
              <Link href="/settings/ai-usage" className="text-primary hover:underline">
                Details
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {ai.data ? (
              <>
                <Meter label="Spend" used={ai.data.month.spentUsd} limit={ai.data.month.budgetUsd} format={(v) => (v === null ? 'No cap' : formatUsd(v))} />
                <Meter label="Tokens" used={ai.data.month.tokens} limit={ai.data.limits.tokensPerMonth} />
                <dl className="grid grid-cols-3 gap-2 pt-2 text-center">
                  <Stat label="Requests" value={formatNumber(ai.data.totals.requests)} />
                  <Stat label="Cache hits" value={`${Math.round(ai.data.totals.cacheHitRate * 100)}%`} />
                  <Stat label="Forecast" value={formatUsd(ai.data.month.forecastUsd)} />
                </dl>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{ai.isError ? 'AI usage is not available for your role.' : 'Loading…'}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
