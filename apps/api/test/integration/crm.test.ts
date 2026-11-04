import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, invited, signUp, type TestApp } from './harness';

const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off', FORMS_AI: 'off' });
});

afterAll(async () => {
  await t.close();
});

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Bakery', defaultLocale: 'en' }).expect(201)).body as { id: string; internalDomain: string };
  const form = (
    await t.http
      .post(`/v1/sites/${site.id}/forms`)
      .set(h)
      .send({ name: 'Catering request', fields: [{ name: 'name', type: 'text', label: 'Name', required: true }, { name: 'email', type: 'email', label: 'Email', required: true }, { name: 'phone', type: 'phone', label: 'Phone' }, { name: 'message', type: 'textarea', label: 'Message' }] })
      .expect(201)
  ).body as { id: string };
  const submit = (data: Record<string, unknown>) =>
    t.http.post(`/v1/delivery/forms/${form.id}/submit`).set({ ...DELIVERY, 'x-canon-host': site.internalDomain, 'x-canon-ip': `198.51.100.${Math.floor(Math.random() * 200)}` }).send({ data, elapsedMs: 9000 }).expect(202);

  // A small shop for orders.
  const base = `/v1/sites/${site.id}/collections`;
  const shop = (await t.http.post(base).set(h).send({ name: 'Products', slug: 'products', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'price', label: 'Price', type: 'number' }] }).expect(201)).body as { id: string };
  await t.http.patch(`${base}/${shop.id}`).set(h).send({ settings: { commerce: { priceField: 'price', currency: 'EUR', paymentMethods: ['cash'] } } }).expect(200);
  const cake = (await t.http.post(`${base}/${shop.id}/entries`).set(h).send({ data: { name: 'Cake', price: 30 } }).expect(201)).body as { id: string };
  await t.http.post(`${base}/${shop.id}/entries/${cake.id}/publish`).set(h).send({}).expect(200);
  const order = (email: string, quantity = 1) => t.http.post(`/v1/delivery/sites/${site.id}/orders`).set({ ...DELIVERY, 'x-canon-host': site.internalDomain, 'x-canon-ip': `10.1.${Math.floor(Math.random() * 200)}.1` }).send({ items: [{ productId: cake.id, quantity }], customer: { name: 'Ada Buyer', email }, paymentMethod: 'cash' }).expect(201);
  const drain = () => drainOutbox(t, owner.tenantId);
  return { owner, h, site, form, submit, order, drain };
}

describe('contacts', () => {
  it('grow from form submissions and orders: one per email, a timeline, order totals, idempotent', async () => {
    const { h, site, submit, order, drain } = await setup();
    await submit({ name: 'Ada', email: 'ADA@example.test', phone: '+1 555 0100', message: 'Cake for 40 people?' });
    await order('ada@example.test', 2);
    await submit({ name: 'Bob', email: 'bob@example.test' });
    await drain();
    await drain(); // handled twice → nothing doubles

    const list = (await t.http.get(`/v1/sites/${site.id}/contacts`).set(h).expect(200)).body;
    expect(list.total).toBe(2);
    const ada = list.items.find((c: { email: string }) => c.email === 'ada@example.test');
    expect(ada).toMatchObject({ name: 'Ada', phone: '+1 555 0100', orderCount: 1, revenue: { EUR: 6000 } });
    expect((await t.http.get(`/v1/sites/${site.id}/contacts`).query({ customers: 'true' }).set(h).expect(200)).body.total).toBe(1);
    expect((await t.http.get(`/v1/sites/${site.id}/contacts`).query({ q: 'bob' }).set(h).expect(200)).body.items[0].email).toBe('bob@example.test');

    const detail = (await t.http.get(`/v1/sites/${site.id}/contacts/${ada.id}`).set(h).expect(200)).body;
    expect(detail.activities.map((a: { kind: string }) => a.kind).sort()).toEqual(['form', 'order']);

    // Notes and tags from the team; a cancelled order stops counting.
    await t.http.post(`/v1/sites/${site.id}/contacts/${ada.id}/notes`).set(h).send({ text: 'Called back, wants chocolate.' }).expect(200);
    const tagged = (await t.http.patch(`/v1/sites/${site.id}/contacts/${ada.id}`).set(h).send({ tags: ['Catering', 'catering', 'VIP'] }).expect(200)).body;
    expect(tagged.tags).toEqual(['catering', 'vip']);
    expect((await t.http.get(`/v1/sites/${site.id}/contacts`).query({ tag: 'vip' }).set(h).expect(200)).body.total).toBe(1);
    const orders = (await t.http.get(`/v1/sites/${site.id}/orders`).set(h).expect(200)).body.items as { id: string }[];
    await t.http.patch(`/v1/sites/${site.id}/orders/${orders[0]!.id}`).set(h).send({ status: 'CANCELLED' }).expect(200);
    await drain();
    await drain();
    const after = (await t.http.get(`/v1/sites/${site.id}/contacts/${ada.id}`).set(h).expect(200)).body;
    expect(after).toMatchObject({ orderCount: 0, revenue: { EUR: 0 } });
    expect(after.activities.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(['note', 'order_status']));

    // Erasure removes the person and the timeline.
    await t.http.delete(`/v1/sites/${site.id}/contacts/${ada.id}`).set(h).expect(204);
    await t.http.get(`/v1/sites/${site.id}/contacts/${ada.id}`).set(h).expect(404);
  });

  it('are personal data: editors work with them, viewers and other workspaces do not', async () => {
    const { owner, site, submit, drain } = await setup();
    await submit({ name: 'Ada', email: 'ada@example.test' });
    await drain();
    const editor = await invited(t, owner, 'EDITOR');
    const list = (await t.http.get(`/v1/sites/${site.id}/contacts`).set(bearer(editor.accessToken)).expect(200)).body;
    await t.http.delete(`/v1/sites/${site.id}/contacts/${list.items[0].id}`).set(bearer(editor.accessToken)).expect(403);
    const viewer = await invited(t, owner, 'VIEWER');
    await t.http.get(`/v1/sites/${site.id}/contacts`).set(bearer(viewer.accessToken)).expect(403);
    const stranger = await signUp(t);
    await t.http.get(`/v1/sites/${site.id}/contacts/${list.items[0].id}`).set(bearer(stranger.accessToken)).expect(404);
    // A CRM sync key reads contacts but can't erase them.
    const crm = (await t.http.post('/v1/api-keys').set(bearer(owner.accessToken)).send({ name: 'crm sync', scopes: ['crm:read', 'crm:write'] }).expect(201)).body.key as string;
    expect((await t.http.get(`/v1/sites/${site.id}/contacts`).set('x-api-key', crm).expect(200)).body.total).toBe(1);
    await t.http.patch(`/v1/sites/${site.id}/contacts/${list.items[0].id}`).set('x-api-key', crm).send({ tags: ['synced'] }).expect(200);
    await t.http.delete(`/v1/sites/${site.id}/contacts/${list.items[0].id}`).set('x-api-key', crm).expect(403);
  });
});

describe('automations', () => {
  it('act on forms and orders with conditions: email the contact or the team, add a tag — once per event', async () => {
    const { owner, h, site, form, submit, order, drain } = await setup();
    const make = (body: object) => t.http.post(`/v1/sites/${site.id}/automations`).set(h).send(body);
    await make({ name: 'Bad', trigger: { event: 'form.submitted', formId: 'nope' }, actions: [{ type: 'add_tag', tag: 'x' }] }).expect(400);
    await make({ name: 'Bad', trigger: { event: 'order.placed' }, actions: [] }).expect(400);
    await make({ name: 'Bad', trigger: { event: 'order.placed' }, actions: [{ type: 'webhook', url: 'http://169.254.169.254' }] }).expect(400);

    const reply = (await make({ name: 'Catering auto-reply', trigger: { event: 'form.submitted', formId: form.id }, actions: [{ type: 'email_contact', subject: 'Thanks, {{contact.name}}!', body: 'We got your request on {{site.name}} and will call you.\n\n<b>The bakery</b>' }, { type: 'add_tag', tag: 'lead' }] }).expect(201)).body;
    await make({ name: 'Big orders', trigger: { event: 'order.placed', minTotal: 5000 }, actions: [{ type: 'email_team', to: 'owner@bakery.test', subject: 'Big order #{{order.number}}: {{order.total}}', body: '{{contact.name}} ({{contact.email}}) ordered {{order.total}}.' }, { type: 'add_tag', tag: 'big spender' }] }).expect(201);
    await make({ name: 'Shipped', enabled: false, trigger: { event: 'order.status', status: 'SHIPPED' }, actions: [{ type: 'email_contact', subject: 'On its way', body: 'Order {{order.number}} is on its way.' }] }).expect(201);

    await submit({ name: 'Ada', email: 'ada@example.test' });
    await order('ada@example.test', 1); // €30: below the minimum
    await order('ada@example.test', 2); // €60
    await drain();
    await drain();

    const toAda = t.mailer.outbox.filter((m) => m.to === 'ada@example.test' && m.template === 'automation-email_contact');
    expect(toAda).toHaveLength(1);
    expect(toAda[0]!.subject).toBe('Thanks, Ada!');
    expect(toAda[0]!.html).toContain('&lt;b&gt;The bakery&lt;/b&gt;'); // texts are plain, never markup
    const toTeam = t.mailer.outbox.filter((m) => m.to === 'owner@bakery.test');
    expect(toTeam.map((m) => m.subject)).toEqual(['Big order #1002: €60.00']);

    const contacts = (await t.http.get(`/v1/sites/${site.id}/contacts`).set(h).expect(200)).body.items;
    expect(contacts[0].tags.sort()).toEqual(['big spender', 'lead']);
    const runs = (await t.http.get(`/v1/sites/${site.id}/automations/${reply.id}/runs`).set(h).expect(200)).body;
    expect(runs).toEqual([expect.objectContaining({ status: 'ok', detail: { actions: ['email_contact', 'add_tag'], event: 'form.submitted' } })]);

    // A disabled automation does nothing; editors can see automations but not change them.
    const orders = (await t.http.get(`/v1/sites/${site.id}/orders`).set(h).expect(200)).body.items as { id: string }[];
    await t.http.patch(`/v1/sites/${site.id}/orders/${orders[0]!.id}`).set(h).send({ status: 'SHIPPED' }).expect(409); // NEW → SHIPPED is not a move
    await t.http.patch(`/v1/sites/${site.id}/orders/${orders[0]!.id}`).set(h).send({ status: 'CONFIRMED' }).expect(200);
    await t.http.patch(`/v1/sites/${site.id}/orders/${orders[0]!.id}`).set(h).send({ status: 'SHIPPED' }).expect(200);
    await drain();
    expect(t.mailer.outbox.filter((m) => m.subject === 'On its way')).toHaveLength(0);
    const editor = await invited(t, owner, 'EDITOR');
    expect((await t.http.get(`/v1/sites/${site.id}/automations`).set(bearer(editor.accessToken)).expect(200)).body).toHaveLength(3);
    await t.http.patch(`/v1/sites/${site.id}/automations/${reply.id}`).set(bearer(editor.accessToken)).send({ enabled: false }).expect(403);
    expect((await t.http.patch(`/v1/sites/${site.id}/automations/${reply.id}`).set(h).send({ enabled: false }).expect(200)).body.enabled).toBe(false);
  });
});
