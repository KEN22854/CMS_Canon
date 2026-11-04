import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, invited, signUp, type TestApp } from './harness';

const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra';
let t: TestApp;
let fake: Server;
const calls: { method: string; token: string; body: { chat_id?: string; text?: string; parse_mode?: string } }[] = [];

beforeAll(async () => {
  // A stand-in for api.telegram.org: accepts one token, records every call.
  fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = req.url!.match(/^\/bot([^/]+)\/(\w+)$/);
      const body = raw ? JSON.parse(raw) : {};
      if (m) calls.push({ token: m[1]!, method: m[2]!, body });
      const ok = m?.[1] === TOKEN;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true, result: m![2] === 'getMe' ? { username: 'bakery_bot' } : { message_id: 1 } } : { ok: false, description: 'Unauthorized' }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  t = await createTestApp({ TELEGRAM_API_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off', FORMS_AI: 'off' });
});

afterAll(async () => {
  await t.close();
  await new Promise((r) => fake.close(r));
});

describe('Telegram integration', () => {
  it('connects a bot (encrypted token), posts orders and form requests, and powers automations', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Bakery', defaultLocale: 'en' }).expect(201)).body as { id: string; internalDomain: string };
    const s = `/v1/sites/${site.id}`;

    expect((await t.http.get(`${s}/integrations/telegram`).set(h).expect(200)).body).toEqual({ connected: false });
    await t.http.put(`${s}/integrations/telegram`).set(h).send({ botToken: 'nope', chatId: '-1001234567890' }).expect(400);
    expect((await t.http.put(`${s}/integrations/telegram`).set(h).send({ botToken: '999999:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-xx', chatId: '-1001234567890' }).expect(400)).body.error.code).toBe('TELEGRAM_TOKEN');
    const st = (await t.http.put(`${s}/integrations/telegram`).set(h).send({ botToken: TOKEN, chatId: '-1001234567890', events: ['order.placed', 'form.submitted'] }).expect(200)).body;
    expect(st).toEqual({ connected: true, chatId: '-1001234567890', events: ['order.placed', 'form.submitted'], tokenHint: '…K-ra', botName: 'bakery_bot' });
    // The token is never stored or returned in the clear.
    const row = await t.system.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(JSON.stringify(row.settings)).not.toContain(TOKEN);
    expect(JSON.stringify((await t.http.get(`${s}`).set(h).expect(200)).body)).not.toContain(TOKEN);

    await t.http.post(`${s}/integrations/telegram/test`).set(h).send({}).expect(200);
    expect(calls.at(-1)).toMatchObject({ method: 'sendMessage', body: { chat_id: '-1001234567890' } });
    expect(calls.at(-1)!.body.parse_mode).toBeUndefined(); // plain text only

    // A shop order and a form request reach the chat; an automation sends its own message.
    const col = (await t.http.post(`${s}/collections`).set(h).send({ name: 'Products', slug: 'products', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'price', label: 'Price', type: 'number' }] }).expect(201)).body as { id: string };
    await t.http.patch(`${s}/collections/${col.id}`).set(h).send({ settings: { commerce: { priceField: 'price', currency: 'EUR', paymentMethods: ['cash'] } } }).expect(200);
    const cake = (await t.http.post(`${s}/collections/${col.id}/entries`).set(h).send({ data: { name: 'Cake', price: 30 } }).expect(201)).body as { id: string };
    await t.http.post(`${s}/collections/${col.id}/entries/${cake.id}/publish`).set(h).send({}).expect(200);
    await t.http.post(`${s}/automations`).set(h).send({ name: 'Ping', trigger: { event: 'order.placed' }, actions: [{ type: 'telegram', text: 'VIP alert: {{contact.name}} spent {{order.total}}' }] }).expect(201);
    await t.http.post(`/v1/delivery/sites/${site.id}/orders`).set({ ...DELIVERY, 'x-canon-host': site.internalDomain, 'x-canon-ip': '10.9.9.9' }).send({ items: [{ productId: cake.id, quantity: 2 }], customer: { name: 'Ada <b>Buyer</b>', email: 'ada@example.test', phone: '+1 555' }, paymentMethod: 'cash' }).expect(201);
    const form = (await t.http.post(`${s}/forms`).set(h).send({ name: 'Catering', fields: [{ name: 'email', type: 'email', label: 'Email', required: true }, { name: 'message', type: 'textarea', label: 'Message' }] }).expect(201)).body as { id: string };
    await t.http.post(`/v1/delivery/forms/${form.id}/submit`).set({ ...DELIVERY, 'x-canon-host': site.internalDomain, 'x-canon-ip': '198.51.100.9', 'x-canon-ua': 'Mozilla/5.0' }).send({ data: { email: 'bob@example.test', message: 'Cake for 40?' }, elapsedMs: 9000 }).expect(202);
    await drainOutbox(t, owner.tenantId);
    await drainOutbox(t, owner.tenantId);

    const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text ?? '');
    const order = texts.find((x) => x.includes('order #1001'));
    expect(order).toContain('2 × Cake — €60.00');
    expect(order).toContain('Ada <b>Buyer</b> · ada@example.test · +1 555'); // sent as text, never rendered
    expect(texts.filter((x) => x.includes('order #1001'))).toHaveLength(1); // once, even after two drains
    expect(texts.find((x) => x.includes('“Catering”'))).toContain('message: Cake for 40?');
    expect(texts).toContain('VIP alert: Ada <b>Buyer</b> spent €60.00');

    // Only site admins manage it; disconnecting stops the messages.
    const editor = await invited(t, owner, 'EDITOR');
    await t.http.put(`${s}/integrations/telegram`).set(bearer(editor.accessToken)).send({ chatId: '@bakery' }).expect(403);
    await t.http.put(`${s}/integrations/telegram`).set(h).send({ chatId: '@bakery_news', events: ['order.placed'] }).expect(200); // token kept
    await t.http.delete(`${s}/integrations/telegram`).set(h).expect(204);
    expect((await t.http.get(`${s}/integrations/telegram`).set(h).expect(200)).body).toEqual({ connected: false });
  });
});
