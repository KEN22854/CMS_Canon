import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, signUp, type TestApp } from './harness';

const DELIVERY = { 'x-canon-delivery': 'test-delivery-token-0123456789' };
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off' });
});

afterAll(async () => {
  await t.close();
});

interface TestNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: TestNode[];
  styles?: unknown;
}
const node = (id: string, type: string, props: Record<string, unknown>, children: TestNode[] = [], extra: Partial<TestNode> = {}): TestNode => ({ id, type, props, children, ...extra });

describe('infinite canvas builder: elements and styles through the existing page API', () => {
  it('saves icons, badges, lists, cropped images and per-breakpoint layout styles; refuses unsafe ones; delivers them', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Board site', defaultLocale: 'en' }).expect(201)).body as { id: string };
    const s = `/v1/sites/${site.id}`;
    const page = (await t.http.post(`${s}/pages`).set(h).send({ title: 'Landing', slug: 'landing' }).expect(201)).body as { id: string; version: number };

    const content = {
      root: node('root', 'section', {}, [
        node('hero', 'section', { background: 'default', paddingY: 'lg', width: 'wide', anchor: '' }, [
          node('row', 'group', { layout: 'row', gap: 'md', align: 'center', columns: 3 }, [node('ic', 'icon', { name: 'camera', size: 'xl', tone: 'primary', circle: true, align: 'left', label: '' }), node('bd', 'badge', { text: 'Portfolio', tone: 'outline', align: 'left' })], {
            // Desktop: a row; phones: a column with a smaller gap — only the mobile override changes.
            styles: { base: { display: 'flex', flexDirection: 'row', gap: '24px' }, mobileS: { flexDirection: 'column', gap: '12px', alignSelf: 'stretch' } },
          }),
          node('li', 'list', { items: [{ text: 'Weddings' }, { text: 'Portraits' }], marker: 'check', align: 'left' }),
          node('im', 'image', { mediaId: '', src: 'https://images.unsplash.com/photo-1', alt: 'Camera', caption: '', rounded: true, ratio: '16/9', fit: 'cover', focus: 'top', overlay: 'dark' }, [], { styles: { base: { aspectRatio: '16/9', backdropFilter: 'blur(4px)' } } }),
        ]),
      ]),
    };
    const saved = (await t.http.patch(`${s}/pages/${page.id}`).set(h).send({ expectedVersion: page.version, content }).expect(200)).body as { version: number };

    // The style layer still refuses anything outside its grammars, whatever the editor sends.
    const bad = structuredClone(content);
    bad.root.children[0]!.children[0]!.styles = { base: { backgroundImage: 'url(https://evil.example/x.png)' } };
    await t.http.patch(`${s}/pages/${page.id}`).set(h).send({ expectedVersion: saved.version, content: bad }).expect(400);
    const unknownIcon = structuredClone(content);
    unknownIcon.root.children[0]!.children[0]!.children[0]!.props.name = 'not-an-icon';
    await t.http.patch(`${s}/pages/${page.id}`).set(h).send({ expectedVersion: saved.version, content: unknownIcon }).expect(400);

    await t.http.post(`${s}/pages/${page.id}/publish`).set(h).send({}).expect(200);
    await drainOutbox(t, owner.tenantId);
    const live = await t.http.get(`/v1/delivery/sites/${site.id}/page`).query({ path: '/landing' }).set(DELIVERY).expect(200);
    const blocks = JSON.stringify(live.body.page.content);
    for (const type of ['"icon"', '"badge"', '"list"']) expect(blocks).toContain(type);
    const row = live.body.page.content.root.children[0].children[0];
    expect(row.styles).toEqual({ base: { display: 'flex', flexDirection: 'row', gap: '24px' }, mobileS: { flexDirection: 'column', gap: '12px', alignSelf: 'stretch' } });
    expect(live.body.page.content.root.children[0].children[2].props).toMatchObject({ ratio: '16/9', focus: 'top', overlay: 'dark' });
  });
});
