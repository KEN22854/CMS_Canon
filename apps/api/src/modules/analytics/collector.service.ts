import { browserFromUserAgent, deviceFromUserAgent, isBot, osFromUserAgent, referrerDomain } from '@canon/edge';
import { Prisma } from '@canon/db';
import { createId } from '@paralleldrive/cuid2';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { notFound } from '../../common/http/api-error';
import { EventBus } from '../../infrastructure/events/outbox';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';

const BUFFER = 'analytics:buffer';
const FLUSH_MS = 2_000;
const FLUSH_BATCH = 2_000;
/** Generous for humans (a page view, a few clicks, engagement pings), hopeless for a flood. */
const MAX_EVENTS_PER_VISITOR_MIN = 300;
export const REALTIME_WINDOW_MS = 5 * 60_000;
/** Default conversion goals; a site overrides them in settings.analytics.goals. */
export const DEFAULT_GOALS = ['signup', 'purchase', 'contact', 'cta_click', 'download'];

const id = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);

export const collectBody = z.object({
  siteId: z.string().min(1).max(40),
  visitorId: id,
  sessionId: id,
  events: z
    .array(
      z.object({
        type: z.enum(['pageview', 'event', 'engagement']),
        path: z.string().max(500).startsWith('/'),
        title: z.string().max(300).optional(),
        name: z.string().regex(/^[a-z0-9_.:-]{1,60}$/i).optional(),
        props: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
        durationMs: z.number().int().min(0).max(6 * 3_600_000).optional(),
      }),
    )
    .min(1)
    .max(50),
  referrer: z.string().max(2048).optional(),
  utm: z.object({ source: z.string().max(100).optional(), medium: z.string().max(100).optional(), campaign: z.string().max(100).optional() }).optional(),
  /** Variants the proxy assigned for the current page (from the rewrite key). */
  experiments: z.array(z.object({ testId: z.string().max(40), variantId: z.string().max(64) })).max(10).optional(),
});
export type CollectBody = z.infer<typeof collectBody>;

export interface CollectMeta {
  userAgent: string | null;
  country: string | null;
  host: string | null;
}

interface SiteInfo {
  tenantId: string;
  hosts: string[];
  goals: string[];
  experiments: { id: string; path: string; goal: string; variants: string[] }[];
}

interface BufferedRow {
  analytics: Prisma.AnalyticsEventCreateManyInput;
  ab?: Prisma.AbTestEventCreateManyInput[];
}

/**
 * Event ingestion. Privacy by construction: the visitor id is a random first-party id the
 * renderer issued (no fingerprinting), IPs never reach this service, user agents are reduced
 * to device/browser/OS before storage, and bots are dropped. Writes go through a Redis buffer
 * and are flushed in batches, so a traffic spike costs one INSERT per batch, not per event.
 */
@Injectable()
export class CollectorService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly sites = new Map<string, { at: number; info: SiteInfo }>();

  constructor(
    private readonly system: SystemPrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
    private readonly bus: EventBus,
  ) {
    this.logger.setContext(CollectorService.name);
  }

  onModuleInit(): void {
    // The running set changed: attribute exposures/conversions to the new definitions at once.
    this.bus.on('ExperimentChanged', async (e) => this.invalidate((e.payload as { siteId: string }).siteId));
    if (process.env.ANALYTICS_FLUSH === 'off') return;
    this.timer = setInterval(() => void this.flush().catch((err: unknown) => this.logger.warn({ err }, 'analytics.flush_failed')), FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }

  /** Returns how many events were accepted (bots and rate-limited batches count as accepted-and-dropped: 0). */
  async collect(body: CollectBody, meta: CollectMeta): Promise<{ accepted: number }> {
    if (isBot(meta.userAgent)) return { accepted: 0 };
    const site = await this.site(body.siteId);
    // The renderer forwards the page's host: events for a site must come from that site.
    if (meta.host && !site.hosts.includes(meta.host.toLowerCase().replace(/:\d+$/, ''))) return { accepted: 0 };
    const minute = Math.floor(Date.now() / 60_000);
    const rateKey = `col:rl:${body.siteId}:${body.visitorId}:${minute}`;
    const n = await this.redis.incrby(rateKey, body.events.length);
    if (n === body.events.length) await this.redis.expire(rateKey, 70);
    if (n > MAX_EVENTS_PER_VISITOR_MIN) return { accepted: 0 };

    const now = new Date();
    const device = deviceFromUserAgent(meta.userAgent);
    const browser = browserFromUserAgent(meta.userAgent);
    const os = osFromUserAgent(meta.userAgent);
    const refDomain = referrerDomain(body.referrer, meta.host ?? undefined);
    const exps = (body.experiments ?? []).flatMap((e) => {
      const def = site.experiments.find((x) => x.id === e.testId && x.variants.includes(e.variantId));
      return def ? [{ ...e, def }] : [];
    });

    const rows: string[] = [];
    for (const [i, ev] of body.events.entries()) {
      // Events of one batch arrive together; +1 ms each keeps their order (entrance page, bounces).
      const at = new Date(now.getTime() + i);
      const event = ev.type === 'event' ? (ev.name ?? 'event') : ev.type;
      const conversion = ev.type === 'event' && site.goals.includes(event);
      const row: BufferedRow = {
        analytics: {
          id: createId(),
          tenantId: site.tenantId,
          siteId: body.siteId,
          event,
          visitorId: body.visitorId,
          sessionId: body.sessionId,
          referrer: ev.type === 'pageview' ? (body.referrer?.slice(0, 500) ?? null) : null,
          userAgent: null,
          country: meta.country,
          device,
          browser,
          os,
          metadata: {
            path: ev.path,
            ...(ev.title ? { title: ev.title } : {}),
            ...(refDomain ? { referrerDomain: refDomain } : {}),
            ...(body.utm?.source ? { utmSource: body.utm.source.toLowerCase() } : {}),
            ...(body.utm?.medium ? { utmMedium: body.utm.medium.toLowerCase() } : {}),
            ...(body.utm?.campaign ? { utmCampaign: body.utm.campaign.toLowerCase() } : {}),
            ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
            ...(ev.props ? { props: ev.props } : {}),
            ...(conversion ? { conversion: true } : {}),
          },
          createdAt: at,
        },
      };
      // Experiments: a page view of the test page is an exposure; the goal event is a conversion.
      const ab = exps.flatMap((e) => {
        const kind = ev.type === 'pageview' && ev.path === e.def.path ? 'exposure' : ev.type === 'event' && event === e.def.goal ? 'conversion' : null;
        return kind ? [{ id: createId(), tenantId: site.tenantId, testId: e.testId, variantId: e.variantId, visitorId: body.visitorId, event: kind, createdAt: at }] : [];
      });
      if (ab.length) row.ab = ab;
      rows.push(JSON.stringify(row));
    }
    const pipe = this.redis.multi().rpush(BUFFER, ...rows);
    const pageviews = body.events.filter((e) => e.type === 'pageview');
    const ts = Date.now();
    if (pageviews.length || body.events.length) {
      pipe.zadd(`rt:${body.siteId}`, ts, body.visitorId).expire(`rt:${body.siteId}`, 3_600);
      for (const pv of pageviews) pipe.zadd(`rtp:${body.siteId}`, ts, `${pv.path}\u0000${body.visitorId}`).expire(`rtp:${body.siteId}`, 3_600);
    }
    await pipe.exec();
    return { accepted: body.events.length };
  }

  /** Drains the buffer into Postgres. Public for tests; the timer calls it every FLUSH_MS. */
  async flush(): Promise<number> {
    let total = 0;
    for (;;) {
      const raw = (await this.redis.lpop(BUFFER, FLUSH_BATCH)) ?? [];
      if (!raw.length) return total;
      const rows = raw.map((r) => JSON.parse(r) as BufferedRow);
      const analytics = rows.map((r) => ({ ...r.analytics, createdAt: new Date(r.analytics.createdAt as string) }));
      const ab = rows.flatMap((r) => r.ab ?? []).map((a) => ({ ...a, createdAt: new Date(a.createdAt as string) }));
      try {
        await this.system.analyticsEvent.createMany({ data: analytics });
        if (ab.length) await this.system.abTestEvent.createMany({ data: ab });
      } catch (err) {
        // Put the batch back so a DB blip doesn't lose events; the next tick retries.
        await this.redis.lpush(BUFFER, ...raw.reverse());
        throw err;
      }
      total += rows.length;
      if (raw.length < FLUSH_BATCH) return total;
    }
  }

  invalidate(siteId: string): void {
    this.sites.delete(siteId);
  }

  private async site(siteId: string): Promise<SiteInfo> {
    const hit = this.sites.get(siteId);
    if (hit && Date.now() - hit.at < 30_000) return hit.info;
    const s = await this.system.site.findFirst({ where: { id: siteId, deletedAt: null }, select: { tenantId: true, domain: true, internalDomain: true, settings: true, defaultLocale: true } });
    if (!s) throw notFound('Site');
    const tests = await this.system.abTest.findMany({ where: { tenantId: s.tenantId, status: 'RUNNING', page: { siteId, deletedAt: null } }, select: { id: true, goalMetric: true, variants: true, page: { select: { fullPath: true, locale: true } } } });
    const goals = (s.settings as { analytics?: { goals?: unknown } })?.analytics?.goals;
    const info: SiteInfo = {
      tenantId: s.tenantId,
      hosts: [s.domain, s.internalDomain].filter((h): h is string => Boolean(h)).map((h) => h.toLowerCase()),
      goals: Array.isArray(goals) && goals.every((g) => typeof g === 'string') ? (goals as string[]) : DEFAULT_GOALS,
      experiments: tests.map((t) => ({
        id: t.id,
        // Visitors see locale-prefixed URLs for non-default locales.
        path: t.page.locale === s.defaultLocale ? t.page.fullPath : `/${t.page.locale}${t.page.fullPath === '/' ? '' : t.page.fullPath}`,
        goal: t.goalMetric,
        variants: (t.variants as { id: string }[]).map((v) => v.id),
      })),
    };
    this.sites.set(siteId, { at: Date.now(), info });
    return info;
  }
}
