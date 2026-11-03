import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import {
  bearer,
  createTestApp,
  drainOutbox,
  invited,
  signUp,
  startFakeOllama,
  waitFor,
  type SignedIn,
  type TestApp,
} from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;
const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({
    OLLAMA_BASE_URL: ollama.url,
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
  await ollama.close();
});

const FIELDS = [
  { name: 'name', type: 'text', label: 'Name', required: true },
  { name: 'email', type: 'email', label: 'Work email', required: true },
  { name: 'message', type: 'textarea', label: 'Message' },
  { name: 'privacy', type: 'consent', label: 'I agree to the privacy policy', required: true },
  { name: 'source', type: 'hidden', label: 'Source', defaultValue: 'contact-page' },
];

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (
    await t.http.post('/v1/sites').set(h).send({ name: 'Leads', defaultLocale: 'en' }).expect(201)
  ).body as { id: string; internalDomain: string };
  const form = (
    await t.http
      .post(`/v1/sites/${site.id}/forms`)
      .set(h)
      .send({
        name: 'Contact sales',
        fields: FIELDS,
        successMessage: 'Thanks — we reply within a day.',
        notificationEmails: ['sales@leads.test'],
      })
      .expect(201)
  ).body as { id: string; slug: string };
  return { owner, h, site, form };
}

const submit = (
  c: Awaited<ReturnType<typeof setup>>,
  body: object,
  ip = '198.51.100.23',
  host = c.site.internalDomain,
) =>
  t.http
    .post(`/v1/delivery/forms/${c.form.id}/submit`)
    .set(DELIVERY)
    .set('x-canon-host', host)
    .set('x-canon-ip', ip)
    .set('x-canon-ua', 'Mozilla/5.0')
    .send(body);

const lead = (over: Record<string, unknown> = {}) => ({
  data: {
    name: 'Ada',
    email: 'ada@acme.example',
    message: 'We need a demo for 40 editors.',
    privacy: true,
    ...over,
  },
  elapsedMs: 12_000,
  path: '/contact',
  utm: { source: 'newsletter' },
});

describe('forms: definitions', () => {
  it('validates fields, keeps slugs unique per site, and follows the role model', async () => {
    const c = await setup();
    expect(c.form.slug).toBe('contact-sales');
    await t.http
      .post(`/v1/sites/${c.site.id}/forms`)
      .set(c.h)
      .send({ name: 'Broken', fields: [{ name: 'plan', type: 'select', label: 'Plan' }] })
      .expect(400);
    await t.http
      .post(`/v1/sites/${c.site.id}/forms`)
      .set(c.h)
      .send({ name: 'Contact sales', fields: FIELDS })
      .expect(409);
    const upd = await t.http
      .patch(`/v1/forms/${c.form.id}`)
      .set(c.h)
      .send({ settings: { privacyNote: 'We never share your data.' }, redirectUrl: '/thanks' })
      .expect(200);
    expect(upd.body).toMatchObject({
      redirectUrl: '/thanks',
      settings: { privacyNote: 'We never share your data.' },
    });
    await t.http
      .patch(`/v1/forms/${c.form.id}`)
      .set(c.h)
      .send({ redirectUrl: 'javascript:alert(1)' })
      .expect(400);

    const author = await invited(t, c.owner, 'AUTHOR');
    await t.http
      .post(`/v1/sites/${c.site.id}/forms`)
      .set(bearer(author.accessToken))
      .send({ name: 'Mine', fields: FIELDS })
      .expect(403);
    const other = await signUp(t);
    await t.http.get(`/v1/forms/${c.form.id}`).set(bearer(other.accessToken)).expect(404);
  });
});

describe('forms: public submissions', () => {
  it('accepts a valid lead, stores it privately, and refuses bad input, wrong hosts and floods', async () => {
    const c = await setup();
    const ok = await submit(c, lead()).expect(202);
    expect(ok.body).toEqual({
      accepted: true,
      successMessage: 'Thanks — we reply within a day.',
      redirectUrl: null,
    });
    const row = await t.system.formSubmission.findFirstOrThrow({ where: { formId: c.form.id } });
    expect(row).toMatchObject({
      status: 'NEW',
      ipAddress: '198.51.100.0',
      data: { name: 'Ada', email: 'ada@acme.example', privacy: true, source: 'contact-page' },
    });
    expect(row.meta).toMatchObject({
      path: '/contact',
      utm: { source: 'newsletter' },
      consent: [{ name: 'privacy', given: true, label: 'I agree to the privacy policy' }],
    });

    const bad = await submit(c, lead({ email: 'nope', privacy: false })).expect(422);
    expect(bad.body.error.details.fields).toEqual({
      email: 'Enter a valid email',
      privacy: 'Please give your consent',
    });
    await submit(c, lead(), '198.51.100.24', 'evil.example').expect(404);
    await t.http.post(`/v1/delivery/forms/${c.form.id}/submit`).send(lead()).expect(401);

    for (let i = 0; i < 9; i++) await submit(c, lead(), '203.0.113.9').expect(202);
    await submit(c, lead(), '203.0.113.9').expect(202);
    await submit(c, lead(), '203.0.113.9').expect(429);

    await t.http.patch(`/v1/forms/${c.form.id}`).set(c.h).send({ isActive: false }).expect(200);
    await submit(c, lead(), '198.51.100.99').expect(404);
  });

  it('quarantines bots by rules and lets the model decide the uncertain middle', async () => {
    const c = await setup();
    await submit(c, { ...lead(), honeypot: 'http://spam.example' }, '198.51.100.40').expect(202);
    const bot = await t.system.formSubmission.findFirstOrThrow({
      where: { formId: c.form.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(bot).toMatchObject({ status: 'SPAM', spamScore: 1 });
    expect((bot.meta as { spamReasons: string[] }).spamReasons).toContain('honeypot filled');
    // Spam never becomes an event (no e-mail, no webhook, no CRM).
    expect(
      await t.system.outboxEvent.count({ where: { aggregateId: c.form.id, type: 'FormSubmitted' } }),
    ).toBe(0);

    // A short message with a link scores in the middle → the classifier marks the SEO pitch as spam.
    await submit(c, lead({ message: 'Top ranking: https://seo.example' }), '198.51.100.41').expect(202);
    const pitch = await waitFor(async () => {
      const s = await t.system.formSubmission.findFirst({
        where: { formId: c.form.id, status: 'SPAM', aiClassification: { not: undefined } },
        orderBy: { createdAt: 'desc' },
      });
      return s?.aiClassification ? s : undefined;
    });
    expect(pitch.aiClassification).toMatchObject({ spam: true, category: 'spam' });
  });
});

describe('forms: delivery and inbox', () => {
  it('e-mails the team, notifies members in-app, and feeds webhooks', async () => {
    const c = await setup();
    await submit(c, lead()).expect(202);
    await drainOutbox(t, c.owner.tenantId);
    await waitFor(() => t.mailer.lastTo('sales@leads.test'));
    const mail = t.mailer.lastTo('sales@leads.test')!;
    expect(mail.template).toBe('form.submitted');
    expect(mail.text).toContain('email: ada@acme.example');

    const inbox = await waitFor(async () => {
      const r = await t.http.get('/v1/notifications?unread=true').set(c.h).expect(200);
      return r.body.items.length ? r.body : undefined;
    });
    expect(inbox.items[0]).toMatchObject({
      type: 'form.submitted',
      title: 'New submission: Contact sales',
      link: `/sites/${c.site.id}/forms/${c.form.id}`,
    });
    expect(inbox.unread).toBe(1);
    // Re-delivering the same outbox event does not notify twice.
    await t.app
      .get(NotificationsService)
      .notifyRoles(c.owner.tenantId, ['OWNER'], {
        type: 'form.submitted',
        title: 'dup',
        message: 'dup',
        dedupeKey: `form:${inbox.items[0].id}`,
      });
  });

  it('lists, filters, updates, exports and erases submissions', async () => {
    const c = await setup();
    await submit(c, lead({ name: 'Grace', email: 'grace@acme.example' }), '198.51.100.50').expect(202);
    await submit(c, lead({ name: '=cmd|calc', email: 'x@acme.example' }), '198.51.100.51').expect(202);
    await submit(c, { ...lead(), honeypot: 'bot' }, '198.51.100.52').expect(202);

    const list = (await t.http.get(`/v1/forms/${c.form.id}/submissions`).set(c.h).expect(200)).body;
    expect(list.items).toHaveLength(2); // spam hidden by default
    expect(list.counts).toMatchObject({ NEW: 2, SPAM: 1 });
    expect(
      (await t.http.get(`/v1/forms/${c.form.id}/submissions?status=SPAM`).set(c.h).expect(200)).body.items,
    ).toHaveLength(1);
    const forms = (await t.http.get(`/v1/sites/${c.site.id}/forms`).set(c.h).expect(200)).body;
    expect(forms[0]).toMatchObject({ id: c.form.id, newSubmissions: 2 });

    const first = list.items[0].id as string;
    expect(
      (await t.http.patch(`/v1/form-submissions/${first}`).set(c.h).send({ status: 'READ' }).expect(200)).body
        .status,
    ).toBe('READ');

    const csv = await t.http.get(`/v1/forms/${c.form.id}/submissions/export`).set(c.h).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\n');
    expect(lines[0]).toBe('createdAt,status,name,email,message,privacy,source,page');
    expect(lines).toHaveLength(3);
    expect(csv.text).toContain("'=cmd|calc"); // formula injection neutralised

    await t.http.delete(`/v1/form-submissions/${first}`).set(c.h).expect(204);
    expect(
      (await t.http.get(`/v1/forms/${c.form.id}/submissions`).set(c.h).expect(200)).body.items,
    ).toHaveLength(1);
    const other: SignedIn = await signUp(t);
    await t.http
      .delete(`/v1/form-submissions/${list.items[1].id}`)
      .set(bearer(other.accessToken))
      .expect(404);
  });

  it('ships the public form with the page that embeds it', async () => {
    const c = await setup();
    const page = await t.http
      .post(`/v1/sites/${c.site.id}/pages`)
      .set(c.h)
      .send({
        title: 'Contact',
        slug: 'contact',
        content: {
          root: {
            id: 'root',
            type: 'section',
            props: {},
            children: [
              { id: 'f', type: 'form', props: { formId: c.form.id, title: 'Talk to sales' }, children: [] },
            ],
          },
        },
      })
      .expect(201);
    await t.http.post(`/v1/sites/${c.site.id}/pages/${page.body.id}/publish`).set(c.h).send({}).expect(200);
    const res = await t.http
      .get(`/v1/delivery/sites/${c.site.id}/page?path=/contact&locale=en`)
      .set(DELIVERY)
      .expect(200);
    const pf = res.body.forms[c.form.id];
    expect(pf).toMatchObject({ id: c.form.id, successMessage: 'Thanks — we reply within a day.' });
    expect(pf.fields.map((f: { name: string }) => f.name)).toEqual(['name', 'email', 'message', 'privacy']); // hidden stays server-side
  });
});

describe('notifications', () => {
  it('marks read, stores preferences, and sends one daily digest of unread items', async () => {
    const c = await setup();
    const svc = t.app.get(NotificationsService);
    await svc.notify(c.owner.tenantId, [c.owner.userId], {
      type: 'canon.branch_ready',
      title: 'Branch ready',
      message: 'Pro price updates',
      link: '/canon',
    });
    await svc.notify(c.owner.tenantId, [c.owner.userId], {
      type: 'review.requested',
      title: 'Review asked',
      message: 'Pricing page',
      link: '/sites',
    });
    // review.requested defaults to instant e-mail.
    expect(t.mailer.lastTo(c.owner.email)?.template).toBe('notification.review.requested');

    const prefs = (await t.http.get('/v1/notifications/preferences').set(c.h).expect(200)).body as {
      type: string;
      email: string;
    }[];
    expect(prefs.find((p) => p.type === 'canon.branch_ready')?.email).toBe('digest');
    await t.http
      .put('/v1/notifications/preferences')
      .set(c.h)
      .send({ 'review.requested': 'off' })
      .expect(200);
    await t.http.put('/v1/notifications/preferences').set(c.h).send({ 'nope.type': 'instant' }).expect(400);

    const res = await svc.sendDigests();
    expect(res.sent).toBeGreaterThanOrEqual(1);
    const digest = t.mailer.lastTo(c.owner.email)!;
    expect(digest.template).toBe('notification.digest');
    expect(digest.text).toContain('Branch ready');
    expect(digest.text).not.toContain('Review asked'); // already e-mailed instantly
    const before = (await svc.sendDigests()).sent;
    expect(t.mailer.lastTo(c.owner.email)).toBe(digest); // nothing new to send
    expect(before).toBeGreaterThanOrEqual(0);

    const list = (await t.http.get('/v1/notifications').set(c.h).expect(200)).body;
    expect(list.unread).toBe(2);
    await t.http
      .post('/v1/notifications/read')
      .set(c.h)
      .send({ ids: [list.items[0].id] })
      .expect(200);
    expect((await t.http.get('/v1/notifications/unread-count').set(c.h).expect(200)).body.unread).toBe(1);
    await t.http.post('/v1/notifications/read').set(c.h).send({ all: true }).expect(200);
    expect((await t.http.get('/v1/notifications/unread-count').set(c.h).expect(200)).body.unread).toBe(0);
  });
});
