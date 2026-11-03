import { Prisma, type MemberRole } from '@canon/db';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { Mailer } from '../../infrastructure/mail/mailer';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { REDIS } from '../../infrastructure/redis/redis.module';

export type Delivery = 'instant' | 'digest' | 'off';

/** Every type a person can receive, with its e-mail default (in-app is always on). */
export const NOTIFICATION_TYPES = {
  'form.submitted': { label: 'New form submissions', email: 'digest' },
  'review.requested': { label: 'Someone asks you to review a page', email: 'instant' },
  'review.decided': { label: 'Your review request was approved or sent back', email: 'instant' },
  'comment.mentioned': { label: 'You were mentioned in a comment', email: 'instant' },
  'canon.branch_ready': { label: 'Canon prepared page updates for a changed fact', email: 'digest' },
  'billing.payment_failed': { label: 'A payment failed', email: 'instant' },
  'webhook.disabled': { label: 'A webhook was paused after failures', email: 'instant' },
  'domain.status': { label: 'A custom domain was verified or stopped resolving', email: 'instant' },
} as const satisfies Record<string, { label: string; email: Delivery }>;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const prefsBody = z.partialRecord(
  z.enum(Object.keys(NOTIFICATION_TYPES) as [NotificationType, ...NotificationType[]]),
  z.enum(['instant', 'digest', 'off']),
);

export interface NotifyInput {
  type: NotificationType;
  title: string;
  message: string;
  /** Admin path the notification opens (e.g. /sites/x/forms/y). */
  link?: string;
  data?: Record<string, unknown>;
  /** Same key, same person → one notification (outbox handlers run at least once). */
  dedupeKey?: string;
}

const DIGEST_QUEUE = 'notification-digest';
const DIGEST_EVERY_MS = 24 * 60 * 60_000;

/**
 * The bell in the admin, plus e-mail: instantly for what needs action, as a daily digest for the
 * rest, per person and per type. Any module notifies through here, so preferences, dedupe and
 * mail formatting live in one place.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly system: SystemPrismaService,
    private readonly mailer: Mailer,
    private readonly queues: Queues,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationsService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NOTIFICATION_JOBS === 'off') return;
    this.queues.worker(DIGEST_QUEUE, () => this.sendDigests(), 1);
    await this.queues
      .queue(DIGEST_QUEUE)
      .upsertJobScheduler(
        'notification-digest',
        { every: DIGEST_EVERY_MS },
        { name: 'digest', data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } },
      );
  }

  private delivery(prefs: unknown, type: NotificationType): Delivery {
    const p = (prefs ?? {}) as Record<string, Delivery>;
    return p[type] ?? NOTIFICATION_TYPES[type].email;
  }

  async notify(tenantId: string | null, userIds: string[], n: NotifyInput): Promise<number> {
    const users = await this.system.user.findMany({
      where: { id: { in: [...new Set(userIds)] }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, email: true, notificationPrefs: true },
    });
    let created = 0;
    for (const u of users) {
      if (n.dedupeKey && !(await this.redis.set(`notif:${n.dedupeKey}:${u.id}`, '1', 'EX', 7 * 86_400, 'NX')))
        continue;
      const row = await this.system.notification.create({
        data: {
          userId: u.id,
          tenantId,
          type: n.type,
          title: n.title.slice(0, 200),
          message: n.message.slice(0, 1_000),
          link: n.link ?? null,
          data: (n.data ?? {}) as Prisma.InputJsonValue,
        },
      });
      created++;
      if (this.delivery(u.notificationPrefs, n.type) !== 'instant') continue;
      const url = n.link ? `${this.config.ADMIN_PUBLIC_URL}${n.link}` : this.config.ADMIN_PUBLIC_URL;
      await this.mailer
        .send({
          to: u.email,
          subject: n.title,
          text: `${n.message}\n\n${url}`,
          html: `<p>${escapeHtml(n.message)}</p><p><a href="${escapeHtml(url)}">Open in Canon</a></p>`,
          template: `notification.${n.type}`,
        })
        .then(() =>
          this.system.notification.update({ where: { id: row.id }, data: { emailedAt: new Date() } }),
        )
        .catch((err: unknown) => this.logger.warn({ err, type: n.type }, 'notification.mail_failed'));
    }
    return created;
  }

  async notifyRoles(tenantId: string, roles: MemberRole[], n: NotifyInput): Promise<number> {
    const members = await this.system.tenantMember.findMany({
      where: { tenantId, role: { in: roles } },
      select: { userId: true },
    });
    return this.notify(
      tenantId,
      members.map((m) => m.userId),
      n,
    );
  }

  async list(userId: string, q: { unread?: boolean; cursor?: string; limit: number }) {
    const rows = await this.system.notification.findMany({
      where: { userId, ...(q.unread ? { isRead: false } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        tenantId: true,
        type: true,
        title: true,
        message: true,
        link: true,
        isRead: true,
        createdAt: true,
      },
    });
    return {
      items: rows.slice(0, q.limit),
      nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      unread: await this.unreadCount(userId),
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.system.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: string, ids: string[] | 'all'): Promise<{ updated: number }> {
    const res = await this.system.notification.updateMany({
      where: { userId, isRead: false, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: res.count };
  }

  async preferences(userId: string) {
    const u = await this.system.user.findUniqueOrThrow({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    return Object.entries(NOTIFICATION_TYPES).map(([type, t]) => ({
      type,
      label: t.label,
      email: this.delivery(u.notificationPrefs, type as NotificationType),
      default: t.email,
    }));
  }

  async setPreferences(userId: string, prefs: z.infer<typeof prefsBody>) {
    const u = await this.system.user.findUniqueOrThrow({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    await this.system.user.update({
      where: { id: userId },
      data: { notificationPrefs: { ...(u.notificationPrefs as object), ...prefs } as Prisma.InputJsonValue },
    });
    return this.preferences(userId);
  }

  /** One e-mail per person with what they have not read or been mailed about in the last day. */
  async sendDigests(now = new Date()): Promise<{ sent: number }> {
    const since = new Date(now.getTime() - DIGEST_EVERY_MS);
    const pending = await this.system.notification.findMany({
      where: { isRead: false, emailedAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true, notificationPrefs: true, status: true, deletedAt: true } } },
      take: 10_000,
    });
    const byUser = new Map<string, typeof pending>();
    for (const n of pending) {
      if (n.user.status !== 'ACTIVE' || n.user.deletedAt) continue;
      if (this.delivery(n.user.notificationPrefs, n.type as NotificationType) !== 'digest') continue;
      byUser.set(n.userId, [...(byUser.get(n.userId) ?? []), n]);
    }
    let sent = 0;
    for (const list of byUser.values()) {
      const to = list[0]!.user.email;
      const items = list.map((n) => `• ${n.title}${n.message ? ` — ${n.message}` : ''}`);
      await this.mailer.send({
        to,
        subject: `Canon: ${list.length} update${list.length === 1 ? '' : 's'} since yesterday`,
        text: `${items.join('\n')}\n\n${this.config.ADMIN_PUBLIC_URL}`,
        html: `<ul>${list.map((n) => `<li><b>${escapeHtml(n.title)}</b>${n.message ? ` — ${escapeHtml(n.message)}` : ''}</li>`).join('')}</ul><p><a href="${escapeHtml(this.config.ADMIN_PUBLIC_URL)}">Open Canon</a></p>`,
        template: 'notification.digest',
      });
      await this.system.notification.updateMany({
        where: { id: { in: list.map((n) => n.id) } },
        data: { emailedAt: now },
      });
      sent++;
    }
    return { sent };
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
