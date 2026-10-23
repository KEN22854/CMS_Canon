import type { CollectionAiSettings } from '@canon/fields';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Queues } from '../../infrastructure/queue/queue.module';

export const ENRICH_QUEUE = 'entry-enrich';
/** Editors autosave every few seconds; waiting lets a burst of saves cost one enrichment. */
const DEBOUNCE_MS = 15_000;

export interface EnrichJob {
  tenantId: string;
  entryId: string;
}

/**
 * Scheduling side of entry enrichment, kept apart from the worker so EntriesService can depend on
 * it without pulling the AI stack into its constructor graph.
 */
@Injectable()
export class EnrichmentQueue {
  constructor(
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EnrichmentQueue.name);
  }

  wanted(ai: CollectionAiSettings): boolean {
    return ai.autoTag || ai.autoSummary || ai.qualityScore || ai.duplicateCheck;
  }

  async schedule(tenantId: string, entryId: string, ai: CollectionAiSettings): Promise<void> {
    if (!this.wanted(ai)) return;
    const q = this.queues.queue(ENRICH_QUEUE);
    try {
      // One pending job per entry: a newer save while one is waiting is already covered, because
      // the worker reads the entry when it runs. Finished jobs are removed so the id is reusable.
      const existing = await q.getJob(entryId);
      if (existing && ['waiting', 'delayed'].includes(await existing.getState())) return;
      if (existing) await existing.remove().catch(() => undefined);
      await q.add('enrich', { tenantId, entryId } satisfies EnrichJob, { jobId: entryId, delay: DEBOUNCE_MS, removeOnComplete: true, removeOnFail: true, attempts: 3 });
    } catch (err) {
      // Enrichment is best-effort: a Redis hiccup must never fail the editor's save.
      this.logger.warn({ err, entryId }, 'enrichment.schedule_failed');
    }
  }
}
