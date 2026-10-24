import { encodeVariantKey } from '@canon/edge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectorService } from '../../src/modules/analytics/collector.service';
import { RollupService, dayString } from '../../src/modules/analytics/rollup.service';
import { bearer, createTestApp, drainOutbox, signUp, startFakeOllama, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;
const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url, ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off' });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

interface Ctx {
  owner: SignedIn;
  h: Record<string, string>;
  siteId: string;
  host: string;
  pageId: string;
}

const hero = (title: string) => ({ id: 'hero', type: 'hero', props: { title, ctaLabel: 'Start', ctaHref: '/signup' } });

async function setup(): Promise<Ctx> {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = await t.http.post('/v1/sites').set(h).send({ name: 'Grow', defaultLocale: 'en', locales: ['en'] }).expect(201);
  const page = await t.http.post(`/v1/sites/${site.body.id}/pages`).set(h).send({ title: 'Pricing', slug: 'pricing', content: { root: { id: 'root', type: 'section', props: {}, children: [hero('Simple pricing'), { id: 'cta', type: 'cta', props: { title: 'Ready?', buttonLabel: 'Go', buttonHref: '/signup' } }] } } }).expect(201);
  await t.http.post(`/v1/sites/${site.body.id}/pages/${page.body.id}/publish`).set(h).send({}).expect(200);
  return { owner, h, siteId: site.body.id, host: site.body.internalDomain, pageId: page.body.id };
}

const collect = (c: Ctx, body: object, ua = UA, host = c.host) => t.http.post('/v1/delivery/collect').set(DELIVERY).set('x-canon-ua', ua).set('x-canon-country', 'de').set('x-canon-host', host).send({ siteId: c.siteId, ...body });

describe('analytics pipeline', () => {
  it('collects privately, drops bots and foreign hosts, buffers, rolls up and reports', async () => {
    const c = await setup();
    const v = (n: number) => ({ visitorId: `visitor-${n}-${c.siteId.slice(0, 6)}`, sessionId: `session-${n}-${c.siteId.slice(0, 6)}` });
    expect((await collect(c, { ...v(1), referrer: 'https://www.google.com/search?q=x', events: [{ type: 'pageview', path: '/pricing' }, { type: 'event', name: 'signup', path: '/pricing' }, { type: 'engagement', path: '/pricing', durationMs: 30_000 }] }).expect(202)).body).toEqual({ accepted: 3 });
    await collect(c, { ...v(2), events: [{ type: 'pageview', path: '/pricing' }, { type: 'pageview', path: '/' }] }).expect(202);
    await collect(c, { ...v(3), events: [{ type: 'pageview', path: '/' }] }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130').expect(202);
    expect((await collect(c, { ...v(4), events: [{ type: 'pageview', path: '/' }] }, 'Googlebot/2.1').expect(202)).body).toEqual({ accepted: 0 });
    expect((await collect(c, { ...v(5), events: [{ type: 'pageview', path: '/' }] }, UA, 'evil.example').expect(202)).body).toEqual({ accepted: 0 });
    await t.http.post('/v1/delivery/collect').send({ siteId: c.siteId, ...v(6), events: [{ type: 'pageview', path: '/' }] }).expect(401);

    await t.app.get(CollectorService).flush();
    const rows = await t.system.analyticsEvent.findMany({ where: { siteId: c.siteId }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.userAgent === null)).toBe(true); // UA reduced to device/browser/os
    expect(rows[0]).toMatchObject({ device: 'mobile', browser: 'Safari', os: 'iOS', country: 'DE', metadata: expect.objectContaining({ referrerDomain: 'google.com' }) });
    expect(rows.find((r) => r.event === 'signup')?.metadata).toMatchObject({ conversion: true });

    const today = dayString(new Date());
    expect(await t.app.get(RollupService).rollupDay(c.siteId, today)).toMatchObject({ pages: 2 });
    const report = await t.http.get(`/v1/sites/${c.siteId}/analytics?from=${today}&to=${today}`).set(c.h).expect(200);
    expect(report.body.totals).toMatchObject({ views: 4, visitors: 4, sessions: 4, conversions: 1, avgEngagedSec: 7.5 });
    const pricing = report.body.pages.find((p: { path: string }) => p.path === '/pricing');
    expect(pricing).toMatchObject({ title: 'Pricing', views: 2, conversions: 1 });
    // Visitor 1 saw one page → bounce; visitor 2 entered on /pricing and moved on.
    expect(pricing.bounceRate).toBe(0.5);
    expect(report.body.dims.device).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'mobile', views: 3 }), expect.objectContaining({ value: 'desktop', views: 1 })]));
    expect(report.body.dims.referrer).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'google.com', views: 1, conversions: 1 })]));
    expect(report.body.series.at(-1)).toMatchObject({ day: today, views: 4 });

    const rt = await t.http.get(`/v1/sites/${c.siteId}/analytics/realtime`).set(c.h).expect(200);
    expect(rt.body.visitors).toBe(3);
    expect(rt.body.pages[0]).toMatchObject({ path: expect.any(String), visitors: 2 });

    const other = await signUp(t);
    await t.http.get(`/v1/sites/${c.siteId}/analytics`).set(bearer(other.accessToken)).expect(404);
  });

  it('writes insights from computed signals, and drops paths the data does not contain', async () => {
    const c = await setup();
    const rules = await t.http.post(`/v1/sites/${c.siteId}/analytics/insights`).set(c.h).send({ ai: false }).expect(200);
    expect(rules.body).toMatchObject({ generatedBy: 'rules', summary: 'No traffic recorded in this period yet.' });
    // Seed history: a traffic jump today vs. yesterday triggers signals, then the model narrates.
    for (let i = 0; i < 60; i++) await collect(c, { visitorId: `vv-${i}-${c.siteId.slice(0, 8)}`, sessionId: `ss-${i}-${c.siteId.slice(0, 8)}`, events: [{ type: 'pageview', path: '/pricing' }] }).expect(202);
    await t.app.get(CollectorService).flush();
    const today = dayString(new Date());
    const ai = await t.http.post(`/v1/sites/${c.siteId}/analytics/insights`).set(c.h).send({ from: today, to: today }).expect(200);
    expect(ai.body.generatedBy).toBe('ai');
    expect(ai.body.insights.map((i: { path?: string }) => i.path)).toEqual(['/pricing', undefined]);
    expect(ai.body.recommendations[0]).toMatchObject({ action: 'ab_test', path: '/pricing' });
  });
});

describe('A/B experiments', () => {
  it('validates variants, serves them by variant key, attributes exposures/conversions and refuses early winners', async () => {
    const c = await setup();
    const base = `/v1/sites/${c.siteId}/pages/${c.pageId}/experiments`;
    const unknown = await t.http.post(base).set(c.h).send({ name: 'Bad', goalMetric: 'signup', variants: [{ id: 'b', name: 'B', patch: { nope: { title: 'x' } } }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('INVALID_PATCH');
    expect((await t.http.post(base).set(c.h).send({ name: 'Bad', goalMetric: 'signup', variants: [{ id: 'b', name: 'B', patch: { hero: { title: 'x'.repeat(500) } } }] })).status).toBe(422);

    const created = await t.http.post(base).set(c.h).send({ name: 'Headline', goalMetric: 'signup', variants: [{ id: 'b', name: 'Benefit', weight: 1, patch: { hero: { title: 'Ship twice as fast' }, cta: { __hidden: true } } }] }).expect(201);
    const id = created.body.id as string;
    expect(created.body.variants.map((v: { id: string }) => v.id)).toEqual(['control', 'b']);
    await t.http.post(`/v1/experiments/${id}/start`).set(c.h).send({}).expect(200);
    await drainOutbox(t, c.owner.tenantId);

    const runtime = await t.http.get(`/v1/delivery/sites/${c.siteId}/runtime`).set(DELIVERY).expect(200);
    expect(runtime.body.experiments).toEqual([expect.objectContaining({ id, path: '/pricing', locale: 'en', variants: [{ id: 'control', weight: 1 }, { id: 'b', weight: 1 }] })]);

    const key = encodeVariantKey({ experiments: [{ testId: id, variantId: 'b' }], segmentId: null })!;
    const variant = await t.http.get(`/v1/delivery/sites/${c.siteId}/page?path=/pricing&variant=${encodeURIComponent(key)}`).set(DELIVERY).expect(200);
    expect(variant.body.page.content.root.children.map((b: { id: string }) => b.id)).toEqual(['hero']);
    expect(variant.body.page.content.root.children[0].props.title).toBe('Ship twice as fast');
    expect(variant.body.applied).toEqual({ experiments: [{ testId: id, variantId: 'b' }], segmentId: null });
    const forged = await t.http.get(`/v1/delivery/sites/${c.siteId}/page?path=/pricing&variant=${encodeURIComponent('~t.nottest.b')}`).set(DELIVERY).expect(200);
    expect(forged.body.page.content.root.children[0].props.title).toBe('Simple pricing');

    // 3 visitors in B (2 convert), 2 in control (0 convert); a conversion without exposure doesn't count.
    const send = (n: number, variantId: string, convert: boolean) => collect(c, { visitorId: `ab-${n}-${id.slice(0, 6)}`, sessionId: `abs-${n}-${id.slice(0, 6)}`, experiments: [{ testId: id, variantId }], events: [{ type: 'pageview', path: '/pricing' }, ...(convert ? [{ type: 'event' as const, name: 'signup', path: '/pricing' }] : [])] }).expect(202);
    await send(1, 'b', true);
    await send(2, 'b', true);
    await send(3, 'b', false);
    await send(4, 'control', false);
    await send(5, 'control', false);
    await collect(c, { visitorId: `ab-x-${id.slice(0, 6)}`, sessionId: `abs-x-${id.slice(0, 6)}`, experiments: [{ testId: id, variantId: 'b' }], events: [{ type: 'event', name: 'signup', path: '/other' }] }).expect(202);
    await t.app.get(CollectorService).flush();

    const detail = await t.http.get(`/v1/experiments/${id}`).set(c.h).expect(200);
    const byId = Object.fromEntries(detail.body.results.variants.map((v: { id: string; exposures: number; conversions: number }) => [v.id, [v.exposures, v.conversions]]));
    expect(byId).toEqual({ control: [2, 0], b: [3, 2] });
    expect(detail.body.results.verdict).toBe('collecting');

    const rec = await t.http.post(`/v1/experiments/${id}/recommend`).set(c.h).send({}).expect(200);
    expect(rec.body).toMatchObject({ decision: 'keep_running', generatedBy: 'ai', overridden: expect.stringContaining('declare_winner') });

    const done = await t.http.post(`/v1/experiments/${id}/complete`).set(c.h).send({ winnerVariantId: 'b', applyToDraft: true }).expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', winnerVariantId: 'b' });
    const page = await t.http.get(`/v1/sites/${c.siteId}/pages/${c.pageId}`).set(c.h).expect(200);
    expect(page.body.content.root.children.map((b: { id: string }) => b.id)).toEqual(['hero']);
    expect(page.body.hasUnpublishedChanges).toBe(true); // publishing the winner stays a human decision
  });

  it('allows one running test per page and suggests validated AI variants', async () => {
    const c = await setup();
    const base = `/v1/sites/${c.siteId}/pages/${c.pageId}/experiments`;
    const one = await t.http.post(base).set(c.h).send({ name: 'One', goalMetric: 'signup', variants: [{ id: 'b', name: 'B', patch: { hero: { title: 'B' } } }] }).expect(201);
    const two = await t.http.post(base).set(c.h).send({ name: 'Two', goalMetric: 'signup', variants: [{ id: 'b', name: 'B', patch: { hero: { title: 'C' } } }] }).expect(201);
    await t.http.post(`/v1/experiments/${one.body.id}/start`).set(c.h).send({}).expect(200);
    await t.http.post(`/v1/experiments/${two.body.id}/start`).set(c.h).send({}).expect(409);
    await t.http.patch(`/v1/experiments/${one.body.id}`).set(c.h).send({ variants: [{ id: 'z', name: 'Z', patch: {} }] }).expect(409);

    const s = await t.http.post(`${base}/suggest`).set(c.h).send({ blockId: 'hero', count: 2 }).expect(200);
    expect(s.body.variants).toEqual([expect.objectContaining({ name: 'Benefit-led', patch: { hero: { title: 'Benefit: Simple pricing', ctaLabel: 'Benefit: Start' } } })]);
  });
});

describe('personalization', () => {
  it('serves a segment patch through the variant key, and stops when paused', async () => {
    const c = await setup();
    const bad = await t.http.post(`/v1/sites/${c.siteId}/segments`).set(c.h).send({ name: 'Bad', rules: { conditions: [{ attr: 'country', op: 'gte', value: 1 }] } });
    expect(bad.status).toBe(400);
    const seg = await t.http.post(`/v1/sites/${c.siteId}/segments`).set(c.h).send({ name: 'DACH mobile', rules: { match: 'all', conditions: [{ attr: 'country', op: 'in', value: ['de', 'at', 'ch'] }, { attr: 'device', op: 'eq', value: 'mobile' }] } }).expect(201);
    const test = await t.http.post(`/v1/sites/${c.siteId}/segments/test`).set(c.h).send({ rules: seg.body.rules, context: { country: 'AT', device: 'mobile' } }).expect(200);
    expect(test.body).toEqual({ matches: true });

    const url = `/v1/sites/${c.siteId}/pages/${c.pageId}/personalizations`;
    await t.http.put(url).set(c.h).send({ segmentId: seg.body.id, patch: { hero: { title: 'Willkommen!' } } }).expect(200);
    await drainOutbox(t, c.owner.tenantId);
    const runtime = await t.http.get(`/v1/delivery/sites/${c.siteId}/runtime`).set(DELIVERY).expect(200);
    expect(runtime.body.personalization).toEqual([{ pageId: c.pageId, path: '/pricing', locale: 'en', segmentIds: [seg.body.id] }]);
    expect(runtime.body.segments[0]).toMatchObject({ id: seg.body.id, rules: seg.body.rules });

    const key = encodeURIComponent(encodeVariantKey({ experiments: [], segmentId: seg.body.id })!);
    const personal = await t.http.get(`/v1/delivery/sites/${c.siteId}/page?path=/pricing&variant=${key}`).set(DELIVERY).expect(200);
    expect(personal.body.page.content.root.children[0].props.title).toBe('Willkommen!');

    await t.http.put(url).set(c.h).send({ segmentId: seg.body.id, patch: { hero: { title: 'Willkommen!' } }, status: 'PAUSED' }).expect(200);
    await drainOutbox(t, c.owner.tenantId);
    const paused = await t.http.get(`/v1/delivery/sites/${c.siteId}/page?path=/pricing&variant=${key}`).set(DELIVERY).expect(200);
    expect(paused.body.page.content.root.children[0].props.title).toBe('Simple pricing');
    expect((await t.http.get(`/v1/delivery/sites/${c.siteId}/runtime`).set(DELIVERY).expect(200)).body.personalization).toEqual([]);
  });
});
