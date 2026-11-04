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

const item = (o: { id: number; type: string; title: string; slug: string; link: string; status: string; content: string; parent?: number; cats?: string[]; tags?: string[] }) => `
  <item>
    <title>${o.title}</title>
    <link>${o.link}</link>
    <dc:creator><![CDATA[anna]]></dc:creator>
    <content:encoded><![CDATA[${o.content}]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${o.id}</wp:post_id>
    <wp:post_date_gmt><![CDATA[2024-05-06 08:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[${o.slug}]]></wp:post_name>
    <wp:status><![CDATA[${o.status}]]></wp:status>
    <wp:post_parent>${o.parent ?? 0}</wp:post_parent>
    <wp:post_type><![CDATA[${o.type}]]></wp:post_type>
    ${(o.cats ?? []).map((c) => `<category domain="category" nicename="${c.toLowerCase()}"><![CDATA[${c}]]></category>`).join('')}
    ${(o.tags ?? []).map((c) => `<category domain="post_tag" nicename="${c}"><![CDATA[${c}]]></category>`).join('')}
  </item>`;

const WXR = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Old Bakery Blog</title>
  <link>https://old-bakery.example</link>
  ${item({ id: 1, type: 'post', title: 'Rye &amp; patience', slug: 'rye-and-patience', link: 'https://old-bakery.example/2024/05/rye-and-patience/', status: 'publish', content: '<!-- wp:paragraph --><p>Rye needs <strong>time</strong>.</p><!-- /wp:paragraph --><h2>Steps</h2><ul><li>Mix</li><li>Wait</li></ul><img src="https://old-bakery.example/wp-content/uploads/rye.jpg"><script>alert(1)</script>', cats: ['Recipes'], tags: ['rye'] })}
  ${item({ id: 2, type: 'post', title: 'Classic post', slug: 'classic-post', link: 'https://old-bakery.example/?p=2', status: 'publish', content: 'First line.\n\nSecond paragraph.', cats: ['News'] })}
  ${item({ id: 3, type: 'post', title: 'Unfinished', slug: 'unfinished', link: 'https://old-bakery.example/?p=3', status: 'draft', content: '<p>Draft</p>' })}
  ${item({ id: 4, type: 'post', title: 'Deleted', slug: 'deleted', link: 'https://old-bakery.example/?p=4', status: 'trash', content: '<p>x</p>' })}
  ${item({ id: 10, type: 'page', title: 'About us', slug: 'about-us', link: 'https://old-bakery.example/about-us/', status: 'publish', content: '<p>We bake.</p>' })}
  ${item({ id: 11, type: 'page', title: 'Team', slug: 'team', link: 'https://old-bakery.example/about-us/team/', status: 'publish', content: '<p>Anna and Bob.</p>', parent: 10 })}
  ${item({ id: 20, type: 'attachment', title: 'rye.jpg', slug: 'rye', link: 'https://old-bakery.example/rye/', status: 'inherit', content: '' })}
</channel>
</rss>`;

describe('migration center: WordPress', () => {
  it('reports in a dry run, then imports posts, pages and old addresses without losing anything', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = (await t.http.post('/v1/sites').set(h).send({ name: 'New bakery', defaultLocale: 'en' }).expect(201)).body as { id: string };
    const upload = (q: string, body = WXR, auth = h) => t.http.post(`/v1/sites/${site.id}/migrations/wordpress${q}`).set(auth).attach('file', Buffer.from(body), 'export.xml');

    const dry = (await upload('?dryRun=true').expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, source: { title: 'Old Bakery Blog' }, posts: { total: 3, published: 2, drafts: 1 }, pages: { total: 2, published: 2 }, categories: ['Recipes', 'News'], authors: ['anna'], images: 1, skipped: { attachment: 1, trash: 1 } });
    // Only addresses that change need a rule: ?p=2 has no path, pages keep theirs.
    expect(dry.redirects).toEqual([{ from: '/2024/05/rye-and-patience', to: '/blog/rye-and-patience' }]);
    expect((await t.http.get(`/v1/sites/${site.id}/collections`).set(h).expect(200)).body).toEqual([]); // nothing changed

    await upload('', '<html>not an export</html>').expect(400);
    await upload('', WXR.replace('<?xml version="1.0" encoding="UTF-8" ?>', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>')).expect(400);
    const viewer = await invited(t, owner, 'VIEWER');
    await upload('', WXR, bearer(viewer.accessToken)).expect(403);

    const res = (await upload('').expect(200)).body;
    expect(res.created).toEqual({ entries: 3, pages: 2, redirects: 1, collection: 'blog' });
    expect(res.errors).toEqual([]);
    await drainOutbox(t, owner.tenantId);

    // The post is a live entry page; markup kept, script dropped, draft stays a draft.
    const live = await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/blog/rye-and-patience' }).set(DELIVERY).expect(200);
    const content = JSON.stringify(live.body.page.content);
    expect(live.body.page.title).toBe('Rye & patience');
    // jsonb reorders keys, so look at the structure, not the string.
    const find = (v: unknown): unknown => (Array.isArray(v) ? v.map(find).find(Boolean) : v && typeof v === 'object' ? ((v as { text?: string }).text === 'time' ? v : Object.values(v).map(find).find(Boolean)) : undefined);
    expect(find(live.body.page.content)).toEqual({ type: 'text', text: 'time', marks: [{ type: 'bold' }] });
    expect(content).toContain('bulletList');
    expect(content).not.toContain('alert');
    expect(content).toContain('2024-05-06 · anna');
    await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/blog/unfinished' }).set(DELIVERY).expect(404);
    const entries = (await t.http.get(`/v1/sites/${site.id}/collections`).set(h).expect(200)).body as { id: string; fields: { name: string; options?: string[] }[] }[];
    expect(entries[0]!.fields.find((f) => f.name === 'category')?.options).toEqual(['Recipes', 'News']);

    // Pages keep their hierarchy; old addresses lead to the new ones.
    expect((await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/about-us/team' }).set(DELIVERY).expect(200)).body.page.title).toBe('Team');
    const rt = (await t.http.get(`/v1/delivery/sites/${site.id}/runtime`).set(DELIVERY).expect(200)).body as { redirects: { from: string; to: string; status: number }[] };
    expect(rt.redirects).toEqual(expect.arrayContaining([{ from: '/2024/05/rye-and-patience', to: '/blog/rye-and-patience', status: 301 }]));

    // Importing again doesn't clash: a second collection and suffixed addresses.
    const again = (await upload('').expect(200)).body;
    expect(again.created).toMatchObject({ entries: 3, pages: 2, collection: 'wordpress-posts' });
  });
});
