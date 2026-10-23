import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, startFakeOllama, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

async function siteWithFact(owner: SignedIn) {
  const site = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Builder Site', defaultLocale: 'en', locales: ['en'] }).expect(201);
  await t.system.kgEntity.create({ data: { id: `e_${owner.tenantId}`, tenantId: owner.tenantId, type: 'plan', canonicalName: 'Pro' } });
  await t.system.fact.create({ data: { tenantId: owner.tenantId, key: 'pro.price', subjectId: `e_${owner.tenantId}`, predicate: 'price', valueType: 'MONEY', value: { amount: 59 }, displayValue: '$59' } });
  return site.body as { id: string };
}

type Node = { id: string; type: string; props: Record<string, unknown>; children: Node[] };

describe('AI page builder', () => {
  it('generates a validated page with fresh ids and bound Canon facts', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const res = await t.http.post(`/v1/sites/${site.id}/ai/generate-page`).set(bearer(owner.accessToken)).send({ brief: 'A pricing page for our Pro plan' }).expect(200);

    expect(res.body.title).toBe('Pricing that scales');
    expect(res.body.repaired).toBe(false);
    const blocks = res.body.content.root.children as Node[];
    expect(blocks.map((b) => b.type)).toEqual(['hero', 'text', 'row', 'cta']);
    // Plain fields get the value; rich text gets a bound factRef; unknown fact tokens vanish.
    expect(blocks[0]!.props.subtitle).toBe('One plan: $59');
    const para = (blocks[1]!.props.doc as { content: { content: object[] }[] }).content;
    expect(para[0]!.content).toEqual([{ type: 'text', text: 'Pro costs ' }, { type: 'factRef', attrs: { factKey: 'pro.price' } }, { type: 'text', text: ' per month.' }]);
    expect(JSON.stringify(para[1])).not.toContain('made.up');
    // Defaults filled, numeric enums coerced, nested ids generated and unique.
    expect(blocks[2]!.children[0]!.children[0]!.props.level).toBe(3);
    expect(blocks[3]!.props.tone).toBe('primary');
    const ids: string[] = [];
    const walk = (n: Node) => (ids.push(n.id), n.children.forEach(walk));
    blocks.forEach(walk);
    expect(new Set(ids).size).toBe(ids.length);

    const ledger = await t.system.aiGeneration.findMany({ where: { tenantId: owner.tenantId, feature: 'LAYOUT' } });
    expect(ledger).toHaveLength(1);
  });

  it('repairs once when the validator rejects blocks', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const res = await t.http.post(`/v1/sites/${site.id}/ai/generate-page`).set(bearer(owner.accessToken)).send({ brief: 'Landing page [broken]' }).expect(200);
    expect(res.body.repaired).toBe(true);
    expect(res.body.title).toBe('Fixed page');
    expect(res.body.dropped).toEqual([]);
    expect(res.body.ai.calls).toBe(2);
  });

  it('fails with AI_BAD_OUTPUT when nothing usable comes back, after one repair', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const before = ollama.calls;
    const res = await t.http.post(`/v1/sites/${site.id}/ai/generate-page`).set(bearer(owner.accessToken)).send({ brief: 'Anything at all [garbage]' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AI_BAD_OUTPUT');
    expect(ollama.calls - before).toBe(2);
  });

  it('creates a draft page when asked, flagged as AI-generated and never published', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const res = await t.http
      .post(`/v1/sites/${site.id}/ai/generate-page`)
      .set(bearer(owner.accessToken))
      .send({ brief: 'A pricing page for our Pro plan', createPage: { slug: 'pricing' } })
      .expect(200);
    expect(res.body.page).toMatchObject({ title: 'Pricing that scales', fullPath: '/pricing', status: 'DRAFT', publishedVersion: null });
    const row = await t.system.page.findUniqueOrThrow({ where: { id: res.body.page.id } });
    expect(row.aiGenerated).toBe(true);
  });

  it('uses a reference screenshot from the same site only', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#e2e8f0' } }).png().toBuffer();
    const up = await t.http.post(`/v1/sites/${site.id}/media/upload`).set(bearer(owner.accessToken)).attach('file', png, 'layout.png').expect(201);
    const res = await t.http.post(`/v1/sites/${site.id}/ai/generate-page`).set(bearer(owner.accessToken)).send({ brief: 'Rebuild this layout please', screenshotMediaId: up.body.id }).expect(200);
    expect(res.body.content.root.children[0].props.title).toBe('From your screenshot');

    const other = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Other' });
    if (other.status === 201) {
      await t.http.post(`/v1/sites/${other.body.id}/ai/generate-page`).set(bearer(owner.accessToken)).send({ brief: 'Rebuild this layout please', screenshotMediaId: up.body.id }).expect(400);
    }
  });

  it('generates a single block, honouring a requested type', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const any = await t.http.post(`/v1/sites/${site.id}/ai/generate-block`).set(bearer(owner.accessToken)).send({ brief: 'Common questions', outline: ['hero: Ship faster'] }).expect(200);
    expect(any.body.block).toMatchObject({ type: 'faq', props: { title: 'Questions' } });
    const stats = await t.http.post(`/v1/sites/${site.id}/ai/generate-block`).set(bearer(owner.accessToken)).send({ brief: 'Key numbers', type: 'stats' }).expect(200);
    expect(stats.body.block.props.items).toEqual([{ value: '$59', label: 'Pro plan' }]);
  });

  it('lists facts for the picker and requires the AI permission for generation', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const facts = await t.http.get(`/v1/facts?siteId=${site.id}&q=price`).set(bearer(owner.accessToken)).expect(200);
    expect(facts.body.items).toEqual([expect.objectContaining({ key: 'pro.price', displayValue: '$59' })]);
    await t.http.post(`/v1/sites/${site.id}/ai/generate-page`).send({ brief: 'A pricing page for our Pro plan' }).expect(401);
    await t.http.post(`/v1/sites/${site.id}/ai/generate-page`).set(bearer(owner.accessToken)).send({ brief: 'short' }).expect(400);
  });

  it('improves all texts of a block in one call, keeping marks, links and facts', async () => {
    const owner = await signUp(t);
    const site = await siteWithFact(owner);
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' costs ' }, { type: 'factRef', attrs: { factKey: 'pro.price' } }] }] };
    const hero = { id: 'h1', type: 'hero', props: { title: 'ship faster', subtitle: 'for teams', ctaLabel: 'start', ctaHref: '/signup' }, children: [] };
    const res = await t.http.post(`/v1/sites/${site.id}/ai/improve-block`).set(bearer(owner.accessToken)).send({ block: hero, action: 'rewrite' }).expect(200);
    expect(res.body.block).toMatchObject({ id: 'h1', props: { title: 'SHIP FASTER', subtitle: 'FOR TEAMS', ctaLabel: 'START', ctaHref: '/signup' } });
    expect(res.body.changed).toBe(3);

    const text = await t.http.post(`/v1/sites/${site.id}/ai/improve-block`).set(bearer(owner.accessToken)).send({ block: { id: 't1', type: 'text', props: { doc } }, action: 'fix', fields: ['doc'] }).expect(200);
    expect(text.body.block.props.doc.content[0].content).toEqual([{ type: 'text', text: 'BOLD', marks: [{ type: 'bold' }] }, { type: 'text', text: ' COSTS ' }, { type: 'factRef', attrs: { factKey: 'pro.price' } }]);

    await t.http.post(`/v1/sites/${site.id}/ai/improve-block`).set(bearer(owner.accessToken)).send({ block: { id: 'x', type: 'spacer', props: {} }, action: 'rewrite' }).expect(400);
  });
});
