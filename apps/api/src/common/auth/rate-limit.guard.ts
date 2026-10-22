import { HttpStatus, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { API_ERROR_CODES, ApiError } from '../http/api-error';
import { RATE_LIMIT, type RateLimitRule } from './decorators';

/**
 * Sliding-window-log limiter (Redis sorted set): exact counts at window edges, which matters for
 * credential-stuffing protection where fixed windows allow 2× bursts across the boundary.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT, [ctx.getHandler(), ctx.getClass()]);
    if (!rule) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const who = rule.by === 'principal' ? (req.principal?.userId ?? req.principal?.apiKeyId ?? req.ip) : req.ip;
    const key = `rl:${rule.bucket}:${who ?? 'unknown'}`;

    const now = Date.now();
    let count: number;
    try {
      const res = await this.redis
        .multi()
        .zremrangebyscore(key, 0, now - rule.windowSec * 1000)
        .zadd(key, now, `${now}:${Math.random()}`)
        .zcard(key)
        .expire(key, rule.windowSec)
        .exec();
      count = Number(res?.[2]?.[1] ?? 0);
    } catch {
      return true; // fail open; account lockout still protects passwords
    }
    if (count > rule.limit) {
      ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(rule.windowSec));
      throw new ApiError(API_ERROR_CODES.RATE_LIMITED, 'Too many requests, slow down', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
