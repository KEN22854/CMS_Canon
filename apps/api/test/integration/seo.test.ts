import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, invited, signUp, type SignedIn, type TestApp } from './harness';

const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off' });
});

afterAll(async () => {
  await t.close();
});

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (await t.http.post('/v1/sites').set(h).send({ name: 'SEO', defaultLocale: 'en' }).expect(201)).body as { id: string };
  return { owner, h, site };
}

async function publishedPage(owner: SignedIn, siteId: string, slug: string, title: string, content?: unknown) {
  const h = bearer(owner.accessToken);
  const p = (await t.http.post(`/v1/sites/${siteId}/pages`).set(h).send({ title, slug }).expect(201)).body as { id: string; version: number };
  if (content) await t.http.patch(`/v1/sites/${siteId}/pages/${p.id}`).set(h).send({ expectedVersion: p.version, content }).expect(200);
  await t.http.post(`/v1/sites/${siteId}/pages/${p.id}/publish`).set(h).send({}).expect(200);
  return p;
}

describe('redirects', () => {
  it('validates rules, refuses loops and duplicates, and reaches the renderer config', async () => {
    const { owner, h, site } = await setup();
    const make = (body: object) => t.http.post(`/v1/sites/${site.id}/redirects`).set(h).send(body);

    const a = (await make({ fromPath: '/Old-Pricing/', toPath: '/pricing' }).expect(201)).body;
    expect(a).toMatchObject({ fromPath: '/old-pricing', toPath: '/pricing', statusCode: 301, automatic: false });
    await make({ fromPath: '/blog/*', toPath: '/news/*', statusCode: 308 }).expect(201);
    await make({ fromPath: '/old-pricing', toPath: '/elsewhere' }).expect(409);
    expect((await make({ fromPath: '/', toPath: '/x' }).expect(400)).body.error.code).toBe('INVALID_REDIRECT');
    expect((await make({ fromPath: '/x', toPath: 'javascript:alert(1)' }).expect(400)).body.error.code).toBe('INVALID_REDIRECT');
    await make({ fromPath: '/x', toPath: '/x', statusCode: 418 }).expect(400);
    await make({ fromPath: '/pricing', toPath: '/plans' }).expect(201);
    const loop = await make({ fromPath: '/plans', toPath: '/old-pricing' }).expect(400);
    expect(loop.body.error).toMatchObject({ code: 'REDIRECT_LOOP' });

    await drainOutbox(t, owner.tenantId);
    const rt = await t.http.get(`/v1/delivery/sites/${site.id}/runtime`).set(DELIVERY).expect(200);
    expect(rt.body.redirects).toEqual(expect.arrayContaining([{ from: '/old-pricing', to: '/pricing', status: 301 }, { from: '/blog/*', to: '/news/*', status: 308 }]));

    // Viewers read, only site managers change; other workspaces see nothing.
    const viewer = await invited(t, owner, 'VIEWER');
    await t.http.get(`/v1/sites/${site.id}/redirects`).set(bearer(viewer.accessToken)).expect(200);
    await t.http.delete(`/v1/redirects/${a.id}`).set(bearer(viewer.accessToken)).expect(403);
    const stranger = await signUp(t);
    await t.http.patch(`/v1/redirects/${a.id}`).set(bearer(stranger.accessToken)).send({ toPath: '/mine' }).expect(404);
    await t.http.delete(`/v1/redirects/${a.id}`).set(h).expect(204);
  });

  it('imports CSV with per-line errors', async () => {
    const { h, site } = await setup();
    const csv = ['from,to,status', '/a,/b', '/c;https://example.com/c;302', '/d,/d', '/e,/f,404', '"/g","/h"'].join('\n');
    const res = await t.http.post(`/v1/sites/${site.id}/redirects/import`).set(h).send({ csv }).expect(200);
    expect(res.body.imported).toBe(3);
    expect(res.body.errors.map((e: { line: number }) => e.line)).toEqual([4, 5]);
    const list = (await t.http.get(`/v1/sites/${site.id}/redirects`).set(h).expect(200)).body as { fromPath: string; statusCode: number }[];
    expect(list.map((r) => [r.fromPath, r.statusCode])).toEqual([['/a', 301], ['/c', 302], ['/g', 301]]);
  });

  it('keeps old addresses working when a published page moves, and a live page wins over a rule', async () => {
    const { owner, h, site } = await setup();
    const p = await publishedPage(owner, site.id, 'about', 'About');
    const detail = (await t.http.get(`/v1/sites/${site.id}/pages/${p.id}`).set(h).expect(200)).body as { version: number };
    await t.http.patch(`/v1/sites/${site.id}/pages/${p.id}`).set(h).send({ expectedVersion: detail.version, slug: 'company' }).expect(200);
    await drainOutbox(t, owner.tenantId);
    const rules = (await t.http.get(`/v1/sites/${site.id}/redirects`).set(h).expect(200)).body as { fromPath: string; toPath: string; automatic: boolean }[];
    expect(rules.map((r) => [r.fromPath, r.toPath, r.automatic])).toEqual([
      ['/about', '/company', true],
      ['/about/*', '/company/*', true],
    ]);

    // Publishing a new page at /about removes the rule that would hide it.
    await publishedPage(owner, site.id, 'about', 'About us (new)');
    await drainOutbox(t, owner.tenantId);
    const after = (await t.http.get(`/v1/sites/${site.id}/redirects`).set(h).expect(200)).body as { fromPath: string }[];
    expect(after.map((r) => r.fromPath)).toEqual(['/about/*']);
  });
});

describe('SEO audit and structured data', () => {
  it('scores pages and reports issues with the site-wide context', async () => {
    const { owner, h, site } = await setup();
    const words = Array.from({ length: 140 }, (_, i) => `w${i}`).join(' ');
    const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    const good = { root: { id: 'r', type: 'section', props: {}, children: [{ id: 'h', type: 'hero', props: { title: 'Pricing', ctaLabel: 'Go', ctaHref: '/old' }, children: [] }, { id: 't', type: 'text', props: { doc: doc(words) }, children: [] }, { id: 'f', type: 'faq', props: { title: 'FAQ', items: [{ q: 'Free?', a: 'Yes.' }] }, children: [] }] } };
    await t.http.post(`/v1/sites/${site.id}/redirects`).set(h).send({ fromPath: '/old', toPath: '/pricing' }).expect(201);
    const pricing = await publishedPage(owner, site.id, 'pricing', 'Pricing plans for every team', good);
    const v = ((await t.http.get(`/v1/sites/${site.id}/pages/${pricing.id}`).set(h).expect(200)).body as { version: number }).version;
    await t.http.patch(`/v1/sites/${site.id}/pages/${pricing.id}`).set(h).send({ expectedVersion: v, description: 'Simple plans for teams of every size; start free and upgrade when you need more.' }).expect(200);
    await publishedPage(owner, site.id, 'bad', 'X', { root: { id: 'r', type: 'section', props: {}, children: [{ id: 'b', type: 'button', props: { label: 'Broken', href: '/nowhere' }, children: [] }] } });

    const audit = (await t.http.get(`/v1/sites/${site.id}/seo/audit`).set(h).expect(200)).body as { score: number; totals: Record<string, number>; pages: { path: string; score: number; issues: { code: string; detail?: string }[] }[] };
    const byPath = Object.fromEntries(audit.pages.map((p) => [p.path, p]));
    // The link to /old resolves through the redirect; the good page only lacks a social image.
    expect(byPath['/pricing']!.issues.map((i) => i.code)).toEqual(['og-image-missing']);
    expect(byPath['/bad']!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['title-short', 'description-missing', 'h1-missing', 'link-broken', 'thin-content']));
    expect(byPath['/bad']!.issues.find((i) => i.code === 'link-broken')!.detail).toBe('/nowhere');
    expect(audit.pages[0]!.path).toBe('/bad'); // worst first
    expect(audit.totals.error).toBeGreaterThan(0);
    expect(typeof audit.score).toBe('number');

    // The renderer gets breadcrumbs for nested pages and the 404 page stays out of nav and sitemap.
    const child = (await t.http.post(`/v1/sites/${site.id}/pages`).set(h).send({ title: 'Pro plan', slug: 'pro', parentId: pricing.id }).expect(201)).body as { id: string };
    await t.http.post(`/v1/sites/${site.id}/pages/${child.id}/publish`).set(h).send({}).expect(200);
    await publishedPage(owner, site.id, '404', 'Not found');
    await drainOutbox(t, owner.tenantId);
    const live = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/pricing/pro`).set(DELIVERY).expect(200);
    expect(live.body.breadcrumbs).toEqual([{ title: 'Pricing plans for every team', path: '/pricing' }]);
    expect(live.body.nav.map((n: { path: string }) => n.path)).not.toContain('/404');
    const list = await t.http.get(`/v1/delivery/sites/${site.id}/pages`).set(DELIVERY).expect(200);
    expect(list.body.pages.map((p: { path: string }) => p.path)).not.toContain('/404');
  });
});
