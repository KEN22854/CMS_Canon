import { randomBytes } from 'node:crypto';
import { Prisma, type Webhook } from '@canon/db';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { RequestPrincipal } from '../../common/auth/principal';
import { FieldEncryption } from '../../common/crypto/encryption';
import { forbidden, notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { EventBus, type StoredEvent } from '../../infrastructure/events/outbox';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { EVENT_BY_TYPE, WEBHOOK_EVENTS, WEBHOOK_EVENT_NAMES, assertDeliverableUrl, signWebhook } from './events';
import { pluginTarget } from './plugin-targets';

export const webhookBody = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.url().max(2_000),
  events: z.array(z.enum(['*', ...WEBHOOK_EVENT_NAMES] as [string, ...string[]])).min(1),
  siteId: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});
export type WebhookBody = z.infer<typeof webhookBody>;

const QUEUE = 'webhook-deliveries';
const ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;
/** Consecutive dead deliveries after which an endpoint is switched off (and owners see why). */
const DISABLE_AFTER = 15;

interface DeliveryJob {
  deliveryId: string;
}

export interface Envelope {
  id: string;
  type: string;
  createdAt: string;
  tenantId: string;
  data: unknown;
}

/**
 * Outbound webhooks: tenant endpoints and plugin subscriptions share one pipeline. Outbox events
 * become delivery rows (the log the admin shows), each delivered by a queue job with exponential
 * backoff. Receivers get a stable envelope, an idempotency key that survives retries, and an
 * HMAC signature; failing endpoints are disabled instead of retried forever.
 */
@Injectable()
export class WebhooksService implements OnApplicationBootstrap {
  private readonly crypto: FieldEncryption;
  private readonly allowPrivate: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly bus: EventBus,
    private readonly queues: Queues,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhooksService.name);
    this.crypto = new FieldEncryption(config.ENCRYPTION_KEY);
    this.allowPrivate = config.NODE_ENV !== 'production';
  }

  onApplicationBootstrap(): void {
    for (const type of Object.values(WEBHOOK_EVENTS)) this.bus.on(type, (e) => this.dispatch(e));
    if (process.env.WEBHOOKS === 'off') return;
    this.queues.worker<DeliveryJob>(QUEUE, (job) => this.deliver(job), 8);
  }

  encrypt(secret: string): string {
    return this.crypto.encrypt(secret);
  }

  decrypt(secret: string): string {
    return this.crypto.decrypt(secret);
  }

  // ── Tenant endpoints ────────────────────────────────────────────────────────

  async list(tenantId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).webhook.findMany({ where: { tenantId, pluginInstanceId: null }, orderBy: { createdAt: 'desc' } });
    return rows.map(present);
  }

  async create(actor: RequestPrincipal & { tenantId: string }, body: WebhookBody) {
    await assertDeliverableUrl(body.url, this.allowPrivate);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).webhook.create({ data: { tenantId: actor.tenantId, name: body.name, url: body.url, events: body.events, siteId: body.siteId ?? null, isActive: body.isActive, secret: this.encrypt(secret) } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'webhook.created', entityType: 'Webhook', entityId: row.id, changes: { url: body.url, events: body.events } }, actor);
    // The secret is shown once; afterwards only its use proves it.
    return { ...present(row), secret };
  }

  private async own(tenantId: string, id: string): Promise<Webhook> {
    const row = await this.prisma.forTenant({ tenantId }).webhook.findFirst({ where: { id, tenantId } });
    if (!row) throw notFound('Webhook');
    if (row.pluginInstanceId) throw forbidden('This webhook belongs to a plugin — manage it from the plugin');
    return row;
  }

  async update(actor: RequestPrincipal & { tenantId: string }, id: string, body: Partial<WebhookBody>) {
    await this.own(actor.tenantId, id);
    if (body.url) await assertDeliverableUrl(body.url, this.allowPrivate);
    const row = await this.prisma.forTenant({ tenantId: actor.tenantId }).webhook.update({
      where: { id },
      data: { ...body, ...(body.isActive ? { failureCount: 0, disabledReason: null } : {}) },
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'webhook.updated', entityType: 'Webhook', entityId: id, changes: body as Prisma.InputJsonValue }, actor);
    return present(row);
  }

  async rotateSecret(actor: RequestPrincipal & { tenantId: string }, id: string) {
    await this.own(actor.tenantId, id);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await this.prisma.forTenant({ tenantId: actor.tenantId }).webhook.update({ where: { id }, data: { secret: this.encrypt(secret) } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'webhook.secret_rotated', entityType: 'Webhook', entityId: id }, actor);
    return { secret };
  }

  async remove(actor: RequestPrincipal & { tenantId: string }, id: string): Promise<void> {
    await this.own(actor.tenantId, id);
    await this.prisma.forTenant({ tenantId: actor.tenantId }).webhook.delete({ where: { id } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'webhook.deleted', entityType: 'Webhook', entityId: id }, actor);
  }

  async deliveries(tenantId: string, webhookId: string) {
    const db = this.prisma.forTenant({ tenantId });
    if (!(await db.webhook.findFirst({ where: { id: webhookId, tenantId }, select: { id: true } }))) throw notFound('Webhook');
    return db.webhookDelivery.findMany({ where: { webhookId, tenantId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, event: true, status: true, attempts: true, responseStatus: true, durationMs: true, error: true, createdAt: true, nextRetryAt: true, idempotencyKey: true } });
  }

  /** Sends a `ping` now so the receiver (and its signature check) can be tested. */
  async test(actor: RequestPrincipal & { tenantId: string }, id: string) {
    const hook = await this.own(actor.tenantId, id);
    const evtId = `evt_test_${randomBytes(8).toString('hex')}`;
    return this.enqueue(hook, 'ping', { id: evtId, type: 'ping', createdAt: new Date().toISOString(), tenantId: actor.tenantId, data: { webhookId: id, message: 'Canon webhook test' } });
  }

  async redeliver(actor: RequestPrincipal & { tenantId: string }, deliveryId: string) {
    const d = await this.prisma.forTenant({ tenantId: actor.tenantId }).webhookDelivery.findFirst({ where: { id: deliveryId, tenantId: actor.tenantId }, include: { webhook: true } });
    if (!d) throw notFound('Delivery');
    // Same idempotency key: a receiver that already processed it can skip.
    const copy = await this.system.webhookDelivery.create({ data: { tenantId: d.tenantId, webhookId: d.webhookId, event: d.event, idempotencyKey: d.idempotencyKey, payload: d.payload as Prisma.InputJsonValue } });
    await this.queues.queue(QUEUE).add('deliver', { deliveryId: copy.id }, { jobId: `wd-${copy.id}`, attempts: ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } });
    return { id: copy.id };
  }

  // ── Pipeline ────────────────────────────────────────────────────────────────

  private async dispatch(e: StoredEvent): Promise<void> {
    const name = EVENT_BY_TYPE.get(e.type);
    if (!name) return;
    const siteId = (e.payload as { siteId?: string } | null)?.siteId ?? null;
    const hooks = await this.system.webhook.findMany({
      where: {
        tenantId: e.tenantId,
        isActive: true,
        OR: [{ events: { has: name } }, { events: { has: '*' } }],
        AND: [{ OR: [{ siteId: null }, ...(siteId ? [{ siteId }] : [])] }, { OR: [{ pluginInstanceId: null }, { pluginInstance: { isActive: true } }] }],
      },
    });
    const envelope: Envelope = { id: e.id, type: name, createdAt: e.occurredAt.toISOString(), tenantId: e.tenantId, data: e.payload };
    for (const h of hooks) await this.enqueue(h, name, envelope);
  }

  private async enqueue(hook: Webhook, event: string, envelope: Envelope) {
    const idempotencyKey = `${envelope.id}:${hook.id}`;
    // The outbox is at-least-once: the same event for the same hook is recorded once.
    const existing = event === 'ping' ? null : await this.system.webhookDelivery.findFirst({ where: { webhookId: hook.id, idempotencyKey }, select: { id: true } });
    if (existing) return { id: existing.id };
    const d = await this.system.webhookDelivery.create({ data: { tenantId: hook.tenantId, webhookId: hook.id, event, idempotencyKey, payload: envelope as unknown as Prisma.InputJsonValue } });
    await this.queues.queue(QUEUE).add('deliver', { deliveryId: d.id }, { jobId: `wd-${d.id}`, attempts: ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } });
    return { id: d.id };
  }

  /** Public for tests: one attempt for one delivery (throws to let the queue retry). */
  async deliver(job: Pick<Job<DeliveryJob>, 'data' | 'attemptsMade' | 'opts'>): Promise<void> {
    const d = await this.system.webhookDelivery.findUnique({ where: { id: job.data.deliveryId }, include: { webhook: { include: { pluginInstance: { include: { plugin: true } } } } } });
    if (!d || d.status === 'SUCCEEDED' || d.status === 'DEAD') return;
    const hook = d.webhook;
    if (!hook.isActive) {
      await this.system.webhookDelivery.update({ where: { id: d.id }, data: { status: 'DEAD', error: 'Endpoint disabled' } });
      return;
    }
    const envelope = d.payload as unknown as Envelope;
    const started = Date.now();
    let status: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;
    try {
      const target = hook.pluginInstance ? pluginTarget(hook.pluginInstance, envelope, (s) => this.decrypt(s)) : { url: hook.url, body: JSON.stringify(envelope), headers: {} };
      if (!target) {
        await this.system.webhookDelivery.update({ where: { id: d.id }, data: { status: 'SUCCEEDED', error: 'Skipped by plugin (not relevant)' } });
        return;
      }
      await assertDeliverableUrl(target.url, this.allowPrivate);
      const res = await fetch(target.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Canon-Webhooks/1.0',
          'canon-event': envelope.type,
          'canon-delivery': d.id,
          'idempotency-key': d.idempotencyKey,
          'canon-signature': signWebhook(target.body, this.decrypt(hook.secret)),
          ...target.headers,
        },
        body: target.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      responseBody = (await res.text().catch(() => '')).slice(0, 1_000);
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    const durationMs = Date.now() - started;
    const attempts = job.attemptsMade + 1;
    if (!error) {
      await this.system.$transaction([
        this.system.webhookDelivery.update({ where: { id: d.id }, data: { status: 'SUCCEEDED', attempts, responseStatus: status, responseBody, durationMs, error: null, nextRetryAt: null } }),
        this.system.webhook.update({ where: { id: hook.id }, data: { lastTriggeredAt: new Date(), failureCount: 0 } }),
      ]);
      return;
    }
    const final = attempts >= (job.opts.attempts ?? ATTEMPTS);
    await this.system.webhookDelivery.update({
      where: { id: d.id },
      data: { status: final ? 'DEAD' : 'FAILED', attempts, responseStatus: status, responseBody, durationMs, error, nextRetryAt: final ? null : new Date(Date.now() + 10_000 * 2 ** (attempts - 1)) },
    });
    if (final) {
      const updated = await this.system.webhook.update({ where: { id: hook.id }, data: { failureCount: { increment: 1 }, lastTriggeredAt: new Date() } });
      if (updated.failureCount >= DISABLE_AFTER) {
        await this.system.webhook.update({ where: { id: hook.id }, data: { isActive: false, disabledReason: `Disabled after ${updated.failureCount} failed deliveries (last: ${error})` } });
        this.logger.warn({ webhookId: hook.id, tenantId: hook.tenantId }, 'webhook.disabled');
      }
      return;
    }
    throw new Error(error);
  }
}

function present(w: Webhook) {
  return { id: w.id, name: w.name, url: w.url, events: w.events, siteId: w.siteId, isActive: w.isActive, failureCount: w.failureCount, disabledReason: w.disabledReason, lastTriggeredAt: w.lastTriggeredAt, createdAt: w.createdAt };
}
