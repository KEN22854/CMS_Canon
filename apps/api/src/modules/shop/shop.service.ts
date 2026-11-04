import { formatMoney, toMinor } from '@canon/blocks';
import { collectionSettingsSchema, type CollectionCommerce } from '@canon/fields';
import { Prisma, type Order } from '@canon/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { Mailer } from '../../infrastructure/mail/mailer';
import { newOrderMail, orderPlacedMail } from '../../infrastructure/mail/templates';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { truncateIp } from '../forms/forms.service';
import { SitesService } from '../sites/sites.service';
import { ORDER_TRANSITIONS, type CheckoutBody, type ListOrdersQuery, type OrderItem, type OrderStatusName, type UpdateOrderBody } from './shop.dto';

const RATE_PER_IP = 10;
const RATE_WINDOW_SEC = 600;
/**
 * Faster than anyone can fill a checkout form, even with autofill: a bot. Kept low on purpose —
 * the honeypot field is the main signal, a slow threshold would turn away real buyers.
 */
const MIN_FILL_MS = 300;


type Tx = Prisma.TransactionClient;

interface Line {
  entryId: string;
  quantity: number;
}

/**
 * Orders (Stage 7). The checkout runs on the system role (a visitor has no tenant), pinned to the
 * site resolved from the request host. The browser sends product ids and quantities; prices come
 * from the products' published snapshots, stock is decremented with a conditional UPDATE inside the
 * order's transaction, so two buyers can't take the last item twice. Payment is offline (cash or
 * card on delivery, bank transfer): no card data ever reaches Canon.
 */
@Injectable()
export class ShopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ShopService.name);
  }

  // ── checkout (visitors, via the renderer) ──────────────────────────────────

  async checkout(siteId: string, body: CheckoutBody, meta: { ip: string | null; host: string | null }) {
    const site = await this.system.site.findFirst({ where: { id: siteId, deletedAt: null } });
    if (!site) throw notFound('Site');
    // Orders are accepted only from the shop's own hosts.
    const hosts = [site.internalDomain, site.domainStatus === 'VERIFIED' ? site.domain : null].filter(Boolean);
    if (meta.host && !hosts.includes(meta.host.toLowerCase())) throw notFound('Site');
    if (meta.ip) {
      const key = `shop-rate:${siteId}:${meta.ip}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, RATE_WINDOW_SEC);
      if (n > RATE_PER_IP) throw new ApiError('RATE_LIMITED', 'Too many orders from here — try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (body.honeypot || (body.elapsedMs !== undefined && body.elapsedMs < MIN_FILL_MS)) throw new ApiError('REJECTED', 'The order could not be placed', HttpStatus.UNPROCESSABLE_ENTITY);

    // Same product twice → one line.
    const lines = [...body.items.reduce((m, i) => m.set(i.productId, Math.min(99, (m.get(i.productId) ?? 0) + i.quantity)), new Map<string, number>())].map(([entryId, quantity]): Line => ({ entryId, quantity }));
    const entries = await this.system.entry.findMany({
      where: { id: { in: lines.map((l) => l.entryId) }, deletedAt: null, publishedVersion: { not: null }, collection: { siteId, deletedAt: null } },
      select: { id: true, collectionId: true, publishedVersion: true, collection: { select: { settings: true } } },
    });
    const missing = lines.filter((l) => !entries.some((e) => e.id === l.entryId)).map((l) => l.entryId);
    if (missing.length) throw new ApiError('PRODUCT_UNAVAILABLE', 'Some products are no longer available', HttpStatus.CONFLICT, { productIds: missing });
    const collectionIds = new Set(entries.map((e) => e.collectionId));
    if (collectionIds.size > 1) throw badRequest('MIXED_SHOPS', 'Products of one order must come from one shop');
    const collectionId = entries[0]!.collectionId;
    const commerce = commerceOf(entries[0]!.collection.settings);
    if (!commerce) throw new ApiError('SHOP_DISABLED', 'This collection is not a shop', HttpStatus.CONFLICT);
    if (!commerce.paymentMethods.includes(body.paymentMethod)) throw badRequest('PAYMENT_METHOD', 'This payment method is not offered');

    const versions = await this.system.entryVersion.findMany({ where: { OR: entries.map((e) => ({ entryId: e.id, version: e.publishedVersion! })) }, select: { entryId: true, version: true, slug: true, title: true, data: true } });
    const items: OrderItem[] = lines.map((l) => {
      const v = versions.find((x) => x.entryId === l.entryId)!;
      const data = v.data as Record<string, unknown>;
      const price = data[commerce.priceField];
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) throw new ApiError('PRODUCT_UNAVAILABLE', `“${v.title}” has no price`, HttpStatus.CONFLICT, { productIds: [l.entryId] });
      const unitPrice = toMinor(price);
      const sku = commerce.skuField && typeof data[commerce.skuField] === 'string' ? (data[commerce.skuField] as string) : null;
      return { entryId: l.entryId, slug: v.slug, title: v.title, sku, unitPrice, quantity: l.quantity, lineTotal: unitPrice * l.quantity };
    });
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    if (subtotal > 2_000_000_000) throw badRequest('ORDER_TOO_LARGE', 'The order is too large');
    const publishedVersion = new Map(entries.map((e) => [e.id, e.publishedVersion!]));

    const order = await this.system.$transaction(async (tx) => {
      if (commerce.stockField) for (const i of items) await this.takeStock(tx, commerce.stockField, i, publishedVersion.get(i.entryId)!);
      // One order number at a time per site; the lock ends with the transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`orders:${siteId}`}))`;
      const last = await tx.order.aggregate({ where: { siteId }, _max: { number: true } });
      const o = await tx.order.create({
        data: {
          tenantId: site.tenantId,
          siteId,
          collectionId,
          number: (last._max.number ?? 1000) + 1,
          currency: commerce.currency,
          subtotal,
          total: subtotal,
          items: items as unknown as Prisma.InputJsonValue,
          customer: body.customer as Prisma.InputJsonValue,
          paymentMethod: body.paymentMethod,
          history: [{ at: new Date().toISOString(), status: 'NEW', by: 'customer' }],
          locale: body.locale ?? site.defaultLocale,
          ipAddress: truncateIp(meta.ip),
        },
      });
      // Stock changed: the outbox bumps the delivery cache (product pages show it).
      await this.outbox.enqueue(tx, { tenantId: site.tenantId, aggregateType: 'Order', aggregateId: o.id, type: 'OrderPlaced', payload: { siteId, orderId: o.id, number: o.number, total: o.total, currency: o.currency } });
      return o;
    });

    await this.notify(order, site.name, commerce);
    return { number: order.number, status: order.status, currency: order.currency, total: order.total, items: items.map((i) => ({ title: i.title, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal })) };
  }

  /**
   * Decrements tracked stock in the entry and in its published snapshot (what delivery shows), only
   * where enough is left. A product without a stock value is unlimited.
   */
  private async takeStock(tx: Tx, field: string, item: OrderItem, version: number): Promise<void> {
    const tracked = await tx.$queryRaw<{ n: number | null }[]>`SELECT CASE WHEN jsonb_typeof(data->${field}::text) = 'number' THEN (data->>${field}::text)::numeric ELSE NULL END AS n FROM entry_versions WHERE "entryId" = ${item.entryId} AND version = ${version}`;
    if (tracked[0]?.n === null || tracked[0]?.n === undefined) return;
    const updated = await tx.$executeRaw`UPDATE entry_versions SET data = jsonb_set(data, ARRAY[${field}::text], to_jsonb((data->>${field}::text)::numeric - ${item.quantity})) WHERE "entryId" = ${item.entryId} AND version = ${version} AND (data->>${field}::text)::numeric >= ${item.quantity}`;
    if (updated === 0) throw new ApiError('OUT_OF_STOCK', `Only ${Number(tracked[0].n)} of “${item.title}” left`, HttpStatus.CONFLICT, { productId: item.entryId, available: Number(tracked[0].n) });
    // The working copy follows, so the next publish doesn't bring the old count back.
    await tx.$executeRaw`UPDATE entries SET data = jsonb_set(data, ARRAY[${field}::text], to_jsonb(GREATEST(0, (data->>${field}::text)::numeric - ${item.quantity}))) WHERE id = ${item.entryId} AND jsonb_typeof(data->${field}::text) = 'number'`;
  }

  private async returnStock(tx: Tx, order: Order): Promise<void> {
    const c = await tx.collection.findFirst({ where: { id: order.collectionId }, select: { settings: true } });
    const field = commerceOf(c?.settings)?.stockField;
    if (!field) return;
    for (const i of order.items as unknown as OrderItem[]) {
      await tx.$executeRaw`UPDATE entry_versions v SET data = jsonb_set(v.data, ARRAY[${field}::text], to_jsonb((v.data->>${field}::text)::numeric + ${i.quantity})) FROM entries e WHERE e.id = ${i.entryId} AND v."entryId" = e.id AND v.version = e."publishedVersion" AND jsonb_typeof(v.data->${field}::text) = 'number'`;
      await tx.$executeRaw`UPDATE entries SET data = jsonb_set(data, ARRAY[${field}::text], to_jsonb((data->>${field}::text)::numeric + ${i.quantity})) WHERE id = ${i.entryId} AND jsonb_typeof(data->${field}::text) = 'number'`;
    }
  }

  /** Confirmation to the customer, a heads-up to the shop. Mail trouble never fails the order. */
  private async notify(order: Order, shop: string, commerce: CollectionCommerce): Promise<void> {
    const items = order.items as unknown as OrderItem[];
    const lines = items.map((i) => ({ title: i.title, quantity: i.quantity, line: formatMoney(i.lineTotal, order.currency, order.locale) }));
    const total = formatMoney(order.total, order.currency, order.locale);
    const customer = order.customer as { name: string; email: string };
    const link = `${this.config.ADMIN_PUBLIC_URL}/sites/${order.siteId}/orders?order=${order.id}`;
    const sends = [this.mailer.send(orderPlacedMail(customer.email, shop, order.number, lines, total, order.paymentMethod, order.locale))];
    if (commerce.orderEmail) sends.push(this.mailer.send(newOrderMail(commerce.orderEmail, shop, order.number, customer.name, lines, total, link)));
    for (const r of await Promise.allSettled(sends)) if (r.status === 'rejected') this.logger.warn({ err: r.reason, orderId: order.id }, 'order mail failed');
  }

  // ── orders (the admin) ─────────────────────────────────────────────────────

  async list(tenantId: string, siteId: string, q: ListOrdersQuery) {
    await this.sites.get(tenantId, siteId);
    const db = this.prisma.forTenant({ tenantId });
    const n = q.q && /^#?\d+$/.test(q.q) ? Number(q.q.replace('#', '')) : null;
    const where: Prisma.OrderWhereInput = {
      tenantId,
      siteId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q && n === null ? { OR: [{ customer: { path: ['email'], string_contains: q.q.toLowerCase() } }, { customer: { path: ['name'], string_contains: q.q } }] } : {}),
      ...(n !== null ? { number: n } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      db.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.offset, take: q.limit }),
      db.order.count({ where }),
      db.order.groupBy({ by: ['status'], where: { tenantId, siteId }, _count: true }),
    ]);
    return { items: rows.map(present), total, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  async get(tenantId: string, siteId: string, id: string) {
    const o = await this.prisma.forTenant({ tenantId }).order.findFirst({ where: { id, siteId, tenantId } });
    if (!o) throw notFound('Order');
    return present(o);
  }

  async update(actor: TenantPrincipal, siteId: string, id: string, body: UpdateOrderBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const o = await db.order.findFirst({ where: { id, siteId, tenantId: actor.tenantId } });
    if (!o) throw notFound('Order');
    const from = o.status as OrderStatusName;
    if (!ORDER_TRANSITIONS[from].includes(body.status)) throw conflict(`An order can't go from ${from} to ${body.status}`, { allowed: ORDER_TRANSITIONS[from] });
    const history = [...((o.history as unknown[]) ?? []), { at: new Date().toISOString(), status: body.status, by: actor.userId ?? 'api', ...(body.note ? { note: body.note } : {}) }];
    const updated = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      // Compare-and-swap on the status: two people clicking at once can't both cancel.
      const res = await tx.order.updateMany({ where: { id, status: o.status }, data: { status: body.status, history: history as Prisma.InputJsonValue } });
      if (res.count === 0) throw conflict('The order was changed by someone else — reload it');
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Order', aggregateId: id, type: 'OrderStatusChanged', payload: { siteId, orderId: id, number: o.number, from, status: body.status } });
      if (body.status === 'CANCELLED') {
        await this.returnStock(tx, o);
        await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Order', aggregateId: id, type: 'OrderCancelled', payload: { siteId, orderId: id } });
      }
      return tx.order.findUniqueOrThrow({ where: { id } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'order.status', entityType: 'Order', entityId: id, changes: { from, to: body.status } }, actor);
    return present(updated);
  }
}

function commerceOf(settings: unknown): CollectionCommerce | null {
  const s = collectionSettingsSchema.safeParse(settings ?? {});
  return s.success ? (s.data.commerce ?? null) : null;
}

function present(o: Order) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    currency: o.currency,
    subtotal: o.subtotal,
    total: o.total,
    items: o.items as unknown as OrderItem[],
    customer: o.customer as { name: string; email: string; phone?: string; address?: string; note?: string },
    paymentMethod: o.paymentMethod,
    history: o.history as { at: string; status: string; by: string; note?: string }[],
    allowed: ORDER_TRANSITIONS[o.status as OrderStatusName],
    locale: o.locale,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
