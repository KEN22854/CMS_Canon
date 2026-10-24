import type { AddressInfo } from 'node:net';
import { Y, applyDraftDiff, yDocToDraft, type CollabDraft } from '@canon/collab';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CollabServer } from '../../src/modules/collab/collab.server';
import { PASSWORD, bearer, createTestApp, ip, refreshCookie, signUp, tokenFromMail, uniqueEmail, type SignedIn, type TestApp } from './harness';

// y-websocket is ESM-only; this test file type-checks as CommonJS, so load it dynamically.
type YWebsocket = typeof import('y-websocket', { with: { 'resolution-mode': 'import' } });
type WebsocketProvider = InstanceType<YWebsocket['WebsocketProvider']>;
let WebsocketProvider: YWebsocket['WebsocketProvider'];
let t: TestApp;
let base: string;
const providers: WebsocketProvider[] = [];

beforeAll(async () => {
  ({ WebsocketProvider } = await import('y-websocket'));
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
  const server = t.app.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/collab`;
});

afterAll(async () => {
  for (const p of providers) p.destroy();
  await t.close();
});

async function invited(owner: SignedIn, role: string): Promise<SignedIn> {
  const email = uniqueEmail(role.toLowerCase());
  await t.http.post(`/v1/tenants/${owner.tenantId}/members/invite`).set(bearer(owner.accessToken)).send({ email, role }).expect(201);
  const token = tokenFromMail(t.mailer, email, /invite\/([\w-]+)/);
  const r = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: role, inviteToken: token }).expect(201);
  return { email, accessToken: r.body.accessToken, cookie: refreshCookie(r), userId: r.body.user.id, tenantId: r.body.tenant.id };
}

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = await t.http.post('/v1/sites').set(h).send({ name: 'Collab', defaultLocale: 'en', locales: ['en'] }).expect(201);
  const page = await t.http
    .post(`/v1/sites/${site.body.id}/pages`)
    .set(h)
    .send({ title: 'Pricing', slug: 'pricing', content: { root: { id: 'root', type: 'section', props: {}, children: [{ id: 'hero', type: 'hero', props: { title: 'Simple pricing', ctaLabel: 'Start' } }] } } })
    .expect(201);
  return { owner, h, siteId: site.body.id as string, pageId: page.body.id as string, room: `page:${page.body.id}` };
}

function connect(room: string, token: string, user: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(base, room, doc, { WebSocketPolyfill: WebSocket as never, params: { token }, disableBc: true });
  provider.awareness.setLocalStateField('user', { name: user });
  providers.push(provider);
  return { doc, provider };
}

const synced = (p: WebsocketProvider) => new Promise<void>((resolve) => (p.synced ? resolve() : p.once('sync', (s: boolean) => s && resolve())));

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Status of a raw upgrade attempt (the server answers before switching protocols). */
function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => (ws.close(), resolve(101)));
    ws.on('error', () => undefined);
  });
}

const edit = (doc: Y.Doc, change: (d: CollabDraft) => void) => {
  const prev = yDocToDraft(doc)!;
  const next: CollabDraft = JSON.parse(JSON.stringify(prev));
  change(next);
  applyDraftDiff(doc, prev, next);
};

describe('collaboration server', () => {
  it('authenticates the upgrade and scopes rooms to the tenant', async () => {
    const c = await setup();
    const stranger = await signUp(t);
    expect(await upgradeStatus(`${base}/${c.room}`)).toBe(401);
    expect(await upgradeStatus(`${base}/${c.room}?token=nope`)).toBe(401);
    expect(await upgradeStatus(`${base}/${c.room}?token=${stranger.accessToken}`)).toBe(404);
    expect(await upgradeStatus(`${base}/entry:${c.pageId}?token=${c.owner.accessToken}`)).toBe(404);
    expect(await upgradeStatus(`${base}/${c.room}?token=${c.owner.accessToken}`)).toBe(101);
  });

  it('syncs two editors per prop, shares presence and keeps viewers read-only', async () => {
    const c = await setup();
    const editor = await invited(c.owner, 'EDITOR');
    const viewer = await invited(c.owner, 'VIEWER');
    const a = connect(c.room, c.owner.accessToken, 'Owner');
    const b = connect(c.room, editor.accessToken, 'Editor');
    const v = connect(c.room, viewer.accessToken, 'Viewer');
    await Promise.all([synced(a.provider), synced(b.provider), synced(v.provider)]);
    // The room is seeded from the saved draft.
    expect(yDocToDraft(b.doc)!.content.root.children[0]!.props.title).toBe('Simple pricing');

    // Concurrent edits of different props of the same block both survive.
    edit(a.doc, (d) => (d.content.root.children[0]!.props.title = 'Pricing for teams'));
    edit(b.doc, (d) => (d.content.root.children[0]!.props.ctaLabel = 'Try free'));
    await until(() => [a, b, v].every((x) => ((p) => p.title === 'Pricing for teams' && p.ctaLabel === 'Try free')(yDocToDraft(x.doc)!.content.root.children[0]!.props)));

    // Presence: everyone sees the three users.
    await until(() => [...a.provider.awareness.getStates().values()].filter((s) => s.user).length === 3);

    // The viewer's local change never reaches the room.
    edit(v.doc, (d) => (d.title = 'Hacked'));
    edit(a.doc, (d) => (d.description = 'marker'));
    await until(() => yDocToDraft(b.doc)!.description === 'marker');
    expect(yDocToDraft(b.doc)!.title).toBe('Pricing');

    // Leaving removes presence.
    b.provider.destroy();
    await until(() => [...a.provider.awareness.getStates().values()].filter((s) => s.user).length === 2);
  });

  it('persists the room, restores it, and re-seeds when the page was saved outside the session', async () => {
    const c = await setup();
    const collab = t.app.get(CollabServer);
    const a = connect(c.room, c.owner.accessToken, 'Owner');
    await synced(a.provider);
    edit(a.doc, (d) => (d.content.root.children[0]!.props.title = 'Unsaved live edit'));
    await new Promise((r) => setTimeout(r, 100));
    a.provider.destroy();
    await collab.evict(c.room);
    const row = await t.system.collabDocument.findUnique({ where: { name: c.room } });
    expect(row).toMatchObject({ entityType: 'PAGE', entityId: c.pageId, version: 1 });

    // Same page version → the live (not yet saved) state comes back.
    const b = connect(c.room, c.owner.accessToken, 'Owner again');
    await synced(b.provider);
    expect(yDocToDraft(b.doc)!.content.root.children[0]!.props.title).toBe('Unsaved live edit');
    b.provider.destroy();
    await collab.evict(c.room);

    // A save outside the session bumps the version → the stale room state is dropped.
    await t.http.patch(`/v1/sites/${c.siteId}/pages/${c.pageId}`).set(c.h).send({ expectedVersion: 1, title: 'Plans' }).expect(200);
    const d = connect(c.room, c.owner.accessToken, 'Owner later');
    await synced(d.provider);
    const draft = yDocToDraft(d.doc)!;
    expect(draft.title).toBe('Plans');
    expect(draft.content.root.children[0]!.props.title).toBe('Simple pricing');
  });
});
