import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../../config/env';
import { Mailer } from '../../../infrastructure/mail/mailer';
import { aiBudgetAlertMail } from '../../../infrastructure/mail/templates';
import { SystemPrismaService } from '../../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../../infrastructure/redis/redis.module';

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

/** Thresholds (in %) that a single spend increment crossed. Pure, so the edge cases are unit-tested. */
export function crossedThresholds(before: number, after: number, budget: number): number[] {
  if (budget <= 0) return [];
  return BUDGET_THRESHOLDS.filter((pct) => before < (budget * pct) / 100 && after >= (budget * pct) / 100);
}

/**
 * Notifies owners/admins when spend crosses 50/80/100% of the monthly budget. Each threshold fires
 * once per tenant per month (Redis SET NX), no matter how many replicas see the crossing.
 * Uses the system role: notifications target *other* users, which RLS on notifications forbids
 * for the request-scoped role by design.
 */
@Injectable()
export class AiBudgetAlerts {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly system: SystemPrismaService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiBudgetAlerts.name);
  }

  async maybeNotify(tenantId: string, tenantName: string, before: number, after: number, budget: number): Promise<void> {
    for (const pct of crossedThresholds(before, after, budget)) {
      const d = new Date();
      const key = `ai:alert:${tenantId}:${d.getUTCFullYear()}${d.getUTCMonth() + 1}:${pct}`;
      const first = await this.redis.set(key, '1', 'EX', 40 * 86_400, 'NX');
      if (first !== 'OK') continue;
      await this.notify(tenantId, tenantName, pct, after / 1_000_000, budget / 1_000_000);
    }
  }

  private async notify(tenantId: string, tenantName: string, pct: number, spentUsd: number, budgetUsd: number): Promise<void> {
    const recipients = await this.system.tenantMember.findMany({
      where: { tenantId, role: { in: ['OWNER', 'ADMIN'] } },
      include: { user: { select: { id: true, email: true } } },
    });
    const link = `${this.config.ADMIN_PUBLIC_URL}/settings/ai-usage`;
    await this.system.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.user.id,
        tenantId,
        type: 'ai.budget_threshold',
        title: `${pct}% of AI budget used`,
        message: `${tenantName} has used $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} this month.`,
        data: { percent: pct, spentUsd, budgetUsd },
      })),
    });
    for (const r of recipients) {
      await this.mailer.send(aiBudgetAlertMail(r.user.email, tenantName, pct, spentUsd, budgetUsd, link)).catch((err: unknown) => this.logger.warn({ err }, 'budget alert mail failed'));
    }
    this.logger.info({ tenantId, pct, recipients: recipients.length }, 'ai.budget_threshold_crossed');
  }
}
