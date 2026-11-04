import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, invited, signUp, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off' });
});

afterAll(async () => {
  await t.close();
});

describe('funnels', () => {
  it('count visitors through ordered steps within a window, with prefixes and events', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Funnel shop', defaultLocale: 'en' }).expect(201)).body as { id: string };
    const day = (d: number, min = 0) => new Date(Date.UTC(2026, 9, d, 10, min));
    let n = 0;
    const ev = (visitorId: string, sessionId: string, event: string, at: Date, path = '/', siteId = site.id) => ({ id: `ev${n++}${Date.now()}`, tenantId: owner.tenantId, siteId, event, visitorId, sessionId, metadata: { path }, createdAt: at });
    await t.system.analyticsEvent.createMany({
      data: [
        // v1 does everything, in order, in one visit.
        ev('v1', 's1', 'pageview', day(1, 0), '/products/rye'), ev('v1', 's1', 'add_to_cart', day(1, 1)), ev('v1', 's1', 'pageview', day(1, 2), '/cart'), ev('v1', 's1', 'purchase', day(1, 3)),
        // v2 looks at a product and the cart, never adds anything.
        ev('v2', 's2', 'pageview', day(2), '/products/jam'), ev('v2', 's2', 'pageview', day(2, 5), '/cart'),
        // v3 adds after seeing the cart: the cart step must come after the add.
        ev('v3', 's3', 'pageview', day(3), '/products/rye'), ev('v3', 's3', 'pageview', day(3, 1), '/cart'), ev('v3', 's3', 'add_to_cart', day(3, 2)),
        // v4 adds without viewing a product first (not in the funnel).
        ev('v4', 's4', 'add_to_cart', day(4)),
        // v5 comes back 10 days later in another visit.
        ev('v5', 's5', 'pageview', day(5), '/products/cake'), ev('v5', 's6', 'add_to_cart', day(15)),
        // Noise: another path, another site, outside the range.
        ev('v6', 's7', 'pageview', day(6), '/productsx'),
        ev('v1', 's1', 'pageview', new Date(Date.UTC(2026, 8, 1)), '/products/old'),
      ],
    });

    const steps = [{ kind: 'page', path: '/products/*', label: 'Product' }, { kind: 'event', name: 'add_to_cart' }, { kind: 'page', path: '/cart' }, { kind: 'event', name: 'purchase', label: 'Bought' }];
    await t.http.post(`/v1/sites/${site.id}/analytics/funnels`).set(h).send({ name: 'Bad', steps: steps.slice(0, 1) }).expect(400);
    await t.http.post(`/v1/sites/${site.id}/analytics/funnels`).set(h).send({ name: 'Bad', steps: [{ kind: 'page', path: 'no-slash' }, steps[1]] }).expect(400);
    await t.http.post(`/v1/sites/${site.id}/analytics/funnels`).set(h).send({ name: 'Purchase (7 days)', steps, window: 7 }).expect(201);
    await t.http.post(`/v1/sites/${site.id}/analytics/funnels`).set(h).send({ name: 'Purchase (30 days)', steps: steps.slice(0, 2), window: 30 }).expect(201);
    await t.http.post(`/v1/sites/${site.id}/analytics/funnels`).set(h).send({ name: 'One visit', steps: steps.slice(0, 2), window: 'session' }).expect(201);

    const list = (await t.http.get(`/v1/sites/${site.id}/analytics/funnels`).query({ from: '2026-10-01', to: '2026-10-31' }).set(h).expect(200)).body as { name: string; result: { steps: { label: string; visitors: number; fromPrevious: number }[]; conversion: number } }[];
    const [week, month, visit] = list;
    expect(week!.result.steps.map((s) => [s.label, s.visitors])).toEqual([['Product', 4], ['add_to_cart', 2], ['/cart', 1], ['Bought', 1]]);
    expect(week!.result.conversion).toBe(0.25);
    expect(week!.result.steps[1]!.fromPrevious).toBe(0.5);
    expect(month!.result.steps.map((s) => s.visitors)).toEqual([4, 3]); // v5 counts within 30 days
    expect(visit!.result.steps.map((s) => s.visitors)).toEqual([4, 2]); // …but not in one visit

    // Viewers read, only site admins define funnels.
    const viewer = await invited(t, owner, 'VIEWER');
    await t.http.get(`/v1/sites/${site.id}/analytics/funnels`).set(bearer(viewer.accessToken)).expect(200);
    await t.http.post(`/v1/sites/${site.id}/analytics/funnels`).set(bearer(viewer.accessToken)).send({ name: 'x', steps }).expect(403);
  });
});
