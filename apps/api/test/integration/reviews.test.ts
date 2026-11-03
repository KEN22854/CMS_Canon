import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishScheduler } from '../../src/modules/pages/publish-scheduler';
import { bearer, createTestApp, invited, signUp, type SignedIn, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    KNOWLEDGE: 'off',
    CANON_EXTRACT: 'off',
    CANON_PROPAGATE: 'off',
    ENRICHMENT: 'off',
    ANALYTICS_FLUSH: 'off',
    ANALYTICS_JOBS: 'off',
    SCHEDULER: 'off',
  });
});

afterAll(async () => {
  await t.close();
});

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = (
    await t.http.post('/v1/sites').set(h).send({ name: 'Reviewed', defaultLocale: 'en' }).expect(201)
  ).body as { id: string };
  const page = (await t.http.get(`/v1/sites/${site.id}/pages`).set(h).expect(200)).body.items[0] as {
    id: string;
    version: number;
  };
  const author = await invited(t, owner, 'AUTHOR');
  const editor = await invited(t, owner, 'EDITOR');
  return { owner, h, site, page, author, editor };
}

const as = (u: SignedIn) => bearer(u.accessToken);

describe('review workflow', () => {
  it('gates publishing on an approval of the exact draft version', async () => {
    const { owner, h, site, page, author, editor } = await setup();
    // The edits below are by the editor (authors only edit their own pages).
    const publish = (u: SignedIn, body: object = {}) =>
      t.http.post(`/v1/sites/${site.id}/pages/${page.id}/publish`).set(as(u)).send(body);

    // Off by default: editors publish directly.
    await publish(editor).expect(200);
    expect(
      (await t.http.patch(`/v1/sites/${site.id}`).set(h).send({ requireReview: true }).expect(200)).body
        .requireReview,
    ).toBe(true);

    const blocked = await publish(editor).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'REVIEW_REQUIRED', details: { canOverride: false } });

    // An author asks for review; editors and the owner are notified.
    const review = (
      await t.http
        .post(`/v1/sites/${site.id}/reviews`)
        .set(as(author))
        .send({ entityType: 'PAGE', entityId: page.id, note: 'New pricing copy' })
        .expect(201)
    ).body;
    expect(review).toMatchObject({
      status: 'OPEN',
      version: page.version,
      stale: false,
      requestedByName: expect.any(String),
    });
    expect(
      await t.system.notification.count({
        where: { type: 'review.requested', userId: { in: [owner.userId, editor.userId] } },
      }),
    ).toBe(2);
    expect(
      await t.system.notification.count({ where: { type: 'review.requested', userId: author.userId } }),
    ).toBe(0);

    // Authors cannot review; nobody reviews their own request; "changes" needs a note.
    await t.http.post(`/v1/reviews/${review.id}/approve`).set(as(author)).send({}).expect(403);
    await t.http.post(`/v1/reviews/${review.id}/request-changes`).set(as(editor)).send({}).expect(400);
    const queue = (
      await t.http.get(`/v1/sites/${site.id}/reviews?status=OPEN&mine=true`).set(as(editor)).expect(200)
    ).body as { id: string }[];
    expect(queue.map((r) => r.id)).toEqual([review.id]);

    const approved = (
      await t.http
        .post(`/v1/reviews/${review.id}/approve`)
        .set(as(editor))
        .send({ note: 'Looks good' })
        .expect(200)
    ).body;
    expect(approved).toMatchObject({ status: 'APPROVED', decidedByName: expect.any(String) });
    expect(
      await t.system.notification.findFirst({ where: { type: 'review.decided', userId: author.userId } }),
    ).toMatchObject({ title: expect.stringContaining('approved') });
    await t.http.post(`/v1/reviews/${review.id}/approve`).set(as(owner)).send({}).expect(409); // already decided

    // An edit after approval makes it stale.
    await t.http
      .patch(`/v1/sites/${site.id}/pages/${page.id}`)
      .set(as(editor))
      .send({ expectedVersion: page.version, title: 'Edited after approval' })
      .expect(200);
    expect((await publish(editor).expect(409)).body.error.message).toContain('changed since');

    // Owners can override, and it is audited; editors cannot.
    await publish(editor, { overrideReview: true }).expect(409);
    await publish(owner, { overrideReview: true }).expect(200);
    expect(
      await t.system.auditLog.count({ where: { tenantId: owner.tenantId, action: 'review.overridden' } }),
    ).toBe(1);

    // A fresh review of the new version unblocks a normal publish.
    const again = (
      await t.http
        .post(`/v1/sites/${site.id}/reviews`)
        .set(as(author))
        .send({ entityType: 'PAGE', entityId: page.id, reviewerIds: [editor.userId] })
        .expect(201)
    ).body;
    await t.http.post(`/v1/reviews/${again.id}/approve`).set(as(editor)).send({}).expect(200);
    await publish(editor).expect(200);

    // Reviewers must be publishers.
    await t.http
      .post(`/v1/sites/${site.id}/reviews`)
      .set(as(author))
      .send({ entityType: 'PAGE', entityId: page.id, reviewerIds: [author.userId] })
      .expect(400);
  });

  it('does not let a scheduled publish ship edits made after approval', async () => {
    const { h, site, page, author, editor } = await setup();
    await t.http.patch(`/v1/sites/${site.id}`).set(h).send({ requireReview: true }).expect(200);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await t.http
      .post(`/v1/sites/${site.id}/pages/${page.id}/schedule`)
      .set(as(editor))
      .send({ at })
      .expect(409);

    const r = (
      await t.http
        .post(`/v1/sites/${site.id}/reviews`)
        .set(as(author))
        .send({ entityType: 'PAGE', entityId: page.id })
        .expect(201)
    ).body;
    await t.http.post(`/v1/reviews/${r.id}/approve`).set(as(editor)).send({}).expect(200);
    await t.http
      .post(`/v1/sites/${site.id}/pages/${page.id}/schedule`)
      .set(as(editor))
      .send({ at })
      .expect(200);
    await t.http
      .patch(`/v1/sites/${site.id}/pages/${page.id}`)
      .set(as(editor))
      .send({ expectedVersion: page.version, title: 'Sneaky' })
      .expect(200);

    const row = await t.system.scheduledPublish.findFirstOrThrow({
      where: { entityId: page.id, status: 'PENDING' },
    });
    await t.app.get(PublishScheduler).run(row.id);
    expect((await t.system.scheduledPublish.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'FAILED',
    );
  });

  it('threads comments on blocks, notifies mentions and replies, and resolves threads', async () => {
    const { owner, site, page, author, editor } = await setup();
    const base = { entityType: 'PAGE', entityId: page.id };
    const outsider = await signUp(t);

    const root = (
      await t.http
        .post('/v1/comments')
        .set(as(editor))
        .send({
          ...base,
          blockId: 'hero-1',
          body: '@Author can we shorten the headline?',
          mentions: [author.userId, outsider.userId],
        })
        .expect(201)
    ).body;
    expect(root).toMatchObject({
      blockId: 'hero-1',
      mentions: [author.userId],
      authorName: expect.any(String),
    }); // outsiders are dropped
    expect(
      await t.system.notification.count({ where: { type: 'comment.mentioned', userId: author.userId } }),
    ).toBe(1);
    expect(
      await t.system.notification.count({ where: { userId: outsider.userId, type: 'comment.mentioned' } }),
    ).toBe(0);

    const reply = (
      await t.http
        .post('/v1/comments')
        .set(as(author))
        .send({ ...base, parentId: root.id, body: 'Done.' })
        .expect(201)
    ).body;
    expect(reply).toMatchObject({ parentId: root.id, blockId: 'hero-1' }); // replies inherit the anchor
    expect(
      await t.system.notification.findFirst({ where: { type: 'comment.mentioned', userId: editor.userId } }),
    ).toMatchObject({ title: expect.stringContaining('replied') });

    await t.http.patch(`/v1/comments/${root.id}`).set(as(author)).send({ body: 'hijack' }).expect(403);
    await t.http.patch(`/v1/comments/${reply.id}`).set(as(author)).send({ resolved: true }).expect(400);
    expect(
      (await t.http.patch(`/v1/comments/${root.id}`).set(as(author)).send({ resolved: true }).expect(200))
        .body.resolvedAt,
    ).toBeTruthy();

    const list = (
      await t.http.get(`/v1/comments?entityType=PAGE&entityId=${page.id}`).set(as(author)).expect(200)
    ).body as { id: string }[];
    expect(list.map((c) => c.id)).toEqual([root.id, reply.id]);
    await t.http.get(`/v1/comments?entityType=PAGE&entityId=${page.id}`).set(as(outsider)).expect(404);

    await t.http.delete(`/v1/comments/${root.id}`).set(as(author)).expect(403);
    await t.http.delete(`/v1/comments/${root.id}`).set(as(owner)).expect(204);
    expect(
      (await t.http.get(`/v1/comments?entityType=PAGE&entityId=${page.id}`).set(as(author)).expect(200)).body,
    ).toEqual([]);
    void site;
  });
});
