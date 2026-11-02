import { PrismaClient } from '@canon/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditTrailService } from '../../src/modules/compliance/audit-trail.service';
import { PrivacyService } from '../../src/modules/compliance/privacy.service';
import { PASSWORD, bearer, createTestApp, invited, ip, signUp, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
});

afterAll(async () => {
  await t.close();
});

describe('audit trail', () => {
  it('lists with filters and cursor, exports CSV safely, and is admin-only', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    await t.http.post('/v1/api-keys').set(h).send({ name: '=HYPERLINK("x")', scopes: ['content:read'] }).expect(201);
    await t.http.post('/v1/sites').set(h).send({ name: 'Audited', defaultLocale: 'en', locales: ['en'] }).expect(201);
    const all = await t.http.get('/v1/audit?limit=1').set(h).expect(200);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.nextCursor).toBeTruthy();
    const next = await t.http.get(`/v1/audit?limit=1&cursor=${all.body.nextCursor}`).set(h).expect(200);
    expect(next.body.items[0].id).not.toBe(all.body.items[0].id);
    const keys = await t.http.get('/v1/audit?action=api_key.').set(h).expect(200);
    expect(keys.body.items.map((i: { action: string }) => i.action)).toEqual(['api_key.created']);
    expect(keys.body.items[0].user).toMatchObject({ email: owner.email });

    const csv = await t.http.get('/v1/audit/export?format=csv&action=api_key.').set(h).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('createdAt,id,actorType');
    expect(csv.text).toContain('api_key.created');
    const jsonl = await t.http.get('/v1/audit/export?format=jsonl').set(h).expect(200);
    expect(jsonl.text.trim().split('\n').map((l) => JSON.parse(l).action)).toContain('audit.exported');

    const editor = await invited(t, owner, 'EDITOR');
    await t.http.get('/v1/audit').set(bearer(editor.accessToken)).expect(403);
  });

  it('seals days into a hash chain and detects a modified row', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    await t.http.post('/v1/sites').set(h).send({ name: 'Sealed', defaultLocale: 'en', locales: ['en'] }).expect(201);
    const trail = t.app.get(AuditTrailService);
    await expect(trail.ensurePartitions()).resolves.toBeUndefined(); // idempotent maintenance
    await trail.sealDays(new Date(Date.now() + 86_400_000)); // include today
    const ok = await t.http.get('/v1/audit/integrity').set(h).expect(200);
    expect(ok.body).toMatchObject({ ok: true, sealedDays: 1 });

    const row = await t.system.auditLog.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    await t.system.$executeRaw`UPDATE audit_logs SET action = 'site.nothing_to_see' WHERE id = ${row.id}`;
    const bad = await t.http.get('/v1/audit/integrity').set(h).expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.days[0]).toMatchObject({ status: 'modified' });
  });
});

describe('partition maintenance', () => {
  const partitions = () =>
    t.system.$queryRaw<{ name: string }[]>`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = '"analytics_events"'::regclass`.then((r) => r.map((x) => x.name));
  const month = (d: Date) => `analytics_events_${d.toISOString().slice(0, 7).replace('-', '_')}`;

  it('the worker role creates future partitions and drops raw analytics past retention, never audit', async () => {
    // canon_system does not own the tables: this only works because the function runs as the owner.
    await t.system.$executeRaw`SELECT canon_ensure_monthly_partitions('"analytics_events"'::regclass, 8)`;
    const now = new Date();
    expect(await partitions()).toContain(month(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 8, 1))));

    // An old month, created by the owner as if the installation had been running since 2020.
    const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      await owner.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS partitions.analytics_events_2020_01 PARTITION OF "analytics_events" FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`);
    } finally {
      await owner.$disconnect();
    }
    expect(await partitions()).toContain('analytics_events_2020_01');

    const res = await t.app.get(AuditTrailService).applyRetention();
    expect(res.dropped).toBeGreaterThanOrEqual(1);
    const after = await partitions();
    expect(after).not.toContain('analytics_events_2020_01');
    expect(after).toContain(month(now)); // the live month stays
    // Audit partitions are out of the function's reach.
    const audit = await t.system.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_inherits WHERE inhparent = '"audit_logs"'::regclass`;
    expect(Number(audit[0]!.n)).toBeGreaterThan(1);
  });
});

describe('privacy', () => {
  it('exports my data and erases a member account', async () => {
    const owner = await signUp(t);
    const editor = await invited(t, owner, 'EDITOR');
    const mine = await t.http.get('/v1/me/export').set(bearer(editor.accessToken)).expect(200);
    expect(mine.headers['content-disposition']).toContain('canon-my-data.json');
    expect(mine.body.user).toMatchObject({ email: editor.email });
    expect(mine.body.user.passwordHash).toBeUndefined();
    expect(mine.body.memberships[0]).toMatchObject({ role: 'EDITOR', tenant: { id: owner.tenantId } });

    // Owners must hand over first; a wrong password never erases.
    await t.http.post('/v1/me/delete').set(bearer(owner.accessToken)).send({ password: PASSWORD, confirm: 'DELETE' }).expect(409);
    await t.http.post('/v1/me/delete').set(bearer(editor.accessToken)).send({ password: 'nope nope nope', confirm: 'DELETE' }).expect(401);
    await t.http.post('/v1/me/delete').set(bearer(editor.accessToken)).send({ password: PASSWORD, confirm: 'DELETE' }).expect(204);

    const user = await t.system.user.findUniqueOrThrow({ where: { id: editor.userId } });
    expect(user).toMatchObject({ name: 'Deleted user', passwordHash: null, status: 'DISABLED' });
    expect(user.email).toMatch(/@deleted\.invalid$/);
    expect(await t.system.tenantMember.count({ where: { userId: editor.userId } })).toBe(0);
    await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: editor.email, password: PASSWORD }).expect(401);
    expect(await t.system.auditLog.count({ where: { tenantId: owner.tenantId, action: 'user.erased', entityId: editor.userId } })).toBe(1);
  });

  it('exports a workspace (owner only) and purges deleted workspaces after the grace period', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = await t.http.post('/v1/sites').set(h).send({ name: 'Portable', defaultLocale: 'en', locales: ['en'] }).expect(201);
    await t.http.post(`/v1/sites/${site.body.id}/pages`).set(h).send({ title: 'About', slug: 'about' }).expect(201);
    const dump = await t.http.get('/v1/workspace/export').set(h).expect(200);
    expect(dump.body).toMatchObject({ format: 'canon-export', tenant: { id: owner.tenantId } });
    expect(dump.body.pages.map((p: { title: string }) => p.title)).toContain('About');
    const editor = await invited(t, owner, 'ADMIN');
    await t.http.get('/v1/workspace/export').set(bearer(editor.accessToken)).expect(403);

    await t.http.delete(`/v1/tenants/${owner.tenantId}`).set(h).expect(204);
    const privacy = t.app.get(PrivacyService);
    await privacy.purgeDeletedTenants();
    expect(await t.system.tenant.count({ where: { id: owner.tenantId } })).toBe(1); // still in grace period
    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
    await privacy.purgeDeletedTenants();
    expect(await t.system.tenant.count({ where: { id: owner.tenantId } })).toBe(0);
  });
});
