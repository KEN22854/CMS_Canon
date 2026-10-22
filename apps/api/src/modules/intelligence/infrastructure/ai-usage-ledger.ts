import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { startOfMonthUtc } from '../../tenancy/tenants.service';

interface Bucket {
  key: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

/**
 * Read model over ai_generations — the billing source of truth (Redis counters are a cache of it).
 * Aggregations are single GROUP BY queries on the (tenantId, createdAt) index; for very large
 * tenants a daily materialized rollup replaces them (Phase 6 analytics pipeline).
 */
@Injectable()
export class AiUsageLedger {
  constructor(private readonly prisma: PrismaService) {}

  async monthToDate(tenantId: string): Promise<{ costMicroUsd: number; tokens: number }> {
    const agg = await this.prisma.forTenant({ tenantId }).aiGeneration.aggregate({
      where: { tenantId, createdAt: { gte: startOfMonthUtc() } },
      _sum: { costUsd: true, totalTokens: true },
    });
    return {
      costMicroUsd: Math.round((agg._sum.costUsd?.toNumber() ?? 0) * 1_000_000),
      tokens: agg._sum.totalTokens ?? 0,
    };
  }

  async report(tenantId: string, from: Date, to: Date) {
    const rows = await this.prisma.rawForTenant({ tenantId }, (tx) => tx.$queryRaw<
      { day: Date; feature: string; model: string; status: string; requests: bigint; tokens: bigint | null; cost: string | null; cache_hits: bigint }[]
    >`
      SELECT date_trunc('day', "createdAt") AS day, feature::text AS feature, "modelKey" AS model, status::text AS status,
             count(*) AS requests, sum("totalTokens") AS tokens, sum("costUsd")::text AS cost,
             count(*) FILTER (WHERE "cacheHit") AS cache_hits
      FROM ai_generations
      WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1, 2, 3, 4`);

    const totals = { requests: 0, tokens: 0, costUsd: 0, cacheHits: 0, failed: 0, degraded: 0, blocked: 0 };
    const byFeature = new Map<string, Bucket>();
    const byModel = new Map<string, Bucket>();
    const byDay = new Map<string, Bucket>();
    const add = (map: Map<string, Bucket>, key: string, r: number, t: number, c: number) => {
      const b = map.get(key) ?? { key, requests: 0, tokens: 0, costUsd: 0 };
      b.requests += r;
      b.tokens += t;
      b.costUsd += c;
      map.set(key, b);
    };
    for (const row of rows) {
      const r = Number(row.requests);
      const t = Number(row.tokens ?? 0);
      const c = Number(row.cost ?? 0);
      totals.requests += r;
      totals.tokens += t;
      totals.costUsd += c;
      totals.cacheHits += Number(row.cache_hits);
      if (row.status === 'FAILED') totals.failed += r;
      if (row.status === 'DEGRADED') totals.degraded += r;
      if (row.status === 'BLOCKED') totals.blocked += r;
      add(byFeature, row.feature, r, t, c);
      add(byModel, row.model, r, t, c);
      add(byDay, row.day.toISOString().slice(0, 10), r, t, c);
    }
    const sortDesc = (m: Map<string, Bucket>) => [...m.values()].sort((a, b) => b.costUsd - a.costUsd).map(round);
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totals: { ...totals, costUsd: roundUsd(totals.costUsd), cacheHitRate: totals.requests ? totals.cacheHits / totals.requests : 0 },
      byFeature: sortDesc(byFeature),
      byModel: sortDesc(byModel),
      byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)).map(round),
    };
  }
}

/** Linear month-end projection from month-to-date spend; good enough for budget alerts in a dashboard. */
export function forecastMonthEnd(spentUsd: number, now = new Date()): number {
  const start = startOfMonthUtc(now);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = Math.max((now.getTime() - start.getTime()) / 86_400_000, 1 / 24);
  return roundUsd((spentUsd / elapsedDays) * daysInMonth);
}

function round(b: Bucket): Bucket {
  return { ...b, costUsd: roundUsd(b.costUsd) };
}

function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}
