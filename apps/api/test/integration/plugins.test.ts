import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDeliverableUrl } from '../../src/modules/webhooks/events';
import { WebhooksService } from '../../src/modules/webhooks/webhooks.service';
import { bearer, createTestApp, drainOutbox, signUp, startReceiver, waitFor, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let rx: Awaited<ReturnType<typeof startReceiver>>;

beforeAll(async () => {
  rx = await startReceiver();
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
});

afterAll(async () => {
  await t.close();
  await rx.close();
});

function verify(body: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  return createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex') === parts.v1;
}

async function siteWithPage(owner: SignedIn) {
  const h = bearer(owner.accessToken);
  const site = await t.http.post('/v1/sites').set(h).send({ name: 'Hooked', defaultLocale: 'en', locales: ['en'] }).expect(201);
  const page = await t.http.post(`/v1/sites/${site.body.id}/pages`).set(h).send({ title: 'Pricing', slug: 'pricing' }).expect(201);
  return { h, siteId: site.body.id as string, pageId: page.body.id as string };
}
const publish = (h: Record<string, string>, siteId: string, pageId: string) => t.http.post(`/v1/sites/${siteId}/pages/${pageId}/publish`).set(h).send({}).expect(200);

describe('webhooks', () => {
  it('delivers signed, idempotent events with a delivery log', async () => {
    const owner = await signUp(t);
    const { h, siteId, pageId } = await siteWithPage(owner);
    const created = await t.http.post('/v1/webhooks').set(h).send({ name: 'CRM', url: `${rx.url}/crm`, events: ['page.published'] }).expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect((await t.http.get('/v1/webhooks').set(h).expect(200)).body[0].secret).toBeUndefined();

    await publish(h, siteId, pageId);
    await drainOutbox(t, owner.tenantId);
    const req = await waitFor(() => rx.state.requests.find((r) => r.path === '/crm' && r.headers['canon-event'] === 'page.published' && r.body.includes(pageId)));
    expect(verify(req.body, String(req.headers['canon-signature']), created.body.secret)).toBe(true);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ type: 'page.published', tenantId: owner.tenantId, data: { pageId, fullPath: '/pricing' } });
    expect(req.headers['idempotency-key']).toBe(`${body.id}:${created.body.id}`);

    const log = await waitFor(async () => {
      const r = await t.http.get(`/v1/webhooks/${created.body.id}/deliveries`).set(h).expect(200);
      return r.body.find((d: { status: string }) => d.status === 'SUCCEEDED');
    });
    expect(log).toMatchObject({ event: 'page.published', responseStatus: 200, attempts: 1 });

    await t.http.post(`/v1/webhooks/${created.body.id}/test`).set(h).expect(202);
    await waitFor(() => rx.state.requests.find((r) => r.path === '/crm' && r.headers['canon-event'] === 'ping'));
    const rotated = await t.http.post(`/v1/webhooks/${created.body.id}/rotate-secret`).set(h).expect(200);
    expect(rotated.body.secret).not.toBe(created.body.secret);

    const other = await signUp(t);
    await t.http.get(`/v1/webhooks/${created.body.id}/deliveries`).set(bearer(other.accessToken)).expect(404);
  });

  it('retries, then marks deliveries dead and disables endpoints that keep failing', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const hook = await t.http.post('/v1/webhooks').set(h).send({ name: 'Flaky', url: `${rx.url}/flaky`, events: ['*'] }).expect(201);
    await t.system.webhook.update({ where: { id: hook.body.id }, data: { failureCount: 14 } });
    const svc = t.app.get(WebhooksService);
    rx.state.status = 500;
    try {
      const { id } = await t.http.post(`/v1/webhooks/${hook.body.id}/test`).set(h).expect(202).then((r) => r.body);
      await expect(svc.deliver({ data: { deliveryId: id }, attemptsMade: 0, opts: { attempts: 8 } })).rejects.toThrow('HTTP 500');
      expect(await t.system.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', attempts: 1, responseStatus: 500 });
      await svc.deliver({ data: { deliveryId: id }, attemptsMade: 7, opts: { attempts: 8 } });
      expect(await t.system.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DEAD', attempts: 8 });
    } finally {
      rx.state.status = 200;
    }
    const after = (await t.http.get('/v1/webhooks').set(h).expect(200)).body[0];
    expect(after).toMatchObject({ isActive: false, failureCount: 15 });
    expect(after.disabledReason).toContain('Disabled after 15');
    // Re-enabling resets the counter.
    expect((await t.http.patch(`/v1/webhooks/${hook.body.id}`).set(h).send({ isActive: true }).expect(200)).body).toMatchObject({ isActive: true, failureCount: 0, disabledReason: null });
  });

  it('refuses SSRF targets in production mode', async () => {
    await expect(assertDeliverableUrl('http://example.com/hook', false)).rejects.toThrow('HTTPS');
    await expect(assertDeliverableUrl('https://127.0.0.1/hook', false)).rejects.toThrow('public address');
    await expect(assertDeliverableUrl('https://169.254.169.254/latest/meta-data', false)).rejects.toThrow('public address');
    await expect(assertDeliverableUrl('https://[::1]/x', false)).rejects.toThrow('public address');
    await expect(assertDeliverableUrl('https://user:pw@93.184.216.34/x', false)).rejects.toThrow('Credentials');
    await expect(assertDeliverableUrl('https://93.184.216.34/x', false)).resolves.toBeUndefined();
  });
});

describe('plugins', () => {
  it('lists the marketplace; Slack plugin posts publishes to the channel with masked secrets', async () => {
    const owner = await signUp(t);
    const { h, siteId, pageId } = await siteWithPage(owner);
    const catalog = (await t.http.get('/v1/plugins').set(h).expect(200)).body as { id: string; name: string; installation: unknown }[];
    expect(catalog.map((p) => p.name)).toEqual(expect.arrayContaining(['slack-notifications', 'automation-webhooks', 'marketing-blocks']));
    const slack = catalog.find((p) => p.name === 'slack-notifications')!;
    expect(slack.installation).toBeNull();

    await t.http.post(`/v1/plugins/${slack.id}/install`).set(h).send({ settings: {} }).expect(400);
    const inst = await t.http.post(`/v1/plugins/${slack.id}/install`).set(h).send({ settings: { webhookUrl: `${rx.url}/slack`, channel: '#launches' } }).expect(201);
    expect(inst.body.installation.settings).toEqual({ webhookUrl: '••••••••', channel: '#launches' });
    await t.http.post(`/v1/plugins/${slack.id}/install`).set(h).send({ settings: { webhookUrl: `${rx.url}/slack` } }).expect(409);
    // Plugin webhooks are managed by the plugin, not listed or editable as tenant endpoints.
    expect((await t.http.get('/v1/webhooks').set(h).expect(200)).body).toEqual([]);

    await publish(h, siteId, pageId);
    await drainOutbox(t, owner.tenantId);
    const msg = await waitFor(() => rx.state.requests.find((r) => r.path === '/slack' && r.body.includes('/pricing')));
    expect(JSON.parse(msg.body)).toEqual({ text: '📄 Page published: /pricing (en)', channel: '#launches' });

    // Updating other settings keeps the stored secret.
    await t.http.patch(`/v1/plugins/installations/${inst.body.installation.id}`).set(h).send({ settings: { webhookUrl: '••••••••', channel: '#web' } }).expect(200);
    const stored = await t.system.pluginInstance.findUniqueOrThrow({ where: { id: inst.body.installation.id } });
    expect((stored.settings as { webhookUrl: { __enc: string } }).webhookUrl.__enc).toBeTruthy();
    expect(JSON.stringify(stored.settings)).not.toContain(rx.url);

    await t.http.delete(`/v1/plugins/installations/${inst.body.installation.id}`).set(h).expect(204);
    expect(await t.system.webhook.count({ where: { tenantId: owner.tenantId } })).toBe(0);
  });

  it('requires consent, issues a scoped key shown once, and revokes it on uninstall; block presets reach the builder', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const catalog = (await t.http.get('/v1/plugins').set(h).expect(200)).body as { id: string; name: string }[];
    const zap = catalog.find((p) => p.name === 'automation-webhooks')!;
    const noConsent = await t.http.post(`/v1/plugins/${zap.id}/install`).set(h).send({ settings: { endpoint: `${rx.url}/zap` } }).expect(400);
    expect(noConsent.body.error).toMatchObject({ code: 'CONSENT_REQUIRED', details: { permissions: ['content:read'] } });
    const inst = await t.http.post(`/v1/plugins/${zap.id}/install`).set(h).send({ settings: { endpoint: `${rx.url}/zap` }, grantedPermissions: ['content:read'] }).expect(201);
    expect(inst.body.apiKey).toMatch(/^ck_/);
    await t.http.get('/v1/sites').set('x-api-key', inst.body.apiKey).expect(200);
    // The key reads, it cannot write.
    await t.http.post('/v1/sites').set('x-api-key', inst.body.apiKey).send({ name: 'Nope', defaultLocale: 'en', locales: ['en'] }).expect(403);
    await t.http.delete(`/v1/plugins/installations/${inst.body.installation.id}`).set(h).expect(204);
    await t.http.get('/v1/sites').set('x-api-key', inst.body.apiKey).expect(401);

    const blocks = catalog.find((p) => p.name === 'marketing-blocks')!;
    await t.http.post(`/v1/plugins/${blocks.id}/install`).set(h).send({}).expect(201);
    const presets = (await t.http.get('/v1/plugins/blocks').set(h).expect(200)).body as { key: string; tree: { type: string } }[];
    expect(presets.map((p) => p.key)).toEqual(['pricing-tiers', 'launch-announcement']);
    expect(presets[0]!.tree.type).toBe('section');
  });

  it('private plugins: plan-gated, validated, installed via a signed callback, re-consent on upgrade', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const manifest = {
      name: 'crm-sync',
      version: '1.0.0',
      displayName: 'CRM sync',
      description: 'Pushes published pages to our CRM.',
      author: 'Acme IT',
      category: 'integration',
      permissions: ['content:read'],
      events: ['page.published'],
      delivery: { kind: 'webhook', url: `${rx.url}/crm-plugin` },
      install: { url: `${rx.url}/crm-install` },
    };
    await t.http.post('/v1/plugins').set(h).send({ manifest }).expect(402);
    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'BUSINESS' } });
    const bad = await t.http.post('/v1/plugins').set(h).send({ manifest: { ...manifest, permissions: ['root:everything'] } }).expect(400);
    expect(bad.body.error.code).toBe('INVALID_MANIFEST');
    const reg = await t.http.post('/v1/plugins').set(h).send({ manifest }).expect(201);
    expect(reg.body).toMatchObject({ private: true, name: expect.stringMatching(/\/crm-sync$/) });
    // Private plugins are invisible to other workspaces.
    const stranger = await signUp(t);
    expect((await t.http.get('/v1/plugins').set(bearer(stranger.accessToken)).expect(200)).body.map((p: { id: string }) => p.id)).not.toContain(reg.body.id);

    const inst = await t.http.post(`/v1/plugins/${reg.body.id}/install`).set(h).send({ grantedPermissions: ['content:read'] }).expect(201);
    expect(inst.body.apiKey).toBeNull(); // delivered to the plugin, not shown
    const cb = rx.state.requests.find((r) => r.path === '/crm-install')!;
    const payload = JSON.parse(cb.body);
    expect(payload).toMatchObject({ event: 'plugin.installed', tenantId: owner.tenantId, instanceId: inst.body.installation.id });
    expect(verify(cb.body, String(cb.headers['canon-signature']), payload.signingSecret)).toBe(true);
    await t.http.get('/v1/sites').set('x-api-key', payload.apiKey).expect(200);

    // v1.1 asks for more: the installation keeps its old grant until someone consents.
    await t.http.post('/v1/plugins').set(h).send({ manifest: { ...manifest, version: '1.1.0', permissions: ['content:read', 'content:write'] } }).expect(201);
    const listed = (await t.http.get('/v1/plugins').set(h).expect(200)).body.find((p: { id: string }) => p.id === reg.body.id);
    expect(listed.installation).toMatchObject({ needsConsent: true, updateAvailable: true, grantedPermissions: ['content:read'] });
    await t.http.patch(`/v1/plugins/installations/${inst.body.installation.id}`).set(h).send({ grantedPermissions: ['content:read', 'content:write'] }).expect(200);
    const key = await t.system.apiKey.findFirstOrThrow({ where: { tenantId: owner.tenantId, name: 'Plugin: CRM sync' } });
    expect(key.scopes).toEqual(['content:read', 'content:write']);
    const audit = await t.system.auditLog.findMany({ where: { tenantId: owner.tenantId, action: { startsWith: 'plugin.' } }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['plugin.private_registered', 'plugin.installed', 'plugin.private_updated', 'plugin.updated']));
  });
});
