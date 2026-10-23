import { COLLECTION_PRESETS } from '@canon/fields';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnrichmentService } from '../../src/modules/collections/enrichment.service';
import { OutboxRelay } from '../../src/infrastructure/events/outbox';
import { bearer, createTestApp, signUp, startFakeOllama, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;

beforeAll(async () => {
  ollama = await startFakeOllama();
  // Enrichment runs on demand in these tests; the debounced worker would race the assertions.
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url, ENRICHMENT: 'off' });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

const doc = (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] });

interface Ctx {
  owner: SignedIn;
  siteId: string;
  base: string;
  h: Record<string, string>;
}

async function setup(): Promise<Ctx> {
  const owner = await signUp(t);
  const site = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Content Site', defaultLocale: 'en', locales: ['en', 'de'] }).expect(201);
  return { owner, siteId: site.body.id, base: `/v1/sites/${site.body.id}/collections`, h: bearer(owner.accessToken) };
}

async function collection(c: Ctx, body: object) {
  const res = await t.http.post(c.base).set(c.h).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; slug: string };
}

const blog = (extra: object = {}) => {
  const p = COLLECTION_PRESETS.find((x) => x.id === 'blog')!;
  return { name: p.name, slug: p.slug, fields: p.fields, settings: { titleField: 'title' }, aiSettings: { autoTag: true, autoSummary: true, qualityScore: true, tagVocabulary: ['pricing', 'security', 'launch'] }, ...extra };
};

async function entry(c: Ctx, collectionId: string, body: object) {
  const res = await t.http.post(`${c.base}/${collectionId}/entries`).set(c.h).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; slug: string; version: number; title: string };
}

describe('collections', () => {
  it('validates the field schema with the shared meta-schema', async () => {
    const c = await setup();
    const bad = await t.http.post(c.base).set(c.h).send({ name: 'Bad', slug: 'bad', fields: [{ name: 'status', label: 'Status', type: 'text' }, { name: 'kind', label: 'Kind', type: 'select' }] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('reserved');
    const col = await collection(c, blog());
    const list = await t.http.get(c.base).set(c.h).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: col.id, slug: 'posts', entryCount: 0 })]);
    await t.http.post(c.base).set(c.h).send(blog()).expect(409); // slug taken
  });

  it('guards lossy type changes on fields that hold data, unless forced', async () => {
    const c = await setup();
    const col = await collection(c, { name: 'Products', slug: 'products', fields: [{ name: 'name', label: 'Name', type: 'text' }, { name: 'price', label: 'Price', type: 'number' }] });
    await entry(c, col.id, { data: { name: 'Widget', price: 10 } });
    const lossy = await t.http.patch(`${c.base}/${col.id}`).set(c.h).send({ fields: [{ name: 'name', label: 'Name', type: 'textarea' }, { name: 'price', label: 'Price', type: 'boolean' }] });
    expect(lossy.status).toBe(409);
    expect(lossy.body.error).toMatchObject({ code: 'SCHEMA_CONFLICT', details: { fields: [{ field: 'price', from: 'number', to: 'boolean', entries: 1 }] } });
    const ok = await t.http.patch(`${c.base}/${col.id}`).set(c.h).send({ fields: [{ name: 'name', label: 'Name', type: 'textarea' }, { name: 'price', label: 'Price', type: 'boolean' }], force: true }).expect(200);
    expect(ok.body.diff.retyped).toHaveLength(2);
  });

  it('refuses deleting a collection with entries or one that others relate to', async () => {
    const c = await setup();
    const people = await collection(c, { name: 'People', slug: 'people', fields: [{ name: 'name', label: 'Name', type: 'text' }] });
    await collection(c, { name: 'Posts', slug: 'posts', fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'author', label: 'Author', type: 'relation', relation: { collectionId: people.id } }] });
    const del = await t.http.delete(`${c.base}/${people.id}`).set(c.h);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toContain('Posts');
  });
});

describe('entries', () => {
  it('saves incomplete drafts, enforces required fields on publish and locks versions', async () => {
    const c = await setup();
    const col = await collection(c, blog());
    const e = await entry(c, col.id, { data: { title: 'Pricing update', excerpt: 'Short' } });
    expect(e).toMatchObject({ slug: 'pricing-update', title: 'Pricing update', status: 'DRAFT' });
    const again = await entry(c, col.id, { data: { title: 'Pricing update' } });
    expect(again.slug).toBe('pricing-update-2');

    const pub = await t.http.post(`${c.base}/${col.id}/entries/${e.id}/publish`).set(c.h).send({});
    expect(pub.status).toBe(422);
    expect(pub.body.error.details.issues).toEqual([{ field: 'body', message: 'Body is required' }]);

    const bad = await t.http.patch(`${c.base}/${col.id}/entries/${e.id}`).set(c.h).send({ expectedVersion: e.version, data: { title: 'x', category: 'Nope' } });
    expect(bad.status).toBe(422);
    const upd = await t.http.patch(`${c.base}/${col.id}/entries/${e.id}`).set(c.h).send({ expectedVersion: e.version, data: { title: 'Pricing update', body: doc('All plans got cheaper.') }, tags: ['Pricing ', 'pricing', 'Big News'] }).expect(200);
    expect(upd.body.tags).toEqual(['pricing', 'big-news']);
    const stale = await t.http.patch(`${c.base}/${col.id}/entries/${e.id}`).set(c.h).send({ expectedVersion: e.version, data: { title: 'stale' } });
    expect(stale.status).toBe(409);
    await t.http.post(`${c.base}/${col.id}/entries/${e.id}/publish`).set(c.h).send({}).expect(200);
    const versions = await t.http.get(`${c.base}/${col.id}/entries/${e.id}/versions`).set(c.h).expect(200);
    expect(versions.body[0]).toMatchObject({ version: upd.body.version, isPublished: true });
  });

  it('an empty "New entry" gets a placeholder slug that follows the title until published', async () => {
    const c = await setup();
    const col = await collection(c, blog());
    const e = await entry(c, col.id, { data: {} });
    expect(e.slug).toBe('entry');
    const named = await t.http.patch(`${c.base}/${col.id}/entries/${e.id}`).set(c.h).send({ expectedVersion: e.version, data: { title: 'Hello World' }, slug: 'entry' }).expect(200);
    expect(named.body.slug).toBe('hello-world');
    const manual = await t.http.patch(`${c.base}/${col.id}/entries/${e.id}`).set(c.h).send({ expectedVersion: named.body.version, data: { title: 'Renamed' }, slug: 'hello-world' }).expect(200);
    expect(manual.body.slug).toBe('hello-world');
  });

  it('keeps relations honest: existence, reverse lookups and delete protection', async () => {
    const c = await setup();
    const people = await collection(c, { name: 'People', slug: 'people', fields: [{ name: 'name', label: 'Name', type: 'text' }] });
    const posts = await collection(c, { name: 'Posts', slug: 'posts', fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'authors', label: 'Authors', type: 'relation', multiple: true, relation: { collectionId: people.id } }] });
    const ada = await entry(c, people.id, { data: { name: 'Ada' } });
    const bad = await t.http.post(`${c.base}/${posts.id}/entries`).set(c.h).send({ data: { title: 'X', authors: ['cmnotarealid0000'] } });
    expect(bad.status).toBe(422);
    const post = await entry(c, posts.id, { data: { title: 'Hello', authors: [ada.id] } });
    const detail = await t.http.get(`${c.base}/${posts.id}/entries/${post.id}`).set(c.h).expect(200);
    expect(detail.body.related[ada.id]).toMatchObject({ title: 'Ada' });
    const adaDetail = await t.http.get(`${c.base}/${people.id}/entries/${ada.id}`).set(c.h).expect(200);
    expect(adaDetail.body.referencedBy).toEqual([expect.objectContaining({ entryId: post.id, field: 'authors', collectionName: 'Posts' })]);
    const del = await t.http.delete(`${c.base}/${people.id}/entries/${ada.id}`).set(c.h);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('ENTRY_IN_USE');
    await t.http.delete(`${c.base}/${people.id}/entries/${ada.id}?force=true`).set(c.h).expect(204);
  });

  it('enforces unique fields per locale', async () => {
    const c = await setup();
    const p = COLLECTION_PRESETS.find((x) => x.id === 'products')!;
    const col = await collection(c, { name: p.name, slug: p.slug, fields: p.fields });
    await entry(c, col.id, { data: { name: 'A', sku: 'SKU-1' } });
    const dup = await t.http.post(`${c.base}/${col.id}/entries`).set(c.h).send({ data: { name: 'B', sku: 'SKU-1' } });
    expect(dup.status).toBe(422);
    expect(dup.body.error.details.issues[0].field).toBe('sku');
    await entry(c, col.id, { data: { name: 'B', sku: 'SKU-1' }, locale: 'de' });
  });

  it('searches full text, filters by tag and reports tag counts', async () => {
    const c = await setup();
    const col = await collection(c, blog());
    await entry(c, col.id, { data: { title: 'Zero trust security', body: doc('Encryption everywhere') }, tags: ['security'] });
    await entry(c, col.id, { data: { title: 'New pricing', body: doc('Cheaper plans') }, tags: ['pricing'] });
    const q = await t.http.get(`${c.base}/${col.id}/entries?q=encryption`).set(c.h).expect(200);
    expect(q.body.items.map((i: { title: string }) => i.title)).toEqual(['Zero trust security']);
    const tag = await t.http.get(`${c.base}/${col.id}/entries?tag=pricing`).set(c.h).expect(200);
    expect(tag.body.total).toBe(1);
    expect(tag.body.tags).toEqual(expect.arrayContaining([{ tag: 'pricing', count: 1 }, { tag: 'security', count: 1 }]));
    const sorted = await t.http.get(`${c.base}/${col.id}/entries?sort=title&order=asc`).set(c.h).expect(200);
    expect(sorted.body.items[0].title).toBe('New pricing');
  });
});

describe('import / export', () => {
  it('imports CSV with a dry run, per-line errors, upserts and relation slugs; exports round-trip', async () => {
    const c = await setup();
    const people = await collection(c, { name: 'People', slug: 'people', fields: [{ name: 'name', label: 'Name', type: 'text' }] });
    await entry(c, people.id, { data: { name: 'Ada' }, slug: 'ada' });
    const col = await collection(c, { name: 'Posts', slug: 'posts', fields: [{ name: 'title', label: 'Title', type: 'text', required: true }, { name: 'views', label: 'Views', type: 'number' }, { name: 'author', label: 'Author', type: 'relation', relation: { collectionId: people.id } }] });
    const csv = 'slug,title,views,author,tags,extra\r\nfirst,First post,10,ada,news | launch,x\r\nsecond,Second post,abc,,,\r\nthird,"Third, with comma",3,,,\r\n';
    const dry = await t.http.post(`${c.base}/${col.id}/import?dryRun=true`).set(c.h).attach('file', Buffer.from(csv), 'posts.csv').expect(200);
    expect(dry.body).toMatchObject({ dryRun: true, rows: 3, created: 2, updated: 0, warnings: ['Ignored unknown columns: extra'] });
    expect(dry.body.errors).toEqual([{ line: 3, slug: 'second', issues: [expect.objectContaining({ field: 'views' })] }]);
    expect((await t.http.get(`${c.base}/${col.id}/entries`).set(c.h)).body.total).toBe(0);

    const real = await t.http.post(`${c.base}/${col.id}/import`).set(c.h).attach('file', Buffer.from(csv), 'posts.csv').expect(200);
    expect(real.body).toMatchObject({ created: 2, updated: 0 });
    const again = await t.http.post(`${c.base}/${col.id}/import`).set(c.h).attach('file', Buffer.from('slug,title\r\nfirst,First post (edited)\r\n'), 'posts.csv').expect(200);
    expect(again.body).toMatchObject({ created: 0, updated: 1 });

    const list = await t.http.get(`${c.base}/${col.id}/entries?sort=title&order=asc`).set(c.h).expect(200);
    const first = list.body.items.find((i: { slug: string }) => i.slug === 'first');
    expect(first).toMatchObject({ title: 'First post (edited)', tags: ['news', 'launch'] });
    const detail = await t.http.get(`${c.base}/${col.id}/entries/${first.id}`).set(c.h).expect(200);
    expect(Object.values(detail.body.related)).toEqual([expect.objectContaining({ title: 'Ada' })]);

    const exp = await t.http.get(`${c.base}/${col.id}/export?format=csv`).set(c.h).expect(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.headers['content-disposition']).toMatch(/attachment; filename="posts-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(exp.text).toContain('"Third, with comma"');
    const json = await t.http.get(`${c.base}/${col.id}/export?format=json`).set(c.h).expect(200);
    const parsed = JSON.parse(json.text);
    expect(parsed.entries).toHaveLength(2);

    // JSON export re-imports into another collection unchanged (create mode, ids kept for relations).
    const copy = await collection(c, { name: 'Copy', slug: 'copy', fields: parsed.collection.fields });
    const re = await t.http.post(`${c.base}/${copy.id}/import?mode=create`).set(c.h).attach('file', Buffer.from(json.text), 'posts.json').expect(200);
    expect(re.body).toMatchObject({ created: 2, errors: [] });
  });

  it('rejects files that cannot be parsed', async () => {
    const c = await setup();
    const col = await collection(c, { name: 'Items', slug: 'items', fields: [{ name: 'title', label: 'Title', type: 'text' }] });
    const broken = await t.http.post(`${c.base}/${col.id}/import`).set(c.h).attach('file', Buffer.from('title\r\n"unterminated\r\n'), 'x.csv');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('INVALID_FILE');
  });
});

describe('content delivery (headless)', () => {
  it('serves only published snapshots, to API keys with content:read, cached per tenant', async () => {
    const c = await setup();
    const people = await collection(c, { name: 'People', slug: 'people', fields: [{ name: 'name', label: 'Name', type: 'text' }] });
    const col = await collection(c, { name: 'Posts', slug: 'posts', fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'author', label: 'Author', type: 'relation', relation: { collectionId: people.id } }] });
    const ada = await entry(c, people.id, { data: { name: 'Ada' }, slug: 'ada' });
    const e = await entry(c, col.id, { data: { title: 'Live title', author: ada.id }, slug: 'hello' });
    await entry(c, col.id, { data: { title: 'Draft only' } });
    await t.http.post(`${c.base}/${col.id}/entries/${e.id}/publish`).set(c.h).send({}).expect(200);
    await t.http.patch(`${c.base}/${col.id}/entries/${e.id}`).set(c.h).send({ expectedVersion: e.version + 0, data: { title: 'Unpublished edit', author: ada.id } }).expect(200);
    await t.app.get(OutboxRelay).tick();

    const key = (await t.http.post('/v1/api-keys').set(c.h).send({ name: 'site', scopes: ['content:read'] }).expect(201)).body.key as string;
    const content = `/v1/content/sites/${c.siteId}/collections`;
    const list = await t.http.get(`${content}/posts/entries?expand=true`).set('x-api-key', key).expect(200);
    expect(list.body.total).toBe(1);
    // Draft edit invisible; the related draft-only person resolves to null.
    expect(list.body.items[0]).toMatchObject({ slug: 'hello', title: 'Live title', data: { title: 'Live title', author: null } });
    await t.http.post(`${c.base}/${people.id}/entries/${ada.id}/publish`).set(c.h).send({}).expect(200);
    await t.app.get(OutboxRelay).tick();
    const expanded = await t.http.get(`${content}/posts/entries/hello?expand=true`).set('x-api-key', key).expect(200);
    expect(expanded.body.data.author).toMatchObject({ slug: 'ada', title: 'Ada' });

    await t.http.post(`${content}/posts/entries`).set('x-api-key', key).send({}).expect(404);
    const other = await signUp(t);
    await t.http.get(`${content}/posts/entries`).set(bearer(other.accessToken)).expect(404);
  });
});

describe('AI enrichment', () => {
  it('tags (vocabulary-filtered), summarises and scores quality in one call', async () => {
    const c = await setup();
    const col = await collection(c, blog());
    const e = await entry(c, col.id, { data: { title: 'Pricing update', excerpt: 'Plans got cheaper', body: doc('Every plan now costs less and includes SSO.') }, tags: ['launch'] });
    const before = ollama.calls;
    const res = await t.http.post(`${c.base}/${col.id}/entries/${e.id}/ai-enrich`).set(c.h).send({}).expect(200);
    expect(ollama.calls - before).toBe(1);
    expect(res.body.done).toEqual(expect.arrayContaining(['summary', 'tags', 'quality', 'duplicates']));
    expect(res.body.entry.tags).toEqual(['launch', 'pricing', 'security']);
    expect(res.body.entry.summary).toMatch(/^About: Title: Pricing update/);
    // Completeness: title+body (required, ×2) and excerpt filled = 5 of 8 weight; then 0.4 × that × 100 + 0.6 × 80.
    expect(res.body.entry.qualityScore).toBe(Math.round(0.4 * (5 / 8) * 100 + 0.6 * 80));
    expect(res.body.entry.qualityIssues).toEqual(['Add a concrete example']);

    const ledger = await t.system.aiGeneration.findMany({ where: { tenantId: c.owner.tenantId, feature: 'CLASSIFY' } });
    expect(ledger).toHaveLength(1);
  });

  it('the worker skips unchanged content, so autosaves never re-spend', async () => {
    const c = await setup();
    const col = await collection(c, blog());
    const e = await entry(c, col.id, { data: { title: 'Same', body: doc('Unchanged text') } });
    const svc = t.app.get(EnrichmentService);
    const before = ollama.calls;
    await svc.runAutomatic({ tenantId: c.owner.tenantId, entryId: e.id });
    await svc.runAutomatic({ tenantId: c.owner.tenantId, entryId: e.id });
    expect(ollama.calls - before).toBe(1);
  });

  it('detects near-duplicates without any embedding provider', async () => {
    const c = await setup();
    const col = await collection(c, blog());
    const text = 'Our Pro plan includes unlimited projects, priority support and single sign-on for every member of your team.';
    const a = await entry(c, col.id, { data: { title: 'Pro plan explained', body: doc(text) } });
    await entry(c, col.id, { data: { title: 'Bananas', body: doc('Bananas are a great source of potassium for athletes.') } });
    const check = await t.http.post(`${c.base}/${col.id}/duplicates`).set(c.h).send({ data: { title: 'Pro plan, explained again', body: doc(`Intro. ${text} Thanks.`) }, locale: 'en' }).expect(200);
    expect(check.body.duplicates).toEqual([expect.objectContaining({ id: a.id, method: 'content' })]);
    expect(check.body.duplicates[0].score).toBeGreaterThan(0.7);

    const b = await entry(c, col.id, { data: { title: 'Pro plan explained', body: doc(text) } });
    const res = await t.http.post(`${c.base}/${col.id}/entries/${b.id}/ai-enrich`).set(c.h).send({ tasks: ['embedding'] }).expect(200);
    expect(res.body.aiMeta.duplicates[0]).toMatchObject({ id: a.id, score: 1 });
    expect(res.body.aiMeta.semanticIndex).toBe(false);
  });

  it('suggests a collection schema and drops invalid fields', async () => {
    const c = await setup();
    const res = await t.http.post(`${c.base}/ai/suggest-schema`).set(c.h).send({ description: 'Cooking recipes with difficulty and steps' }).expect(200);
    expect(res.body.fields.map((f: { name: string }) => f.name)).toEqual(['title', 'difficulty', 'steps']);
    expect(res.body.dropped).toEqual([expect.objectContaining({ name: 'slug' })]);
    await collection(c, { name: res.body.name, slug: res.body.slug, fields: res.body.fields });
  });
});
