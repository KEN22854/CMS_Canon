import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { sha256 } from '../../common/crypto/tokens';
import { ApiError } from '../../common/http/api-error';
import { REDIS } from '../../infrastructure/redis/redis.module';

const MAX_FAILURES = 5;
const LOCK_SEC = 15 * 60;

/**
 * Per-account lockout against credential stuffing on a single account (IP rate limits catch
 * the distributed case). Keyed by the submitted email — existing or not — so the lockout itself
 * does not reveal which emails have accounts.
 */
@Injectable()
export class LoginThrottleService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async assertNotLocked(email: string): Promise<void> {
    let failures: string | null;
    let ttl: number;
    try {
      [failures, ttl] = await Promise.all([this.redis.get(key(email)), this.redis.ttl(key(email))]);
    } catch {
      return;
    }
    if (Number(failures ?? 0) >= MAX_FAILURES) {
      throw new ApiError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or reset your password.', HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSec: Math.max(ttl, 1),
      });
    }
  }

  async recordFailure(email: string): Promise<void> {
    try {
      const n = await this.redis.incr(key(email));
      if (n === 1) await this.redis.expire(key(email), LOCK_SEC);
    } catch {
      // Lockout is defence in depth; never fail a login because Redis is down.
    }
  }

  async reset(email: string): Promise<void> {
    try {
      await this.redis.del(key(email));
    } catch {
      /* see recordFailure */
    }
  }
}

function key(email: string): string {
  return `auth:fail:${sha256(email)}`;
}
