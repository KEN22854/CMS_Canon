import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, invited, signUp, type TestApp } from './harness';

const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off' });
});

afterAll(async () => {
  await t.close();
});

const node = (id: string, type: string, props: Record<string, unknown>, children: unknown[] = []) => ({ id, type, props, children });

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Bakery', defaultLocale: 'en' }).expect(201)).body as { id: string; internalDomain: string };
  const base = `/v1/sites/${site.id}/collections`;
  const fields = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'price', label: 'Price', type: 'number' },
    { name: 'stock', label: 'Stock', type: 'number' },
    { name: 'sku', label: 'SKU', type: 'text' },
  ];
  const shop = (await t.http.post(base).set(h).send({ name: 'Products', slug: 'products', fields }).expect(201)).body as { id: string };
  // Commerce settings must point at number fields.
  await t.http.patch(`${base}/${shop.id}`).set(h).send({ settings: { commerce: { priceField: 'name', currency: 'EUR', paymentMethods: ['cash'] } } }).expect(400);
  await t.http.patch(`${base}/${shop.id}`).set(h).send({ settings: { commerce: { priceField: 'price', stockField: 'stock', skuField: 'sku', currency: 'EUR', paymentMethods: ['cash', 'transfer'], orderEmail: 'shop@bakery.test' } } }).expect(200);

  const product = async (data: Record<string, unknown>, publish = true) => {
    const e = (await t.http.post(`${base}/${shop.id}/entries`).set(h).send({ data }).expect(201)).body as { id: string; slug: string };
    if (publish) await t.http.post(`${base}/${shop.id}/entries/${e.id}/publish`).set(h).send({}).expect(200);
    return e;
  };
  const checkout = (body: object, host = site.internalDomain) => t.http.post(`/v1/delivery/sites/${site.id}/orders`).set({ ...DELIVERY, 'x-canon-host': host, 'x-canon-ip': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).send(body);
  const customer = { name: 'Ada Buyer', email: 'Ada@Example.test', address: '1 Bread St' };
  return { owner, h, site, base, shop, product, checkout, customer };
}

describe('checkout', () => {
  it('prices from published products, merges lines, takes stock atomically and numbers orders per site', async () => {
    const { owner, h, site, product, checkout, customer, base, shop } = await setup();
    const rye = await product({ name: 'Rye loaf', price: 4.5, stock: 3, sku: 'RYE-1' });
    const jam = await product({ name: 'Jam', price: 2.25 }); // no stock value: unlimited

    // The client can't set prices: extra keys are ignored, amounts come from the snapshot.
    const res = await checkout({ items: [{ productId: rye.id, quantity: 1, price: 0.01 }, { productId: jam.id, quantity: 3 }, { productId: rye.id, quantity: 1 }], customer, paymentMethod: 'cash', elapsedMs: 5000 }).expect(201);
    expect(res.body).toMatchObject({ number: 1001, status: 'NEW', currency: 'EUR', total: 2 * 450 + 3 * 225 });
    expect(res.body.items).toEqual([
      { title: 'Rye loaf', quantity: 2, unitPrice: 450, lineTotal: 900 },
      { title: 'Jam', quantity: 3, unitPrice: 225, lineTotal: 675 },
    ]);
    // Confirmation to the buyer, a heads-up to the shop.
    expect(t.mailer.lastTo('ada@example.test')?.template).toBe('order-placed');
    expect(t.mailer.lastTo('shop@bakery.test')?.subject).toContain('#1001');

    // One rye left: asking for two fails and changes nothing; one succeeds.
    const out = await checkout({ items: [{ productId: rye.id, quantity: 2 }], customer, paymentMethod: 'cash' }).expect(409);
    expect(out.body.error).toMatchObject({ code: 'OUT_OF_STOCK', details: { available: 1 } });
    expect((await checkout({ items: [{ productId: rye.id, quantity: 1 }], customer: { ...customer, email: 'kurt@example.test' }, paymentMethod: 'transfer', locale: 'de' }).expect(201)).body.number).toBe(1002);
    // The buyer's email speaks the page's language.
    const de = t.mailer.lastTo('kurt@example.test')!;
    expect(de.subject).toBe('Bakery: Bestellung Nr. 1002 eingegangen');
    expect(de.text).toContain('Zahlung: Banküberweisung');
    // Stock shows up in the working copy too (so a later publish doesn't undo it).
    expect((await t.http.get(`${base}/${shop.id}/entries/${rye.id}`).set(h).expect(200)).body.data.stock).toBe(0);

    // Product pages see the stock through Buy blocks.
    const p = (await t.http.post(`/v1/sites/${site.id}/pages`).set(h).send({ title: 'Shop', slug: 'shop' }).expect(201)).body as { id: string; version: number };
    await t.http.patch(`/v1/sites/${site.id}/pages/${p.id}`).set(h).send({ expectedVersion: p.version, content: { root: node('root', 'section', {}, [node('b1', 'buy', { productId: rye.id }), node('b2', 'buy', { productId: jam.id }), node('c', 'cart', {})]) } }).expect(200);
    await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/publish`).set(h).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);
    const page = (await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/shop' }).set(DELIVERY).expect(200)).body;
    expect(page.products[rye.id]).toMatchObject({ title: 'Rye loaf', price: 450, currency: 'EUR', stock: 0, available: false });
    expect(page.products[jam.id]).toMatchObject({ stock: null, available: true });
    expect(page.shop).toMatchObject({ currency: 'EUR', paymentMethods: ['cash', 'transfer'] });
  });

  it('refuses what a shop should refuse', async () => {
    const { product, checkout, customer } = await setup();
    const bread = await product({ name: 'Bread', price: 3 });
    const draft = await product({ name: 'Secret', price: 1 }, false);
    const noPrice = await product({ name: 'Free?' });
    const ok = { customer, paymentMethod: 'cash' };
    expect((await checkout({ ...ok, items: [{ productId: draft.id, quantity: 1 }] }).expect(409)).body.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: { productIds: [draft.id] } });
    expect((await checkout({ ...ok, items: [{ productId: noPrice.id, quantity: 1 }] }).expect(409)).body.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await checkout({ ...ok, paymentMethod: 'card_on_delivery', items: [{ productId: bread.id, quantity: 1 }] }).expect(400)).body.error.code).toBe('PAYMENT_METHOD');
    expect((await checkout({ ...ok, items: [{ productId: bread.id, quantity: 1 }], honeypot: 'http://spam' }).expect(422)).body.error.code).toBe('REJECTED');
    await checkout({ ...ok, items: [{ productId: bread.id, quantity: 100 }] }).expect(400);
    await checkout({ ...ok, customer: { ...customer, email: 'nope' }, items: [{ productId: bread.id, quantity: 1 }] }).expect(400);
    // Another host can't place orders for this site; another site's products aren't sold here.
    await checkout({ ...ok, items: [{ productId: bread.id, quantity: 1 }] }, 'evil.example.com').expect(404);
    const other = await setup();
    const theirs = await other.product({ name: 'Other bread', price: 3 });
    await checkout({ ...ok, items: [{ productId: theirs.id, quantity: 1 }] }).expect(409);
    await t.http.post(`/v1/delivery/sites/x/orders`).send({}).expect(401); // delivery token required
  });
});

describe('orders in the admin', () => {
  it('lists, finds and moves orders; cancelling returns the stock; only shop staff see them', async () => {
    const { owner, h, site, base, shop, product, checkout, customer } = await setup();
    const cake = await product({ name: 'Cake', price: 20, stock: 2 });
    await checkout({ items: [{ productId: cake.id, quantity: 2 }], customer, paymentMethod: 'cash' }).expect(201);
    await checkout({ items: [{ productId: cake.id, quantity: 1 }], customer, paymentMethod: 'cash' }).expect(409);

    const list = (await t.http.get(`/v1/sites/${site.id}/orders`).set(h).expect(200)).body;
    expect(list).toMatchObject({ total: 1, counts: { NEW: 1 } });
    const order = list.items[0] as { id: string; number: number; allowed: string[]; customer: { email: string } };
    expect(order).toMatchObject({ number: 1001, allowed: ['CONFIRMED', 'PAID', 'CANCELLED'], customer: { email: 'ada@example.test' } });
    expect((await t.http.get(`/v1/sites/${site.id}/orders`).query({ q: '#1001' }).set(h).expect(200)).body.total).toBe(1);
    expect((await t.http.get(`/v1/sites/${site.id}/orders`).query({ q: 'ada@' }).set(h).expect(200)).body.total).toBe(1);
    expect((await t.http.get(`/v1/sites/${site.id}/orders`).query({ status: 'PAID' }).set(h).expect(200)).body.total).toBe(0);

    const move = (status: string) => t.http.patch(`/v1/sites/${site.id}/orders/${order.id}`).set(h).send({ status, note: 'by phone' });
    await move('SHIPPED').expect(409);
    expect((await move('CONFIRMED').expect(200)).body).toMatchObject({ status: 'CONFIRMED', allowed: ['PAID', 'SHIPPED', 'CANCELLED'] });
    const cancelled = (await move('CANCELLED').expect(200)).body as { history: { status: string; note?: string }[] };
    expect(cancelled.history.map((x) => x.status)).toEqual(['NEW', 'CONFIRMED', 'CANCELLED']);
    await move('PAID').expect(409);
    // The two cakes are back on the shelf.
    expect((await t.http.get(`${base}/${shop.id}/entries/${cake.id}`).set(h).expect(200)).body.data.stock).toBe(2);
    await drainOutbox(t, owner.tenantId);
    await checkout({ items: [{ productId: cake.id, quantity: 2 }], customer, paymentMethod: 'cash' }).expect(201);

    // Editors run the shop; viewers don't see customers' data (nor authors: same rule); other workspaces see nothing.
    const editor = await invited(t, owner, 'EDITOR');
    await t.http.get(`/v1/sites/${site.id}/orders`).set(bearer(editor.accessToken)).expect(200);
    const viewer = await invited(t, owner, 'VIEWER');
    await t.http.get(`/v1/sites/${site.id}/orders`).set(bearer(viewer.accessToken)).expect(403);
    await t.http.patch(`/v1/sites/${site.id}/orders/${order.id}`).set(bearer(viewer.accessToken)).send({ status: 'PAID' }).expect(403);
    const stranger = await signUp(t);
    await t.http.get(`/v1/sites/${site.id}/orders/${order.id}`).set(bearer(stranger.accessToken)).expect(404);
  });
});
