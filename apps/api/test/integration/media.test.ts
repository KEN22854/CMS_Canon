import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, type SignedIn, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
});

afterAll(async () => {
  await t.close();
});

const image = (color: string, w = 320) => sharp({ create: { width: w, height: 200, channels: 3, background: color } }).png().toBuffer();

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (await t.http.post('/v1/sites').set(h).send({ name: 'Media', defaultLocale: 'en' }).expect(201)).body as { id: string };
  return { owner, h, siteId: site.id };
}

async function presignAndPut(c: { h: Record<string, string>; siteId: string }, body: Buffer, name: string, contentType = 'image/png') {
  const p = await t.http.post(`/v1/sites/${c.siteId}/media/presign`).set(c.h).send({ filename: name, contentType, size: body.length, folder: '/big' }).expect(201);
  const put = await fetch(p.body.uploadUrl as string, { method: 'PUT', headers: p.body.headers as Record<string, string>, body });
  expect(put.ok, `${put.status} ${await put.text()}`).toBe(true);
  return p.body.mediaId as string;
}

describe('media: direct-to-storage uploads', () => {
  it('signs, receives the object, verifies the real type, processes and deduplicates', async () => {
    const c = await setup();
    const p = await t.http.post(`/v1/sites/${c.siteId}/media/presign`).set(c.h).send({ filename: 'Hero Shot!.PNG', contentType: 'image/png', size: 10, folder: '/big' }).expect(201);
    expect(p.body).toMatchObject({ method: 'PUT', expiresInSec: expect.any(Number) });
    // Completing before the browser uploaded anything is refused.
    expect((await t.http.post(`/v1/media/${p.body.mediaId}/complete`).set(c.h).expect(400)).body.error.code).toBe('UPLOAD_MISSING');

    const bytes = await image('#2563eb', 640);
    const id = await presignAndPut(c, bytes, 'hero.png');
    const done = await t.http.post(`/v1/media/${id}/complete`).set(c.h).expect(200);
    expect(done.body).toMatchObject({ id, status: 'READY', mimeType: 'image/png', duplicate: false, width: 640 });
    // Completing twice is harmless.
    expect((await t.http.post(`/v1/media/${id}/complete`).set(c.h).expect(200)).body).toMatchObject({ id, status: 'READY' });

    // The same bytes again resolve to the existing item; the placeholder is discarded.
    const again = await presignAndPut(c, bytes, 'copy.png');
    const dup = await t.http.post(`/v1/media/${again}/complete`).set(c.h).expect(200);
    expect(dup.body).toMatchObject({ id, duplicate: true });
    await t.http.get(`/v1/media/${again}`).set(c.h).expect(404);
  });

  it('rejects disguised files after upload, and oversized requests before', async () => {
    const c = await setup();
    const id = await presignAndPut(c, Buffer.from('<?php system($_GET["c"]); ?>'), 'cat.png');
    const bad = await t.http.post(`/v1/media/${id}/complete`).set(c.h);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    await t.http.get(`/v1/media/${id}`).set(c.h).expect(404);
    const big = await t.http.post(`/v1/sites/${c.siteId}/media/presign`).set(c.h).send({ filename: 'movie.mp4', contentType: 'video/mp4', size: 6_000 * 1_048_576 }).expect(400);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('media: library', () => {
  it('filters, searches, pages, edits metadata and stays tenant-scoped', async () => {
    const c = await setup();
    const up = async (color: string, name: string, folder: string) => (await t.http.post(`/v1/sites/${c.siteId}/media/upload`).set(c.h).attach('file', await image(color), name).field('folder', folder).expect(201)).body as { id: string };
    const a = await up('#ef4444', 'team-photo.png', '/team');
    await up('#22c55e', 'logo.png', '/brand');
    await up('#a855f7', 'banner.png', '/brand');

    const list = (q: string) => t.http.get(`/v1/sites/${c.siteId}/media${q}`).set(c.h).expect(200).then((r) => r.body as { items: { id: string; originalName: string }[]; nextCursor: string | null });
    expect((await list('?folder=/brand')).items.map((i) => i.originalName).sort()).toEqual(['banner.png', 'logo.png']);
    expect((await list('?q=team')).items.map((i) => i.id)).toEqual([a.id]);
    expect((await list('?kind=document')).items).toEqual([]);
    const page1 = await list('?limit=2');
    expect(page1.items).toHaveLength(2);
    const page2 = await list(`?limit=2&cursor=${page1.nextCursor}`);
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const edited = await t.http.patch(`/v1/media/${a.id}`).set(c.h).send({ alt: 'Our team at the offsite', tags: ['People', 'Offsite'], title: 'Team' }).expect(200);
    expect(edited.body).toMatchObject({ alt: 'Our team at the offsite', altGenerated: false, tags: ['people', 'offsite'] });
    expect((await list('?tag=people')).items.map((i) => i.id)).toEqual([a.id]);
    await t.http.patch(`/v1/media/${a.id}`).set(c.h).send({ url: 'https://evil.example/x.png' }).expect(400);
    expect((await t.http.get(`/v1/media/${a.id}/usage`).set(c.h).expect(200)).body).toEqual([]);

    const other: SignedIn = await signUp(t);
    await t.http.get(`/v1/media/${a.id}`).set(bearer(other.accessToken)).expect(404);
    await t.http.get(`/v1/sites/${c.siteId}/media`).set(bearer(other.accessToken)).expect(404);
    await t.http.delete(`/v1/media/${a.id}`).set(bearer(other.accessToken)).expect(404);
  });
});
