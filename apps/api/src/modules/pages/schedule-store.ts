import { Injectable } from '@nestjs/common';
import type { ScheduledAction } from '@canon/db';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';

export const PUBLISH_QUEUE = 'publish-scheduler';

/**
 * Arms and disarms scheduled publishes. Split from PublishScheduler (which executes them via
 * PagesService) so PagesService can schedule without a circular import.
 * The DB row is the source of truth; the BullMQ delayed job is only the alarm clock
 * (jobId = schedule id, so re-arming is idempotent).
 */
@Injectable()
export class ScheduleStore {
  constructor(
    private readonly queues: Queues,
    private readonly system: SystemPrismaService,
  ) {}

  async enqueue(scheduleId: string, at: Date): Promise<void> {
    await this.queues.queue(PUBLISH_QUEUE).add('run', { scheduleId }, { jobId: scheduleId, delay: Math.max(at.getTime() - Date.now(), 0) });
  }

  async cancelForPage(tenantId: string, pageId: string, action?: ScheduledAction): Promise<void> {
    const rows = await this.system.scheduledPublish.findMany({ where: { tenantId, entityType: 'PAGE', entityId: pageId, status: 'PENDING', ...(action ? { action } : {}) }, select: { id: true } });
    if (!rows.length) return;
    await this.system.scheduledPublish.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'CANCELLED' } });
    const q = this.queues.queue(PUBLISH_QUEUE);
    await Promise.allSettled(rows.map((r) => q.remove(r.id)));
  }
}
