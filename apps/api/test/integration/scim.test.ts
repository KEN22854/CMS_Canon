import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    KNOWLEDGE: 'off',
    CANON_EXTRACT: 'off',
    CANON_PROPAGATE: 'off',
    ENRICHMENT: 'off',
    ANALYTICS_FLUSH: 'off',
    ANALYTICS_JOBS: 'off',
  });
});

afterAll(async () => {
  await t.close();
});

const EXT = 'urn:ietf:params:scim:schemas:extension:canon:2.0:User';

async function enterprise() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const domain = `corp-${owner.tenantId.slice(-6)}.example.com`;
  // Plan-gated: a free workspace cannot mint SCIM tokens.
  await t.http.post('/v1/scim-tokens').set(h).send({ name: 'Okta' }).expect(402);
  await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'ENTERPRISE' } });
  await t.system.ssoConnection.create({
    data: {
      tenantId: owner.tenantId,
      name: 'Okta',
      domains: [domain],
      verifiedDomains: [domain],
      idpEntityId: 'urn:okta',
      idpSsoUrl: 'https://okta.example.com/sso',
      idpCertificate: 'x',
      defaultRole: 'AUTHOR',
    },
  });
  const created = (await t.http.post('/v1/scim-tokens').set(h).send({ name: 'Okta' }).expect(201)).body as {
    id: string;
    token: string;
    baseUrl: string;
  };
  expect(created.token).toMatch(/^cs_/);
  expect(created.baseUrl).toBe(`${t.config.ADMIN_PUBLIC_URL}/api/scim/v2`);
  const scim = { authorization: `Bearer ${created.token}`, 'content-type': 'application/scim+json' };
  return { owner, h, domain, scim, tokenId: created.id };
}

describe('SCIM 2.0', () => {
  it('provisions, updates and deprovisions members from the identity provider', async () => {
    const { owner, h, domain, scim, tokenId } = await enterprise();

    await t.http.get('/scim/v2/Users').expect(401);
    await t.http.get('/scim/v2/Users').set({ authorization: 'Bearer cs_nope_nope' }).expect(401);
    const spc = await t.http.get('/scim/v2/ServiceProviderConfig').set(scim).expect(200);
    expect(spc.headers['content-type']).toContain('application/scim+json');
    expect(spc.body).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    expect(
      (await t.http.get('/scim/v2/ResourceTypes').set(scim).expect(200)).body.Resources[0].endpoint,
    ).toBe('/Users');
    expect((await t.http.get('/scim/v2/Schemas').set(scim).expect(200)).body.totalResults).toBe(2);

    // Create → member with the SSO default role, matched later by userName or externalId.
    const email = `ada@${domain}`;
    const user = (
      await t.http
        .post('/scim/v2/Users')
        .set(scim)
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: email.toUpperCase(),
          externalId: 'okta-1',
          name: { givenName: 'Ada', familyName: 'Lovelace' },
          emails: [{ value: email, primary: true }],
          active: true,
        })
        .expect(201)
    ).body;
    expect(user).toMatchObject({
      userName: email,
      externalId: 'okta-1',
      displayName: 'Ada Lovelace',
      active: true,
      [EXT]: { role: 'AUTHOR' },
    });
    const members = (await t.http.get(`/v1/tenants/${owner.tenantId}/members`).set(h).expect(200)).body as {
      id: string;
      role: string;
    }[];
    expect(members.find((m) => m.id === user.id)?.role).toBe('AUTHOR');

    await t.http.post('/scim/v2/Users').set(scim).send({ userName: email }).expect(409);
    const conflict = await t.http
      .post('/scim/v2/Users')
      .set(scim)
      .send({ userName: 'eve@elsewhere.example' })
      .expect(400);
    expect(conflict.body).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '400',
      scimType: 'invalidValue',
    });

    const byName = (
      await t.http
        .get(`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`)
        .set(scim)
        .expect(200)
    ).body;
    expect(byName).toMatchObject({ totalResults: 1, Resources: [{ id: user.id }] });
    expect(
      (
        await t.http
          .get(`/scim/v2/Users?filter=${encodeURIComponent('externalId eq "okta-1"')}`)
          .set(scim)
          .expect(200)
      ).body.totalResults,
    ).toBe(1);
    expect(
      (await t.http.get(`/scim/v2/Users?startIndex=1&count=1`).set(scim).expect(200)).body,
    ).toMatchObject({ totalResults: 2, itemsPerPage: 1 }); // owner + Ada
    await t.http
      .get(`/scim/v2/Users?filter=${encodeURIComponent('title co "x"')}`)
      .set(scim)
      .expect(400);

    // PATCH in the Azure AD style (no path) and the Okta style (path).
    const patched = (
      await t.http
        .patch(`/scim/v2/Users/${user.id}`)
        .set(scim)
        .send({
          Operations: [{ op: 'Replace', value: { displayName: 'Ada King', [EXT]: { role: 'editor' } } }],
        })
        .expect(200)
    ).body;
    expect(patched).toMatchObject({ displayName: 'Ada King', [EXT]: { role: 'EDITOR' } });
    await t.http
      .patch(`/scim/v2/Users/${user.id}`)
      .set(scim)
      .send({ Operations: [{ op: 'replace', path: `${EXT}:role`, value: 'OWNER' }] })
      .expect(400); // never ownership

    // The owner cannot be demoted or removed by the IdP when they are the last owner.
    await t.http
      .patch(`/scim/v2/Users/${owner.userId}`)
      .set(scim)
      .send({ Operations: [{ op: 'replace', path: `${EXT}:role`, value: 'VIEWER' }] })
      .expect(200);
    expect(
      (
        await t.system.tenantMember.findFirstOrThrow({
          where: { tenantId: owner.tenantId, userId: owner.userId },
        })
      ).role,
    ).toBe('OWNER');
    await t.http.delete(`/scim/v2/Users/${owner.userId}`).set(scim).expect(409);

    // Deactivate → membership removed, sessions must re-check.
    const off = (
      await t.http
        .patch(`/scim/v2/Users/${user.id}`)
        .set(scim)
        .send({ Operations: [{ op: 'replace', path: 'active', value: false }] })
        .expect(200)
    ).body;
    expect(off.active).toBe(false);
    await t.http.get(`/scim/v2/Users/${user.id}`).set(scim).expect(404);
    expect(await t.system.tenantMember.count({ where: { tenantId: owner.tenantId, userId: user.id } })).toBe(
      0,
    );
    expect(
      await t.system.auditLog.count({
        where: {
          tenantId: owner.tenantId,
          action: {
            in: ['member.provisioned_by_scim', 'member.deprovisioned_by_scim', 'member.role_changed_by_scim'],
          },
        },
      }),
    ).toBe(3);

    // Re-provisioning the same person works (the user account is kept).
    const back = (
      await t.http
        .post('/scim/v2/Users')
        .set(scim)
        .send({ userName: email, externalId: 'okta-1' })
        .expect(201)
    ).body;
    expect(back.id).toBe(user.id);
    await t.http.delete(`/scim/v2/Users/${user.id}`).set(scim).expect(204);

    // Revoked tokens stop working; another workspace's token sees nothing here.
    const other = await enterprise();
    await t.http.get(`/scim/v2/Users/${owner.userId}`).set(other.scim).expect(404);
    await t.http.delete(`/v1/scim-tokens/${tokenId}`).set(h).expect(204);
    await t.http.get('/scim/v2/Users').set(scim).expect(401);
    expect((await t.http.get('/v1/scim-tokens').set(h).expect(200)).body.tokens).toEqual([]);
  });
});
