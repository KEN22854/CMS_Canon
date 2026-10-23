import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { PagesService } from './pages.service';
import { PUBLISH_QUEUE, ScheduleStore } from './schedule-store';

/**
 * Executes scheduled publish/unpublish. On boot every PENDING row is re-armed, so a Redis flush
 * cannot silently drop a launch.
 */
@Injectable()
export class PublishScheduler implements OnApplicationBootstrap {
  constructor(
    private readonly queues: Queues,
    private readonly store: ScheduleStore,
    private readonly system: SystemPrismaService,
    private readonly pages: PagesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PublishScheduler.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SCHEDULER === 'off') return;
    this.queues.worker<{ scheduleId: string }>(PUBLISH_QUEUE, (job) => this.run(job.data.scheduleId), 2);
    const pending = await this.system.scheduledPublish.findMany({ where: { status: 'PENDING' }, select: { id: true, scheduledAt: true } });
    for (const p of pending) await this.store.enqueue(p.id, p.scheduledAt);
    if (pending.length) this.logger.info({ count: pending.length }, 'scheduler.rearmed');
  }

  /** Public for tests: executes a schedule as if its time had come. */
  async run(scheduleId: string): Promise<void> {
    // Claim with a conditional update so a duplicate job delivery is a no-op.
    const claimed = await this.system.scheduledPublish.updateMany({ where: { id: scheduleId, status: 'PENDING' }, data: { status: 'RUNNING' } });
    if (claimed.count === 0) return;
    const row = await this.system.scheduledPublish.findUniqueOrThrow({ where: { id: scheduleId } });
    try {
      const page = await this.system.page.findFirst({ where: { id: row.entityId, tenantId: row.tenantId, deletedAt: null }, select: { siteId: true } });
      if (!page) throw new Error('page no longer exists');
      const actor = { actorType: 'system' as const, tenantId: row.tenantId };
      if (row.action === 'PUBLISH') await this.pages.publish(actor, null, page.siteId, row.entityId, 'Scheduled publish');
      else await this.pages.unpublish(actor, null, page.siteId, row.entityId);
      await this.system.scheduledPublish.update({ where: { id: scheduleId }, data: { status: 'DONE' } });
    } catch (err) {
      this.logger.error({ err, scheduleId }, 'scheduler.run_failed');
      await this.system.scheduledPublish.update({ where: { id: scheduleId }, data: { status: 'FAILED' } });
    }
  }
}
