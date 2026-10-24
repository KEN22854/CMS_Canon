import { createHmac, X509Certificate } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { MemberRole, SsoConnection } from '@canon/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { RequestPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { emailDomain, SsoPolicy } from '../identity/sso-policy';
import { effectiveLimits } from '../tenancy/plans';

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'Expected a domain like example.com');

export const ssoConnectionBody = z.object({
  name: z.string().trim().min(2).max(80),
  domains: z.array(domain).min(1).max(20),
  idpEntityId: z.string().trim().min(3).max(500),
  idpSsoUrl: z.url().refine((u) => u.startsWith('https://') || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1'), 'The IdP sign-in URL must use HTTPS'),
  /** Write-only; omit on update to keep the stored certificate. */
  idpCertificate: z.string().trim().min(100).max(20_000).optional(),
  enforced: z.boolean().default(false),
  jitProvisioning: z.boolean().default(true),
  defaultRole: z.enum(['ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER']).default('VIEWER'),
  isActive: z.boolean().default(true),
});
export type SsoConnectionBody = z.infer<typeof ssoConnectionBody>;

/** Consumer mailboxes can never be claimed: one tenant would capture everyone's logins. */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'yandex.ru', 'mail.ru', 'qq.com', '163.com']);
const REQUEST_TTL_SEC = 600;
const EMAIL_CLAIMS = ['email', 'mail', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'];
const NAME_CLAIMS = ['displayName', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'http://schemas.microsoft.com/identity/claims/displayname'];

/** AuthnRequest ids live in Redis so InResponseTo is checked (and single-use) across API instances. */
class RedisRequestCache implements CacheProvider {
  constructor(private readonly redis: Redis) {}
  async saveAsync(key: string, value: string) {
    await this.redis.set(`saml:req:${key}`, value, 'EX', REQUEST_TTL_SEC);
    return { value, createdAt: Date.now() };
  }
  getAsync(key: string) {
    return this.redis.get(`saml:req:${key}`);
  }
  async removeAsync(key: string | null) {
    if (key) await this.redis.del(`saml:req:${key}`);
    return key;
  }
}

/** PEM or bare base64 → the base64 body node-saml expects, after proving it parses as X.509. */
function normalizeCert(input: string): string {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  try {
    const cert = new X509Certificate(Buffer.from(body, 'base64'));
    if (new Date(cert.validTo) < new Date()) throw badRequest('INVALID_CERTIFICATE', `The IdP certificate expired on ${cert.validTo}`);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw badRequest('INVALID_CERTIFICATE', 'The IdP certificate is not a valid X.509 certificate');
  }
  return body;
}

/**
 * SAML 2.0 single sign-on (service-provider side). Each workspace connects one IdP (Okta, Entra
 * ID, Google Workspace…). Logins are routed by email domain, but only for domains the workspace
 * proved it owns via DNS; the IdP may only sign in addresses on those domains. Users are
 * provisioned just in time with the connection's default role.
 */
@Injectable()
export class SsoService {
  private readonly cache: RedisRequestCache;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) redis: Redis,
    private readonly system: SystemPrismaService,
    private readonly policy: SsoPolicy,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SsoService.name);
    this.cache = new RedisRequestCache(redis);
  }

  private urls(id: string) {
    const base = `${this.config.ADMIN_PUBLIC_URL}/api/v1/auth/sso/saml/${id}`;
    return { entityId: `${base}/metadata`, acsUrl: `${base}/acs`, metadataUrl: `${base}/metadata`, loginUrl: `${base}/login` };
  }

  private saml(c: Pick<SsoConnection, 'id' | 'idpSsoUrl' | 'idpEntityId' | 'idpCertificate'>): SAML {
    const u = this.urls(c.id);
    return new SAML({
      callbackUrl: u.acsUrl,
      entryPoint: c.idpSsoUrl,
      issuer: u.entityId,
      audience: u.entityId,
      idpIssuer: c.idpEntityId,
      idpCert: c.idpCertificate,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_SEC * 1000,
      cacheProvider: this.cache,
      acceptedClockSkewMs: 60_000,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });
  }

  /** Token a domain's TXT record must carry: `_canon-verification.<domain>  "canon-verification=<token>"`. */
  verificationToken(tenantId: string, d: string): string {
    return createHmac('sha256', this.config.ENCRYPTION_KEY).update(`sso-domain:${tenantId}:${d}`).digest('hex').slice(0, 32);
  }

  async get(tenantId: string) {
    const c = await this.system.ssoConnection.findUnique({ where: { tenantId } });
    const sp = c ? this.urls(c.id) : null;
    return {
      connection: c && { ...c, idpCertificate: undefined, certificateFingerprint: this.fingerprint(c.idpCertificate) },
      serviceProvider: sp,
      domains: (c?.domains ?? []).map((d) => ({ domain: d, verified: c!.verifiedDomains.includes(d), record: { type: 'TXT', name: `_canon-verification.${d}`, value: `canon-verification=${this.verificationToken(tenantId, d)}` } })),
    };
  }

  private fingerprint(cert: string): string | null {
    try {
      return new X509Certificate(Buffer.from(cert, 'base64')).fingerprint256;
    } catch {
      return null;
    }
  }

  async upsert(actor: RequestPrincipal & { tenantId: string }, body: SsoConnectionBody) {
    const tenant = await this.system.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { plan: true } });
    if (tenant.plan !== 'ENTERPRISE') throw new ApiError('PLAN_REQUIRED', 'Single sign-on is part of the Enterprise plan', HttpStatus.PAYMENT_REQUIRED, { plan: 'ENTERPRISE', limits: effectiveLimits(tenant.plan, {}) });
    const domains = [...new Set(body.domains)];
    const blocked = domains.filter((d) => PUBLIC_DOMAINS.has(d));
    if (blocked.length) throw badRequest('PUBLIC_EMAIL_DOMAIN', `Public email domains cannot be used for SSO: ${blocked.join(', ')}`);
    const existing = await this.system.ssoConnection.findUnique({ where: { tenantId: actor.tenantId } });
    if (!body.idpCertificate && !existing) throw badRequest('CERTIFICATE_REQUIRED', 'Paste the identity provider signing certificate');
    const cert = body.idpCertificate ? normalizeCert(body.idpCertificate) : existing!.idpCertificate;
    // Removing a domain drops its verification; keeping it keeps it.
    const verifiedDomains = (existing?.verifiedDomains ?? []).filter((d) => domains.includes(d));
    const data = { ...body, domains, verifiedDomains, idpCertificate: cert, defaultRole: body.defaultRole as MemberRole };
    const row = await this.system.ssoConnection.upsert({ where: { tenantId: actor.tenantId }, create: { tenantId: actor.tenantId, ...data }, update: data });
    await this.audit.record({ tenantId: actor.tenantId, action: existing ? 'sso.updated' : 'sso.created', entityType: 'SsoConnection', entityId: row.id, changes: { domains, enforced: body.enforced, jit: body.jitProvisioning, defaultRole: body.defaultRole, idpEntityId: body.idpEntityId, isActive: body.isActive } }, actor);
    return this.get(actor.tenantId);
  }

  async verifyDomain(actor: RequestPrincipal & { tenantId: string }, d: string) {
    const c = await this.system.ssoConnection.findUnique({ where: { tenantId: actor.tenantId } });
    if (!c || !c.domains.includes(d)) throw notFound('Domain on this SSO connection');
    const taken = await this.system.ssoConnection.findFirst({ where: { tenantId: { not: actor.tenantId }, verifiedDomains: { has: d } }, select: { id: true } });
    if (taken) throw conflict('This domain is already verified by another workspace — contact support');
    if (this.config.SSO_DOMAIN_VERIFICATION === 'dns') {
      const expected = `canon-verification=${this.verificationToken(actor.tenantId, d)}`;
      const records = await resolveTxt(`_canon-verification.${d}`).catch(() => [] as string[][]);
      if (!records.some((r) => r.join('') === expected)) throw badRequest('DOMAIN_NOT_VERIFIED', `TXT record not found yet at _canon-verification.${d} (DNS can take a few minutes)`);
    }
    if (!c.verifiedDomains.includes(d)) await this.system.ssoConnection.update({ where: { id: c.id }, data: { verifiedDomains: { push: d } } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'sso.domain_verified', entityType: 'SsoConnection', entityId: c.id, changes: { domain: d } }, actor);
    return this.get(actor.tenantId);
  }

  async remove(actor: RequestPrincipal & { tenantId: string }): Promise<void> {
    const c = await this.system.ssoConnection.findUnique({ where: { tenantId: actor.tenantId } });
    if (!c) return;
    await this.system.ssoConnection.delete({ where: { id: c.id } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'sso.deleted', entityType: 'SsoConnection', entityId: c.id }, actor);
  }

  async discover(email: string): Promise<{ sso: false } | { sso: true; name: string; loginUrl: string; enforced: boolean }> {
    const c = await this.policy.connectionFor(email);
    return c ? { sso: true, name: c.name, loginUrl: this.policy.loginUrl(c.id), enforced: c.enforced } : { sso: false };
  }

  private async active(id: string): Promise<SsoConnection> {
    const c = await this.system.ssoConnection.findUnique({ where: { id } });
    if (!c || !c.isActive) throw notFound('SSO connection');
    return c;
  }

  async authorizeUrl(id: string): Promise<string> {
    return this.saml(await this.active(id)).getAuthorizeUrlAsync('', undefined, {});
  }

  async metadata(id: string): Promise<string> {
    return this.saml(await this.active(id)).generateServiceProviderMetadata(null);
  }

  /**
   * Consumes the IdP's POSTed response. Returns the user and workspace to start a session for;
   * every rejection is a typed error the controller turns into a login-page message.
   */
  async consume(id: string, body: Record<string, string>) {
    const c = await this.active(id);
    let profile: Profile | null;
    try {
      ({ profile } = await this.saml(c).validatePostResponseAsync(body));
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, connection: id }, 'sso.invalid_response');
      throw new ApiError('SSO_INVALID_RESPONSE', 'The identity provider response could not be verified', HttpStatus.UNAUTHORIZED);
    }
    if (!profile) throw new ApiError('SSO_INVALID_RESPONSE', 'No identity in the response', HttpStatus.UNAUTHORIZED);
    const claim = (keys: string[]) => keys.map((k) => profile[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
    const email = (claim(EMAIL_CLAIMS) ?? (profile.nameID?.includes('@') ? profile.nameID : ''))?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new ApiError('SSO_NO_EMAIL', 'The identity provider did not send an email address', HttpStatus.UNAUTHORIZED);
    // The IdP is trusted only for the domains this workspace proved it owns.
    if (!c.verifiedDomains.includes(emailDomain(email))) throw new ApiError('SSO_DOMAIN_MISMATCH', `${email} is not on a verified domain of this connection`, HttpStatus.FORBIDDEN);

    let user = await this.system.user.findUnique({ where: { email } });
    if (user && (user.deletedAt || user.status === 'SUSPENDED' || user.status === 'DISABLED')) throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled', HttpStatus.FORBIDDEN);
    const member = user ? await this.system.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: c.tenantId, userId: user.id } } }) : null;
    if (!member && !c.jitProvisioning) throw new ApiError('SSO_NOT_A_MEMBER', 'Ask a workspace admin to invite you first', HttpStatus.FORBIDDEN);

    if (!user) {
      user = await this.system.user.create({ data: { email, name: claim(NAME_CLAIMS) ?? email.split('@')[0]!, status: 'ACTIVE', emailVerified: new Date() } });
    } else if (!user.emailVerified || user.status === 'PENDING_VERIFICATION') {
      // The IdP vouches for the mailbox on a domain the workspace owns.
      user = await this.system.user.update({ where: { id: user.id }, data: { emailVerified: new Date(), status: 'ACTIVE' } });
    }
    if (!member) {
      await this.system.tenantMember.create({ data: { tenantId: c.tenantId, userId: user.id, role: c.defaultRole } });
      await this.audit.record({ tenantId: c.tenantId, action: 'member.provisioned_by_sso', entityType: 'Member', entityId: user.id, changes: { email, role: c.defaultRole } }, undefined);
    }
    await this.system.ssoConnection.update({ where: { id: c.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ tenantId: c.tenantId, action: 'auth.sso_login', entityType: 'User', entityId: user.id, changes: { connection: c.id } }, { actorType: 'user', userId: user.id, tenantId: c.tenantId } as RequestPrincipal);
    return { user, tenantId: c.tenantId };
  }
}
