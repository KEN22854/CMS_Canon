import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/**
 * BullMQ wiring. Queues are created lazily by name and share one connection config; workers run
 * in-process for now (the API image doubles as the worker image — Phase 6 splits them by flag).
 * BullMQ brings its own ioredis, so it gets connection *options*, not our client instance.
 */
@Injectable()
export class Queues implements OnApplicationShutdown {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  readonly connection: ConnectionOptions;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const url = new URL(config.REDIS_URL);
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      // Required by BullMQ workers: blocking commands must not be cut by per-request retries.
      maxRetriesPerRequest: null,
    };
  }

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: { removeOnComplete: 1_000, removeOnFail: 5_000, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } } });
      this.queues.set(name, q);
    }
    return q;
  }

  worker<T>(name: string, processor: Processor<T>, concurrency = 4): Worker<T> {
    const w = new Worker<T>(name, processor, { connection: this.connection, concurrency });
    this.workers.push(w as Worker);
    return w;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.workers.map((w) => w.close()), ...[...this.queues.values()].map((q) => q.close())]);
  }
}

@Global()
@Module({ providers: [Queues], exports: [Queues] })
export class QueueModule {}
