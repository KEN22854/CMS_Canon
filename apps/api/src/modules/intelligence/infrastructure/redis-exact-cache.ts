import type { CachedCompletion, ExactCachePort } from '@canon/ai-gateway';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../../infrastructure/redis/redis.module';

@Injectable()
export class RedisExactCache implements ExactCachePort {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async get(tenantId: string, key: string): Promise<CachedCompletion | null> {
    const raw = await this.redis.get(cacheKey(tenantId, key));
    return raw ? (JSON.parse(raw) as CachedCompletion) : null;
  }

  async set(tenantId: string, key: string, value: CachedCompletion, ttlSec: number): Promise<void> {
    if (ttlSec <= 0) return;
    await this.redis.set(cacheKey(tenantId, key), JSON.stringify(value), 'EX', ttlSec);
  }
}

/** Tenant id in the key (not just the hash input) so a tenant purge is a single SCAN pattern. */
function cacheKey(tenantId: string, key: string): string {
  return `ai:x:${tenantId}:${key}`;
}
