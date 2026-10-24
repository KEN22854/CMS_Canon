import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';

export const ROLLUP_QUEUE = 'analytics-rollup';
const EVERY_MS = 15 * 60_000;
export const DIMENSIONS = ['referrer', 'country', 'device', 'browser', 'os', 'utm_source'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface PageRow {
  tenantId: string;
  siteId: string;
  path: string;
  views: number;
  visitors: number;
  sessions: number;
  entrances: number;
  bounces: number;
  engagedMs: number;
  conversions: number;
}

export interface DimRow {
  tenantId: string;
  siteId: string;
  dim: Dimension;
  value: string;
  views: number;
  visitors: number;
  conversions: number;
}

/** "YYYY-MM-DD" in UTC — analytics days are UTC days. */
export const dayString = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily rollups. One SQL computes a day's aggregates from the raw partitioned events; it backs
 * both the persisted rollup (idempotent delete + insert, every 15 minutes for today and
 * yesterday) and the live "today" slice of reports. Raw events can then age out with their
 * monthly partitions while history stays in the small rollup tables.
 */
@Injectable()
export class RollupService implements OnApplicationBootstrap {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RollupService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.ANALYTICS_JOBS === 'off') return;
    this.queues.worker(ROLLUP_QUEUE, () => this.rollupRecent(), 1);
    // One scheduler per queue (upsert): N API instances don't create N schedules.
    await this.queues.queue(ROLLUP_QUEUE).upsertJobScheduler('analytics-rollup', { every: EVERY_MS }, { name: 'rollup', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  async rollupRecent(): Promise<void> {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    for (const d of [yesterday, today]) {
      const sites = await this.system.$queryRaw<{ siteId: string }[]>`SELECT DISTINCT "siteId" FROM analytics_events WHERE "createdAt" >= ${dayString(d)}::date AND "createdAt" < ${dayString(d)}::date + 1`;
      for (const s of sites) await this.rollupDay(s.siteId, dayString(d));
    }
  }

  /** Recomputes and replaces one site-day. Safe to run any number of times. */
  async rollupDay(siteId: string, day: string): Promise<{ pages: number; dims: number }> {
    const { pages, dims } = await this.computeDay(siteId, day);
    await this.system.$transaction(async (tx) => {
      await tx.analyticsDailyPage.deleteMany({ where: { siteId, day: new Date(`${day}T00:00:00Z`) } });
      await tx.analyticsDailyDim.deleteMany({ where: { siteId, day: new Date(`${day}T00:00:00Z`) } });
      if (pages.length) await tx.analyticsDailyPage.createMany({ data: pages.map((p) => ({ ...p, day: new Date(`${day}T00:00:00Z`), engagedMs: BigInt(p.engagedMs) })) });
      if (dims.length) await tx.analyticsDailyDim.createMany({ data: dims.map((d) => ({ ...d, day: new Date(`${day}T00:00:00Z`) })) });
    });
    return { pages: pages.length, dims: dims.length };
  }

  async computeDay(siteId: string, day: string): Promise<{ pages: PageRow[]; dims: DimRow[] }> {
    const pages = await this.system.$queryRaw<PageRow[]>`
      WITH ev AS (
        SELECT * FROM analytics_events
        WHERE "siteId" = ${siteId} AND "createdAt" >= ${day}::date AND "createdAt" < ${day}::date + 1
      ),
      pv AS (
        SELECT "tenantId", "siteId", "sessionId", "visitorId", metadata->>'path' AS path,
               row_number() OVER (PARTITION BY "sessionId" ORDER BY "createdAt", id) AS rn,
               count(*) OVER (PARTITION BY "sessionId") AS n
        FROM ev WHERE event = 'pageview'
      ),
      agg AS (
        SELECT "tenantId", "siteId", path,
               count(*)::int AS views,
               count(DISTINCT "visitorId")::int AS visitors,
               count(DISTINCT "sessionId")::int AS sessions,
               (count(*) FILTER (WHERE rn = 1))::int AS entrances,
               (count(*) FILTER (WHERE rn = 1 AND n = 1))::int AS bounces
        FROM pv GROUP BY 1, 2, 3
      ),
      other AS (
        SELECT metadata->>'path' AS path,
               coalesce(sum((metadata->>'durationMs')::bigint) FILTER (WHERE event = 'engagement'), 0)::bigint AS "engagedMs",
               (count(*) FILTER (WHERE metadata->>'conversion' = 'true'))::int AS conversions
        FROM ev WHERE event <> 'pageview' GROUP BY 1
      )
      SELECT a."tenantId", a."siteId", a.path, a.views, a.visitors, a.sessions, a.entrances, a.bounces,
             coalesce(o."engagedMs", 0)::float8 AS "engagedMs", coalesce(o.conversions, 0)::int AS conversions
      FROM agg a LEFT JOIN other o ON o.path = a.path`;

    const dims = await this.system.$queryRaw<DimRow[]>`
      WITH ev AS (
        SELECT "tenantId", "siteId", event, "visitorId", country, device, browser, os, metadata
        FROM analytics_events
        WHERE "siteId" = ${siteId} AND "createdAt" >= ${day}::date AND "createdAt" < ${day}::date + 1
      ),
      labelled AS (
        SELECT "tenantId", "siteId", event, "visitorId", metadata, 'referrer' AS dim, coalesce(metadata->>'referrerDomain', '(direct)') AS value FROM ev
        UNION ALL SELECT "tenantId", "siteId", event, "visitorId", metadata, 'country', coalesce(country, '(unknown)') FROM ev
        UNION ALL SELECT "tenantId", "siteId", event, "visitorId", metadata, 'device', coalesce(device, '(unknown)') FROM ev
        UNION ALL SELECT "tenantId", "siteId", event, "visitorId", metadata, 'browser', coalesce(browser, '(unknown)') FROM ev
        UNION ALL SELECT "tenantId", "siteId", event, "visitorId", metadata, 'os', coalesce(os, '(unknown)') FROM ev
        UNION ALL SELECT "tenantId", "siteId", event, "visitorId", metadata, 'utm_source', coalesce(metadata->>'utmSource', '(none)') FROM ev
      )
      SELECT "tenantId", "siteId", dim, value,
             (count(*) FILTER (WHERE event = 'pageview'))::int AS views,
             (count(DISTINCT "visitorId") FILTER (WHERE event = 'pageview'))::int AS visitors,
             (count(*) FILTER (WHERE metadata->>'conversion' = 'true'))::int AS conversions
      FROM labelled GROUP BY 1, 2, 3, 4
      HAVING count(*) FILTER (WHERE event = 'pageview') > 0 OR count(*) FILTER (WHERE metadata->>'conversion' = 'true') > 0`;
    return { pages: pages.map((p) => ({ ...p, engagedMs: Number(p.engagedMs) })), dims };
  }
}
