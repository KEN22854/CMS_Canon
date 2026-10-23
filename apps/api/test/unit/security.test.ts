import { subject } from '@casl/ability';
import { describe, expect, it } from 'vitest';
import { defineAbilityFor } from '../../src/common/auth/abilities';
import { FieldEncryption } from '../../src/common/crypto/encryption';
import { checkPasswordPolicy } from '../../src/common/crypto/password';
import { base32Encode, totpCode, verifyTotp } from '../../src/common/crypto/totp';
import { crossedThresholds } from '../../src/modules/intelligence/infrastructure/ai-budget-alerts';
import { effectiveLimits } from '../../src/modules/tenancy/plans';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890"; 6-digit truncation of the 8-digit vectors.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%i → %s', (sec, code) => {
    expect(totpCode(secret, sec * 1000)).toBe(code);
  });

  it('accepts ±1 step of clock skew and nothing beyond', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});

describe('FieldEncryption', () => {
  const enc = new FieldEncryption(Buffer.alloc(32, 7).toString('base64'));

  it('round-trips and uses a fresh IV each time', () => {
    const a = enc.encrypt('JBSWY3DPEHPK3PXP');
    const b = enc.encrypt('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(enc.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering (GCM auth tag)', () => {
    const [iv, tag, data] = enc.encrypt('secret').split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => enc.decrypt([iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });
});

describe('password policy', () => {
  it('rejects short, common and personal passwords', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('password1234').ok).toBe(false);
    expect(checkPasswordPolicy('ada.lovelace2026', ['ada.lovelace@acme.io', 'Ada Lovelace']).ok).toBe(false);
  });

  it('accepts a long passphrase', () => {
    expect(checkPasswordPolicy('correct horse battery staple 42').ok).toBe(true);
  });
});

describe('RBAC matrix', () => {
  const T = 'tenant_1';
  const user = (memberRole: 'OWNER' | 'ADMIN' | 'EDITOR' | 'AUTHOR' | 'VIEWER') => defineAbilityFor({ actorType: 'user', userId: 'u1', tenantId: T, memberRole, systemRole: 'VIEWER' });

  it('owners manage everything in their tenant, nothing outside it', () => {
    const a = user('OWNER');
    expect(a.can('delete', subject('Tenant', { tenantId: T }))).toBe(true);
    expect(a.can('read', subject('Page', { tenantId: 'other' }))).toBe(false);
  });

  it('admins cannot delete the tenant, manage billing or touch owners', () => {
    const a = user('ADMIN');
    expect(a.can('delete', 'Tenant')).toBe(false);
    expect(a.can('manage', 'Billing')).toBe(false);
    expect(a.can('update', subject('Member', { tenantId: T, role: 'EDITOR' }))).toBe(true);
    expect(a.can('update', subject('Member', { tenantId: T, role: 'OWNER' }))).toBe(false);
    expect(a.can('invite', subject('Member', { tenantId: T, role: 'OWNER' }))).toBe(false);
  });

  it('authors edit only their own content and never publish', () => {
    const a = user('AUTHOR');
    expect(a.can('update', subject('Page', { tenantId: T, createdById: 'u1' }))).toBe(true);
    expect(a.can('update', subject('Page', { tenantId: T, createdById: 'u2' }))).toBe(false);
    expect(a.can('publish', 'Page')).toBe(false);
    expect(a.can('invoke', 'Ai')).toBe(true);
  });

  it('editors work inside sites but cannot reconfigure them', () => {
    const a = user('EDITOR');
    expect(a.can('read', 'Site')).toBe(true);
    expect(a.can('update', 'Site')).toBe(false);
    expect(a.can('create', 'Site')).toBe(false);
    expect(a.can('publish', 'Page')).toBe(true);
    expect(a.can('delete', 'Media')).toBe(true);
  });

  it('viewers read but cannot invoke AI', () => {
    const a = user('VIEWER');
    expect(a.can('read', 'Page')).toBe(true);
    expect(a.can('update', 'Page')).toBe(false);
    expect(a.can('invoke', 'Ai')).toBe(false);
  });

  it('API keys get exactly their scopes', () => {
    const a = defineAbilityFor({ actorType: 'agent', tenantId: T, scopes: ['content:read', 'ai:invoke', 'bogus:scope'] });
    expect(a.can('read', 'Page')).toBe(true);
    expect(a.can('invoke', 'Ai')).toBe(true);
    expect(a.can('update', 'Page')).toBe(false);
    expect(a.can('read', 'Member')).toBe(false);
  });

  it('a principal without a tenant can do nothing (except super admins)', () => {
    expect(defineAbilityFor({ actorType: 'user', userId: 'u1', systemRole: 'VIEWER' }).can('read', 'Page')).toBe(false);
    expect(defineAbilityFor({ actorType: 'user', userId: 'u1', systemRole: 'SUPER_ADMIN' }).can('manage', 'all')).toBe(true);
  });
});

describe('plans & budget alerts', () => {
  it('applies per-tenant overrides on top of plan defaults', () => {
    const l = effectiveLimits('FREE', { aiTokensPerMonth: 1_000, bogus: 1 });
    expect(l.aiTokensPerMonth).toBe(1_000);
    expect(l.members).toBe(3);
    expect(effectiveLimits('PRO', 'garbage').aiRequestsPerMin).toBe(60);
  });

  it('reports each threshold exactly when crossed', () => {
    expect(crossedThresholds(0, 49, 100)).toEqual([]);
    expect(crossedThresholds(49, 50, 100)).toEqual([50]);
    expect(crossedThresholds(40, 120, 100)).toEqual([50, 80, 100]);
    expect(crossedThresholds(80, 90, 100)).toEqual([]);
    expect(crossedThresholds(0, 10, 0)).toEqual([]);
  });
});
