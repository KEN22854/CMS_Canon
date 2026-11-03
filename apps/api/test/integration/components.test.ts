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

const header = (text: string) => ({ id: 'hdr', type: 'group', props: { layout: 'row' }, children: [{ id: 'brand', type: 'heading', props: { text, level: 4 }, children: [] }] });

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Components', defaultLocale: 'en' }).expect(201)).body as { id: string };
  const page = (await t.http.get(`/v1/sites/${site.id}/pages`).set(h).expect(200)).body.items[0] as { id: string; version: number; fullPath: string };
  return { owner, h, site, page };
}

describe('global components', () => {
  it('expands only the published version on live pages, the working copy in previews', async () => {
    const { owner, h, site, page } = await setup();
    const created = await t.http.post(`/v1/sites/${site.id}/components`).set(h).send({ name: 'Header', tree: header('Acme v1') }).expect(201);
    const c = created.body as { id: string; version: number; publishedVersion: number | null };
    expect(c).toMatchObject({ version: 1, publishedVersion: null, hasUnpublishedChanges: true });

    // Two instances on the page; the second overrides the brand text.
    const content = {
      root: {
        id: 'root',
        type: 'section',
        props: {},
        children: [
          { id: 'i1', type: 'component', props: { componentId: c.id }, children: [], styles: { base: { paddingTop: '8px' } } },
          { id: 'i2', type: 'component', props: { componentId: c.id, overrides: { brand: { text: 'Acme Docs' } } }, children: [] },
        ],
      },
    };
    await t.http.patch(`/v1/sites/${site.id}/pages/${page.id}`).set(h).send({ expectedVersion: page.version, content }).expect(200);
    await t.http.post(`/v1/sites/${site.id}/pages/${page.id}/publish`).set(h).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);

    // Not published yet: instances render nothing on the live site.
    const before = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=${page.fullPath}`).set(DELIVERY).expect(200);
    expect(before.body.page.content.root.children).toHaveLength(0);

    await t.http.post(`/v1/components/${c.id}/publish`).set(h).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);
    const live = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=${page.fullPath}`).set(DELIVERY).expect(200);
    const [a, b] = live.body.page.content.root.children;
    expect(a).toMatchObject({ id: 'i1', type: 'group', styles: { base: { paddingTop: '8px' } } });
    expect(a.children[0]).toMatchObject({ id: 'i1-brand', props: { text: 'Acme v1' } });
    expect(b.children[0]).toMatchObject({ id: 'i2-brand', props: { text: 'Acme Docs' } });

    // Editing the working copy doesn't touch the live site until it is published again.
    const edited = await t.http.patch(`/v1/components/${c.id}`).set(h).send({ version: 1, tree: header('Acme v2') }).expect(200);
    expect(edited.body).toMatchObject({ version: 2, publishedVersion: 1, hasUnpublishedChanges: true });
    await t.http.patch(`/v1/components/${c.id}`).set(h).send({ version: 1, name: 'Stale' }).expect(409);
    await drainOutbox(t, owner.tenantId);
    const still = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=${page.fullPath}`).set(DELIVERY).expect(200);
    expect(still.body.page.content.root.children[0].children[0].props.text).toBe('Acme v1');

    const { body: preview } = await t.http.post(`/v1/sites/${site.id}/pages/${page.id}/preview`).set(h).send({}).expect(200);
    const token = new URL(preview.url).searchParams.get('token')!;
    const draft = await t.http.get(`/v1/delivery/preview?token=${encodeURIComponent(token)}`).set(DELIVERY).expect(200);
    expect(draft.body.page.content.root.children[0].children[0].props.text).toBe('Acme v2');

    await t.http.post(`/v1/components/${c.id}/publish`).set(h).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);
    const updated = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=${page.fullPath}`).set(DELIVERY).expect(200);
    expect(updated.body.page.content.root.children[0].children[0].props.text).toBe('Acme v2');

    // Deleting it removes the instances from the live page.
    await t.http.delete(`/v1/components/${c.id}`).set(h).expect(204);
    await drainOutbox(t, owner.tenantId);
    const gone = await t.http.get(`/v1/delivery/sites/${site.id}/page?path=${page.fullPath}`).set(DELIVERY).expect(200);
    expect(gone.body.page.content.root.children).toHaveLength(0);
  });

  it('validates trees, refuses nesting and enforces roles and tenants', async () => {
    const { owner, h, site } = await setup();
    const bad = await t.http.post(`/v1/sites/${site.id}/components`).set(h).send({ name: 'Bad', tree: { id: 'x', type: 'heading', props: { level: 9 }, children: [] } }).expect(400);
    expect(bad.body.error.code).toBe('INVALID_CONTENT');
    const nested = await t.http.post(`/v1/sites/${site.id}/components`).set(h).send({ name: 'Nested', tree: { id: 'g', type: 'group', props: {}, children: [{ id: 'i', type: 'component', props: { componentId: 'abc' }, children: [] }] } }).expect(400);
    expect(nested.body.error.message).toMatch(/cannot contain other components/);
    const unsafe = await t.http.post(`/v1/sites/${site.id}/components`).set(h).send({ name: 'Unsafe', tree: { ...header('x'), styles: { base: { color: 'red;background:url(javascript:1)' } } } }).expect(400);
    expect(unsafe.body.error.code).toBe('INVALID_CONTENT');

    const ok = (await t.http.post(`/v1/sites/${site.id}/components`).set(h).send({ name: 'Footer', tree: header('Footer') }).expect(201)).body as { id: string };
    const viewer = await invited(t, owner, 'VIEWER');
    await t.http.get(`/v1/sites/${site.id}/components`).set(bearer(viewer.accessToken)).expect(200);
    await t.http.patch(`/v1/components/${ok.id}`).set(bearer(viewer.accessToken)).send({ version: 1, name: 'Nope' }).expect(403);
    await t.http.post(`/v1/components/${ok.id}/publish`).set(bearer(viewer.accessToken)).send({}).expect(403);

    // Another workspace can't see or touch it (RLS + tenant scoping).
    const stranger = await signUp(t);
    await t.http.get(`/v1/components/${ok.id}`).set(bearer(stranger.accessToken)).expect(404);
    await t.http.patch(`/v1/components/${ok.id}`).set(bearer(stranger.accessToken)).send({ version: 1, name: 'Mine' }).expect(404);
  });
});
