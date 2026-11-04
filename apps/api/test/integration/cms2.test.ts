import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, invited, signUp, type SignedIn, type TestApp } from './harness';

const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off' });
});

afterAll(async () => {
  await t.close();
});

const node = (id: string, type: string, props: Record<string, unknown>, children: unknown[] = []) => ({ id, type, props, children });
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Blog', defaultLocale: 'en' }).expect(201)).body as { id: string };
  const base = `/v1/sites/${site.id}/collections`;
  const posts = (
    await t.http
      .post(base)
      .set(h)
      .send({
        name: 'Posts',
        slug: 'posts',
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
          { name: 'body', label: 'Body', type: 'richtext' },
          { name: 'cover', label: 'Cover', type: 'url' },
          { name: 'topic', label: 'Topic', type: 'select', options: ['news', 'guides'] },
          { name: 'price', label: 'Price', type: 'number' },
        ],
      })
      .expect(201)
  ).body as { id: string };
  return { owner, h, site, base, posts };
}

async function page(owner: SignedIn, siteId: string, slug: string, title: string, content: unknown, publish = true) {
  const h = bearer(owner.accessToken);
  const p = (await t.http.post(`/v1/sites/${siteId}/pages`).set(h).send({ title, slug }).expect(201)).body as { id: string; version: number };
  await t.http.patch(`/v1/sites/${siteId}/pages/${p.id}`).set(h).send({ expectedVersion: p.version, content }).expect(200);
  if (publish) await t.http.post(`/v1/sites/${siteId}/pages/${p.id}/publish`).set(h).send({}).expect(200);
  return p;
}

async function post(h: Record<string, string>, base: string, cid: string, data: Record<string, unknown>, opts: { publish?: boolean; tags?: string[] } = {}) {
  const e = (await t.http.post(`${base}/${cid}/entries`).set(h).send({ data, tags: opts.tags ?? [] }).expect(201)).body as { id: string; slug: string; version: number };
  if (opts.publish !== false) await t.http.post(`${base}/${cid}/entries/${e.id}/publish`).set(h).send({}).expect(200);
  return e;
}

describe('entry pages (collection routes)', () => {
  it('serves each published entry at basePath/slug through the template, hides drafts and the template itself', async () => {
    const { owner, h, site, base, posts } = await setup();
    const template = await page(owner, site.id, 'post-template', 'Post template', {
      root: node('root', 'section', {}, [
        node('h', 'heading', { text: '{{entry.title}}', level: 1 }),
        node('ex', 'text', { doc: doc('{{entry.excerpt}} — {{entry.publishedAt}}') }),
        node('b', 'text', { doc: doc('{{entry.body}}') }),
        node('img', 'image', { mediaId: '', src: '{{entry.cover}}', alt: '{{entry.title}}' }),
      ]),
    });
    // The route must point to a page of this site.
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { route: { basePath: '/blog', templatePageId: 'nope' } } }).expect(400);
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { route: { basePath: '/blog/', templatePageId: template.id } } }).expect(400);
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { route: { basePath: '/blog', templatePageId: template.id } } }).expect(200);

    const body = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Chapter one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Knead <b>well</b>.' }] }] };
    await post(h, base, posts.id, { title: 'Sourdough at home', excerpt: 'A slow loaf', body, cover: 'https://images.unsplash.com/photo-1?w=800' });
    const draft = await post(h, base, posts.id, { title: 'Secret draft' }, { publish: false });
    await drainOutbox(t, owner.tenantId);

    const res = await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/blog/sourdough-at-home' }).set(DELIVERY).expect(200);
    const content = JSON.stringify(res.body.page.content);
    expect(res.body.page).toMatchObject({ title: 'Sourdough at home', path: '/blog/sourdough-at-home' });
    expect(res.body.page.seo.title).toBe('Sourdough at home');
    expect(res.body.entry).toMatchObject({ slug: 'sourdough-at-home', basePath: '/blog' });
    expect(content).toContain('"text":"Sourdough at home"');
    expect(content).toMatch(/A slow loaf — \d{4}-\d{2}-\d{2}/);
    // A rich text field in its own paragraph brings its structure; markup stays text.
    expect(content).toContain('"type":"heading","attrs":{"level":2}');
    expect(content).toContain('Knead <b>well</b>.');
    expect(content).toContain('"src":"https://images.unsplash.com/photo-1?w=800"');
    expect(content).not.toContain('{{entry.');

    // Drafts, unknown slugs and the raw template are not destinations.
    await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: `/blog/${draft.slug}` }).set(DELIVERY).expect(404);
    await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/blog/nothing-here' }).set(DELIVERY).expect(404);
    await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/post-template' }).set(DELIVERY).expect(404);

    // Sitemap: entry pages in, the template out.
    const list = (await t.http.get(`/v1/delivery/sites/${site.id}/pages`).set(DELIVERY).expect(200)).body as { pages: { path: string }[]; entries: { path: string }[] };
    expect(list.pages.map((p) => p.path)).not.toContain('/post-template');
    expect(list.entries.map((e) => e.path)).toEqual(['/blog/sourdough-at-home']);

    // A real page at the same path wins over the entry.
    await page(owner, site.id, 'blog', 'Blog', { root: node('root', 'section', {}, [node('t', 'heading', { text: 'All posts', level: 1 })]) });
    await drainOutbox(t, owner.tenantId);
    expect((await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/blog' }).set(DELIVERY).expect(200)).body.page.title).toBe('Blog');

    // Unpublishing takes the entry page down.
    const e = (await t.http.get(`${base}/${posts.id}/entries`).set(h).query({ q: 'sourdough' }).expect(200)).body.items[0] as { id: string };
    await t.http.post(`${base}/${posts.id}/entries/${e.id}/unpublish`).set(h).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);
    await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/blog/sourdough-at-home' }).set(DELIVERY).expect(404);
  });

  it('refuses two collections on one base path', async () => {
    const { owner, h, site, base, posts } = await setup();
    const tpl = await page(owner, site.id, 'tpl', 'Template', { root: node('root', 'section', {}, []) }, false);
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { route: { basePath: '/news', templatePageId: tpl.id } } }).expect(200);
    const other = (await t.http.post(base).set(h).send({ name: 'Events', slug: 'events', fields: [{ name: 'name', label: 'Name', type: 'text' }] }).expect(201)).body as { id: string };
    const clash = await t.http.patch(`${base}/${other.id}`).set(h).send({ settings: { route: { basePath: '/news', templatePageId: tpl.id } } }).expect(409);
    expect(clash.body.error.message).toContain('Posts');
  });
});

describe('collection list blocks', () => {
  it('fills cards from published entries (tag, order, limit) with links to entry pages, in delivery and the builder preview', async () => {
    const { owner, h, site, base, posts } = await setup();
    const tpl = await page(owner, site.id, 'tpl', 'Template', { root: node('root', 'section', {}, [node('h', 'heading', { text: '{{entry.title}}', level: 1 })]) });
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { route: { basePath: '/blog', templatePageId: tpl.id } } }).expect(200);
    for (const [title, tags] of [['First', ['news']], ['Second', ['guides']], ['Third', ['news']]] as const) await post(h, base, posts.id, { title, excerpt: `About ${title}`, cover: 'https://evil.example.com/x.jpg' }, { tags: [...tags] });
    await post(h, base, posts.id, { title: 'Hidden draft' }, { publish: false, tags: ['news'] });

    const list = node('list', 'collection-list', { collection: 'posts', title: 'News', layout: 'grid', columns: 3, limit: 5, sort: 'newest', tag: 'news', imageField: '', textField: 'excerpt', showDate: true, linkLabel: 'Read', emptyText: 'None' });
    const missing = node('none', 'collection-list', { collection: 'nope', limit: 3 });
    await page(owner, site.id, 'news', 'News', { root: node('root', 'section', {}, [list, missing]) });
    await drainOutbox(t, owner.tenantId);

    const res = await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/news' }).set(DELIVERY).expect(200);
    const cards = res.body.lists.list as { title: string; path: string; text: string; imageUrl: string | null }[];
    expect(cards.map((c) => c.title)).toEqual(['Third', 'First']);
    expect(cards[0]).toMatchObject({ path: '/blog/third', text: 'About Third', imageUrl: null }); // non-allowlisted image dropped
    expect(res.body.lists.none).toEqual([]);

    // The builder preview returns the same cards, for members of the workspace only.
    const preview = await t.http.post(`/v1/sites/${site.id}/collection-lists/preview`).set(h).send({ blocks: [{ id: 'list', type: 'collection-list', props: list.props }], locale: 'en' }).expect(200);
    expect(preview.body.list.map((c: { title: string }) => c.title)).toEqual(['Third', 'First']);
    const stranger = await signUp(t);
    await t.http.post(`/v1/sites/${site.id}/collection-lists/preview`).set(bearer(stranger.accessToken)).send({ blocks: [], locale: 'en' }).expect(404);
  });
});

describe('entries table: field filters and bulk actions', () => {
  it('filters by field values and applies one action to many entries with per-entry results', async () => {
    const { owner, h, base, posts } = await setup();
    const a = await post(h, base, posts.id, { title: 'Cheap', topic: 'news', price: 5 }, { publish: false });
    const b = await post(h, base, posts.id, { title: 'Dear', topic: 'guides', price: 50, excerpt: 'Long read' }, { publish: false });
    const c = await post(h, base, posts.id, { price: 1 }, { publish: false }); // no title: can't be published
    const list = (filters: unknown) => t.http.get(`${base}/${posts.id}/entries`).set(h).query({ filters: JSON.stringify(filters) });

    expect((await list([{ field: 'topic', op: 'eq', value: 'NEWS' }]).expect(200)).body.items.map((e: { title: string }) => e.title)).toEqual(['Cheap']);
    expect((await list([{ field: 'price', op: 'eq', value: '50' }]).expect(200)).body.total).toBe(1);
    expect((await list([{ field: 'excerpt', op: 'contains', value: 'long' }]).expect(200)).body.items[0].title).toBe('Dear');
    expect((await list([{ field: 'excerpt', op: 'empty' }]).expect(200)).body.total).toBe(2);
    expect((await list([{ field: 'topic', op: 'notEmpty' }, { field: 'price', op: 'eq', value: '5' }]).expect(200)).body.total).toBe(1);
    // A value that looks like SQL is just a value.
    expect((await list([{ field: 'topic', op: 'eq', value: "x' OR '1'='1" }]).expect(200)).body.total).toBe(0);
    expect((await list([{ field: 'nope', op: 'eq', value: '1' }]).expect(400)).body.error.code).toBe('INVALID_FILTER');
    await t.http.get(`${base}/${posts.id}/entries`).set(h).query({ filters: 'not json' }).expect(400);

    // Bulk publish: the incomplete entry fails validation, the rest goes through.
    const bulk = (body: object) => t.http.post(`${base}/${posts.id}/entries/bulk`).set(h).send(body);
    const pub = (await bulk({ ids: [a.id, b.id, c.id], action: 'publish' }).expect(200)).body;
    expect(pub.done).toBe(2);
    expect(pub.failed).toEqual([expect.objectContaining({ id: c.id, code: 'INVALID_ENTRY' })]);
    const tagged = (await bulk({ ids: [a.id, b.id], action: 'addTag', tag: 'Featured' }).expect(200)).body;
    expect(tagged).toEqual({ done: 2, failed: [] });
    expect((await t.http.get(`${base}/${posts.id}/entries`).set(h).query({ tag: 'featured' }).expect(200)).body.total).toBe(2);
    await bulk({ ids: [a.id], action: 'removeTag', tag: 'featured' }).expect(200);
    expect((await t.http.get(`${base}/${posts.id}/entries`).set(h).query({ tag: 'featured' }).expect(200)).body.total).toBe(1);
    await bulk({ ids: [a.id], action: 'addTag' }).expect(400);

    // Viewers can't change entries in bulk either; each entry reports the refusal.
    const viewer = await invited(t, owner, 'VIEWER');
    const denied = (await t.http.post(`${base}/${posts.id}/entries/bulk`).set(bearer(viewer.accessToken)).send({ ids: [a.id], action: 'unpublish' }).expect(200)).body;
    expect(denied.failed[0].code).toBe('FORBIDDEN');

    // Archive unpublishes first; delete removes.
    expect((await bulk({ ids: [b.id], action: 'archive' }).expect(200)).body.done).toBe(1);
    expect((await t.http.get(`${base}/${posts.id}/entries/${b.id}`).set(h).expect(200)).body).toMatchObject({ status: 'ARCHIVED', publishedVersion: null });
    expect((await bulk({ ids: [a.id, c.id, 'missing-id'], action: 'delete' }).expect(200)).body).toMatchObject({ done: 2, failed: [{ id: 'missing-id', code: 'NOT_FOUND' }] });
  });

  it('keeps saved views in the collection settings', async () => {
    const { h, base, posts } = await setup();
    const views = [{ id: 'drafts', name: 'Drafts about news', status: 'DRAFT', filters: [{ field: 'topic', op: 'eq', value: 'news' }] }];
    const res = await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { views } }).expect(200);
    expect(res.body.settings.views).toEqual([expect.objectContaining({ id: 'drafts', sort: 'updated', order: 'desc' })]);
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { views: [...views, ...views] } }).expect(400);
    await t.http.patch(`${base}/${posts.id}`).set(h).send({ settings: { views: [{ ...views[0], filters: [{ field: 'Bad Name', op: 'eq' }] }] } }).expect(400);
  });
});
