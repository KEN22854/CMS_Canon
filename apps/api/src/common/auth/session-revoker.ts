import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccessTokenService } from './access-token.service';

/**
 * Two strengths of revocation:
 *  - `forceRefresh`: deny-list access tokens only; the refresh token still works and re-reads
 *    membership/role from the DB. Used for role changes and removal from a tenant.
 *  - `revokeAll`: kill refresh tokens too (password reset, "sign out everywhere", reuse attack).
 */
@Injectable()
export class SessionRevoker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
  ) {}

  async forceRefresh(userId: string, tenantId?: string): Promise<void> {
    const families = await this.activeFamilies(userId, tenantId);
    await this.tokens.revokeFamilies(families);
  }

  async revokeAll(userId: string, reason: string, exceptFamilyId?: string): Promise<number> {
    const families = (await this.activeFamilies(userId)).filter((f) => f !== exceptFamilyId);
    if (families.length === 0) return 0;
    await this.prisma.session.updateMany({
      where: { userId, familyId: { in: families }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.tokens.revokeFamilies(families);
    return families.length;
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    await this.tokens.revokeFamilies([familyId]);
  }

  private async activeFamilies(userId: string, tenantId?: string): Promise<string[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() }, ...(tenantId ? { tenantId } : {}) },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    return rows.map((r) => r.familyId);
  }
}
