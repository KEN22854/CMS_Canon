import { createId } from '@paralleldrive/cuid2';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SessionRevoker } from '../../common/auth/session-revoker';
import { randomToken, sha256 } from '../../common/crypto/tokens';
import { unauthenticated } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface IssuedSession {
  refreshToken: string;
  familyId: string;
  userId: string;
  tenantId: string | null;
  expiresAt: Date;
}

/**
 * Two tabs refreshing at the same moment present the same token twice. Inside this window the
 * second use is treated as a benign race (401, retry with the new cookie) rather than theft.
 */
const ROTATION_GRACE_MS = 15_000;

/**
 * Refresh tokens: opaque, single-use, rotated on every refresh (OAuth 2.1 BCP).
 * Reusing an already-rotated token outside the grace window means it leaked: the whole family
 * is revoked, logging out both the attacker and the victim, who then re-authenticates.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revoker: SessionRevoker,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SessionService.name);
  }

  async issue(userId: string, tenantId: string | null, meta: ClientMeta, familyId: string = createId()): Promise<IssuedSession> {
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TTL_DAYS * 86_400_000);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        familyId,
        tenantId,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        expiresAt,
      },
    });
    return { refreshToken, familyId, userId, tenantId, expiresAt };
  }

  /** `tenantId` override = tenant switch; undefined keeps the session's tenant. */
  async rotate(rawToken: string, meta: ClientMeta, tenantId?: string | null): Promise<IssuedSession> {
    const row = await this.prisma.session.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!row) throw unauthenticated('Invalid refresh token');

    if (row.revokedAt) {
      const benignRace = row.revokedReason === 'rotated' && Date.now() - row.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (row.revokedReason === 'rotated' && !benignRace) {
        this.logger.warn({ userId: row.userId, familyId: row.familyId, ip: meta.ip }, 'auth.refresh_token_reuse_detected');
        await this.revoker.revokeFamily(row.familyId, 'reuse_detected');
      }
      throw unauthenticated('Refresh token is no longer valid');
    }
    if (row.expiresAt < new Date()) throw unauthenticated('Session expired');

    // Conditional update = compare-and-swap: only one concurrent caller can win the rotation.
    const won = await this.prisma.session.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'rotated' },
    });
    if (won.count === 0) throw unauthenticated('Refresh token is no longer valid');

    const next = await this.issue(row.userId, tenantId === undefined ? row.tenantId : tenantId, meta, row.familyId);
    // Absolute lifetime stays anchored to login, so rotation cannot extend a session forever.
    await this.prisma.session.updateMany({ where: { tokenHash: sha256(next.refreshToken) }, data: { expiresAt: row.expiresAt } });
    return { ...next, expiresAt: row.expiresAt };
  }

  async revokeByToken(rawToken: string, reason: string): Promise<string | null> {
    const row = await this.prisma.session.findUnique({ where: { tokenHash: sha256(rawToken) }, select: { familyId: true } });
    if (!row) return null;
    await this.revoker.revokeFamily(row.familyId, reason);
    return row.familyId;
  }

  async listActive(userId: string, currentFamilyId?: string) {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const started = await this.prisma.session.groupBy({
      by: ['familyId'],
      where: { familyId: { in: rows.map((r) => r.familyId) } },
      _min: { createdAt: true },
    });
    const startedAt = new Map(started.map((s) => [s.familyId, s._min.createdAt]));
    return rows.map((r) => ({
      id: r.familyId,
      current: r.familyId === currentFamilyId,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      tenantId: r.tenantId,
      createdAt: startedAt.get(r.familyId) ?? r.createdAt,
      lastUsedAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** Ownership check inside the query: a user can only ever revoke their own sessions. */
  async revokeOwn(userId: string, familyId: string): Promise<boolean> {
    const owned = await this.prisma.session.count({ where: { userId, familyId } });
    if (owned === 0) return false;
    await this.revoker.revokeFamily(familyId, 'revoked_by_user');
    return true;
  }
}
