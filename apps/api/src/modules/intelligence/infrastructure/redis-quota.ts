import type { AiCallContext, QuotaDecision, QuotaDenial, QuotaPort, QuotaSlot, TokenUsage } from '@canon/ai-gateway';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { REDIS } from '../../../infrastructure/redis/redis.module';
import { AiBudgetAlerts } from './ai-budget-alerts';
import { AiUsageLedger } from './ai-usage-ledger';
import { TenantAiSettingsService, type TenantAiLimits } from './tenant-ai-settings';

const MONTH_TTL_SEC = 40 * 86_400;
/** Upper bound on a single call; a crashed worker's slot frees itself after this. */
const SLOT_TTL_SEC = 600;

/**
 * Limits enforced in Redis so every API/worker replica shares one view:
 *  - requests/min per tenant and per user (fixed window; abuse protection, not billing)
 *  - concurrent in-flight calls per tenant (semaphore = sorted set of slot ids scored by expiry)
 *  - monthly tokens and micro-USD vs. plan (hard → reject; soft → allow + alert)
 * Counters are seeded from ai_generations when missing (Redis flush/failover), so a restart can't
 * hand a tenant a fresh budget. Redis failure fails OPEN — an AI outage costs more than a minute
 * of unmetered calls, and ai_generations remains the billing source of truth.
 */
@Injectable()
export class RedisQuota implements QuotaPort {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: TenantAiSettingsService,
    private readonly ledger: AiUsageLedger,
    private readonly alerts: AiBudgetAlerts,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisQuota.name);
  }

  async check(ctx: AiCallContext, estimatedMicroUsd: number, estimatedTokens: number): Promise<QuotaDecision> {
    const { limits } = await this.settings.settings(ctx.tenantId);
    try {
      const rate = await this.checkRate(ctx, limits);
      if (rate) return rate;
      const { spent, tokens } = await this.monthCounters(ctx.tenantId);

      if (limits.tokensPerMonth !== null && tokens + estimatedTokens > limits.tokensPerMonth) {
        if (limits.hardLimit) return { allowed: false, reason: 'tokens', message: `Monthly AI allowance of ${limits.tokensPerMonth.toLocaleString('en')} tokens reached on the ${limits.plan} plan` };
        this.logger.warn({ tenantId: ctx.tenantId, tokens }, 'ai.soft_token_cap_exceeded');
      }
      if (limits.budgetMicroUsd !== null && spent + estimatedMicroUsd > limits.budgetMicroUsd) {
        if (limits.hardLimit) return { allowed: false, reason: 'budget', message: 'Monthly AI budget exhausted' };
        this.logger.warn({ tenantId: ctx.tenantId, spent, budget: limits.budgetMicroUsd }, 'ai.soft_budget_exceeded');
      }
      return { allowed: true };
    } catch (err) {
      this.logger.error({ err, tenantId: ctx.tenantId }, 'ai.quota_check_failed_open');
      return { allowed: true };
    }
  }

  async acquire(ctx: AiCallContext): Promise<QuotaSlot | QuotaDenial> {
    const { limits } = await this.settings.settings(ctx.tenantId);
    const key = `ai:slots:${ctx.tenantId}`;
    const slotId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    try {
      const res = await this.redis
        .multi()
        .zremrangebyscore(key, 0, now) // drop slots whose holder died without releasing
        .zadd(key, now + SLOT_TTL_SEC * 1000, slotId)
        .zcard(key)
        .expire(key, SLOT_TTL_SEC)
        .exec();
      const count = Number(res?.[2]?.[1] ?? 0);
      if (count > limits.concurrentRequests) {
        await this.redis.zrem(key, slotId);
        return { allowed: false, reason: 'concurrency', message: `At most ${limits.concurrentRequests} AI requests may run at once on the ${limits.plan} plan`, retryAfterSec: 2 };
      }
    } catch (err) {
      this.logger.error({ err, tenantId: ctx.tenantId }, 'ai.slot_acquire_failed_open');
      return { release: async () => undefined };
    }
    return { release: async () => void (await this.redis.zrem(key, slotId)) };
  }

  async commit(ctx: AiCallContext, generationId: string, costMicroUsd: number, usage: TokenUsage): Promise<void> {
    const tokens = usage.inputTokens + usage.outputTokens;
    if (costMicroUsd <= 0 && tokens <= 0) return;
    try {
      // NX guard makes commit idempotent if a retry path calls it twice for one generation.
      const first = await this.redis.set(`ai:commit:${generationId}`, '1', 'EX', 3_600, 'NX');
      if (first !== 'OK') return;
      await this.monthCounters(ctx.tenantId); // ensure seeded before incrementing
      const { spendKey, tokensKey } = monthKeys(ctx.tenantId);
      const res = await this.redis.multi().incrby(spendKey, costMicroUsd).incrby(tokensKey, tokens).expire(spendKey, MONTH_TTL_SEC).expire(tokensKey, MONTH_TTL_SEC).exec();
      const newSpent = Number(res?.[0]?.[1] ?? 0);
      const { limits, name } = await this.settings.settings(ctx.tenantId);
      if (limits.budgetMicroUsd) await this.alerts.maybeNotify(ctx.tenantId, name, newSpent - costMicroUsd, newSpent, limits.budgetMicroUsd);
    } catch (err) {
      this.logger.error({ err, tenantId: ctx.tenantId, generationId }, 'ai.quota_commit_failed');
    }
  }

  private async checkRate(ctx: AiCallContext, limits: TenantAiLimits): Promise<QuotaDenial | null> {
    const minute = Math.floor(Date.now() / 60_000);
    const retryAfterSec = 60 - (Math.floor(Date.now() / 1000) % 60);
    const tenantKey = `ai:rate:${ctx.tenantId}:${minute}`;
    const multi = this.redis.multi().incr(tenantKey).expire(tenantKey, 120);
    const userKey = ctx.userId ? `ai:urate:${ctx.userId}:${minute}` : undefined;
    if (userKey) multi.incr(userKey).expire(userKey, 120);
    const res = await multi.exec();
    if (Number(res?.[0]?.[1] ?? 0) > limits.requestsPerMin) {
      return { allowed: false, reason: 'rate', message: `AI rate limit of ${limits.requestsPerMin}/min reached for this workspace`, retryAfterSec };
    }
    if (userKey && Number(res?.[2]?.[1] ?? 0) > limits.requestsPerUserPerMin) {
      return { allowed: false, reason: 'rate', message: `AI rate limit of ${limits.requestsPerUserPerMin}/min reached for your account`, retryAfterSec };
    }
    return null;
  }

  private async monthCounters(tenantId: string): Promise<{ spent: number; tokens: number }> {
    const { spendKey, tokensKey } = monthKeys(tenantId);
    const [spentRaw, tokensRaw] = await this.redis.mget(spendKey, tokensKey);
    if (spentRaw !== null && tokensRaw !== null) return { spent: Number(spentRaw), tokens: Number(tokensRaw) };

    const fromDb = await this.ledger.monthToDate(tenantId);
    // NX: if another replica seeded meanwhile, its value (possibly already incremented) wins.
    await this.redis.multi().set(spendKey, fromDb.costMicroUsd, 'EX', MONTH_TTL_SEC, 'NX').set(tokensKey, fromDb.tokens, 'EX', MONTH_TTL_SEC, 'NX').exec();
    const [s, t] = await this.redis.mget(spendKey, tokensKey);
    return { spent: Number(s ?? fromDb.costMicroUsd), tokens: Number(t ?? fromDb.tokens) };
  }
}

function monthKeys(tenantId: string): { spendKey: string; tokensKey: string } {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { spendKey: `ai:spend:${tenantId}:${ym}`, tokensKey: `ai:tokens:${tenantId}:${ym}` };
}
