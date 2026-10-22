import type { AiCallContext, QuotaDecision, QuotaPort, TokenUsage } from '@canon/ai-gateway';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { REDIS } from '../../../infrastructure/redis/redis.module';
import { TenantAiSettingsService } from './tenant-ai-settings';

const MONTH_TTL_SEC = 40 * 86_400;

/**
 * Two limits, both in Redis so every API/worker replica sees the same counters:
 *  - fixed-window requests/min (cheap, good enough for abuse protection; sliding window in Phase 1)
 *  - monthly spend in micro-USD vs. tenant budget (hard → reject, soft → allow + warn)
 * Redis failure fails OPEN: losing quota enforcement for a minute is cheaper than an AI outage.
 */
@Injectable()
export class RedisQuota implements QuotaPort {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: TenantAiSettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisQuota.name);
  }

  async check(ctx: AiCallContext, estimatedMicroUsd: number): Promise<QuotaDecision> {
    const { limits } = await this.settings.settings(ctx.tenantId);
    try {
      const minute = Math.floor(Date.now() / 60_000);
      const rateKey = `ai:rate:${ctx.tenantId}:${minute}`;
      const [[, count], [, spentRaw]] = (await this.redis
        .multi()
        .incr(rateKey)
        .get(spendKey(ctx.tenantId))
        .expire(rateKey, 120)
        .exec()) as [[null, number], [null, string | null], [null, number]];

      if (count > limits.requestsPerMin) {
        return { allowed: false, reason: 'rate', message: `AI rate limit of ${limits.requestsPerMin}/min exceeded`, retryAfterSec: 60 - (Math.floor(Date.now() / 1000) % 60) };
      }
      if (limits.budgetMicroUsd !== null) {
        const spent = Number(spentRaw ?? 0);
        if (spent + estimatedMicroUsd > limits.budgetMicroUsd) {
          if (limits.hardLimit) {
            return { allowed: false, reason: 'budget', message: 'Monthly AI budget exhausted' };
          }
          this.logger.warn({ tenantId: ctx.tenantId, spent, budget: limits.budgetMicroUsd }, 'ai.soft_budget_exceeded');
        }
      }
      return { allowed: true };
    } catch (err) {
      this.logger.error({ err, tenantId: ctx.tenantId }, 'ai.quota_check_failed_open');
      return { allowed: true };
    }
  }

  async commit(ctx: AiCallContext, generationId: string, costMicroUsd: number, _usage: TokenUsage): Promise<void> {
    if (costMicroUsd <= 0) return;
    try {
      // NX guard makes commit idempotent if a retry path calls it twice for one generation.
      const first = await this.redis.set(`ai:commit:${generationId}`, '1', 'EX', 3_600, 'NX');
      if (first !== 'OK') return;
      const key = spendKey(ctx.tenantId);
      await this.redis.multi().incrby(key, costMicroUsd).expire(key, MONTH_TTL_SEC).exec();
    } catch (err) {
      // ai_generations remains the billing source of truth; Redis is only the fast-path counter.
      this.logger.error({ err, tenantId: ctx.tenantId, generationId }, 'ai.quota_commit_failed');
    }
  }
}

function spendKey(tenantId: string): string {
  const d = new Date();
  return `ai:spend:${tenantId}:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
