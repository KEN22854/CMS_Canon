import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { RequestPrincipal } from '../../common/auth/principal';
import { SessionRevoker } from '../../common/auth/session-revoker';
import { verifyPassword } from '../../common/crypto/password';
import { ApiError, conflict, forbidden } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';

/** Days a deleted workspace stays restorable by support before it is purged for good. */
export const TENANT_PURGE_AFTER_DAYS = 30;
const PURGE_QUEUE = 'tenant-purge';
const PURGE_EVERY_MS = 6 * 60 * 60_000;

/**
 * Data-subject and data-controller rights (GDPR art. 15, 17, 20): export my data, erase my
 * account, export a whole workspace, and purge deleted workspaces after the grace period.
 * Erasure anonymizes rather than deletes the user row: content they wrote and the audit trail
 * keep their integrity, while nothing identifying remains.
 */
@Injectable()
export class PrivacyService implements OnApplicationBootstrap {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly sessions: SessionRevoker,
    private readonly audit: AuditService,
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrivacyService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.COMPLIANCE_JOBS === 'off') return;
    this.queues.worker(PURGE_QUEUE, () => this.purgeDeletedTenants(), 1);
    await this.queues.queue(PURGE_QUEUE).upsertJobScheduler('tenant-purge', { every: PURGE_EVERY_MS }, { name: 'purge', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  /** Everything Canon holds about the caller as a person (not the workspaces' content). */
  async exportMe(userId: string) {
    const user = await this.system.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, avatar: true, phone: true, locale: true, role: true, status: true, emailVerified: true, twoFactorEnabled: true, lastLoginAt: true, createdAt: true, updatedAt: true, preferredAiModel: true, aiSettings: true },
    });
    const [memberships, sessions, apiKeys, notifications, audit, ai] = await Promise.all([
      this.system.tenantMember.findMany({ where: { userId }, select: { role: true, createdAt: true, tenant: { select: { id: true, name: true } } } }),
      this.system.session.findMany({ where: { userId }, select: { id: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
      this.system.apiKey.findMany({ where: { createdById: userId }, select: { id: true, name: true, keyPrefix: true, scopes: true, createdAt: true, revokedAt: true, tenantId: true } }),
      this.system.notification.findMany({ where: { userId }, select: { type: true, title: true, message: true, createdAt: true, isRead: true }, orderBy: { createdAt: 'desc' }, take: 1_000 }),
      this.system.auditLog.findMany({ where: { userId }, select: { tenantId: true, action: true, entityType: true, entityId: true, ipAddress: true, userAgent: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 10_000 }),
      this.system.aiGeneration.findMany({ where: { userId }, select: { tenantId: true, feature: true, modelKey: true, promptText: true, totalTokens: true, costUsd: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5_000 }),
    ]);
    return { exportedAt: new Date().toISOString(), user, memberships, sessions, apiKeys, notifications, activity: audit, aiRequests: ai };
  }

  /**
   * Right to erasure. Owners must first hand over or delete their workspaces, so a workspace is
   * never left without an owner. Password-protected accounts confirm with the password.
   */
  async deleteMe(actor: RequestPrincipal, password: string | undefined, req: Request): Promise<void> {
    const userId = actor.userId;
    if (!userId || actor.actorType !== 'user') throw forbidden('Only a signed-in person can delete their account');
    const user = await this.system.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, email: true } });
    if (user.passwordHash && !(password && (await verifyPassword(user.passwordHash, password)))) throw new ApiError('INVALID_CREDENTIALS', 'Password is incorrect', 401);
    const owned = await this.system.tenantMember.findMany({ where: { userId, role: 'OWNER', tenant: { deletedAt: null } }, select: { tenant: { select: { id: true, name: true } } } });
    if (owned.length) throw conflict('Transfer ownership or delete these workspaces first', { workspaces: owned.map((o) => o.tenant) });

    const memberships = await this.system.tenantMember.findMany({ where: { userId }, select: { tenantId: true } });
    await this.sessions.revokeAll(userId, 'account_deleted');
    await this.system.$transaction([
      this.system.apiKey.updateMany({ where: { createdById: userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.system.tenantMember.deleteMany({ where: { userId } }),
      this.system.invitation.deleteMany({ where: { email: user.email, acceptedAt: null } }),
      this.system.notification.deleteMany({ where: { userId } }),
      this.system.user.update({
        where: { id: userId },
        data: {
          email: `deleted+${userId}@deleted.invalid`,
          name: 'Deleted user',
          passwordHash: null,
          avatar: null,
          phone: null,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorBackupCodes: [],
          emailVerificationToken: null,
          passwordResetTokenHash: null,
          aiSettings: {},
          status: 'DISABLED',
          deletedAt: new Date(),
        },
      }),
    ]);
    for (const m of memberships) await this.audit.record({ tenantId: m.tenantId, action: 'user.erased', entityType: 'User', entityId: userId }, actor, req);
  }

  /** Data portability for a workspace: content, structure and settings as one JSON document. */
  async exportTenant(tenantId: string) {
    const db = this.system;
    const [tenant, members, sites, pages, collections, entries, facts, media, segments, experiments, webhooks] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true, slug: true, plan: true, settings: true, createdAt: true } }),
      db.tenantMember.findMany({ where: { tenantId }, select: { role: true, user: { select: { email: true, name: true } } } }),
      db.site.findMany({ where: { tenantId, deletedAt: null } }),
      db.page.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, siteId: true, parentId: true, title: true, slug: true, fullPath: true, locale: true, status: true, content: true, seo: true, description: true, version: true, publishedVersion: true, translationGroupId: true, createdAt: true, updatedAt: true } }),
      db.collection.findMany({ where: { tenantId, deletedAt: null } }),
      db.entry.findMany({ where: { tenantId, deletedAt: null } }),
      db.fact.findMany({ where: { tenantId }, include: { versions: { orderBy: { createdAt: 'asc' } } } }),
      db.media.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, siteId: true, originalName: true, mimeType: true, size: true, url: true, alt: true, createdAt: true } }),
      db.segment.findMany({ where: { tenantId, deletedAt: null } }),
      db.abTest.findMany({ where: { tenantId } }),
      db.webhook.findMany({ where: { tenantId }, select: { id: true, name: true, url: true, events: true, isActive: true } }),
    ]);
    return { format: 'canon-export', version: 1, exportedAt: new Date().toISOString(), tenant, members, sites, pages, collections, entries, facts, media, segments, experiments, webhooks };
  }

  /** Hard-deletes workspaces soft-deleted more than the grace period ago (cascades to all content). */
  async purgeDeletedTenants(now = new Date()): Promise<{ purged: number }> {
    const before = new Date(now.getTime() - TENANT_PURGE_AFTER_DAYS * 86_400_000);
    const due = await this.system.tenant.findMany({ where: { deletedAt: { lt: before } }, select: { id: true } });
    for (const t of due) {
      await this.system.tenant.delete({ where: { id: t.id } });
      this.logger.warn({ tenantId: t.id }, 'tenant.purged');
    }
    return { purged: due.length };
  }
}
