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

const node = (id: string, type: string, props: Record<string, unknown>, children: unknown[] = []) => ({ id, type, props, children });
const pageWith = (title: string) => ({ root: node('root', 'section', {}, [node('h', 'heading', { text: title, level: 1 }), node('c', 'component', { componentId: '__ID__', overrides: {} })]) });
const header = (text: string) => node('hdr', 'group', { layout: 'row' }, [node('brand', 'heading', { text, level: 4 })]);

describe('site releases', () => {
  it('record what is live and roll the whole site back (pages, components, entries), undoably', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Releases', defaultLocale: 'en' }).expect(201)).body as { id: string };
    const s = `/v1/sites/${site.id}`;
    const live = async (path: string) => {
      await drainOutbox(t, owner.tenantId);
      const r = await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path }).set(DELIVERY);
      return r.status === 200 ? JSON.stringify(r.body.page.content) : null;
    };

    // v1 of everything: a component, a page using it, an entry.
    const comp = (await t.http.post(`${s}/components`).set(h).send({ name: 'Header', tree: header('Brand v1') }).expect(201)).body as { id: string };
    await t.http.post(`/v1/components/${comp.id}/publish`).set(h).send({}).expect(200);
    const about = (await t.http.post(`${s}/pages`).set(h).send({ title: 'About', slug: 'about' }).expect(201)).body as { id: string; version: number };
    const v1 = (await t.http.patch(`${s}/pages/${about.id}`).set(h).send({ expectedVersion: about.version, content: JSON.parse(JSON.stringify(pageWith('About v1')).replace('__ID__', comp.id)) }).expect(200)).body as { version: number };
    await t.http.post(`${s}/pages/${about.id}/publish`).set(h).send({}).expect(200);
    const col = (await t.http.post(`${s}/collections`).set(h).send({ name: 'News', slug: 'news', fields: [{ name: 'title', label: 'Title', type: 'text' }] }).expect(201)).body as { id: string };
    const old = (await t.http.post(`${s}/collections/${col.id}/entries`).set(h).send({ data: { title: 'Old news' } }).expect(201)).body as { id: string };
    await t.http.post(`${s}/collections/${col.id}/entries/${old.id}/publish`).set(h).send({}).expect(200);

    const r1 = (await t.http.post(`${s}/releases`).set(h).send({ note: 'Before the redesign' }).expect(201)).body;
    expect(r1).toMatchObject({ number: 1, note: 'Before the redesign', automatic: false, componentCount: 1, entryCount: 1 });
    expect(r1.pages.map((p: { path: string }) => p.path)).toEqual(['/about']); // the new site's home is still a draft

    // The "bad" change: new texts, a new header, a new page, a new entry.
    await t.http.patch(`${s}/pages/${about.id}`).set(h).send({ expectedVersion: v1.version, content: JSON.parse(JSON.stringify(pageWith('About v2 — broken')).replace('__ID__', comp.id)) }).expect(200);
    await t.http.post(`${s}/pages/${about.id}/publish`).set(h).send({}).expect(200);
    await t.http.patch(`/v1/components/${comp.id}`).set(h).send({ version: 1, tree: header('Brand v2') }).expect(200);
    await t.http.post(`/v1/components/${comp.id}/publish`).set(h).send({}).expect(200);
    const promo = (await t.http.post(`${s}/pages`).set(h).send({ title: 'Promo', slug: 'promo' }).expect(201)).body as { id: string };
    await t.http.post(`${s}/pages/${promo.id}/publish`).set(h).send({}).expect(200);
    const fresh = (await t.http.post(`${s}/collections/${col.id}/entries`).set(h).send({ data: { title: 'Fresh news' } }).expect(201)).body as { id: string };
    await t.http.post(`${s}/collections/${col.id}/entries/${fresh.id}/publish`).set(h).send({}).expect(200);
    expect(await live('/about')).toContain('About v2');
    expect(await live('/about')).toContain('Brand v2');

    // What rolling back would do.
    const diff = (await t.http.get(`${s}/releases/${r1.id}`).set(h).expect(200)).body;
    expect(diff.changes.restored).toEqual([expect.objectContaining({ path: '/about', to: 2 })]);
    expect(diff.changes.unpublished).toEqual([expect.objectContaining({ path: '/promo' })]);
    expect(diff.changes).toMatchObject({ components: 1, entries: 1, missing: [] });

    // Editors may record releases but not roll the site back.
    const editor = await invited(t, owner, 'EDITOR');
    await t.http.post(`${s}/releases`).set(bearer(editor.accessToken)).send({}).expect(201);
    await t.http.post(`${s}/releases/${r1.id}/rollback`).set(bearer(editor.accessToken)).send({}).expect(403);

    const res = (await t.http.post(`${s}/releases/${r1.id}/rollback`).set(h).send({}).expect(200)).body;
    expect(res).toMatchObject({ restored: 1, unpublished: 1, skipped: 0, backup: { number: 3, automatic: true, note: 'Before rollback to release 1' } });
    expect(await live('/about')).toContain('About v1');
    expect(await live('/about')).toContain('Brand v1');
    expect(await live('/promo')).toBeNull();
    const entries = (await t.http.get(`${s}/collections/${col.id}/entries`).set(h).expect(200)).body.items as { title: string; publishedVersion: number | null }[];
    expect(entries.find((e) => e.title === 'Fresh news')!.publishedVersion).toBeNull();
    expect(entries.find((e) => e.title === 'Old news')!.publishedVersion).toBe(1);
    // The draft is untouched: work in progress isn't lost by a rollback.
    expect(JSON.stringify((await t.http.get(`${s}/pages/${about.id}`).set(h).expect(200)).body.content)).toContain('About v2');

    // …and the rollback itself can be undone.
    await t.http.post(`${s}/releases/${res.backup.id}/rollback`).set(h).send({}).expect(200);
    expect(await live('/about')).toContain('About v2');
    expect(await live('/promo')).not.toBeNull();
    expect((await t.http.get(`${s}/releases`).set(h).expect(200)).body.map((r: { number: number }) => r.number)).toEqual([4, 3, 2, 1]);

    // Other workspaces see nothing.
    const stranger = await signUp(t);
    await t.http.get(`${s}/releases/${r1.id}`).set(bearer(stranger.accessToken)).expect(404);
  });
});
