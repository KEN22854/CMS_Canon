import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../../src/modules/billing/billing.service';
import { signStripePayload } from '../../src/modules/billing/stripe.client';
import { PASSWORD, bearer, createTestApp, ip, signUp, startFakeStripe, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let stripe: Awaited<ReturnType<typeof startFakeStripe>>;
const SECRET = 'whsec_test_secret';

beforeAll(async () => {
  stripe = await startFakeStripe();
  t = await createTestApp({
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_API_BASE: stripe.url,
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_BUSINESS: 'price_business',
    BILLING_JOBS: 'off',
    KNOWLEDGE: 'off',
    CANON_EXTRACT: 'off',
    CANON_PROPAGATE: 'off',
    ENRICHMENT: 'off',
    ANALYTICS_FLUSH: 'off',
    ANALYTICS_JOBS: 'off',
  });
});

afterAll(async () => {
  await t.close();
  await stripe.close();
});

let seq = 0;
function event(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) {
  return { id: `evt_${Date.now()}_${seq++}`, type, created, data: { object } };
}
const send = (body: object, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return t.http.post('/v1/billing/webhook').set('stripe-signature', signStripePayload(raw, secret)).set('content-type', 'application/json').send(raw);
};
const sub = (id: string, customer: string, price: string, status: string, extra: Record<string, unknown> = {}) => ({ id, customer, status, cancel_at_period_end: false, items: { data: [{ price: { id: price }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400 }] }, ...extra });
const plan = async (o: SignedIn) => (await t.http.get('/v1/billing').set(bearer(o.accessToken)).expect(200)).body.plan as string;

describe('billing', () => {
  it('checkout → verified webhooks drive the plan; duplicates and stale events are ignored', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const overview = await t.http.get('/v1/billing').set(h).expect(200);
    expect(overview.body).toMatchObject({ plan: 'FREE', billingEnabled: true, subscription: null });
    expect(overview.body.plans.find((p: { plan: string }) => p.plan === 'PRO')).toMatchObject({ purchasable: true, priceUsd: 49 });

    const co = await t.http.post('/v1/billing/checkout').set(h).send({ plan: 'PRO' }).expect(200);
    expect(co.body.url).toBe(`https://checkout.stripe.test/${owner.tenantId}`);
    const tenant = await t.system.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } });
    expect(tenant.billingCustomerId).toMatch(/^cus_/);
    const customer = tenant.billingCustomerId!;
    // The success redirect alone changes nothing.
    expect(await plan(owner)).toBe('FREE');

    // Forged / unsigned webhooks are rejected.
    await send(event('customer.subscription.updated', sub('sub_x', customer, 'price_business', 'active')), 'whsec_wrong').expect(400);
    await t.http.post('/v1/billing/webhook').send({ id: 'evt_unsigned' }).expect(400);

    stripe.state.subscriptions.set('sub_1', sub('sub_1', customer, 'price_pro', 'active'));
    const completed = event('checkout.session.completed', { id: 'cs_test', client_reference_id: owner.tenantId, customer, subscription: 'sub_1' });
    expect((await send(completed).expect(200)).body.outcome).toBe('plan:FREE->PRO');
    expect(await plan(owner)).toBe('PRO');
    // Stripe retries: same event id → no second effect.
    expect((await send(completed).expect(200)).body.outcome).toMatch(/^duplicate:/);

    // Upgrade via the portal.
    const up = Math.floor(Date.now() / 1000) + 10;
    expect((await send(event('customer.subscription.updated', sub('sub_1', customer, 'price_business', 'active'), up)).expect(200)).body.outcome).toBe('plan:PRO->BUSINESS');
    // An older event delivered late cannot roll it back.
    expect((await send(event('customer.subscription.updated', sub('sub_1', customer, 'price_pro', 'active'), up - 5)).expect(200)).body.outcome).toBe('out_of_order');
    expect(await plan(owner)).toBe('BUSINESS');

    // Already subscribed → portal, not a second checkout.
    await t.http.post('/v1/billing/checkout').set(h).send({ plan: 'PRO' }).expect(409);
    expect((await t.http.post('/v1/billing/portal').set(h).expect(200)).body.url).toBe(`https://billing.stripe.test/${customer}`);

    // Dunning keeps features on; payment failure notifies owners.
    expect((await send(event('customer.subscription.updated', sub('sub_1', customer, 'price_business', 'past_due'), up + 10)).expect(200)).body.outcome).toBe('synced:PAST_DUE');
    expect((await send(event('invoice.payment_failed', { id: 'in_1', customer })).expect(200)).body.outcome).toBe('owners_notified');
    expect(t.mailer.lastTo(owner.email)?.template).toBe('billing.payment_failed');
    // Cancellation ends paid features.
    expect((await send(event('customer.subscription.deleted', sub('sub_1', customer, 'price_business', 'canceled'), up + 20)).expect(200)).body.outcome).toBe('plan:BUSINESS->FREE');
    const overview2 = await t.http.get('/v1/billing').set(h).expect(200);
    expect(overview2.body).toMatchObject({ plan: 'FREE', subscription: { status: 'CANCELED', plan: 'BUSINESS' } });

    const audit = await t.system.auditLog.findMany({ where: { tenantId: owner.tenantId, action: 'billing.plan_changed' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => (a.changes as { to: string }).to)).toEqual(['PRO', 'BUSINESS', 'FREE']);
  });

  it('keeps billing with owners, and plans are set by hand only by super admins', async () => {
    const owner = await signUp(t);
    // Enterprise is sold by contract, not checkout.
    await t.http.post('/v1/billing/checkout').set(bearer(owner.accessToken)).send({ plan: 'ENTERPRISE' }).expect(400);

    await t.http.patch(`/v1/platform/tenants/${owner.tenantId}/plan`).set(bearer(owner.accessToken)).send({ plan: 'ENTERPRISE' }).expect(403);
    const admin = await signUp(t);
    await t.system.user.update({ where: { id: admin.userId }, data: { role: 'SUPER_ADMIN' } });
    const login = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: admin.email, password: PASSWORD }).expect(200);
    await t.http.patch(`/v1/platform/tenants/${owner.tenantId}/plan`).set(bearer(login.body.accessToken)).send({ plan: 'ENTERPRISE' }).expect(204);
    expect(await plan(owner)).toBe('ENTERPRISE');
  });

  it('reports AI overage above the included budget to the Stripe meter, once per delta', async () => {
    const owner = await signUp(t);
    const customer = 'cus_overage_' + owner.tenantId.slice(-6);
    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { billingCustomerId: customer } });
    stripe.state.subscriptions.set('sub_ov', sub('sub_ov', customer, 'price_pro', 'active'));
    await send(event('checkout.session.completed', { id: 'cs_ov', client_reference_id: owner.tenantId, customer, subscription: 'sub_ov' })).expect(200);
    // PRO includes $100: spend $112.34.
    await t.system.aiGeneration.create({ data: { tenantId: owner.tenantId, feature: 'REWRITE', modelKey: 'ollama/test', promptText: 'x', status: 'SUCCEEDED', costUsd: 112.34, totalTokens: 1 } });
    const billing = t.app.get(BillingService);
    const before = stripe.state.calls.filter((c) => c.path === '/v1/billing/meter_events' && c.form['payload[stripe_customer_id]'] === customer).length;
    await billing.reportAiOverage();
    await billing.reportAiOverage();
    const meters = stripe.state.calls.filter((c) => c.path === '/v1/billing/meter_events' && c.form['payload[stripe_customer_id]'] === customer);
    expect(meters.length - before).toBe(1);
    expect(meters.at(-1)!.form).toMatchObject({ event_name: 'canon_ai_overage_cents', 'payload[value]': '1234' });
  });
});
