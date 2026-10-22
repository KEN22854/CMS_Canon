import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/common/crypto/totp';
import { PASSWORD, bearer, createTestApp, ip, refreshCookie, signUp, tokenFromMail, uniqueEmail, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe('registration & email verification', () => {
  it('signs up, blocks login until verified, then verification signs the user in as OWNER', async () => {
    const email = uniqueEmail('reg');
    const reg = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: 'Ada', tenantName: 'Ada Labs' });
    expect(reg.status).toBe(202);
    expect(reg.body).toEqual({ status: 'check_email' });

    const early = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = tokenFromMail(t.mailer, email, /verify-email\?token=([\w-]+)/);
    const verified = await t.http.post('/v1/auth/verify-email').set('x-forwarded-for', ip()).send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body.tenant).toMatchObject({ name: 'Ada Labs', role: 'OWNER', plan: 'FREE' });
    expect(verified.body.refreshToken).toBeUndefined(); // browser clients get it only as a cookie
    const cookie = String(verified.headers['set-cookie']);
    expect(cookie).toMatch(/canon_rt=.*HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const me = await t.http.get('/v1/auth/me').set(bearer(verified.body.accessToken)).expect(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.tenants).toHaveLength(1);
    expect(Array.isArray(me.body.rules)).toBe(true);

    // Single-use link.
    await t.http.post('/v1/auth/verify-email').set('x-forwarded-for', ip()).send({ token }).expect(400);
  });

  it('answers an existing email exactly like a new one and mails the owner instead', async () => {
    const { email } = await signUp(t);
    const res = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: 'Impostor' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(t.mailer.lastTo(email)?.template).toBe('account-exists');
  });

  it('rejects weak passwords with zxcvbn feedback', async () => {
    const res = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email: uniqueEmail(), password: 'password123', name: 'Weak' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

describe('login protection', () => {
  it('locks the account after 5 failures, regardless of source IP', async () => {
    const { email } = await signUp(t);
    for (let i = 0; i < 5; i++) {
      const r = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email, password: 'wrong password entirely' });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('gives an unknown email the same answer as a wrong password', async () => {
    const r = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: uniqueEmail('ghost'), password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rate-limits credential endpoints per IP', async () => {
    const addr = ip();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const r = await t.http.post('/v1/auth/login').set('x-forwarded-for', addr).send({ email: uniqueEmail('rl'), password: 'x' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('sessions & refresh rotation', () => {
  it('rotates the refresh token on every use', async () => {
    const s = await signUp(t);
    const r1 = await t.http.post('/v1/auth/refresh').set('Cookie', s.cookie).expect(200);
    const c1 = refreshCookie(r1);
    expect(c1).not.toBe(s.cookie);
    const r2 = await t.http.post('/v1/auth/refresh').set('Cookie', c1).expect(200);
    expect(r2.body.accessToken).toBeTruthy();
  });

  it('treats reuse of a rotated token as theft and revokes the whole session family', async () => {
    const s = await signUp(t);
    const r1 = await t.http.post('/v1/auth/refresh').set('Cookie', s.cookie).expect(200);
    const fresh = refreshCookie(r1);
    // Push the rotation out of the concurrency grace window.
    await t.system.session.updateMany({ where: { userId: s.userId, revokedReason: 'rotated' }, data: { revokedAt: new Date(Date.now() - 60_000) } });

    await t.http.post('/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
    // The legitimate holder of the newest token is logged out too…
    await t.http.post('/v1/auth/refresh').set('Cookie', fresh).expect(401);
    // …and so are outstanding access tokens of that family.
    await t.http.get('/v1/auth/me').set(bearer(r1.body.accessToken)).expect(401);
    const rows = await t.system.session.findMany({ where: { userId: s.userId, revokedReason: 'reuse_detected' } });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('logout kills both the refresh cookie and the access token immediately', async () => {
    const s = await signUp(t);
    await t.http.post('/v1/auth/logout').set('Cookie', s.cookie).expect(204);
    await t.http.get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
    await t.http.post('/v1/auth/refresh').set('Cookie', s.cookie).expect(401);
  });

  it('lists sessions and revokes one from another device', async () => {
    const s = await signUp(t);
    const second = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: s.email, password: PASSWORD }).expect(200);
    const list = await t.http.get('/v1/auth/sessions').set(bearer(s.accessToken)).expect(200);
    expect(list.body).toHaveLength(2);
    const other = list.body.find((x: { current: boolean }) => !x.current);
    await t.http.delete(`/v1/auth/sessions/${other.id}`).set(bearer(s.accessToken)).expect(204);
    await t.http.get('/v1/auth/me').set(bearer(second.body.accessToken)).expect(401);
  });

  it('rejects refresh from an untrusted Origin', async () => {
    const s = await signUp(t);
    const r = await t.http.post('/v1/auth/refresh').set('Cookie', s.cookie).set('Origin', 'https://evil.example');
    expect(r.status).toBe(403);
  });

  it('native clients receive the refresh token in the body', async () => {
    const s = await signUp(t);
    const r = await t.http.post('/v1/auth/login').set('x-canon-client', 'native').set('x-forwarded-for', ip()).send({ email: s.email, password: PASSWORD }).expect(200);
    expect(r.body.refreshToken).toBeTruthy();
    await t.http.post('/v1/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(200);
  });
});

describe('password reset', () => {
  it('resets via emailed single-use link and signs out every session', async () => {
    const s = await signUp(t);
    await t.http.post('/v1/auth/forgot-password').set('x-forwarded-for', ip()).send({ email: s.email }).expect(202);
    const token = tokenFromMail(t.mailer, s.email, /reset-password\?token=([\w-]+)/);
    const newPassword = 'a completely different passphrase 7';
    await t.http.post('/v1/auth/reset-password').set('x-forwarded-for', ip()).send({ token, password: newPassword }).expect(204);

    await t.http.get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
    await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: s.email, password: PASSWORD }).expect(401);
    await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: s.email, password: newPassword }).expect(200);
    await t.http.post('/v1/auth/reset-password').set('x-forwarded-for', ip()).send({ token, password: 'yet another strong passphrase 9' }).expect(400);
  });

  it('does not reveal whether the email exists', async () => {
    await t.http.post('/v1/auth/forgot-password').set('x-forwarded-for', ip()).send({ email: uniqueEmail('nobody') }).expect(202);
  });
});

describe('two-factor authentication', () => {
  it('enrolls TOTP, requires it at login, rejects replays and accepts a backup code once', async () => {
    const s = await signUp(t);
    const begin = await t.http.post('/v1/auth/2fa/enable').set(bearer(s.accessToken)).send({ password: PASSWORD }).expect(200);
    expect(begin.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret: string = begin.body.secret;

    const confirm = await t.http.post('/v1/auth/2fa/verify').set(bearer(s.accessToken)).send({ code: totpCode(secret) }).expect(200);
    const backupCodes: string[] = confirm.body.backupCodes;
    expect(backupCodes).toHaveLength(10);

    const login = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: s.email, password: PASSWORD }).expect(200);
    expect(login.body).toMatchObject({ mfaRequired: true });
    expect(login.body.accessToken).toBeUndefined();

    // The enrollment code's time step is already spent → replay rejected.
    const replay = await t.http.post('/v1/auth/2fa/login').set('x-forwarded-for', ip()).send({ mfaToken: login.body.mfaToken, code: totpCode(secret) });
    expect(replay.status).toBe(401);

    const next = await t.http.post('/v1/auth/2fa/login').set('x-forwarded-for', ip()).send({ mfaToken: login.body.mfaToken, code: totpCode(secret, Date.now() + 30_000) });
    expect(next.status).toBe(200);
    expect(next.body.accessToken).toBeTruthy();

    const login2 = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: s.email, password: PASSWORD }).expect(200);
    await t.http.post('/v1/auth/2fa/login').set('x-forwarded-for', ip()).send({ mfaToken: login2.body.mfaToken, code: backupCodes[0] }).expect(200);
    const login3 = await t.http.post('/v1/auth/login').set('x-forwarded-for', ip()).send({ email: s.email, password: PASSWORD }).expect(200);
    await t.http.post('/v1/auth/2fa/login').set('x-forwarded-for', ip()).send({ mfaToken: login3.body.mfaToken, code: backupCodes[0] }).expect(401);
  });
});

describe('access tokens', () => {
  it('rejects missing, malformed and forged tokens', async () => {
    await t.http.get('/v1/auth/me').expect(401);
    await t.http.get('/v1/auth/me').set(bearer('not-a-jwt')).expect(401);
    const forged = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4Iiwic2lkIjoieCIsInNybCI6IlNVUEVSX0FETUlOIiwidHlwIjoiYWNjZXNzIn0.';
    await t.http.get('/v1/auth/me').set(bearer(forged)).expect(401);
  });
});
