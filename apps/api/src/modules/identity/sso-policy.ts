import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/**
 * Which IdP owns an email address, and whether a password may still be used. Lives in identity
 * (not the SSO module) because the password login path consults it on every sign-in.
 */
@Injectable()
export class SsoPolicy {
  constructor(
    private readonly system: SystemPrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  loginUrl(connectionId: string): string {
    return `${this.config.ADMIN_PUBLIC_URL}/api/v1/auth/sso/saml/${connectionId}/login`;
  }

  /** The active connection whose *verified* domains include this email's domain. */
  connectionFor(email: string) {
    return this.system.ssoConnection.findFirst({ where: { isActive: true, verifiedDomains: { has: emailDomain(email) } }, select: { id: true, tenantId: true, enforced: true, name: true } });
  }

  /**
   * Enforced SSO: members of that workspace sign in through the IdP. Owners keep the password as
   * a break-glass path (an IdP outage must not lock a company out of its own workspace).
   */
  async assertPasswordAllowed(user: { id: string; email: string }): Promise<void> {
    const conn = await this.connectionFor(user.email);
    if (!conn?.enforced) return;
    const member = await this.system.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: conn.tenantId, userId: user.id } }, select: { role: true } });
    if (!member || member.role === 'OWNER') return;
    throw new ApiError('SSO_REQUIRED', `${conn.name} requires single sign-on`, HttpStatus.FORBIDDEN, { loginUrl: this.loginUrl(conn.id) });
  }
}
