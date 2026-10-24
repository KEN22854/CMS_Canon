import { packRules } from '@casl/ability/extra';
import type { MemberRole, User } from '@canon/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { defineAbilityFor } from '../../common/auth/abilities';
import { AccessTokenService } from '../../common/auth/access-token.service';
import type { RequestPrincipal } from '../../common/auth/principal';
import { SessionRevoker } from '../../common/auth/session-revoker';
import { burnPasswordCheck, checkPasswordPolicy, hashPassword, verifyPassword } from '../../common/crypto/password';
import { randomToken, sha256 } from '../../common/crypto/tokens';
import { ApiError, badRequest, forbidden, notFound, unauthenticated } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { Mailer } from '../../infrastructure/mail/mailer';
import { accountExistsMail, passwordChangedMail, resetPasswordMail, verifyEmailMail } from '../../infrastructure/mail/templates';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { InvitationsService } from '../tenancy/invitations.service';
import { TenantsService, type TenantSummary } from '../tenancy/tenants.service';
import type { LoginBody, RegisterBody } from './auth.dto';
import { LoginThrottleService } from './login-throttle.service';
import { SsoPolicy } from './sso-policy';
import { SessionService, type ClientMeta, type IssuedSession } from './session.service';
import { TwoFactorService } from './two-factor.service';

const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 3_600_000;

export interface AuthSuccess {
  kind: 'session';
  accessToken: string;
  expiresIn: number;
  session: IssuedSession;
  user: PublicUser;
  tenant: (TenantSummary & { role: MemberRole }) | null;
}

export interface MfaChallenge {
  kind: 'mfa';
  mfaToken: string;
}

export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'avatar' | 'locale' | 'role' | 'twoFactorEnabled'> & { emailVerified: boolean };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly tokens: AccessTokenService,
    private readonly revoker: SessionRevoker,
    private readonly tenants: TenantsService,
    private readonly invitations: InvitationsService,
    private readonly twoFactor: TwoFactorService,
    private readonly throttle: LoginThrottleService,
    private readonly sso: SsoPolicy,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  /**
   * Enumeration-safe: a new and an existing email get the same 202 response; the difference is
   * only in the email sent. Exception: a valid invite token proves mailbox ownership, so that
   * path signs the user in immediately.
   */
  async register(body: RegisterBody, meta: ClientMeta): Promise<AuthSuccess | { kind: 'pending'; status: 'check_email' }> {
    const policy = checkPasswordPolicy(body.password, [body.email, body.name]);
    if (!policy.ok) throw badRequest('WEAK_PASSWORD', policy.warning ?? 'Password is too weak', { score: policy.score, suggestions: policy.suggestions });

    const existing = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      // Same argon2 cost as the new-user path, so response time does not reveal the account.
      await burnPasswordCheck(body.password);
      await this.mailer.send(accountExistsMail(body.email, `${this.config.ADMIN_PUBLIC_URL}/login`, `${this.config.ADMIN_PUBLIC_URL}/forgot-password`));
      return { kind: 'pending', status: 'check_email' };
    }

    const invite = body.inviteToken ? await this.invitations.preview(body.inviteToken).catch(() => null) : null;
    const invitedHere = invite?.state === 'pending' && invite.email === body.email;

    const verifyToken = randomToken();
    const user = await this.prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        locale: body.locale ?? 'en',
        status: invitedHere ? 'ACTIVE' : 'PENDING_VERIFICATION',
        emailVerified: invitedHere ? new Date() : null,
        emailVerificationToken: invitedHere ? null : sha256(verifyToken),
        emailVerificationExpiresAt: invitedHere ? null : new Date(Date.now() + VERIFY_TTL_MS),
      },
    });

    if (invitedHere && body.inviteToken) {
      const { tenantId } = await this.invitations.accept(body.inviteToken, user);
      return this.startSession(user, tenantId, meta);
    }

    await this.tenants.createForOwner(user.id, { name: body.tenantName ?? `${body.name}'s workspace`, template: 'blank' });
    await this.mailer.send(verifyEmailMail(user.email, `${this.config.ADMIN_PUBLIC_URL}/verify-email?token=${verifyToken}`));
    return { kind: 'pending', status: 'check_email' };
  }

  /** Clicking the link proves mailbox ownership, so it also signs the user in. */
  async verifyEmail(token: string, meta: ClientMeta): Promise<AuthSuccess> {
    const user = await this.prisma.user.findUnique({ where: { emailVerificationToken: sha256(token) } });
    if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      throw badRequest('INVALID_TOKEN', 'Verification link is invalid or expired');
    }
    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date(), status: user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : user.status, emailVerificationToken: null, emailVerificationExpiresAt: null },
    });
    return this.startSession(verified, undefined, meta);
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerified) return;
    const token = randomToken();
    await this.prisma.user.update({ where: { id: user.id }, data: { emailVerificationToken: sha256(token), emailVerificationExpiresAt: new Date(Date.now() + VERIFY_TTL_MS) } });
    await this.mailer.send(verifyEmailMail(user.email, `${this.config.ADMIN_PUBLIC_URL}/verify-email?token=${token}`));
  }

  async login(body: LoginBody, meta: ClientMeta): Promise<AuthSuccess | MfaChallenge> {
    await this.throttle.assertNotLocked(body.email);
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    const valid = user?.passwordHash ? await verifyPassword(user.passwordHash, body.password) : (await burnPasswordCheck(body.password), false);
    if (!user || !valid || user.deletedAt) {
      await this.throttle.recordFailure(body.email);
      this.logger.info({ ip: meta.ip }, 'auth.login_failed');
      throw unauthenticated('Email or password is incorrect', 'INVALID_CREDENTIALS');
    }
    // Account state is revealed only after the password proved who is asking.
    if (user.status === 'SUSPENDED' || user.status === 'DISABLED') throw forbidden('This account is disabled', { reason: 'ACCOUNT_DISABLED' });
    if (!user.emailVerified) throw new ApiError('EMAIL_NOT_VERIFIED', 'Confirm your email first — we can resend the link', HttpStatus.FORBIDDEN);
    await this.throttle.reset(body.email);
    await this.sso.assertPasswordAllowed(user);

    const tenantId = body.tenantSlug ? (await this.tenants.listForUser(user.id)).find((t) => t.slug === body.tenantSlug)?.id : undefined;
    if (user.twoFactorEnabled) {
      return { kind: 'mfa', mfaToken: await this.tokens.signMfaChallenge(user.id, tenantId) };
    }
    return this.startSession(user, tenantId, meta);
  }

  async completeMfa(mfaToken: string, code: string, meta: ClientMeta): Promise<AuthSuccess> {
    const claims = await this.tokens.verifyMfaChallenge(mfaToken);
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) throw unauthenticated();
    await this.throttle.assertNotLocked(user.email);
    if (!(await this.twoFactor.verify(user.id, code))) {
      // Shares the password lockout budget so the 6-digit space cannot be brute-forced.
      await this.throttle.recordFailure(user.email);
      throw unauthenticated('Invalid verification code', 'INVALID_2FA_CODE');
    }
    await this.throttle.reset(user.email);
    return this.startSession(user, claims.tid, meta);
  }

  async refresh(rawToken: string, meta: ClientMeta): Promise<AuthSuccess> {
    const session = await this.sessions.rotate(rawToken, meta);
    return this.accessFor(session);
  }

  async switchTenant(p: RequestPrincipal, rawToken: string, tenantId: string, meta: ClientMeta): Promise<AuthSuccess> {
    if (!p.userId) throw forbidden('API keys are bound to a single tenant');
    const member = await this.tenants.membership(p.userId, tenantId);
    if (!member && p.systemRole !== 'SUPER_ADMIN') throw notFound('Tenant');
    const session = await this.sessions.rotate(rawToken, meta, tenantId);
    if (session.userId !== p.userId) throw unauthenticated('Session does not belong to the caller');
    return this.accessFor(session);
  }

  async logout(rawToken: string | undefined, p: RequestPrincipal | undefined): Promise<void> {
    if (rawToken) await this.sessions.revokeByToken(rawToken, 'logout');
    else if (p?.sessionId) await this.revoker.revokeFamily(p.sessionId, 'logout');
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt) return;
    const token = randomToken();
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordResetTokenHash: sha256(token), passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_MS) } });
    await this.mailer.send(resetPasswordMail(user.email, `${this.config.ADMIN_PUBLIC_URL}/reset-password?token=${token}`));
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { passwordResetTokenHash: sha256(token) } });
    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
      throw badRequest('INVALID_TOKEN', 'Reset link is invalid or expired');
    }
    await this.setPassword(user, password, { clearReset: true });
    // Completing a reset proves mailbox ownership as well.
    if (!user.emailVerified) await this.prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date(), status: 'ACTIVE', emailVerificationToken: null } });
    await this.revoker.revokeAll(user.id, 'password_changed');
  }

  async changePassword(p: RequestPrincipal, current: string, next: string): Promise<void> {
    if (!p.userId) throw forbidden('Not available for API keys');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, current))) throw unauthenticated('Current password is incorrect', 'INVALID_CREDENTIALS');
    await this.setPassword(user, next, { clearReset: false });
    // Other devices are signed out; the device that changed the password stays signed in.
    await this.revoker.revokeAll(user.id, 'password_changed', p.sessionId);
  }

  async me(p: RequestPrincipal) {
    if (!p.userId) {
      return { actorType: p.actorType, tenantId: p.tenantId, scopes: p.scopes, rules: packRules(defineAbilityFor(p).rules) };
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    const tenants = await this.tenants.listForUser(user.id);
    return {
      user: toPublic(user),
      tenant: tenants.find((t) => t.id === p.tenantId) ?? null,
      tenants,
      // Packed CASL rules let the admin UI hide what the API would reject anyway.
      rules: packRules(defineAbilityFor(p).rules),
    };
  }

  private async setPassword(user: User, password: string, opts: { clearReset: boolean }): Promise<void> {
    const policy = checkPasswordPolicy(password, [user.email, user.name]);
    if (!policy.ok) throw badRequest('WEAK_PASSWORD', policy.warning ?? 'Password is too weak', { score: policy.score, suggestions: policy.suggestions });
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        ...(opts.clearReset ? { passwordResetTokenHash: null, passwordResetExpiresAt: null } : {}),
      },
    });
    await this.mailer.send(passwordChangedMail(user.email));
  }

  /** Session for an identity proven elsewhere (SAML): no password, no Canon 2FA (the IdP owns MFA). */
  async startFederatedSession(user: User, tenantId: string, meta: ClientMeta): Promise<AuthSuccess> {
    return this.startSession(user, tenantId, meta);
  }

  private async startSession(user: User, preferredTenantId: string | undefined, meta: ClientMeta): Promise<AuthSuccess> {
    const tenants = await this.tenants.listForUser(user.id);
    const active = tenants.find((t) => t.id === preferredTenantId) ?? tenants[0] ?? null;
    const session = await this.sessions.issue(user.id, active?.id ?? null, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.accessFor(session, user);
  }

  /** Role and tenant are always re-derived from the DB here — the only place access tokens are minted. */
  private async accessFor(session: IssuedSession, knownUser?: User): Promise<AuthSuccess> {
    const user = knownUser ?? (await this.prisma.user.findUnique({ where: { id: session.userId } }));
    if (!user || user.deletedAt || user.status === 'SUSPENDED' || user.status === 'DISABLED') {
      await this.revoker.revokeFamily(session.familyId, 'admin');
      throw unauthenticated('Account is no longer active');
    }
    let tenant: AuthSuccess['tenant'] = null;
    if (session.tenantId) {
      const m = await this.tenants.membership(user.id, session.tenantId);
      if (m) tenant = { id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug, plan: m.tenant.plan, role: m.role };
      else if (user.role === 'SUPER_ADMIN') {
        const t = await this.tenants.get(session.tenantId);
        tenant = { id: t.id, name: t.name, slug: t.slug, plan: t.plan, role: 'OWNER' };
      }
    }
    const accessToken = await this.tokens.signAccess({
      sub: user.id,
      sid: session.familyId,
      tid: tenant?.id,
      trl: tenant?.role,
      srl: user.role,
    });
    return { kind: 'session', accessToken, expiresIn: this.tokens.accessTtlSec, session, user: toPublic(user), tenant };
  }
}

export function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatar: u.avatar,
    locale: u.locale,
    role: u.role,
    twoFactorEnabled: u.twoFactorEnabled,
    emailVerified: u.emailVerified !== null,
  };
}
