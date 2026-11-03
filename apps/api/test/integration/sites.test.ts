import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, invited, signUp, type SignedIn, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
});

afterAll(async () => {
  await t.close();
});

const site = (o: SignedIn, body: object) => t.http.post('/v1/sites').set(bearer(o.accessToken)).send({ defaultLocale: 'en', ...body });

describe('sites', () => {
  it('enforces the plan site limit and unique slugs', async () => {
    const owner = await signUp(t);
    await site(owner, { name: 'First' }).expect(201);
    const limited = await site(owner, { name: 'Second' }).expect(402);
    expect(limited.body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { resource: 'sites', limit: 1 } });

    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'PRO' } });
    await site(owner, { name: 'Docs', slug: 'docs', template: 'docs' }).expect(201);
    const dup = await site(owner, { name: 'Docs again', slug: 'docs' }).expect(409);
    expect(dup.body.error.message).toContain('"docs"');

    const list = (await t.http.get('/v1/sites').set(bearer(owner.accessToken)).expect(200)).body as {
      name: string;
      pageCount: number;
    }[];
    expect(list.map((s) => s.name)).toEqual(['First', 'Docs']);
    expect(list.every((s) => s.pageCount === 1)).toBe(true); // every site starts with a home page
  });

  it('validates locales and custom domains, and merges SEO defaults and settings', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const s = (await site(owner, { name: 'Shop', locales: ['en', 'de'] }).expect(201)).body as { id: string };

    expect((await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ defaultLocale: 'fr' }).expect(400)).body.error.code).toBe('INVALID_LOCALES');
    expect((await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ locales: ['de'], defaultLocale: 'de' }).expect(200)).body).toMatchObject({ defaultLocale: 'de', locales: ['de'] });

    expect((await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ domain: `x.${t.config.PUBLIC_SITES_DOMAIN}` }).expect(400)).body.error.code).toBe('INVALID_DOMAIN');
    const domain = `shop-${owner.tenantId.slice(-6)}.example.com`;
    await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ domain: domain.toUpperCase() }).expect(200);
    // An unproven claim blocks nobody; once verified, another workspace cannot take it.
    const other = await signUp(t);
    const theirs = (await site(other, { name: 'Copycat' }).expect(201)).body as { id: string };
    await t.http.patch(`/v1/sites/${theirs.id}`).set(bearer(other.accessToken)).send({ domain }).expect(200);
    await t.system.site.update({ where: { id: s.id }, data: { domainStatus: 'VERIFIED' } });
    await t.http
      .patch(`/v1/sites/${theirs.id}`)
      .set(bearer(other.accessToken))
      .send({ domain: null })
      .expect(200);
    await t.http.patch(`/v1/sites/${theirs.id}`).set(bearer(other.accessToken)).send({ domain }).expect(409);

    await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ seoDefaults: { titleTemplate: '%s · Shop' }, settings: { analytics: true } }).expect(200);
    const merged = await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ seoDefaults: { description: 'Gear' }, settings: { nav: 'top' }, description: null }).expect(200);
    expect(merged.body.seoDefaults).toEqual({ titleTemplate: '%s · Shop', description: 'Gear' });
    const row = await t.system.site.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.settings).toEqual({ analytics: true, nav: 'top' });
    expect(row.domain).toBe(domain); // stored lower-case
    const outbox = await t.system.outboxEvent.findMany({ where: { aggregateId: s.id, type: 'SiteUpdated' } });
    expect(outbox.length).toBeGreaterThanOrEqual(4);
  });

  it('merges theme colors and AI settings, and keeps editors out of site configuration', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const s = (await site(owner, { name: 'Brand' }).expect(201)).body as { id: string };

    await t.http.patch(`/v1/sites/${s.id}/theme`).set(h).send({ colors: { primary: '#ff0000' }, font: 'Inter' }).expect(200);
    const theme = (await t.http.patch(`/v1/sites/${s.id}/theme`).set(h).send({ colors: { muted: '#eeeeee' } }).expect(200)).body;
    expect(theme).toMatchObject({ font: 'Inter', colors: { primary: '#ff0000', muted: '#eeeeee', background: '#ffffff' } });
    await t.http.patch(`/v1/sites/${s.id}/theme`).set(h).send({ colors: { primary: 'red' } }).expect(400);

    await t.http.patch(`/v1/sites/${s.id}/ai-settings`).set(h).send({ brandVoice: 'Friendly, concise' }).expect(200);
    const ai = (await t.http.patch(`/v1/sites/${s.id}/ai-settings`).set(h).send({ forbiddenTopics: ['politics'] }).expect(200)).body;
    expect(ai).toMatchObject({ brandVoice: 'Friendly, concise', forbiddenTopics: ['politics'] });
    expect((await t.http.get(`/v1/sites/${s.id}/ai-settings`).set(h).expect(200)).body).toMatchObject({ brandVoice: 'Friendly, concise' });

    const editor = await invited(t, owner, 'EDITOR');
    const eh = bearer(editor.accessToken);
    await t.http.get(`/v1/sites/${s.id}`).set(eh).expect(200);
    await t.http.patch(`/v1/sites/${s.id}`).set(eh).send({ name: 'Hijacked' }).expect(403);
    await t.http.patch(`/v1/sites/${s.id}/theme`).set(eh).send({ font: 'mono' }).expect(403);
    await t.http.delete(`/v1/sites/${s.id}`).set(eh).expect(403);
  });

  it('soft-deletes a site, frees its domain and purges its hosts', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const s = (await site(owner, { name: 'Gone' }).expect(201)).body as {
      id: string;
      internalDomain: string;
    };
    const domain = `gone-${owner.tenantId.slice(-6)}.example.com`;
    await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ domain }).expect(200);
    await t.http.delete(`/v1/sites/${s.id}`).set(h).expect(204);
    await t.http.get(`/v1/sites/${s.id}`).set(h).expect(404);
    await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ name: 'Back' }).expect(404);
    const ev = await t.system.outboxEvent.findFirstOrThrow({ where: { aggregateId: s.id, type: 'SiteDeleted' } });
    expect((ev.payload as { hosts: string[] }).hosts).toEqual([s.internalDomain, domain]);

    // The domain can be connected again elsewhere.
    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'PRO' } });
    const next = (await site(owner, { name: 'Again' }).expect(201)).body as { id: string };
    await t.http.patch(`/v1/sites/${next.id}`).set(h).send({ domain }).expect(200);
  });
});
