import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { PASSWORD, bearer, createTestApp, ip, refreshCookie, signUp, tokenFromMail, uniqueEmail, type SignedIn, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

async function invite(owner: SignedIn, email: string, role: string) {
  const res = await t.http.post(`/v1/tenants/${owner.tenantId}/members/invite`).set(bearer(owner.accessToken)).send({ email, role });
  return res;
}

async function joinViaInvite(email: string): Promise<SignedIn & { role: string }> {
  const token = tokenFromMail(t.mailer, email, /invite\/([\w-]+)/);
  const preview = await t.http.get(`/v1/invitations/${token}`).set('x-forwarded-for', ip()).expect(200);
  expect(preview.body.state).toBe('pending');
  const res = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: 'Invited', inviteToken: token });
  expect(res.status).toBe(201);
  return { email, accessToken: res.body.accessToken, cookie: refreshCookie(res), userId: res.body.user.id, tenantId: res.body.tenant.id, role: res.body.tenant.role };
}

describe('invitations & roles', () => {
  it('invited users join the inviting tenant with the invited role, email already verified', async () => {
    const owner = await signUp(t, { tenantName: 'Invite Co' });
    const email = uniqueEmail('editor');
    const inv = await invite(owner, email, 'EDITOR');
    expect(inv.status).toBe(201);

    const editor = await joinViaInvite(email);
    expect(editor.tenantId).toBe(owner.tenantId);
    expect(editor.role).toBe('EDITOR');

    const members = await t.http.get(`/v1/tenants/${owner.tenantId}/members`).set(bearer(owner.accessToken)).expect(200);
    expect(members.body.map((m: { email: string; role: string }) => [m.email, m.role])).toContainEqual([email, 'EDITOR']);
  });

  it('editors cannot invite, change roles or manage API keys', async () => {
    const owner = await signUp(t);
    const email = uniqueEmail('ed');
    await invite(owner, email, 'EDITOR');
    const editor = await joinViaInvite(email);

    expect((await invite(editor, uniqueEmail(), 'VIEWER')).status).toBe(403);
    await t.http.patch(`/v1/tenants/${owner.tenantId}/members/${owner.userId}`).set(bearer(editor.accessToken)).send({ role: 'VIEWER' }).expect(403);
    await t.http.post('/v1/api-keys').set(bearer(editor.accessToken)).send({ name: 'nope', scopes: ['content:read'] }).expect(403);
  });

  it('admins cannot touch owners or mint new owners', async () => {
    const owner = await signUp(t);
    const email = uniqueEmail('admin');
    await invite(owner, email, 'ADMIN');
    const admin = await joinViaInvite(email);

    await t.http.patch(`/v1/tenants/${owner.tenantId}/members/${owner.userId}`).set(bearer(admin.accessToken)).send({ role: 'VIEWER' }).expect(403);
    expect((await invite(admin, uniqueEmail(), 'OWNER')).status).toBe(403);
    expect((await invite(admin, uniqueEmail(), 'EDITOR')).status).toBe(201);
  });

  it('a role change takes effect immediately: old access token is rejected, refresh carries the new role', async () => {
    const owner = await signUp(t);
    const email = uniqueEmail('demote');
    await invite(owner, email, 'EDITOR');
    const member = await joinViaInvite(email);

    await t.http.patch(`/v1/tenants/${owner.tenantId}/members/${member.userId}`).set(bearer(owner.accessToken)).send({ role: 'VIEWER' }).expect(200);
    await t.http.get('/v1/auth/me').set(bearer(member.accessToken)).expect(401);
    const refreshed = await t.http.post('/v1/auth/refresh').set('Cookie', member.cookie).expect(200);
    expect(refreshed.body.tenant.role).toBe('VIEWER');
  });

  it('protects the last owner', async () => {
    const owner = await signUp(t);
    const res = await t.http.patch(`/v1/tenants/${owner.tenantId}/members/${owner.userId}`).set(bearer(owner.accessToken)).send({ role: 'ADMIN' });
    expect(res.status).toBe(409);
    await t.http.delete(`/v1/tenants/${owner.tenantId}/members/${owner.userId}`).set(bearer(owner.accessToken)).expect(409);
  });

  it('an invitation only works for the invited email', async () => {
    const owner = await signUp(t);
    const invitedEmail = uniqueEmail('target');
    await invite(owner, invitedEmail, 'EDITOR');
    const token = tokenFromMail(t.mailer, invitedEmail, /invite\/([\w-]+)/);
    const stranger = await signUp(t);
    const res = await t.http.post('/v1/invitations/accept').set(bearer(stranger.accessToken)).send({ token });
    expect(res.status).toBe(403);
  });

  it('enforces the plan member limit including pending invites (FREE = 3)', async () => {
    const owner = await signUp(t);
    expect((await invite(owner, uniqueEmail(), 'EDITOR')).status).toBe(201);
    expect((await invite(owner, uniqueEmail(), 'EDITOR')).status).toBe(201);
    const third = await invite(owner, uniqueEmail(), 'EDITOR');
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('tenant isolation', () => {
  it('a valid token cannot be pointed at another tenant', async () => {
    const a = await signUp(t, { tenantName: 'Tenant A' });
    const b = await signUp(t, { tenantName: 'Tenant B' });
    const res = await t.http.get(`/v1/tenants/${a.tenantId}/members`).set(bearer(b.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('TENANT_MISMATCH');
  });

  it('switch-tenant only works for tenants the user belongs to', async () => {
    const a = await signUp(t);
    const b = await signUp(t);
    await t.http.post('/v1/auth/switch-tenant').set(bearer(a.accessToken)).set('Cookie', a.cookie).send({ tenantId: b.tenantId }).expect(404);

    const created = await t.http.post('/v1/tenants').set(bearer(a.accessToken)).send({ name: 'Second Brand' }).expect(201);
    const switched = await t.http.post('/v1/auth/switch-tenant').set(bearer(a.accessToken)).set('Cookie', a.cookie).send({ tenantId: created.body.id }).expect(200);
    expect(switched.body.tenant).toMatchObject({ id: created.body.id, role: 'OWNER' });
    const quota = await t.http.get(`/v1/tenants/${created.body.id}/quota`).set(bearer(switched.body.accessToken)).expect(200);
    expect(quota.body.limits.members).toBe(3);
  });

  it('RLS hides other tenants even from the runtime DB role', async () => {
    const a = await signUp(t);
    await signUp(t);
    const prisma = t.app.get(PrismaService);
    const visible = await prisma.forTenant({ tenantId: a.tenantId }).tenantMember.findMany();
    expect(new Set(visible.map((m) => m.tenantId))).toEqual(new Set([a.tenantId]));
    expect(await prisma.tenantMember.count()).toBe(0); // no GUC → fail closed
  });
});

describe('API keys', () => {
  it('scoped keys get exactly their scopes, and revocation is immediate', async () => {
    const owner = await signUp(t);
    const created = await t.http.post('/v1/api-keys').set(bearer(owner.accessToken)).send({ name: 'agent', scopes: ['ai:invoke'], isAgentKey: true }).expect(201);
    const key: string = created.body.key;
    expect(key).toMatch(/^ck_[A-Za-z0-9]{8}_/);

    await t.http.get('/v1/ai/models').set('x-api-key', key).expect(200);
    await t.http.get(`/v1/tenants/${owner.tenantId}/members`).set('x-api-key', key).expect(403);
    const list = await t.http.get('/v1/api-keys').set(bearer(owner.accessToken)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key.slice(13)); // secret never listed

    await t.http.delete(`/v1/api-keys/${created.body.id}`).set(bearer(owner.accessToken)).expect(204);
    await t.http.get('/v1/ai/models').set('x-api-key', key).expect(401);
  });
});
