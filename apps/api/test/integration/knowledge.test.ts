import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeIndexer } from '../../src/modules/knowledge/indexer.service';
import { DbModelCatalog } from '../../src/modules/intelligence/infrastructure/db-model-catalog';
import { bearer, createTestApp, drainOutbox, signUp, startFakeOllama, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;

beforeAll(async () => {
  ollama = await startFakeOllama();
  // A 1536-dim embedding model served by the fake Ollama, so the vector half of hybrid search runs too.
  // Tier "premium" keeps it out of FREE plans' model lists that other test files assert on (embed() ignores tiers).
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url, AI_EMBEDDING_MODEL: 'ollama/canon-test-embed', KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off' });
  const provider = await t.system.aiProvider.findUniqueOrThrow({ where: { name: 'ollama' } });
  await t.system.aiModel.upsert({
    where: { providerId_name: { providerId: provider.id, name: 'canon-test-embed' } },
    create: { providerId: provider.id, name: 'canon-test-embed', displayName: 'Test embeddings', contextWindow: 8_192, maxOutputTokens: 0, inputPricePer1M: 0, outputPricePer1M: 0, capabilities: ['embedding'], tier: 'premium', embeddingDims: 1536 },
    update: {},
  });
  await t.app.get(DbModelCatalog).refresh();
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

const doc = (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] });
const tree = (...children: object[]) => ({ root: { id: 'root', type: 'section', props: {}, children } });

async function siteWithPage(owner: SignedIn, text: string, publish = true) {
  const site = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Know Site', defaultLocale: 'en', locales: ['en'] }).expect(201);
  const page = await t.http
    .post(`/v1/sites/${site.body.id}/pages`)
    .set(bearer(owner.accessToken))
    .send({ title: 'Pricing', slug: 'pricing', content: tree({ id: 'h1', type: 'heading', props: { text: 'Plans and pricing' } }, { id: 't1', type: 'text', props: { doc: doc(text) } }) })
    .expect(201);
  if (publish) await t.http.post(`/v1/sites/${site.body.id}/pages/${page.body.id}/publish`).set(bearer(owner.accessToken)).send({}).expect(200);
  await drainOutbox(t, owner.tenantId);
  return { siteId: site.body.id as string, pageId: page.body.id as string };
}

async function fact(owner: SignedIn, key: string, amount: number) {
  const res = await t.http.post('/v1/canon/facts').set(bearer(owner.accessToken)).send({ key, subject: { type: 'plan', name: 'Pro plan' }, predicate: 'monthly_price', valueType: 'MONEY', value: { amount, currency: 'USD', period: 'month' } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; displayValue: string };
}

describe('knowledge index & hybrid search', () => {
  it('indexes published content only, with headings, and searches lexically + semantically', async () => {
    const owner = await signUp(t);
    const { siteId, pageId } = await siteWithPage(owner, 'Our Pro plan includes single sign-on and audit logs for every team.');
    const indexer = t.app.get(KnowledgeIndexer);
    const res = await indexer.index({ tenantId: owner.tenantId, type: 'PAGE', id: pageId });
    // The short heading block merges into the text under it: one chunk, heading kept as context.
    expect(res).toMatchObject({ chunks: 1, embedded: true });
    expect(await indexer.index({ tenantId: owner.tenantId, type: 'PAGE', id: pageId })).toMatchObject({ skipped: true });

    const search = await t.http.get(`/v1/sites/${siteId}/search?q=${encodeURIComponent('audit logs')}`).set(bearer(owner.accessToken)).expect(200);
    expect(search.body.semantic).toBe(true);
    expect(search.body.hits[0]).toMatchObject({ entityType: 'PAGE', entityId: pageId, title: 'Pricing', path: '/pricing', heading: 'Plans and pricing' });
    expect(search.body.hits[0].via).toEqual(expect.arrayContaining(['lexical', 'semantic']));
    expect(search.body.hits[0].snippet).toContain('<<audit>>');
    expect(search.body.hits[0].text).toBeUndefined();

    const stats = await t.http.get(`/v1/sites/${siteId}/knowledge/stats`).set(bearer(owner.accessToken)).expect(200);
    expect(stats.body).toMatchObject({ chunks: 1, embedded: 1, entities: 1 });

    await t.http.post(`/v1/sites/${siteId}/pages/${pageId}/unpublish`).set(bearer(owner.accessToken)).send({}).expect(200);
    expect(await indexer.index({ tenantId: owner.tenantId, type: 'PAGE', id: pageId })).toMatchObject({ removed: true });
    const gone = await t.http.get(`/v1/sites/${siteId}/search?q=audit`).set(bearer(owner.accessToken)).expect(200);
    expect(gone.body.hits).toEqual([]);
  });

  it('keeps drafts and other tenants out', async () => {
    const owner = await signUp(t);
    const { siteId, pageId } = await siteWithPage(owner, 'Secret roadmap item: quantum widgets.', false);
    await t.app.get(KnowledgeIndexer).index({ tenantId: owner.tenantId, type: 'PAGE', id: pageId });
    const res = await t.http.get(`/v1/sites/${siteId}/search?q=quantum`).set(bearer(owner.accessToken)).expect(200);
    expect(res.body.hits).toEqual([]);
    const other = await signUp(t);
    await t.http.get(`/v1/sites/${siteId}/search?q=quantum`).set(bearer(other.accessToken)).expect(404);
  });

  it('indexes published entries with their collection path', async () => {
    const owner = await signUp(t);
    const { siteId } = await siteWithPage(owner, 'Intro', false);
    const col = await t.http.post(`/v1/sites/${siteId}/collections`).set(bearer(owner.accessToken)).send({ name: 'FAQ', slug: 'faq', fields: [{ name: 'question', label: 'Question', type: 'text' }, { name: 'answer', label: 'Answer', type: 'richtext' }] }).expect(201);
    const e = await t.http.post(`/v1/sites/${siteId}/collections/${col.body.id}/entries`).set(bearer(owner.accessToken)).send({ data: { question: 'Do you offer refunds?', answer: doc('Yes, within thirty days of purchase, no questions asked, for every plan we sell to customers.') } }).expect(201);
    await t.http.post(`/v1/sites/${siteId}/collections/${col.body.id}/entries/${e.body.id}/publish`).set(bearer(owner.accessToken)).send({}).expect(200);
    await t.app.get(KnowledgeIndexer).index({ tenantId: owner.tenantId, type: 'ENTRY', id: e.body.id });
    const res = await t.http.get(`/v1/sites/${siteId}/search?q=refunds`).set(bearer(owner.accessToken)).expect(200);
    expect(res.body.hits[0]).toMatchObject({ entityType: 'ENTRY', path: '/faq/do-you-offer-refunds', collection: 'faq' });
  });
});

describe('grounded answers', () => {
  it('answers from canonical facts and cited sources, recording a CHAT generation', async () => {
    const owner = await signUp(t);
    const { siteId, pageId } = await siteWithPage(owner, 'The Pro plan is the best choice for growing teams.');
    await fact(owner, 'pro_plan.price', 49);
    await t.app.get(KnowledgeIndexer).index({ tenantId: owner.tenantId, type: 'PAGE', id: pageId });
    const res = await t.http.post(`/v1/sites/${siteId}/ask`).set(bearer(owner.accessToken)).send({ question: 'How much does the Pro plan cost?' }).expect(200);
    expect(res.body.answer).toBe('It is $49/month [F1]. Details are on the page [1].');
    expect(res.body.facts).toEqual([expect.objectContaining({ ref: 'F1', key: 'pro_plan.price', displayValue: '$49/month' })]);
    expect(res.body.citations).toEqual([expect.objectContaining({ n: 1, title: 'Pricing', url: expect.stringMatching(/\/pricing$/) })]);
    const gens = await t.system.aiGeneration.findMany({ where: { tenantId: owner.tenantId, feature: 'CHAT' } });
    expect(gens).toHaveLength(1);
  });

  it('streams sources first, then deltas and done', async () => {
    const owner = await signUp(t);
    const { siteId, pageId } = await siteWithPage(owner, 'Pro plan details and limits.');
    await fact(owner, 'pro_plan.price', 49);
    await t.app.get(KnowledgeIndexer).index({ tenantId: owner.tenantId, type: 'PAGE', id: pageId });
    const res = await t.http.post(`/v1/sites/${siteId}/ask/stream`).set(bearer(owner.accessToken)).send({ question: 'What is the Pro plan price?' }).buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => cb(null, data));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = [...(res.body as string).matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
    expect(events[0]).toBe('sources');
    expect(events).toContain('delta');
    expect(events.at(-1)).toBe('done');
  });
});
