import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishScheduler } from '../../src/modules/pages/publish-scheduler';
import { PASSWORD, bearer, createTestApp, drainOutbox, ip, refreshCookie, signUp, startFakeOllama, tokenFromMail, uniqueEmail, type SignedIn, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;
const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

const text = (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] });
const tree = (...children: object[]) => ({ root: { id: 'root', type: 'section', props: {}, children } });

async function newSite(owner: SignedIn, locales = ['en', 'de']) {
  const res = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Docs Site', template: 'landing', defaultLocale: locales[0], locales });
  expect(res.status).toBe(201);
  return res.body as { id: string; internalDomain: string };
}

async function page(owner: SignedIn, siteId: string, body: object) {
  const res = await t.http.post(`/v1/sites/${siteId}/pages`).set(bearer(owner.accessToken)).send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number; fullPath: string };
}

async function invited(owner: SignedIn, role: string): Promise<SignedIn> {
  const email = uniqueEmail(role.toLowerCase());
  await t.http.post(`/v1/tenants/${owner.tenantId}/members/invite`).set(bearer(owner.accessToken)).send({ email, role }).expect(201);
  const token = tokenFromMail(t.mailer, email, /invite\/([\w-]+)/);
  const r = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: role, inviteToken: token }).expect(201);
  return { email, accessToken: r.body.accessToken, cookie: refreshCookie(r), userId: r.body.user.id, tenantId: r.body.tenant.id };
}



describe('sites', () => {
  it('creates a site with a starter home page and enforces the plan site limit', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    expect(site.internalDomain).toMatch(/\.canon\.localhost$/);
    const pages = await t.http.get(`/v1/sites/${site.id}/pages`).set(bearer(owner.accessToken)).expect(200);
    expect(pages.body.items.map((p: { fullPath: string }) => p.fullPath)).toEqual(['/']);
    const second = await t.http.post('/v1/sites').set(bearer(owner.accessToken)).send({ name: 'Another' });
    expect(second.status).toBe(402);
  });

  it('only admins shape sites; editors work inside them', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const editor = await invited(owner, 'EDITOR');
    await t.http.patch(`/v1/sites/${site.id}`).set(bearer(editor.accessToken)).send({ name: 'Hijack' }).expect(403);
    await t.http.get(`/v1/sites/${site.id}`).set(bearer(editor.accessToken)).expect(200);
  });

  it('keeps sites tenant-private', async () => {
    const a = await signUp(t);
    const b = await signUp(t);
    const site = await newSite(a);
    await t.http.get(`/v1/sites/${site.id}`).set(bearer(b.accessToken)).expect(404);
    await t.http.get(`/v1/sites/${site.id}/pages`).set(bearer(b.accessToken)).expect(404);
  });
});

describe('pages', () => {
  it('nests paths, validates content and slugs, and locks versions', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const docs = await page(owner, site.id, { title: 'Docs', slug: 'docs' });
    const intro = await page(owner, site.id, { title: 'Intro', slug: 'intro', parentId: docs.id });
    expect(intro.fullPath).toBe('/docs/intro');

    await t.http.post(`/v1/sites/${site.id}/pages`).set(bearer(owner.accessToken)).send({ title: 'x', slug: 'api' }).expect(400);
    await t.http.post(`/v1/sites/${site.id}/pages`).set(bearer(owner.accessToken)).send({ title: 'x', slug: 'de' }).expect(400); // locale prefix
    await t.http.post(`/v1/sites/${site.id}/pages`).set(bearer(owner.accessToken)).send({ title: 'dup', slug: 'docs' }).expect(409);

    const bad = await t.http.patch(`/v1/sites/${site.id}/pages/${intro.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 1, content: tree({ id: 'b', type: 'button', props: { label: 'x', href: 'javascript:alert(1)' } }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CONTENT');

    await t.http.patch(`/v1/sites/${site.id}/pages/${intro.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 1, title: 'Introduction' }).expect(200);
    const stale = await t.http.patch(`/v1/sites/${site.id}/pages/${intro.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 1, title: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    // Renaming the parent moves the child's URL with it.
    await t.http.patch(`/v1/sites/${site.id}/pages/${docs.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 1, slug: 'guide' }).expect(200);
    const child = await t.http.get(`/v1/sites/${site.id}/pages/${intro.id}`).set(bearer(owner.accessToken)).expect(200);
    expect(child.body.fullPath).toBe('/guide/intro');
    // …and a page cannot be moved under its own descendant.
    const cycle = await t.http.patch(`/v1/sites/${site.id}/pages/${docs.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 2, parentId: intro.id });
    expect(cycle.status).toBe(400);
  });

  it('publishes snapshots: drafts never reach delivery, restore goes back to the draft', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const p = await page(owner, site.id, { title: 'Pricing', slug: 'pricing' });
    await t.http.patch(`/v1/sites/${site.id}/pages/${p.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 1, content: tree({ id: 'h', type: 'heading', props: { text: 'Live v2' } }) }).expect(200);
    await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/pricing`).set(DELIVERY).expect(404);

    const pub = await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/publish`).set(bearer(owner.accessToken)).send({}).expect(200);
    expect(pub.body).toMatchObject({ status: 'PUBLISHED', publishedVersion: 2 });
    await drainOutbox(t, owner.tenantId);
    const live = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/pricing`).set(DELIVERY).expect(200);
    expect(live.body.page.content.root.children[0].props.text).toBe('Live v2');

    const edited = await t.http.patch(`/v1/sites/${site.id}/pages/${p.id}`).set(bearer(owner.accessToken)).send({ expectedVersion: 2, content: tree({ id: 'h', type: 'heading', props: { text: 'Draft v3' } }) }).expect(200);
    expect(edited.body.hasUnpublishedChanges).toBe(true);
    const still = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/pricing`).set(DELIVERY).expect(200);
    expect(still.body.page.content.root.children[0].props.text).toBe('Live v2');

    await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/versions/2/restore`).set(bearer(owner.accessToken)).send({}).expect(200);
    const restored = await t.http.get(`/v1/sites/${site.id}/pages/${p.id}`).set(bearer(owner.accessToken)).expect(200);
    expect(restored.body.content.root.children[0].props.text).toBe('Live v2');

    await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/unpublish`).set(bearer(owner.accessToken)).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);
    await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/pricing`).set(DELIVERY).expect(404);
  });

  it('preview tokens expose the draft only to the renderer with the token', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const p = await page(owner, site.id, { title: 'Secret', slug: 'secret', content: tree({ id: 'h', type: 'heading', props: { text: 'Not live yet' } }) });
    const { body } = await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/preview`).set(bearer(owner.accessToken)).send({}).expect(200);
    const token = new URL(body.url).searchParams.get('token')!;
    const preview = await t.http.get(`/v1/delivery/preview?token=${encodeURIComponent(token)}`).set(DELIVERY).expect(200);
    expect(preview.body).toMatchObject({ draft: true, page: { path: '/secret' } });
    await t.http.get(`/v1/delivery/preview?token=${encodeURIComponent(token)}x`).set(DELIVERY).expect(401);
    await t.http.get(`/v1/delivery/preview?token=${encodeURIComponent(token)}`).expect(401); // no delivery token
  });

  it('resolves Canon fact tokens and hreflang alternates in delivery', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    await t.system.kgEntity.create({ data: { id: `e_${owner.tenantId}`, tenantId: owner.tenantId, type: 'plan', canonicalName: 'Pro' } });
    await t.system.fact.create({ data: { tenantId: owner.tenantId, key: 'pro.price', subjectId: `e_${owner.tenantId}`, predicate: 'price', valueType: 'MONEY', value: { amount: 59 }, displayValue: '$59' } });
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pro is ' }, { type: 'factRef', attrs: { factKey: 'pro.price' } }] }] };
    const p = await page(owner, site.id, { title: 'Plans', slug: 'plans', content: tree({ id: 't', type: 'text', props: { doc } }) });
    await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/publish`).set(bearer(owner.accessToken)).send({}).expect(200);
    const live = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/plans`).set(DELIVERY).expect(200);
    expect(live.body.facts).toEqual({ 'pro.price': '$59' });
    const resolved = await t.http.get(`/v1/delivery/resolve?host=${site.internalDomain}`).set(DELIVERY).expect(200);
    expect(resolved.body.id).toBe(site.id);
  });

  it('authors edit only their own pages and never publish', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const ownersPage = await page(owner, site.id, { title: 'Owner page', slug: 'owner' });
    const author = await invited(owner, 'AUTHOR');
    const mine = await page(author, site.id, { title: 'Mine', slug: 'mine' });
    await t.http.patch(`/v1/sites/${site.id}/pages/${mine.id}`).set(bearer(author.accessToken)).send({ expectedVersion: 1, title: 'Mine edited' }).expect(200);
    await t.http.patch(`/v1/sites/${site.id}/pages/${ownersPage.id}`).set(bearer(author.accessToken)).send({ expectedVersion: 1, title: 'Hacked' }).expect(403);
    await t.http.post(`/v1/sites/${site.id}/pages/${mine.id}/publish`).set(bearer(author.accessToken)).send({}).expect(403);
  });

  it('runs a scheduled publish', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const p = await page(owner, site.id, { title: 'Launch', slug: 'launch' });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const res = await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/schedule`).set(bearer(owner.accessToken)).send({ at }).expect(200);
    expect(res.body.status).toBe('SCHEDULED');
    // Fire the job now instead of waiting an hour.
    await t.app.get(PublishScheduler).run(res.body.schedule.id);
    const after = await t.http.get(`/v1/sites/${site.id}/pages/${p.id}`).set(bearer(owner.accessToken)).expect(200);
    expect(after.body).toMatchObject({ status: 'PUBLISHED', schedule: null });
  });

  it('deleting a parent removes its sub-pages from the site', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const parent = await page(owner, site.id, { title: 'Blog', slug: 'blog' });
    const child = await page(owner, site.id, { title: 'Post', slug: 'post', parentId: parent.id });
    await t.http.post(`/v1/sites/${site.id}/pages/${child.id}/publish`).set(bearer(owner.accessToken)).send({}).expect(200);
    await t.http.delete(`/v1/sites/${site.id}/pages/${parent.id}`).set(bearer(owner.accessToken)).expect(204);
    await drainOutbox(t, owner.tenantId);
    await t.http.get(`/v1/delivery/sites/${site.id}/page?path=/blog/post`).set(DELIVERY).expect(404);
    await t.http.get(`/v1/sites/${site.id}/pages/${child.id}`).set(bearer(owner.accessToken)).expect(404);
  });
});

describe('media', () => {
  const png = () => sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();

  it('uploads, generates variants, serves them publicly and deduplicates', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const buf = await png();
    const up = await t.http.post(`/v1/sites/${site.id}/media/upload`).set(bearer(owner.accessToken)).attach('file', buf, 'red.png').field('folder', '/brand');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ status: 'READY', mimeType: 'image/png', width: 900, height: 600, duplicate: false, folder: '/brand' });
    const formats = new Set(up.body.variants.sources.map((s: { format: string }) => s.format));
    expect(formats).toEqual(new Set(['webp', 'avif']));
    const variant = await fetch(up.body.variants.sources[0].url);
    expect(variant.status).toBe(200);
    expect(variant.headers.get('content-type')).toBe('image/webp');

    const again = await t.http.post(`/v1/sites/${site.id}/media/upload`).set(bearer(owner.accessToken)).attach('file', buf, 'copy.png');
    expect(again.body).toMatchObject({ id: up.body.id, duplicate: true });

    const fake = await t.http.post(`/v1/sites/${site.id}/media/upload`).set(bearer(owner.accessToken)).attach('file', Buffer.from('<html><script>x</script>'), { filename: 'evil.jpg', contentType: 'image/jpeg' });
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses to delete media in use unless forced', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const up = await t.http.post(`/v1/sites/${site.id}/media/upload`).set(bearer(owner.accessToken)).attach('file', await png(), 'used.png').expect(201);
    await page(owner, site.id, { title: 'Gallery', slug: 'gallery', content: tree({ id: 'i', type: 'image', props: { mediaId: up.body.id } }) });
    const del = await t.http.delete(`/v1/media/${up.body.id}`).set(bearer(owner.accessToken));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('MEDIA_IN_USE');
    await t.http.delete(`/v1/media/${up.body.id}?force=true`).set(bearer(owner.accessToken)).expect(204);
  });
});

describe('basic AI on content', () => {
  it('rewrites text with the site voice', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const r = await t.http.post('/v1/ai/text').set(bearer(owner.accessToken)).send({ action: 'shorten', text: 'Our product helps teams ship faster.', siteId: site.id }).expect(200);
    expect(r.body).toMatchObject({ status: 'SUCCEEDED', model: 'ollama/llama3.1:8b' });
    expect(r.body.text).toMatch(/^echo:/);
  });

  it('translates a page into a draft in another locale, keeping structure and facts', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Costs ' }, { type: 'factRef', attrs: { factKey: 'pro.price' } }] }] };
    const p = await page(owner, site.id, {
      title: 'About',
      slug: 'about',
      content: tree({ id: 'h', type: 'heading', props: { text: 'Who we are' } }, { id: 't', type: 'text', props: { doc } }, { id: 'b', type: 'button', props: { label: 'Contact', href: '/contact' } }),
    });
    const r = await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/ai-translate`).set(bearer(owner.accessToken)).send({ targetLocale: 'de' }).expect(200);
    const de = r.body.page;
    expect(de).toMatchObject({ locale: 'de', fullPath: '/about', status: 'DRAFT', title: '[tr] About' });
    const [h, txt, btn] = de.content.root.children;
    expect(h.props.text).toBe('[tr] Who we are');
    expect(btn.props).toMatchObject({ label: '[tr] Contact', href: '/contact' });
    expect(txt.props.doc.content[0].content[1]).toEqual({ type: 'factRef', attrs: { factKey: 'pro.price' } });
    // Same translation group → the source now lists its German sibling.
    const src = await t.http.get(`/v1/sites/${site.id}/pages/${p.id}`).set(bearer(owner.accessToken)).expect(200);
    expect(src.body.translations.map((x: { locale: string }) => x.locale)).toEqual(['de']);
    await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/ai-translate`).set(bearer(owner.accessToken)).send({ targetLocale: 'de' }).expect(409);
  });

  it('suggests SEO meta and generates alt text with a vision model', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const p = await page(owner, site.id, { title: 'Pricing', slug: 'pricing', content: tree({ id: 't', type: 'text', props: { doc: text('Plans for teams of every size.') } }) });
    const seo = await t.http.post(`/v1/sites/${site.id}/pages/${p.id}/ai-seo`).set(bearer(owner.accessToken)).send({}).expect(200);
    expect(seo.body.suggestion).toMatchObject({ title: 'Simple, fair pricing', keywords: ['pricing', 'plans'] });

    const up = await t.http.post(`/v1/sites/${site.id}/media/upload`).set(bearer(owner.accessToken)).attach('file', await sharp({ create: { width: 400, height: 400, channels: 3, background: '#7c3aed' } }).jpeg().toBuffer(), 'shape.jpg').expect(201);
    const alt = await t.http.post(`/v1/media/${up.body.id}/ai-alt`).set(bearer(owner.accessToken)).send({ apply: true }).expect(200);
    expect(alt.body).toMatchObject({ alt: 'A purple square with a yellow circle in the middle', applied: true, model: 'ollama/qwen2.5vl:7b' });
    const media = await t.http.get(`/v1/media/${up.body.id}`).set(bearer(owner.accessToken)).expect(200);
    expect(media.body).toMatchObject({ altGenerated: true });
  });

  it('viewers cannot run AI or edit content', async () => {
    const owner = await signUp(t);
    const site = await newSite(owner);
    const viewer = await invited(owner, 'VIEWER');
    await t.http.post('/v1/ai/text').set(bearer(viewer.accessToken)).send({ action: 'rewrite', text: 'x' }).expect(403);
    await t.http.post(`/v1/sites/${site.id}/pages`).set(bearer(viewer.accessToken)).send({ title: 'x', slug: 'x' }).expect(403);
  });
});
