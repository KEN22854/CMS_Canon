import { getThemePreset, themeTokens } from '@canon/blocks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, drainOutbox, invited, signUp, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off', SCHEDULER: 'off' });
});

afterAll(async () => {
  await t.close();
});

describe('themes', () => {
  it('a preset applied to one site, saved for the workspace, applied to another; editors may only look', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    // Two sites need a paid plan (the free one has one site).
    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'PRO' } });
    const a = (await t.http.post('/v1/sites').set(h).send({ name: 'Bakery one', defaultLocale: 'en' }).expect(201)).body as { id: string };
    const b = (await t.http.post('/v1/sites').set(h).send({ name: 'Bakery two', defaultLocale: 'en' }).expect(201)).body as { id: string };

    const bakery = themeTokens(getThemePreset('bakery')!);
    await t.http.patch(`/v1/sites/${a.id}/theme`).set(h).send(bakery).expect(200);
    const saved = (await t.http.post('/v1/themes').set(h).send({ name: 'Our bakery', theme: bakery }).expect(201)).body as { id: string };
    await t.http.post('/v1/themes').set(h).send({ name: 'Bad', theme: { ...bakery, colors: { ...bakery.colors, primary: 'red' } } }).expect(400);
    await t.http.post('/v1/themes').set(h).send({ name: 'Partial', theme: { font: 'Lora' } }).expect(400);

    const list = (await t.http.get('/v1/themes').set(h).expect(200)).body as { id: string; name: string; theme: typeof bakery }[];
    expect(list).toEqual([expect.objectContaining({ id: saved.id, name: 'Our bakery', theme: bakery })]);
    await t.http.patch(`/v1/sites/${b.id}/theme`).set(h).send(list[0]!.theme).expect(200);
    await drainOutbox(t, owner.tenantId);
    const site = (await t.http.get(`/v1/sites/${b.id}`).set(h).expect(200)).body as { theme: typeof bakery };
    expect(site.theme).toMatchObject(bakery);

    const editor = await invited(t, owner, 'EDITOR');
    await t.http.get('/v1/themes').set(bearer(editor.accessToken)).expect(200);
    await t.http.post('/v1/themes').set(bearer(editor.accessToken)).send({ name: 'Mine', theme: bakery }).expect(403);
    await t.http.delete(`/v1/themes/${saved.id}`).set(h).expect(204);
    await t.http.delete(`/v1/themes/${saved.id}`).set(h).expect(404);
    // Other workspaces have their own list.
    const stranger = await signUp(t);
    expect((await t.http.get('/v1/themes').set(bearer(stranger.accessToken)).expect(200)).body).toEqual([]);
  });
});
