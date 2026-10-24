import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import selfsigned from 'selfsigned';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { PASSWORD, bearer, createTestApp, ip, refreshCookie, signUp, tokenFromMail, type TestApp } from './harness';

let t: TestApp;
const IDP_ENTITY = 'https://idp.example.test/metadata';
const IDP_SSO = 'https://idp.example.test/sso';
const idp = selfsigned.generate([{ name: 'commonName', value: 'idp.example.test' }], { days: 30, keySize: 2048, algorithm: 'sha256' });
const rogue = selfsigned.generate([{ name: 'commonName', value: 'rogue' }], { days: 30, keySize: 2048, algorithm: 'sha256' });

beforeAll(async () => {
  t = await createTestApp({ SSO_DOMAIN_VERIFICATION: 'off', KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
});

afterAll(async () => {
  await t.close();
});

/** A signed SAML Response as an IdP would POST it (assertion signed, RSA-SHA256, exc-c14n). */
function samlResponse(o: { requestId: string; acs: string; audience: string; email: string; key?: string; cert?: string }): string {
  const now = new Date();
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.requestId}" NotOnOrAfter="${iso(300_000)}" Recipient="${o.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>`;
  const sig = new SignedXml({ privateKey: o.key ?? idp.private, publicCert: o.cert ?? idp.cert });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(0)}" InResponseTo="${o.requestId}" Destination="${o.acs}">` +
    `<saml:Issuer>${IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${sig.getSignedXml()}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const domain = `acme-${randomBytes(3).toString('hex')}.test`;
  await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'ENTERPRISE' } });
  const res = await t.http.put('/v1/sso').set(h).send({ name: 'Acme Okta', domains: [domain], idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO, idpCertificate: idp.cert, defaultRole: 'EDITOR' }).expect(200);
  return { owner, h, domain, sp: res.body.serviceProvider as { entityId: string; acsUrl: string; loginUrl: string }, id: res.body.connection.id as string };
}

/** Starts a login like the browser would and returns the AuthnRequest id the response must answer. */
async function startLogin(id: string): Promise<string> {
  const r = await t.http.get(`/v1/auth/sso/saml/${id}/login`).expect(302);
  const url = new URL(r.headers.location as string);
  expect(url.origin + url.pathname).toBe(IDP_SSO);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
  return /ID="([^"]+)"/.exec(xml)![1]!;
}

const post = (id: string, SAMLResponse: string) => t.http.post(`/v1/auth/sso/saml/${id}/acs`).type('form').send({ SAMLResponse });

describe('SAML SSO', () => {
  it('configures an Enterprise connection with guards, and publishes SP metadata', async () => {
    const free = await signUp(t);
    await t.http.put('/v1/sso').set(bearer(free.accessToken)).send({ name: 'Free Co', domains: ['free-co.test'], idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO, idpCertificate: idp.cert }).expect(402);
    const c = await setup();
    await t.http.put('/v1/sso').set(c.h).send({ name: 'Gmail', domains: ['gmail.com'], idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO, idpCertificate: idp.cert }).expect(400).expect((r) => expect(r.body.error.code).toBe('PUBLIC_EMAIL_DOMAIN'));
    await t.http.put('/v1/sso').set(c.h).send({ name: 'Bad cert', domains: [c.domain], idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO, idpCertificate: 'not a certificate'.repeat(10) }).expect(400).expect((r) => expect(r.body.error.code).toBe('INVALID_CERTIFICATE'));

    const view = await t.http.get('/v1/sso').set(c.h).expect(200);
    expect(view.body.connection.idpCertificate).toBeUndefined();
    expect(view.body.domains[0]).toMatchObject({ domain: c.domain, verified: false, record: { type: 'TXT', name: `_canon-verification.${c.domain}` } });
    // Unverified domains route nothing.
    expect((await t.http.post('/v1/auth/sso/discover').send({ email: `ada@${c.domain}` }).expect(200)).body).toEqual({ sso: false });
    await t.http.post('/v1/sso/domains/verify').set(c.h).send({ domain: c.domain }).expect(200);
    expect((await t.http.post('/v1/auth/sso/discover').send({ email: `ada@${c.domain}` }).expect(200)).body).toMatchObject({ sso: true, name: 'Acme Okta', loginUrl: c.sp.loginUrl });

    // A second workspace cannot verify the same domain.
    const other = await signUp(t);
    await t.system.tenant.update({ where: { id: other.tenantId }, data: { plan: 'ENTERPRISE' } });
    await t.http.put('/v1/sso').set(bearer(other.accessToken)).send({ name: 'Other Co', domains: [c.domain], idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO, idpCertificate: idp.cert }).expect(200);
    await t.http.post('/v1/sso/domains/verify').set(bearer(other.accessToken)).send({ domain: c.domain }).expect(409);

    const md = await t.http.get(`/v1/auth/sso/saml/${c.id}/metadata`).expect(200);
    expect(md.text).toContain('EntityDescriptor');
    expect(md.text).toContain(c.sp.acsUrl);
  });

  it('signs in via the IdP with JIT provisioning, and rejects replays, foreign domains and forged signatures', async () => {
    const c = await setup();
    await t.http.post('/v1/sso/domains/verify').set(c.h).send({ domain: c.domain }).expect(200);
    const email = `ada@${c.domain}`;

    const ok = await post(c.id, samlResponse({ requestId: await startLogin(c.id), acs: c.sp.acsUrl, audience: c.sp.entityId, email }));
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toMatch(/\/sso\/callback$/);
    const session = await t.http.post('/v1/auth/refresh').set('Cookie', refreshCookie(ok)).expect(200);
    expect(session.body).toMatchObject({ user: { email, name: 'Ada Lovelace' }, tenant: { id: c.owner.tenantId, role: 'EDITOR' } });
    expect(await t.system.auditLog.count({ where: { tenantId: c.owner.tenantId, action: 'member.provisioned_by_sso' } })).toBe(1);

    // The same response again: its request id was consumed.
    const requestId = await startLogin(c.id);
    const once = samlResponse({ requestId, acs: c.sp.acsUrl, audience: c.sp.entityId, email });
    expect((await post(c.id, once)).headers.location).toMatch(/\/sso\/callback$/);
    expect((await post(c.id, once)).headers.location).toContain('sso_error=SSO_INVALID_RESPONSE');

    // The IdP may only vouch for verified domains.
    const foreign = await post(c.id, samlResponse({ requestId: await startLogin(c.id), acs: c.sp.acsUrl, audience: c.sp.entityId, email: 'eve@elsewhere.test' }));
    expect(foreign.headers.location).toContain('sso_error=SSO_DOMAIN_MISMATCH');
    // Signed by a key other than the configured IdP certificate.
    const forged = await post(c.id, samlResponse({ requestId: await startLogin(c.id), acs: c.sp.acsUrl, audience: c.sp.entityId, email: `boss@${c.domain}`, key: rogue.private, cert: rogue.cert }));
    expect(forged.headers.location).toContain('sso_error=SSO_INVALID_RESPONSE');
    // Unsolicited response (no matching AuthnRequest).
    const unsolicited = await post(c.id, samlResponse({ requestId: '_never-issued', acs: c.sp.acsUrl, audience: c.sp.entityId, email }));
    expect(unsolicited.headers.location).toContain('sso_error=SSO_INVALID_RESPONSE');
    expect(await t.system.user.count({ where: { email: `boss@${c.domain}` } })).toBe(0);
  });

  it('enforced SSO blocks password login for members on the domain, owners keep a break-glass path', async () => {
    const c = await setup();
    await t.http.post('/v1/sso/domains/verify').set(c.h).send({ domain: c.domain }).expect(200);
    const email = `bob@${c.domain}`;
    await t.http.post(`/v1/tenants/${c.owner.tenantId}/members/invite`).set(c.h).send({ email, role: 'EDITOR' }).expect(201);
    const token = tokenFromMail(t.mailer, email, /invite\/([\w-]+)/);
    await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: 'Bob', inviteToken: token }).expect(201);
    await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email, password: PASSWORD }).expect(200);

    const current = (await t.http.get('/v1/sso').set(c.h).expect(200)).body.connection;
    await t.http.put('/v1/sso').set(c.h).send({ name: current.name, domains: current.domains, idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO, idpCertificate: idp.cert, enforced: true }).expect(200);
    const blocked = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email, password: PASSWORD }).expect(403);
    expect(blocked.body.error).toMatchObject({ code: 'SSO_REQUIRED', details: { loginUrl: c.sp.loginUrl } });

    // Promote Bob to owner: the break-glass path opens.
    await t.system.tenantMember.updateMany({ where: { tenantId: c.owner.tenantId, user: { email } }, data: { role: 'OWNER' } });
    await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email, password: PASSWORD }).expect(200);
  });
});
