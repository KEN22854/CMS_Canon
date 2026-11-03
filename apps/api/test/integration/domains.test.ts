import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainsService } from '../../src/modules/sites/domains.service';
import { bearer, createTestApp, signUp, type TestApp } from './harness';

let t: TestApp;
let domains: DomainsService;
/** Fake DNS: name → TXT strings. */
const dns = new Map<string, string[]>();

beforeAll(async () => {
  t = await createTestApp({
    KNOWLEDGE: 'off',
    CANON_EXTRACT: 'off',
    CANON_PROPAGATE: 'off',
    ENRICHMENT: 'off',
    ANALYTICS_FLUSH: 'off',
    ANALYTICS_JOBS: 'off',
  });
  domains = t.app.get(DomainsService);
  domains.lookupTxt = async (name) => (dns.get(name) ?? []).map((v) => [v]);
});

afterAll(async () => {
  await t.close();
});

describe('custom domains', () => {
  it('claims, proves with TXT, then serves and issues certificates only for verified hosts', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const s = (await t.http.post('/v1/sites').set(h).send({ name: 'Shop', defaultLocale: 'en' }).expect(201))
      .body as { id: string; internalDomain: string };
    const domain = `www.shop-${owner.tenantId.slice(-6)}.example.com`;

    const claimed = (await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ domain }).expect(200)).body;
    expect(claimed).toMatchObject({ domain, domainStatus: 'PENDING' });
    expect(claimed.url).toContain(s.internalDomain); // not served on the claim yet
    const status = (await t.http.get(`/v1/sites/${s.id}/domain`).set(h).expect(200)).body as {
      records: { type: string; name: string; value: string }[];
    };
    const txt = status.records.find((r) => r.type === 'TXT')!;
    expect(txt.name).toBe(`_canon-site.${domain}`);
    expect(status.records.find((r) => r.type === 'CNAME')!.value).toBe(
      `sites.${t.config.PUBLIC_SITES_DOMAIN}`,
    );

    const delivery = { 'x-canon-delivery': t.config.DELIVERY_TOKEN };
    await t.http.get(`/v1/delivery/resolve?host=${domain}`).set(delivery).expect(404);
    await t.http.get(`/v1/tls/ask?domain=${domain}`).expect(404);
    await t.http.get(`/v1/tls/ask?domain=${s.internalDomain}`).expect(200);

    // Not there yet → stays pending with a reason.
    const early = (await t.http.post(`/v1/sites/${s.id}/domain/verify`).set(h).expect(200)).body;
    expect(early).toMatchObject({
      status: 'PENDING',
      error: expect.stringContaining('TXT record not found'),
    });

    dns.set(txt.name, ['some-other=1', txt.value]);
    expect((await t.http.post(`/v1/sites/${s.id}/domain/verify`).set(h).expect(200)).body).toMatchObject({
      status: 'VERIFIED',
      error: null,
    });
    expect(
      (await t.http.get(`/v1/delivery/resolve?host=${domain.toUpperCase()}`).set(delivery).expect(200)).body,
    ).toMatchObject({ id: s.id, host: domain });
    await t.http.get(`/v1/tls/ask?domain=${domain}`).expect(200);
    const n = await t.system.notification.findFirst({
      where: { userId: owner.userId, type: 'domain.status' },
    });
    expect(n?.title).toContain('is live');
    expect(
      await t.system.auditLog.count({ where: { tenantId: owner.tenantId, action: 'site.domain_verified' } }),
    ).toBe(1);

    // Changing the hostname starts over with a fresh token.
    await t.http
      .patch(`/v1/sites/${s.id}`)
      .set(h)
      .send({ domain: `shop-${owner.tenantId.slice(-6)}.example.org` })
      .expect(200);
    const again = (await t.http.get(`/v1/sites/${s.id}/domain`).set(h).expect(200)).body as {
      status: string;
      records: { value: string }[];
    };
    expect(again.status).toBe('PENDING');
    expect(again.records[0]!.value).not.toBe(txt.value);
    await t.http.get(`/v1/delivery/resolve?host=${domain}`).set(delivery).expect(404);
  });

  it('auto-verifies pending claims and releases a verified domain after the grace period', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const s = (await t.http.post('/v1/sites').set(h).send({ name: 'Blog', defaultLocale: 'en' }).expect(201))
      .body as { id: string };
    const domain = `blog-${owner.tenantId.slice(-6)}.example.com`;
    await t.http.patch(`/v1/sites/${s.id}`).set(h).send({ domain }).expect(200);
    const row = await t.system.site.findUniqueOrThrow({ where: { id: s.id } });
    dns.set(`_canon-site.${domain}`, [`canon-site=${row.domainToken}`]);

    await domains.recheckAll();
    expect((await t.system.site.findUniqueOrThrow({ where: { id: s.id } })).domainStatus).toBe('VERIFIED');

    // The proof disappears: a warning first, the site keeps serving.
    dns.delete(`_canon-site.${domain}`);
    const day0 = new Date();
    await domains.recheckAll(day0);
    const warned = await t.system.site.findUniqueOrThrow({ where: { id: s.id } });
    expect(warned).toMatchObject({
      domainStatus: 'VERIFIED',
      domainError: expect.stringContaining('TXT record not found'),
    });
    expect(
      await t.system.notification.count({
        where: { userId: owner.userId, type: 'domain.status', title: { contains: 'no longer proves' } },
      }),
    ).toBe(1);

    // Eight days later it is released back to the platform address.
    await domains.recheckAll(new Date(day0.getTime() + 8 * 86_400_000));
    expect((await t.system.site.findUniqueOrThrow({ where: { id: s.id } })).domainStatus).toBe('FAILED');
    await t.http.get(`/v1/tls/ask?domain=${domain}`).expect(404);
    expect(
      await t.system.notification.count({
        where: { userId: owner.userId, type: 'domain.status', title: { contains: 'disconnected' } },
      }),
    ).toBe(1);
  });
});
