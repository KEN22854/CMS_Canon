import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { APP_CONFIG, type AppConfig } from '../../src/config/env';
import { OutboxRelay } from '../../src/infrastructure/events/outbox';
import { MemoryMailer } from '../../src/infrastructure/mail/mailer';
import { SystemPrismaService } from '../../src/infrastructure/prisma/prisma.service';

export const PASSWORD = 'correct horse battery staple 42';

/**
 * Stand-in for Ollama's /api/chat so AI flows run end-to-end (gateway → quota → ledger) without
 * a GPU or API keys. A prompt containing "[slow]" holds the response to test concurrency limits.
 */
export async function startFakeOllama(): Promise<{ url: string; close: () => Promise<void>; calls: number }> {
  const state = { calls: 0 };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url === '/api/embed') {
        // Hashed bag-of-words: deterministic, and texts sharing words land close together.
        const input = (JSON.parse(raw || '{}') as { input?: string[] }).input ?? [];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: input.map(fakeEmbedding), prompt_eval_count: input.join(' ').split(/\s+/).length }));
        return;
      }
      state.calls += 1;
      const body = JSON.parse(raw || '{}') as { messages?: { content: string; images?: string[] }[]; stream?: boolean; format?: string };
      const lastMsg = body.messages?.at(-1);
      const last = lastMsg?.content ?? '';
      const transcript = (body.messages ?? []).map((m) => m.content).join('\n');
      const reply = fakeReply(last, body.format === 'json', Boolean(lastMsg?.images?.length), transcript);
      const send = () => {
        if (body.stream) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.write(`${JSON.stringify({ message: { content: reply.slice(0, 5) }, done: false })}\n`);
          res.end(`${JSON.stringify({ message: { content: reply.slice(5) }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 6 })}\n`);
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: { content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 6 }));
      };
      if (last.includes('[slow]')) setTimeout(send, 400);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Deterministic stand-ins for the shapes our prompts ask for: JSON translations (prefixed so tests
 * can see what was translated), an SEO object, a vision description, else an echo.
 */
function fakeReply(user: string, json: boolean, hasImage: boolean, transcript = user): string {
  const builder = builderReply(user, hasImage, transcript) ?? collectionsReply(user) ?? canonReply(user, transcript) ?? experiencesReply(user);
  if (builder) return builder;
  if (hasImage) return 'A purple square with a yellow circle in the middle';
  if (json) {
    const m = user.match(/<text>\n([\s\S]*)\n<\/text>/);
    if (m) {
      try {
        const arr = JSON.parse(m[1]!) as string[];
        if (Array.isArray(arr) && user.startsWith('Rewrite the text below')) return JSON.stringify({ texts: arr.map((t) => t.toUpperCase()) });
        if (Array.isArray(arr)) return JSON.stringify({ translations: arr.map((t) => (t.trim() ? `[tr] ${t}` : t)) });
      } catch {
        /* not a translation request */
      }
    }
    return JSON.stringify({ title: 'Simple, fair pricing', description: 'Plans for every team size.', keywords: ['pricing', 'plans'] });
  }
  return `echo: ${user.slice(0, 40)}`;
}

/**
 * Phase 6 prompts, each with a built-in temptation the server must resist: insights cite a path
 * that isn't in the data, the recommender declares a winner too early, and one suggested variant
 * is too long for its block.
 */
function experiencesReply(user: string): string | null {
  if (user.startsWith('<data>')) {
    return JSON.stringify({
      summary: 'Traffic grew and the pricing page converts.',
      insights: [
        { title: 'Pricing converts', detail: 'Most conversions start on /pricing.', severity: 'positive', path: '/pricing' },
        { title: 'Ghost page', detail: 'Invented.', severity: 'info', path: '/does-not-exist' },
      ],
      recommendations: [{ title: 'Test the hero', detail: 'Try a benefit-led headline.', action: 'ab_test', path: '/pricing' }],
    });
  }
  if (user.includes('<stats>')) return JSON.stringify({ decision: 'declare_winner', winnerVariantId: 'b', reasoning: 'B looks better already.', nextSteps: ['Ship B'] });
  const texts = user.match(/<texts>\n([\s\S]*?)\n<\/texts>/);
  if (texts) {
    const orig = JSON.parse(texts[1]!) as Record<string, string>;
    const map = (f: (v: string) => string) => Object.fromEntries(Object.entries(orig).map(([k, v]) => [k, f(v)]));
    return JSON.stringify({
      variants: [
        { name: 'Benefit-led', hypothesis: 'Outcomes beat features', texts: map((v) => `Benefit: ${v}`) },
        { name: 'Too long', hypothesis: 'More words', texts: map(() => 'x'.repeat(600)) },
      ],
    });
  }
  return null;
}

export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 1536]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const WORD_NUMBERS: Record<string, number> = { 'thirty-nine': 39, 'forty-nine': 49, 'fifty-nine': 59 };

/**
 * Phase 5 prompts: grounded answers cite the first fact and source; extraction reports spelled-out
 * prices the deterministic linter can't read; the copywriter swaps the old number for the new one
 * ("[escalate]" and "[keep-old]" in the span steer failures); agents call one tool, then finish.
 */
function canonReply(user: string, transcript: string): string | null {
  if (user.includes('<sources>') && user.includes('<question>')) {
    const fact = user.match(/\[F1\][^:]*:\s*([^\n(]+?)\s*\(key/);
    const source = user.includes('<source n="1"');
    if (!fact && !source) return 'I could not find that in the site content.';
    return `${fact ? `It is ${fact[1]} [F1].` : 'See the page.'}${source ? ' Details are on the page [1].' : ''}`;
  }
  if (user.includes('<known_facts>')) {
    const money = user.split('\n').find((l) => /\|\s*MONEY\s*\|/.test(l));
    const key = money?.split('|')[0]?.trim();
    const claims = [...user.matchAll(/\b((?:thirty|forty|fifty)-nine) dollars\b/gi)].map((m) => ({ subject: { type: 'plan', name: 'Pro' }, predicate: 'monthly_price', valueType: 'MONEY', value: { amount: WORD_NUMBERS[m[1]!.toLowerCase()], currency: 'USD' }, surfaceText: m[0], matchesFactKey: key, confidence: 0.9 }));
    if (/support hours/i.test(user)) claims.push({ subject: { type: 'org', name: 'Acme' }, predicate: 'support_hours', valueType: 'TEXT', value: { text: '24/7' } as never, surfaceText: 'support hours', matchesFactKey: undefined, confidence: 0.6 });
    return JSON.stringify({ claims });
  }
  if (user.includes('Old value:') && user.includes('<span>')) {
    const span = user.match(/<span>([\s\S]*?)<\/span>/)?.[1] ?? '';
    const next = user.match(/New value: ([^\n]+)/)?.[1] ?? '';
    if (span.includes('[escalate]') || transcript.includes('[escalate]')) return JSON.stringify({ action: 'escalate', reason: 'Comparison cannot stay true' });
    if (transcript.includes('[keep-old]')) return JSON.stringify({ action: 'replace', text: span, explanation: 'unchanged' });
    const n = next.match(/\d+(?:\.\d+)?/)?.[0] ?? next;
    const text = /\d/.test(span) ? span.replace(/\d+(?:[.,]\d+)?/, n) : next;
    return JSON.stringify({ action: 'replace', text, explanation: `Updated to ${next}` });
  }
  if (user.includes('<proposed>')) return JSON.stringify({ verdict: 'pass', issues: [], confidence: 0.9 });
  if (user.startsWith('<observation')) return JSON.stringify({ thought: 'I have what I need', final: `Answer based on ${user.slice(0, 120)}` });
  if (user.includes('[agent]')) {
    const key = user.match(/fact:([a-z0-9_.]+)/)?.[1] ?? 'missing.key';
    return JSON.stringify({ thought: 'Look up the fact', tool: user.includes('[forbidden-tool]') ? 'content.delete' : 'canon.get_fact', input: { key } });
  }
  return null;
}

/**
 * Collections prompts: enrichment returns tags in mixed case (one outside any vocabulary) so tests
 * see normalisation and filtering; schema suggestion includes a reserved field name to be dropped.
 */
function collectionsReply(user: string): string | null {
  const entry = user.match(/<entry>\n([\s\S]*)\n<\/entry>/);
  if (entry) {
    const text = entry[1]!;
    return JSON.stringify({ summary: `About: ${text.split('\n')[0]!.slice(0, 60)}`, tags: ['Pricing', 'Brand New Tag', 'security', 'pricing'], quality: { score: 80, issues: ['Add a concrete example'] } });
  }
  if (user.includes('<description>')) {
    return JSON.stringify({
      name: 'Recipes',
      slug: 'recipes',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'slug', label: 'Slug', type: 'text' },
        { name: 'difficulty', label: 'Difficulty', type: 'select', options: ['easy', 'hard'] },
        { name: 'steps', label: 'Steps', type: 'richtext' },
      ],
    });
  }
  return null;
}

/**
 * Page builder prompts. Markers in the brief steer the outcome: "[broken]" returns one invalid
 * block first (repaired on the validator's follow-up), "[garbage]" never returns JSON.
 */
function builderReply(user: string, hasImage: boolean, transcript: string): string | null {
  const good = [
    { type: 'hero', props: { title: hasImage ? 'From your screenshot' : 'Ship faster', subtitle: 'One plan: {{fact:pro.price}}', ctaLabel: 'Start', ctaHref: '/signup' } },
    { type: 'text', props: { doc: 'Pro costs {{fact:pro.price}} per month.\n\nNo surprises {{fact:made.up}}.' } },
    { type: 'row', children: [{ type: 'column', children: [{ type: 'heading', props: { text: 'Left', level: '3' } }] }, { type: 'column' }] },
    { type: 'cta', props: { title: 'Ready?', buttonLabel: 'Go', buttonHref: '/signup' } },
  ];
  if (transcript.includes('[garbage]')) return 'I would love to help, but here is prose instead of JSON.';
  if (user.includes('rejected by the validator')) return JSON.stringify({ title: 'Fixed page', description: 'Repaired.', blocks: good });
  if (user.includes('<brief>')) {
    if (user.includes('[garbage]')) return 'I would love to help, but here is prose instead of JSON.';
    const blocks = user.includes('[broken]') ? [...good, { type: 'button', props: { label: 'Bad', href: 'javascript:alert(1)' } }] : good;
    return JSON.stringify({ title: 'Pricing that scales', description: 'Plans for teams.', blocks });
  }
  if (user.includes('<request>')) {
    if (user.includes('Use block type "stats"')) return JSON.stringify({ block: { type: 'stats', props: { items: [{ value: '{{fact:pro.price}}', label: 'Pro plan' }] } } });
    return JSON.stringify({ block: { type: 'faq', props: { title: 'Questions', items: [{ q: 'Is it fast?', a: 'Yes.' }] } } });
  }
  return null;
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  mailer: MemoryMailer;
  system: SystemPrismaService;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createTestApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, inject('testEnv'), extraEnv);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true });
  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    mailer: app.get(MemoryMailer),
    system: app.get(SystemPrismaService),
    config,
    close: () => app.close(),
  };
}

/** Distinct client IP per call so IP-based auth rate limits don't couple unrelated tests. */
export function ip(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomBytes(4).toString('hex')}@canon.test`;
}

export function tokenFromMail(mailer: MemoryMailer, to: string, pattern: RegExp): string {
  const mail = mailer.lastTo(to);
  const m = mail?.text.match(pattern);
  if (!m?.[1]) throw new Error(`No token matching ${pattern} in mail to ${to}: ${mail?.text ?? '(none)'}`);
  return m[1];
}

export function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? '')];
  const c = list.find((x) => x.startsWith('canon_rt='));
  if (!c) throw new Error('No refresh cookie in response');
  return c.split(';')[0]!;
}

export interface SignedIn {
  email: string;
  accessToken: string;
  cookie: string;
  userId: string;
  tenantId: string;
}

/** Full happy path: register → verification mail → verify (auto sign-in). */
export async function signUp(t: TestApp, opts: { email?: string; name?: string; tenantName?: string } = {}): Promise<SignedIn> {
  const email = opts.email ?? uniqueEmail();
  await t.http
    .post('/v1/auth/register')
    .set('x-forwarded-for', ip())
    .send({ email, password: PASSWORD, name: opts.name ?? 'Test User', tenantName: opts.tenantName ?? 'Test Workspace' })
    .expect(202);
  const token = tokenFromMail(t.mailer, email, /verify-email\?token=([\w-]+)/);
  const res = await t.http.post('/v1/auth/verify-email').set('x-forwarded-for', ip()).send({ token }).expect(200);
  return { email, accessToken: res.body.accessToken, cookie: refreshCookie(res), userId: res.body.user.id, tenantId: res.body.tenant.id };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Delivers this tenant's pending outbox events. One tick is not enough: test files share a
 * database, so another app's poller may hold the batch lock (tick() then returns 0) or the batch
 * may be full of other tenants' events.
 */
export async function drainOutbox(t: TestApp, tenantId: string): Promise<void> {
  const relay = t.app.get(OutboxRelay);
  for (let i = 0; i < 200; i++) {
    await relay.tick();
    const pending = await t.system.outboxEvent.count({ where: { tenantId, publishedAt: null } });
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const stuck = await t.system.outboxEvent.findMany({ where: { tenantId, publishedAt: null }, select: { type: true, attempts: true } });
  throw new Error(`outbox for tenant ${tenantId} did not drain: ${JSON.stringify(stuck)}`);
}

/** Minimal Stripe stand-in: records calls; subscriptions are whatever the test puts in the map. */
export async function startFakeStripe() {
  const state = {
    calls: [] as { method: string; path: string; form: Record<string, string> }[],
    subscriptions: new Map<string, Record<string, unknown>>(),
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.calls.push({ method: req.method ?? '', path, form });
      const json = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
      if (req.headers.authorization !== 'Bearer sk_test_fake') return json(401, { error: { message: 'bad key' } });
      if (path === '/v1/customers') return json(200, { id: `cus_${randomBytes(4).toString('hex')}` });
      if (path === '/v1/checkout/sessions') return json(200, { id: 'cs_test', url: `https://checkout.stripe.test/${form.client_reference_id}` });
      if (path === '/v1/billing_portal/sessions') return json(200, { url: `https://billing.stripe.test/${form.customer}` });
      if (path === '/v1/billing/meter_events') return json(200, { identifier: form.identifier });
      const sub = /^\/v1\/subscriptions\/(.+)$/.exec(path);
      if (sub) return state.subscriptions.has(sub[1]!) ? json(200, state.subscriptions.get(sub[1]!)) : json(404, { error: { message: 'no such subscription' } });
      json(404, { error: { message: `unhandled ${path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Invites `role` into the owner's tenant and registers the invitee. */
export async function invited(t: TestApp, owner: SignedIn, role: string): Promise<SignedIn> {
  const email = uniqueEmail(role.toLowerCase());
  await t.http.post(`/v1/tenants/${owner.tenantId}/members/invite`).set(bearer(owner.accessToken)).send({ email, role }).expect(201);
  const token = tokenFromMail(t.mailer, email, /invite\/([\w-]+)/);
  const r = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: role, inviteToken: token }).expect(201);
  return { email, accessToken: r.body.accessToken, cookie: refreshCookie(r), userId: r.body.user.id, tenantId: r.body.tenant.id };
}

/** HTTP receiver for outbound webhooks: records every request; `status` sets the reply code. */
export async function startReceiver() {
  const state = { status: 200, requests: [] as { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      state.requests.push({ path: req.url ?? '', headers: req.headers, body: raw });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
