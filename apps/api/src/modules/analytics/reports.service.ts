import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { badRequest } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { SitesService } from '../sites/sites.service';
import { REALTIME_WINDOW_MS } from './collector.service';
import { DIMENSIONS, RollupService, dayString, type DimRow, type Dimension, type PageRow } from './rollup.service';

const MAX_DAYS = 366;

export interface Totals {
  views: number;
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgEngagedSec: number;
  conversions: number;
  conversionRate: number;
}

export interface Report {
  from: string;
  to: string;
  totals: Totals;
  previous: Totals;
  change: Record<keyof Totals, number | null>;
  series: { day: string; views: number; visitors: number; conversions: number }[];
  pages: { path: string; title: string | null; views: number; visitors: number; bounceRate: number; avgEngagedSec: number; conversions: number }[];
  dims: Record<Dimension, { value: string; views: number; visitors: number; conversions: number }[]>;
}

function totals(pages: Omit<PageRow, 'tenantId' | 'siteId'>[]): Totals {
  const sum = (k: keyof Omit<PageRow, 'tenantId' | 'siteId' | 'path'>) => pages.reduce((n, p) => n + Number(p[k]), 0);
  const views = sum('views');
  const sessions = sum('sessions');
  const entrances = sum('entrances');
  const conversions = sum('conversions');
  // "Visitors" over a range = sum of daily uniques: exact distinct counts across months would
  // need the raw events, which age out by design.
  const visitors = sum('visitors');
  return {
    views,
    visitors,
    sessions,
    bounceRate: entrances ? round(sum('bounces') / entrances) : 0,
    avgEngagedSec: views ? round(sum('engagedMs') / views / 1000) : 0,
    conversions,
    conversionRate: visitors ? round(conversions / visitors, 4) : 0,
  };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: RollupService,
    private readonly sites: SitesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Rollups for past days + a live computation for today (UTC), plus the previous period for deltas. */
  async report(tenantId: string, siteId: string, from: string, to: string): Promise<Report> {
    await this.sites.get(tenantId, siteId);
    const days = dayRange(from, to);
    if (days.length > MAX_DAYS) throw badRequest('RANGE_TOO_LARGE', `At most ${MAX_DAYS} days`);
    const prevDays = dayRange(dayString(new Date(Date.parse(`${from}T00:00:00Z`) - days.length * 86_400_000)), dayString(new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000)));
    const [cur, prev] = await Promise.all([this.load(tenantId, siteId, days), this.load(tenantId, siteId, prevDays)]);

    const byPath = new Map<string, Omit<PageRow, 'tenantId' | 'siteId'>>();
    for (const p of cur.pages) {
      const a = byPath.get(p.path) ?? { path: p.path, views: 0, visitors: 0, sessions: 0, entrances: 0, bounces: 0, engagedMs: 0, conversions: 0 };
      for (const k of ['views', 'visitors', 'sessions', 'entrances', 'bounces', 'engagedMs', 'conversions'] as const) a[k] += Number(p[k]);
      byPath.set(p.path, a);
    }
    const titles = await this.titles(tenantId, siteId, [...byPath.keys()]);
    const t = totals(cur.pages);
    const pt = totals(prev.pages);
    const change = Object.fromEntries((Object.keys(t) as (keyof Totals)[]).map((k) => [k, pt[k] ? round((t[k] - pt[k]) / pt[k], 4) : null])) as Record<keyof Totals, number | null>;

    const dims = Object.fromEntries(
      DIMENSIONS.map((d) => {
        const m = new Map<string, { value: string; views: number; visitors: number; conversions: number }>();
        for (const r of cur.dims.filter((x) => x.dim === d)) {
          const a = m.get(r.value) ?? { value: r.value, views: 0, visitors: 0, conversions: 0 };
          a.views += r.views;
          a.visitors += r.visitors;
          a.conversions += r.conversions;
          m.set(r.value, a);
        }
        return [d, [...m.values()].sort((a, b) => b.views - a.views).slice(0, 10)];
      }),
    ) as Report['dims'];

    return {
      from,
      to,
      totals: t,
      previous: pt,
      change,
      series: days.map((day) => {
        const rows = cur.byDay.get(day) ?? [];
        return { day, views: rows.reduce((n, r) => n + r.views, 0), visitors: rows.reduce((n, r) => n + r.visitors, 0), conversions: rows.reduce((n, r) => n + r.conversions, 0) };
      }),
      pages: [...byPath.values()]
        .sort((a, b) => b.views - a.views)
        .slice(0, 50)
        .map((p) => ({ path: p.path, title: titles.get(p.path) ?? null, views: p.views, visitors: p.visitors, bounceRate: p.entrances ? round(p.bounces / p.entrances) : 0, avgEngagedSec: p.views ? round(p.engagedMs / p.views / 1000) : 0, conversions: p.conversions })),
      dims,
    };
  }

  /** Active visitors in the last 5 minutes and what they are looking at (Redis only — no DB hit). */
  async realtime(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const since = Date.now() - REALTIME_WINDOW_MS;
    await this.redis.multi().zremrangebyscore(`rt:${siteId}`, '0', String(since)).zremrangebyscore(`rtp:${siteId}`, '0', String(since)).exec();
    const [visitors, members] = await Promise.all([this.redis.zcard(`rt:${siteId}`), this.redis.zrange(`rtp:${siteId}`, '0', '-1')]);
    const byPath = new Map<string, Set<string>>();
    for (const m of members) {
      const [path, visitor] = m.split('\u0000');
      if (!path || !visitor) continue;
      byPath.set(path, (byPath.get(path) ?? new Set()).add(visitor));
    }
    return { visitors, pages: [...byPath.entries()].map(([path, v]) => ({ path, visitors: v.size })).sort((a, b) => b.visitors - a.visitors).slice(0, 10) };
  }

  private async load(tenantId: string, siteId: string, days: string[]) {
    const today = dayString(new Date());
    const past = days.filter((d) => d < today);
    const db = this.prisma.forTenant({ tenantId });
    const range = past.length ? { gte: new Date(`${past[0]}T00:00:00Z`), lte: new Date(`${past.at(-1)}T00:00:00Z`) } : undefined;
    const [pages, dims] = range
      ? await Promise.all([db.analyticsDailyPage.findMany({ where: { siteId, day: range } }), db.analyticsDailyDim.findMany({ where: { siteId, day: range } })])
      : [[], []];
    const byDay = new Map<string, { views: number; visitors: number; conversions: number }[]>();
    const outPages: (PageRow & { day: string })[] = pages.map((p) => ({ ...p, day: dayString(p.day), pageId: undefined, engagedMs: Number(p.engagedMs) }) as PageRow & { day: string });
    const outDims: DimRow[] = dims.map((d) => ({ ...d, dim: d.dim as Dimension }));
    if (days.includes(today)) {
      const live = await this.rollup.computeDay(siteId, today);
      outPages.push(...live.pages.map((p) => ({ ...p, day: today })));
      outDims.push(...live.dims);
    }
    for (const p of outPages) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p]);
    return { pages: outPages, dims: outDims, byDay };
  }

  /** Paths are what visitors saw ("/de/preise"); titles come from the page tree, locale prefix included. */
  private async titles(tenantId: string, siteId: string, paths: string[]): Promise<Map<string, string>> {
    if (!paths.length) return new Map();
    const site = await this.sites.get(tenantId, siteId);
    const pages = await this.prisma.forTenant({ tenantId }).page.findMany({ where: { siteId, deletedAt: null }, select: { fullPath: true, locale: true, title: true } });
    const map = new Map<string, string>();
    for (const p of pages) map.set(p.locale === site.defaultLocale ? p.fullPath : `/${p.locale}${p.fullPath === '/' ? '' : p.fullPath}`, p.title);
    return new Map(paths.filter((p) => map.has(p)).map((p) => [p, map.get(p)!]));
  }
}

export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length <= MAX_DAYS + 1; t += 86_400_000) out.push(dayString(new Date(t)));
  return out;
}
