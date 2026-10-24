'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, ExternalLink, Loader2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useBilling, type BillingOverview, type Plan, type PlanLimits } from '@/lib/platform';
import { useTenantId } from '@/lib/queries';
import { cn, formatNumber, formatUsd } from '@/lib/utils';

const PLAN_PITCH: Record<Plan, string> = {
  FREE: 'Try Canon on one site.',
  PRO: 'For a growing marketing team.',
  BUSINESS: 'Several sites, agents and private plugins.',
  ENTERPRISE: 'SSO, audit, unlimited usage, contract.',
};
const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'border-success/40 text-success',
  TRIALING: 'border-primary/40 text-primary',
  PAST_DUE: 'border-warning/40 text-warning',
  UNPAID: 'border-destructive/40 text-destructive',
  CANCELED: 'border-muted-foreground/30 text-muted-foreground',
  INCOMPLETE: 'border-warning/40 text-warning',
};

export default function BillingPage() {
  return (
    <Suspense>
      <Billing />
    </Suspense>
  );
}

function Billing() {
  const billing = useBilling();
  const ability = useAbility();
  const params = useSearchParams();
  const qc = useQueryClient();
  const tid = useTenantId();
  const canManage = ability.can('manage', 'Billing');

  useEffect(() => {
    if (params.get('checkout') === 'success') {
      toast.success('Payment received — your plan updates as soon as Stripe confirms it');
      // Stripe's webhook usually lands within seconds of the redirect.
      const t = setTimeout(() => void qc.invalidateQueries({ queryKey: ['billing', tid] }), 3_000);
      return () => clearTimeout(t);
    }
  }, [params, qc, tid]);

  const go = useMutation({
    mutationFn: (body: { plan?: Plan; portal?: boolean }) => (body.portal ? api<{ url: string }>('/billing/portal', { body: {} }) : api<{ url: string }>('/billing/checkout', { body: { plan: body.plan } })),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (billing.isPending) return <Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (billing.isError || !billing.data) return <Alert tone="error">{errorMessage(billing.error)}</Alert>;
  const b = billing.data;
  const sub = b.subscription;

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan, what you use this month, and payments."
        actions={
          canManage && sub && b.billingEnabled ? (
            <Button variant="outline" loading={go.isPending && go.variables?.portal} onClick={() => go.mutate({ portal: true })}>
              <CreditCard className="h-4 w-4" /> Manage payment & invoices <ExternalLink className="h-3 w-3" />
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-6">
        {sub?.status === 'PAST_DUE' && <Alert tone="error">The last payment failed. Paid features stay on while Stripe retries — update the card in “Manage payment” to avoid a downgrade.</Alert>}
        {sub?.cancelAtPeriodEnd && sub.currentPeriodEnd && <Alert>Your subscription ends on {new Date(sub.currentPeriodEnd).toLocaleDateString()}; the workspace then moves to Free.</Alert>}
        {!b.billingEnabled && <Alert>Online payments are not configured on this installation. Ask your administrator to change the plan.</Alert>}

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Usage this month</CardTitle>
              <CardDescription>
                Current plan: <span className="font-medium text-foreground">{b.plan}</span>
                {sub && (
                  <>
                    {' '}
                    · <Badge className={STATUS_TONE[sub.status]}>{sub.status.toLowerCase().replace('_', ' ')}</Badge>
                    {sub.currentPeriodEnd && !sub.cancelAtPeriodEnd && ` · renews ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`}
                  </>
                )}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Meter label="Sites" used={b.usage.sites} limit={b.limits.sites} />
            <Meter label="Pages" used={b.usage.pages} limit={b.limits.pages} />
            <Meter label="Entries" used={b.usage.entries} limit={b.limits.entries} />
            <Meter label="Members" used={b.usage.members} limit={b.limits.members} />
            <Meter label="Storage" used={b.usage.storageMb} limit={b.limits.storageMb} unit="MB" />
            <Meter label="AI spend" used={b.usage.aiCostUsd} limit={b.limits.aiBudgetUsd} money hint={b.limits.aiHardLimit ? 'AI stops at the budget' : 'Overage is billed per use'} />
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {b.plans.map((p) => (
            <PlanCard key={p.plan} p={p} current={b.plan} subscribed={Boolean(sub && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(sub.status))} canManage={canManage} loading={go.isPending && go.variables?.plan === p.plan} onChoose={() => go.mutate({ plan: p.plan })} onPortal={() => go.mutate({ portal: true })} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Prices in USD, billed monthly by Stripe. Plan changes, cancellation and invoices are handled in the Stripe portal; your plan here always reflects what Stripe confirmed.</p>
      </div>
    </>
  );
}

function Meter({ label, used, limit, unit, money, hint }: { label: string; used: number; limit: number | null; unit?: string; money?: boolean; hint?: string }) {
  const fmt = (n: number) => (money ? formatUsd(n) : `${formatNumber(n)}${unit ? ` ${unit}` : ''}`);
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {fmt(used)} / {limit === null ? '∞' : fmt(limit)}
        </span>
      </div>
      {limit !== null && <Progress value={pct} tone={pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'default'} />}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const FEATURES = (l: PlanLimits, plan: Plan) =>
  [
    `${l.sites ?? 'Unlimited'} site${l.sites === 1 ? '' : 's'}`,
    `${l.pages === null ? 'Unlimited' : formatNumber(l.pages)} pages`,
    `${l.members ?? 'Unlimited'} members`,
    l.aiBudgetUsd === null ? 'Unlimited AI (contract)' : `${formatUsd(l.aiBudgetUsd)} AI included`,
    l.maxAgents ? `${l.maxAgents} AI agents` : null,
    plan === 'BUSINESS' || plan === 'ENTERPRISE' ? 'Private plugins' : null,
    plan === 'ENTERPRISE' ? 'SAML single sign-on' : null,
  ].filter(Boolean) as string[];

function PlanCard({ p, current, subscribed, canManage, loading, onChoose, onPortal }: { p: BillingOverview['plans'][number]; current: Plan; subscribed: boolean; canManage: boolean; loading: boolean; onChoose: () => void; onPortal: () => void }) {
  const isCurrent = p.plan === current;
  return (
    <Card className={cn(isCurrent && 'border-primary ring-1 ring-primary')}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          {p.plan.charAt(0) + p.plan.slice(1).toLowerCase()} {isCurrent && <Badge className="border-primary/40 text-primary">current</Badge>}
        </CardTitle>
        <CardDescription>{PLAN_PITCH[p.plan]}</CardDescription>
        <p className="pt-2 text-2xl font-semibold">{p.priceUsd === null ? 'Custom' : p.priceUsd === 0 ? 'Free' : `$${p.priceUsd}`}{p.priceUsd ? <span className="text-sm font-normal text-muted-foreground">/month</span> : null}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1.5 text-sm">
          {FEATURES(p.limits, p.plan).map((f) => (
            <li key={f} className="flex gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> {f}
            </li>
          ))}
        </ul>
        {!isCurrent && canManage && p.purchasable && !subscribed && (
          <Button className="w-full" loading={loading} onClick={onChoose}>
            Upgrade to {p.plan.charAt(0) + p.plan.slice(1).toLowerCase()}
          </Button>
        )}
        {!isCurrent && canManage && p.purchasable && subscribed && (
          <Button className="w-full" variant="outline" onClick={onPortal}>
            Switch in the billing portal
          </Button>
        )}
        {!isCurrent && p.plan === 'ENTERPRISE' && (
          <a href="mailto:sales@canon.example?subject=Canon%20Enterprise" className="block text-center text-sm font-medium text-primary hover:underline">
            Talk to sales
          </a>
        )}
      </CardContent>
    </Card>
  );
}
