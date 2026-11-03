'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@/components/ui';
import { useAuth } from '@/lib/auth-store';
import { useAiUsage, useQuota } from '@/lib/queries';
import { useT } from '@/lib/i18n';
import { formatNumber, formatUsd } from '@/lib/utils';

function Meter({
  label,
  used,
  limit,
  format = formatNumber,
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (v: number | null) => string;
}) {
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
  const t = useT();

  if (!tenant) {
    return (
      <>
        <PageHeader title={t('dash.welcome', { name: user?.name ?? '' })} />
        <Alert>
          {t('dash.noWorkspace')}{' '}
          <Link className="font-medium underline" href="/workspaces/new">
            {t('dash.createOne')}
          </Link>
          .
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={tenant.name}
        description={t('dash.planLine', { plan: tenant.plan, role: tenant.role.toLowerCase() })}
      />
      {ai.data?.month.forecastOverBudget && (
        <Alert tone="warning" className="mb-4">
          {t('dash.aiForecast', {
            forecast: formatUsd(ai.data.month.forecastUsd),
            budget: formatUsd(ai.data.month.budgetUsd ?? 0),
          })}
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('dash.planUsage')}</CardTitle>
            <CardDescription>{t('dash.planLimits', { plan: tenant.plan })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {quota.data ? (
              <>
                <Meter
                  label={t('dash.members')}
                  used={quota.data.usage.members + quota.data.usage.pendingInvites}
                  limit={quota.data.limits.members}
                />
                <Meter
                  label={t('dash.sites')}
                  used={quota.data.usage.sites}
                  limit={quota.data.limits.sites}
                />
                <Meter
                  label={t('dash.pages')}
                  used={quota.data.usage.pages}
                  limit={quota.data.limits.pages}
                />
                <Meter
                  label={t('dash.storage')}
                  used={quota.data.usage.storageMb}
                  limit={quota.data.limits.storageMb}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {quota.isError ? t('dash.usageError') : t('common.loading')}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('dash.aiMonth')}</CardTitle>
            <CardDescription>
              <Link href="/settings/ai-usage" className="text-primary hover:underline">
                {t('dash.details')}
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {ai.data ? (
              <>
                <Meter
                  label={t('dash.spend')}
                  used={ai.data.month.spentUsd}
                  limit={ai.data.month.budgetUsd}
                  format={(v) => (v === null ? t('dash.noCap') : formatUsd(v))}
                />
                <Meter
                  label={t('dash.tokens')}
                  used={ai.data.month.tokens}
                  limit={ai.data.limits.tokensPerMonth}
                />
                <dl className="grid grid-cols-3 gap-2 pt-2 text-center">
                  <Stat label={t('dash.requests')} value={formatNumber(ai.data.totals.requests)} />
                  <Stat
                    label={t('dash.cacheHits')}
                    value={`${Math.round(ai.data.totals.cacheHitRate * 100)}%`}
                  />
                  <Stat label={t('dash.forecast')} value={formatUsd(ai.data.month.forecastUsd)} />
                </dl>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {ai.isError ? t('dash.aiNotAvailable') : t('common.loading')}
              </p>
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
