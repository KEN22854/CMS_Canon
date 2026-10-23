import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PropagationService } from '../../src/modules/canon/propagation.service';
import { bearer, createTestApp, drainOutbox, signUp, startFakeOllama, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url, KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off' });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

type Inline = { type: 'text'; text: string } | { type: 'factRef'; attrs: { factKey: string } };
const doc = (...parts: (string | { fact: string })[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: parts.map((p): Inline => (typeof p === 'string' ? { type: 'text', text: p } : { type: 'factRef', attrs: { factKey: p.fact } })) }] });
const tree = (...children: object[]) => ({ root: { id: 'root', type: 'section', props: {}, children } });

interface Ctx {
  owner: SignedIn;
  h: Record<string, string>;
  siteId: string;
}

async function setup(): Promise<Ctx> {
  const owner = await signUp(t);
  const site = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Canon Site', defaultLocale: 'en', locales: ['en', 'de'] }).expect(201);
  return { owner, h: bearer(owner.accessToken), siteId: site.body.id };
}

async function priceFact(c: Ctx, amount = 49) {
  const res = await t.http.post('/v1/canon/facts').set(c.h).send({ key: 'pro_plan.price', subject: { type: 'plan', name: 'Pro plan' }, predicate: 'monthly_price', valueType: 'MONEY', value: { amount, currency: 'USD', period: 'month' } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; displayValue: string; version: number };
}

async function page(c: Ctx, slug: string, ...blocks: object[]) {
  const res = await t.http.post(`/v1/sites/${c.siteId}/pages`).set(c.h).send({ title: slug, slug, content: tree(...blocks) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number };
}

const scan = (c: Ctx, id: string, llm = true) => t.http.post('/v1/canon/scan').set(c.h).send({ type: 'PAGE', id, llm }).expect(200);

describe('facts', () => {
  it('formats typed values, refuses duplicate keys and validates types', async () => {
    const c = await setup();
    const f = await priceFact(c);
    expect(f.displayValue).toBe('$49/month');
    await t.http.post('/v1/canon/facts').set(c.h).send({ key: 'pro_plan.price', subject: { type: 'plan', name: 'Pro plan' }, predicate: 'x', valueType: 'MONEY', value: { amount: 1 } }).expect(409);
    await t.http.post('/v1/canon/facts').set(c.h).send({ key: 'Bad Key', subject: { type: 'plan', name: 'Pro' }, predicate: 'x', valueType: 'TEXT', value: { text: 'a' } }).expect(400);
    const other = await signUp(t);
    await t.http.get(`/v1/canon/facts/${f.id}`).set(bearer(other.accessToken)).expect(404);
  });
});

describe('mentions (the linter)', () => {
  it('finds bound tokens, deterministic matches/conflicts and model-only paraphrases', async () => {
    const c = await setup();
    const f = await priceFact(c);
    const p = await page(c, 'pricing', { id: 't1', type: 'text', props: { doc: doc('The Pro plan costs $39 per month.') } }, { id: 't2', type: 'text', props: { doc: doc('Today: ', { fact: 'pro_plan.price' }) } }, { id: 't3', type: 'text', props: { doc: doc('Pro is just forty-nine dollars monthly.') } });
    const res = await scan(c, p.id);
    expect(res.body).toMatchObject({ mentions: 3, conflicts: 1 });
    const impact = await t.http.get(`/v1/canon/facts/${f.id}/impact`).set(c.h).expect(200);
    expect(impact.body.totals).toMatchObject({ mentions: 3, bound: 1, detected: 2, conflicts: 1, entities: 1 });
    const spans = impact.body.entities[0].mentions.map((m: { surfaceText: string; kind: string; state: string }) => `${m.kind}:${m.state}:${m.surfaceText}`).sort();
    expect(spans).toEqual(['BOUND:IN_SYNC:{{fact:pro_plan.price}}', 'DETECTED:CONFLICT:$39', 'DETECTED:IN_SYNC:forty-nine dollars']);

    const inbox = await t.http.get(`/v1/canon/conflicts?siteId=${c.siteId}`).set(c.h).expect(200);
    expect(inbox.body).toEqual([expect.objectContaining({ surfaceText: '$39', state: 'CONFLICT', blockId: 't1', fieldPath: 'doc', fact: expect.objectContaining({ key: 'pro_plan.price' }), entity: expect.objectContaining({ title: 'pricing', path: '/pricing' }) })]);

    const lint = await t.http.post('/v1/canon/lint').set(c.h).send({ siteId: c.siteId, text: 'Our Pro plan is $45.' }).expect(200);
    expect(lint.body.findings).toEqual([expect.objectContaining({ key: 'pro_plan.price', surfaceText: '$45', inSync: false, canonical: '$49/month' })]);
  });

  it('keeps dismissed spans dismissed across re-scans, and works without the model', async () => {
    const c = await setup();
    await priceFact(c);
    const p = await page(c, 'old-post', { id: 't1', type: 'text', props: { doc: doc('Back in 2024 the Pro plan was $29 per month.') } });
    await scan(c, p.id, false);
    const [m] = (await t.http.get(`/v1/canon/conflicts?siteId=${c.siteId}`).set(c.h)).body;
    await t.http.post(`/v1/canon/mentions/${m.id}/dismiss`).set(c.h).send({}).expect(200);
    await scan(c, p.id, false);
    expect((await t.http.get(`/v1/canon/conflicts?siteId=${c.siteId}`).set(c.h)).body).toEqual([]);
  });

  it('binds a detected span to the fact token in the draft', async () => {
    const c = await setup();
    const f = await priceFact(c);
    const p = await page(c, 'bind', { id: 't1', type: 'text', props: { doc: doc('Pro plan: $49/month, cancel anytime.') } });
    await scan(c, p.id, false);
    const impact = await t.http.get(`/v1/canon/facts/${f.id}/impact`).set(c.h).expect(200);
    const mention = impact.body.entities[0].mentions[0];
    await t.http.post(`/v1/canon/mentions/${mention.id}/bind`).set(c.h).send({}).expect(200);
    const detail = await t.http.get(`/v1/sites/${c.siteId}/pages/${p.id}`).set(c.h).expect(200);
    expect(detail.body.content.root.children[0].props.doc.content[0].content).toEqual([{ type: 'text', text: 'Pro plan: ' }, { type: 'factRef', attrs: { factKey: 'pro_plan.price' } }, { type: 'text', text: ', cancel anytime.' }]);
    const after = await t.http.get(`/v1/canon/facts/${f.id}/impact`).set(c.h).expect(200);
    expect(after.body.totals).toMatchObject({ bound: 1, detected: 0 });
    // A fact that pages render can't be deleted out from under them.
    expect((await t.http.delete(`/v1/canon/facts/${f.id}`).set(c.h)).body.error.code).toBe('FACT_IN_USE');
  });
});

describe('propagation (agent team in a branch)', () => {
  it('changes the fact, proposes reviewed rewrites, and merges them into drafts', async () => {
    const c = await setup();
    const f = await priceFact(c);
    const p = await page(c, 'pricing', { id: 't1', type: 'text', props: { doc: doc('The Pro plan is just $49 per month.') } }, { id: 't2', type: 'text', props: { doc: doc('Pro is just forty-nine dollars monthly.') } }, { id: 't3', type: 'text', props: { doc: doc('Always ', { fact: 'pro_plan.price' }) } });
    await scan(c, p.id);

    const upd = await t.http.patch(`/v1/canon/facts/${f.id}`).set(c.h).send({ value: { amount: 59, currency: 'USD', period: 'month' }, reason: 'Price increase' }).expect(200);
    expect(upd.body).toMatchObject({ changed: true, fact: { version: 2, displayValue: '$59/month' } });
    expect(upd.body.impact.totals).toMatchObject({ bound: 1, stale: 2 });
    const event = await t.system.outboxEvent.findFirst({ where: { tenantId: c.owner.tenantId, type: 'FactChanged' } });
    expect(event?.payload).toMatchObject({ siteId: c.siteId, key: 'pro_plan.price', version: 2, entities: [{ type: 'PAGE', id: p.id }] });
    const versions = await t.http.get(`/v1/canon/facts/${f.id}/versions`).set(c.h).expect(200);
    expect(versions.body.map((v: { version: number; reason: string | null }) => [v.version, v.reason])).toEqual([[2, 'Price increase'], [1, 'Created']]);

    const prop = await t.http.post(`/v1/canon/facts/${f.id}/propagate`).set(c.h).send({ siteId: c.siteId }).expect(202);
    expect(prop.body).toMatchObject({ mentions: 2, reused: false });
    await t.app.get(PropagationService).execute(prop.body.runId);

    const branch = await t.http.get(`/v1/branches/${prop.body.branchId}`).set(c.h).expect(200);
    expect(branch.body).toMatchObject({ name: 'canon/pro_plan.price@v2', status: 'IN_REVIEW', summary: { proposed: 2, escalated: 0, failed: 0, bound: 1, from: '$49/month', to: '$59/month' } });
    const change = branch.body.changes[0];
    expect(change).toMatchObject({ entityType: 'PAGE', entityId: p.id, applicable: true, status: 'PROPOSED' });
    expect(change.explanation.spans.map((s: { before: string; after: string; verdict: string; agent: string }) => [s.before, s.after, s.verdict, s.agent])).toEqual(
      expect.arrayContaining([
        ['$49', '$59', 'pass', 'Copywriter'],
        ['forty-nine dollars', '$59/month', 'pass', 'Copywriter'],
      ]),
    );

    // The run tree: Strategist plans, Copywriter and Fact-Checker each record their model calls.
    const run = await t.http.get(`/v1/canon/runs/${prop.body.runId}`).set(c.h).expect(200);
    expect(run.body).toMatchObject({ status: 'WAITING_HUMAN', agent: { name: 'Strategist' } });
    expect(run.body.steps[0]).toMatchObject({ node: 'plan', toolName: 'canon.impact_analysis' });
    const kids = Object.fromEntries(run.body.children.map((k: { agent: { name: string }; steps: unknown[]; status: string }) => [k.agent.name, [k.status, k.steps.length]]));
    expect(kids).toEqual({ Copywriter: ['COMPLETED', 2], 'Fact-Checker': ['COMPLETED', 2] });

    // Nothing touched the page yet.
    const before = await t.http.get(`/v1/sites/${c.siteId}/pages/${p.id}`).set(c.h).expect(200);
    expect(JSON.stringify(before.body.content)).toContain('$49 per month');

    await t.http.post(`/v1/branches/${branch.body.id}/merge`).set(c.h).send({}).expect(409); // nothing accepted
    await t.http.patch(`/v1/branches/${branch.body.id}/changes/${change.id}`).set(c.h).send({ status: 'ACCEPTED' }).expect(200);
    const merged = await t.http.post(`/v1/branches/${branch.body.id}/merge`).set(c.h).send({}).expect(200);
    expect(merged.body.results).toEqual([expect.objectContaining({ ok: true })]);
    expect(merged.body.branch.status).toBe('MERGED');
    const after = await t.http.get(`/v1/sites/${c.siteId}/pages/${p.id}`).set(c.h).expect(200);
    const text = JSON.stringify(after.body.content);
    expect(text).toContain('The Pro plan is just $59 per month.');
    expect(text).toContain('Pro is just $59/month monthly.');
    expect((await t.http.get(`/v1/canon/conflicts?siteId=${c.siteId}`).set(c.h)).body).toEqual([]);
  });

  it('escalates spans it cannot rewrite, fails rewrites that keep the old value, and reports merge conflicts', async () => {
    const c = await setup();
    const f = await priceFact(c);
    const p = await page(c, 'edge', { id: 't1', type: 'text', props: { doc: doc('Pro plan is $49 [escalate] per month.') } }, { id: 't2', type: 'text', props: { doc: doc('The Pro plan costs $49 now.') } });
    await scan(c, p.id, false);
    await t.http.patch(`/v1/canon/facts/${f.id}`).set(c.h).send({ value: { amount: 59, currency: 'USD', period: 'month' } }).expect(200);
    const prop = await t.http.post(`/v1/canon/facts/${f.id}/propagate`).set(c.h).send({ siteId: c.siteId }).expect(202);
    await t.app.get(PropagationService).execute(prop.body.runId);
    const b = (await t.http.get(`/v1/branches/${prop.body.branchId}`).set(c.h)).body;
    expect(b.summary).toMatchObject({ proposed: 1, escalated: 1 });

    // Someone edits the page after the proposal: merge must not overwrite them.
    const live = (await t.http.get(`/v1/sites/${c.siteId}/pages/${p.id}`).set(c.h)).body;
    await t.http.patch(`/v1/sites/${c.siteId}/pages/${p.id}`).set(c.h).send({ expectedVersion: live.version, title: 'Edited meanwhile' }).expect(200);
    await t.http.patch(`/v1/branches/${b.id}/changes/${b.changes[0].id}`).set(c.h).send({ status: 'ACCEPTED' }).expect(200);
    const merge = await t.http.post(`/v1/branches/${b.id}/merge`).set(c.h).send({}).expect(200);
    expect(merge.body.results[0]).toMatchObject({ ok: false, error: 'The page was edited after the proposal' });
    expect(merge.body.branch.status).toBe('CONFLICTED');

    await t.http.post(`/v1/canon/facts/${f.id}/propagate`).set(c.h).send({ siteId: c.siteId }).expect(202);
  });

  it('the deterministic fact-check rejects a rewrite that still states the old price', async () => {
    const c = await setup();
    const f = await priceFact(c);
    const p = await page(c, 'keep', { id: 't1', type: 'text', props: { doc: doc('The Pro plan costs $49 [keep-old].') } });
    await scan(c, p.id, false);
    await t.http.patch(`/v1/canon/facts/${f.id}`).set(c.h).send({ value: { amount: 59, currency: 'USD', period: 'month' } }).expect(200);
    const prop = await t.http.post(`/v1/canon/facts/${f.id}/propagate`).set(c.h).send({ siteId: c.siteId }).expect(202);
    await t.app.get(PropagationService).execute(prop.body.runId);
    const b = (await t.http.get(`/v1/branches/${prop.body.branchId}`).set(c.h)).body;
    expect(b.summary).toMatchObject({ proposed: 0, failed: 1 });
    expect(b.changes[0].explanation.spans[0]).toMatchObject({ verdict: 'fail', applied: false, issues: expect.arrayContaining([expect.stringMatching(/new value/), expect.stringMatching(/old number/)]) });

    // A reviewer can still fix the span by hand and merge.
    const fixed = await t.http.patch(`/v1/branches/${b.id}/changes/${b.changes[0].id}`).set(c.h).send({ status: 'ACCEPTED', overrides: { [b.changes[0].explanation.spans[0].mentionId]: '$59' } }).expect(200);
    expect(fixed.body.changes[0].applicable).toBe(true);
    await t.http.post(`/v1/branches/${b.id}/merge`).set(c.h).send({}).expect(200);
    expect(JSON.stringify((await t.http.get(`/v1/sites/${c.siteId}/pages/${p.id}`).set(c.h)).body.content)).toContain('costs $59 [keep-old]');
  });

  it('has nothing to propagate when every mention is a bound token', async () => {
    const c = await setup();
    const f = await priceFact(c);
    const p = await page(c, 'bound', { id: 't1', type: 'text', props: { doc: doc('Only ', { fact: 'pro_plan.price' }) } });
    await scan(c, p.id, false);
    await t.http.patch(`/v1/canon/facts/${f.id}`).set(c.h).send({ value: { amount: 59, currency: 'USD', period: 'month' } }).expect(200);
    const res = await t.http.post(`/v1/canon/facts/${f.id}/propagate`).set(c.h).send({ siteId: c.siteId });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'NOTHING_TO_PROPAGATE', message: expect.stringContaining('bound') });
    await drainOutbox(t, c.owner.tenantId);
  });
});
