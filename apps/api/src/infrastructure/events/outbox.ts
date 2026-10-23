import { Global, Injectable, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma } from '@canon/db';
import { PinoLogger } from 'nestjs-pino';
import { SystemPrismaService } from '../prisma/prisma.service';

export interface DomainEvent<P extends Prisma.InputJsonObject = Prisma.InputJsonObject> {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  /** e.g. "PagePublished"; consumers subscribe by type. */
  type: string;
  schemaVersion?: number;
  payload: P;
}

export interface StoredEvent {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  schemaVersion: number;
  payload: Prisma.JsonValue;
  occurredAt: Date;
}

type Handler = (e: StoredEvent) => Promise<void>;

/**
 * Transactional outbox. Producers write the event in the *same* transaction as the state change
 * (so "page published but webhook never sent" cannot happen); the relay delivers at-least-once.
 * Handlers must therefore be idempotent (revalidation, cache purge and webhook deliveries are).
 */
@Injectable()
export class Outbox {
  enqueue(tx: Prisma.TransactionClient, e: DomainEvent): Promise<unknown> {
    return tx.outboxEvent.create({
      data: { tenantId: e.tenantId, aggregateType: e.aggregateType, aggregateId: e.aggregateId, type: e.type, schemaVersion: e.schemaVersion ?? 1, payload: e.payload },
    });
  }
}

@Injectable()
export class EventBus {
  private readonly handlers = new Map<string, Handler[]>();

  on(type: string, handler: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  handlersFor(type: string): Handler[] {
    return [...(this.handlers.get(type) ?? []), ...(this.handlers.get('*') ?? [])];
  }
}

const BATCH = 50;
const POLL_MS = 1_000;
const MAX_ATTEMPTS = 10;

/**
 * Polls outbox_events with FOR UPDATE SKIP LOCKED, so any number of API/worker replicas can run
 * the relay without double-processing a row. Runs on the system role: it is cross-tenant by nature.
 * Failed events back off exponentially and stop after MAX_ATTEMPTS (left for inspection — dead letters).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly system: SystemPrismaService,
    private readonly bus: EventBus,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxRelay.name);
  }

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_RELAY === 'off') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public for tests: drain synchronously instead of waiting for the poller. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.system.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<(StoredEvent & { attempts: number })[]>`
          SELECT id, "tenantId", "aggregateType", "aggregateId", type, "schemaVersion", payload, "occurredAt", attempts
          FROM outbox_events
          WHERE "publishedAt" IS NULL AND attempts < ${MAX_ATTEMPTS}
            AND "occurredAt" <= now() - (power(2, attempts) - 1) * interval '1 second'
          ORDER BY "occurredAt"
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;
        for (const e of rows) {
          try {
            for (const h of this.bus.handlersFor(e.type)) await h(e);
            await tx.outboxEvent.update({ where: { id: e.id }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
          } catch (err) {
            this.logger.warn({ err, eventId: e.id, type: e.type, attempts: e.attempts + 1 }, 'outbox.delivery_failed');
            await tx.outboxEvent.update({ where: { id: e.id }, data: { attempts: { increment: 1 } } });
          }
        }
        return rows.length;
      }, { timeout: 30_000 });
    } catch (err) {
      this.logger.error({ err }, 'outbox.tick_failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}

@Global()
@Module({ providers: [Outbox, EventBus, OutboxRelay], exports: [Outbox, EventBus, OutboxRelay] })
export class EventsModule {}
