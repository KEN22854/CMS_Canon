import { Prisma, type SubscriptionStatus, type TenantPlan } from '@canon/db';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { RequestPrincipal } from '../../common/auth/principal';
import { ApiError, conflict, forbidden } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { TenantAiSettingsService } from '../intelligence/infrastructure/tenant-ai-settings';
import { PLAN_LIMITS } from '../tenancy/plans';
import { TenantsService } from '../tenancy/tenants.service';
import { StripeClient, type StripeEvent, type StripeSubscription } from './stripe.client';

export const PAID_PLANS = ['PRO', 'BUSINESS'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

/** Public list prices (USD/month) for the plan picker; the charged amount is Stripe's price. */
export const PLAN_PRICES: Record<TenantPlan, number | null> = { FREE: 0, PRO: 49, BUSINESS: 299, ENTERPRISE: null };

const STATUS: Record<StripeSubscription['status'], SubscriptionStatus> = {
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  unpaid: 'UNPAID',
  canceled: 'CANCELED',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'CANCELED',
  paused: 'UNPAID',
};
/** Paid features stay on while Stripe retries a failed payment (dunning), and stop after. */
const ENTITLED: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

const OVERAGE_QUEUE = 'billing-overage';
const OVERAGE_EVERY_MS = 60 * 60_000;

/**
 * Plans and payments. Stripe owns money and subscription state; Canon mirrors it from signed
 * webhooks into `subscriptions` and derives `tenants.plan` from it — never from what a browser
 * says after checkout. Webhooks are idempotent (billing_events) and ordered (lastEventAt), so
 * retries and out-of-order deliveries cannot flip a tenant back to an older plan.
 */
@Injectable()
export class BillingService implements OnApplicationBootstrap {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly stripe: StripeClient,
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly tenants: TenantsService,
    private readonly aiSettings: TenantAiSettingsService,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BillingService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.BILLING_JOBS === 'off' || !this.stripe.enabled) return;
    this.queues.worker(OVERAGE_QUEUE, () => this.reportAiOverage(), 1);
    await this.queues.queue(OVERAGE_QUEUE).upsertJobScheduler('billing-ai-overage', { every: OVERAGE_EVERY_MS }, { name: 'overage', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  private priceFor(plan: PaidPlan): string | undefined {
    return plan === 'PRO' ? this.config.STRIPE_PRICE_PRO : this.config.STRIPE_PRICE_BUSINESS;
  }

  private planForPrice(price: string): TenantPlan | null {
    if (price && price === this.config.STRIPE_PRICE_PRO) return 'PRO';
    if (price && price === this.config.STRIPE_PRICE_BUSINESS) return 'BUSINESS';
    return null;
  }

  async overview(tenantId: string) {
    const [quota, subscription] = await Promise.all([this.tenants.quotaUsage(tenantId), this.prisma.forTenant({ tenantId }).subscription.findUnique({ where: { tenantId } })]);
    return {
      ...quota,
      billingEnabled: this.stripe.enabled,
      subscription: subscription && { plan: subscription.plan, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd },
      plans: (Object.keys(PLAN_LIMITS) as TenantPlan[]).map((plan) => ({
        plan,
        priceUsd: PLAN_PRICES[plan],
        limits: PLAN_LIMITS[plan],
        purchasable: (PAID_PLANS as readonly string[]).includes(plan) && this.stripe.enabled && Boolean(this.priceFor(plan as PaidPlan)),
      })),
    };
  }

  /** Starts Stripe Checkout. Changing an existing subscription goes through the portal instead. */
  async checkout(actor: RequestPrincipal & { tenantId: string }, plan: PaidPlan): Promise<{ url: string }> {
    const price = this.priceFor(plan);
    if (!this.stripe.enabled || !price) throw new ApiError('BILLING_DISABLED', `The ${plan} plan cannot be purchased on this installation`, 503);
    const db = this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId });
    const sub = await db.subscription.findUnique({ where: { tenantId: actor.tenantId } });
    if (sub && ENTITLED.includes(sub.status)) throw conflict('This workspace already has a subscription — change it in the billing portal', { portal: true });
    const customer = await this.ensureCustomer(actor);
    const base = `${this.config.ADMIN_PUBLIC_URL}/settings/billing`;
    const session = await this.stripe.createCheckoutSession({ customer, price, tenantId: actor.tenantId, successUrl: `${base}?checkout=success`, cancelUrl: `${base}?checkout=cancel` });
    await this.audit.record({ tenantId: actor.tenantId, action: 'billing.checkout_started', entityType: 'Billing', entityId: actor.tenantId, changes: { plan } }, actor);
    return { url: session.url };
  }

  async portal(actor: RequestPrincipal & { tenantId: string }): Promise<{ url: string }> {
    const tenant = await this.tenants.get(actor.tenantId);
    if (!tenant.billingCustomerId) throw conflict('No billing account yet — choose a plan first');
    return this.stripe.createPortalSession({ customer: tenant.billingCustomerId, returnUrl: `${this.config.ADMIN_PUBLIC_URL}/settings/billing` });
  }

  private async ensureCustomer(actor: RequestPrincipal & { tenantId: string }): Promise<string> {
    const tenant = await this.tenants.get(actor.tenantId);
    if (tenant.billingCustomerId) return tenant.billingCustomerId;
    const user = actor.userId ? await this.system.user.findUnique({ where: { id: actor.userId }, select: { email: true } }) : null;
    const customer = await this.stripe.createCustomer({ email: user?.email ?? '', name: tenant.name, tenantId: tenant.id });
    await this.system.tenant.update({ where: { id: tenant.id }, data: { billingCustomerId: customer.id } });
    return customer.id;
  }

  /** Verified, idempotent webhook entry point. Returns what happened (for the response and the log). */
  async handleWebhook(raw: Buffer, signature: string | undefined): Promise<{ received: true; outcome: string }> {
    const event = this.stripe.verifyWebhook(raw, signature);
    const seen = await this.system.billingEvent.findUnique({ where: { id: event.id }, select: { outcome: true } });
    if (seen) return { received: true, outcome: `duplicate:${seen.outcome}` };
    let tenantId: string | null = null;
    let outcome: string;
    try {
      ({ tenantId, outcome } = await this.apply(event));
    } catch (err) {
      // Not recorded: Stripe retries, and the next attempt re-applies.
      this.logger.error({ err, event: event.id, type: event.type }, 'billing.webhook_failed');
      throw err;
    }
    await this.system.billingEvent.create({ data: { id: event.id, type: event.type, tenantId, outcome, payload: event as unknown as Prisma.InputJsonValue } }).catch((err: unknown) => {
      // A concurrent delivery of the same event won the insert; its effect is identical.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    });
    return { received: true, outcome };
  }

  private async apply(event: StripeEvent): Promise<{ tenantId: string | null; outcome: string }> {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const tenantId = typeof obj.client_reference_id === 'string' ? obj.client_reference_id : null;
        if (!tenantId || typeof obj.subscription !== 'string') return { tenantId, outcome: 'ignored' };
        if (typeof obj.customer === 'string') await this.system.tenant.updateMany({ where: { id: tenantId, billingCustomerId: null }, data: { billingCustomerId: obj.customer } });
        // Re-read from Stripe rather than trusting the session payload's snapshot.
        const sub = await this.stripe.retrieveSubscription(obj.subscription);
        return this.syncSubscription(sub, event.created, tenantId);
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = obj as unknown as StripeSubscription;
        if (event.type === 'customer.subscription.deleted') sub.status = 'canceled';
        return this.syncSubscription(sub, event.created);
      }
      case 'invoice.payment_failed': {
        const tenant = typeof obj.customer === 'string' ? await this.system.tenant.findUnique({ where: { billingCustomerId: obj.customer }, select: { id: true, name: true } }) : null;
        if (!tenant) return { tenantId: null, outcome: 'unknown_customer' };
        await this.notifyOwners(tenant.id, 'billing.payment_failed', 'Payment failed', `We couldn't charge the card for ${tenant.name}. Paid features stay on while Stripe retries — update the payment method in Billing to avoid a downgrade.`);
        await this.audit.record({ tenantId: tenant.id, action: 'billing.payment_failed', entityType: 'Billing', entityId: tenant.id, changes: { invoice: obj.id as string } }, undefined);
        return { tenantId: tenant.id, outcome: 'owners_notified' };
      }
      default:
        return { tenantId: null, outcome: 'ignored' };
    }
  }

  private async syncSubscription(sub: StripeSubscription, eventCreated: number, hintTenantId?: string): Promise<{ tenantId: string | null; outcome: string }> {
    const tenant =
      (await this.system.tenant.findUnique({ where: { billingCustomerId: sub.customer }, select: { id: true, plan: true } })) ??
      (hintTenantId || sub.metadata?.tenantId ? await this.system.tenant.findUnique({ where: { id: hintTenantId ?? sub.metadata!.tenantId }, select: { id: true, plan: true } }) : null);
    if (!tenant) return { tenantId: null, outcome: 'unknown_customer' };
    const price = sub.items.data[0]?.price.id ?? '';
    const plan = this.planForPrice(price);
    if (!plan) return { tenantId: tenant.id, outcome: `unknown_price:${price}` };
    const status = STATUS[sub.status];
    const at = new Date(eventCreated * 1000);
    const periodEnd = sub.items.data[0]?.current_period_end ?? sub.current_period_end;
    const data = { stripeSubscriptionId: sub.id, stripePriceId: price, plan, status, cancelAtPeriodEnd: sub.cancel_at_period_end, currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null, lastEventAt: at };

    const result = await this.system.$transaction(async (tx) => {
      const current = await tx.subscription.findUnique({ where: { tenantId: tenant.id } });
      // A subscription replaced by a newer one (re-subscribe after cancel) is history.
      if (current && current.stripeSubscriptionId !== sub.id && ENTITLED.includes(current.status) && !ENTITLED.includes(status)) return 'stale_subscription';
      if (current && current.stripeSubscriptionId === sub.id && current.lastEventAt > at) return 'out_of_order';
      await tx.subscription.upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, ...data }, update: data });
      const nextPlan: TenantPlan = ENTITLED.includes(status) ? plan : 'FREE';
      // Enterprise is contract-managed: Stripe self-serve events never change it.
      if (tenant.plan !== 'ENTERPRISE' && tenant.plan !== nextPlan) await tx.tenant.update({ where: { id: tenant.id }, data: { plan: nextPlan } });
      return tenant.plan === 'ENTERPRISE' || tenant.plan === nextPlan ? `synced:${status}` : `plan:${tenant.plan}->${nextPlan}`;
    });
    if (result.startsWith('plan:')) {
      this.aiSettings.invalidate(tenant.id);
      await this.audit.record({ tenantId: tenant.id, action: 'billing.plan_changed', entityType: 'Tenant', entityId: tenant.id, changes: { from: tenant.plan, to: result.split('->')[1]!, status, subscription: sub.id } }, undefined);
    }
    return { tenantId: tenant.id, outcome: result };
  }

  /** Support tool: super admins set a plan by hand (enterprise contracts, installs without Stripe). */
  async setPlan(actor: RequestPrincipal, tenantId: string, plan: TenantPlan): Promise<void> {
    if (actor.systemRole !== 'SUPER_ADMIN') throw forbidden('Only platform administrators can set plans manually');
    const tenant = await this.system.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
    if (!tenant) throw new ApiError('NOT_FOUND', 'Tenant not found', 404);
    await this.system.tenant.update({ where: { id: tenantId }, data: { plan } });
    this.aiSettings.invalidate(tenantId);
    await this.audit.record({ tenantId, action: 'billing.plan_set_manually', entityType: 'Tenant', entityId: tenantId, changes: { from: tenant.plan, to: plan } }, actor);
  }

  /**
   * Paid plans keep working past their included AI budget; the excess is reported to a Stripe
   * meter as cents. Each run reports only the delta since the last report, with an identifier
   * derived from the running total, so a retried job cannot double-bill.
   */
  async reportAiOverage(now = new Date()): Promise<{ reported: number }> {
    const month = now.toISOString().slice(0, 7);
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const subs = await this.system.subscription.findMany({ where: { status: { in: ENTITLED } }, include: { tenant: { select: { id: true, plan: true, quota: true, settings: true, billingCustomerId: true } } } });
    let reported = 0;
    for (const s of subs) {
      const t = s.tenant;
      const included = PLAN_LIMITS[t.plan].aiBudgetUsd;
      if (!t.billingCustomerId || included === null || PLAN_LIMITS[t.plan].aiHardLimit) continue;
      const agg = await this.system.aiGeneration.aggregate({ where: { tenantId: t.id, createdAt: { gte: monthStart } }, _sum: { costUsd: true } });
      const overCents = Math.max(0, Math.floor((Number(agg._sum.costUsd ?? 0) - included) * 100));
      const settings = (t.settings ?? {}) as { billing?: { overage?: Record<string, number> } };
      const already = settings.billing?.overage?.[month] ?? 0;
      if (overCents <= already) continue;
      await this.stripe.createMeterEvent({ eventName: this.config.STRIPE_AI_METER_EVENT, customer: t.billingCustomerId, value: overCents - already, identifier: `${t.id}-${month}-${overCents}` });
      const next = { ...settings, billing: { ...settings.billing, overage: { ...settings.billing?.overage, [month]: overCents } } };
      await this.system.tenant.update({ where: { id: t.id }, data: { settings: next as Prisma.InputJsonValue } });
      reported++;
    }
    return { reported };
  }

  private async notifyOwners(tenantId: string, type: string, title: string, message: string): Promise<void> {
    const owners = await this.system.tenantMember.findMany({ where: { tenantId, role: 'OWNER' }, select: { user: { select: { id: true, email: true } } } });
    for (const o of owners) {
      await this.system.notification.create({ data: { userId: o.user.id, tenantId, type, title, message } });
      await this.mailer.send({ to: o.user.email, subject: title, text: message, html: `<p>${message}</p>`, template: type }).catch((err: unknown) => this.logger.warn({ err }, 'billing.mail_failed'));
    }
  }
}
