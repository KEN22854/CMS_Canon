import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { randomToken, safeEqual, sha256 } from '../crypto/tokens';
import { API_ERROR_CODES, ApiError } from '../http/api-error';
import type { RequestPrincipal } from './principal';

export const API_KEY_PREFIX = 'ck_';
const PREFIX_CHARS = 8;
const DEFAULT_RATE_PER_MIN = 600;
const AGENT_RATE_PER_MIN = 120;

export interface GeneratedApiKey {
  /** Full secret — shown to the user exactly once. */
  key: string;
  keyPrefix: string;
  keyHash: string;
}

/** Format: ck_<8-char lookup prefix>_<256-bit secret>. The prefix is indexed; the hash is compared. */
export function generateApiKey(): GeneratedApiKey {
  const lookup = randomToken(6).replace(/[-_]/g, 'x').slice(0, PREFIX_CHARS);
  const key = `${API_KEY_PREFIX}${lookup}_${randomToken(32)}`;
  return { key, keyPrefix: `${API_KEY_PREFIX}${lookup}`, keyHash: sha256(key) };
}

@Injectable()
export class ApiKeyAuthenticator {
  constructor(
    private readonly system: SystemPrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ApiKeyAuthenticator.name);
  }

  /** Lookup runs on the system role: the tenant is unknown until the key is identified. */
  async authenticate(rawKey: string): Promise<RequestPrincipal> {
    const keyPrefix = rawKey.slice(0, API_KEY_PREFIX.length + PREFIX_CHARS);
    const hash = sha256(rawKey);
    const candidates = await this.system.apiKey.findMany({
      where: { keyPrefix, revokedAt: null },
      select: { id: true, tenantId: true, keyHash: true, scopes: true, isAgentKey: true, rateLimit: true, expiresAt: true },
    });
    const key = candidates.find((c) => safeEqual(c.keyHash, hash));
    if (!key || (key.expiresAt && key.expiresAt < new Date())) {
      throw new ApiError(API_ERROR_CODES.UNAUTHENTICATED, 'Invalid API key', HttpStatus.UNAUTHORIZED);
    }

    await this.enforceRate(key.id, key.rateLimit ?? (key.isAgentKey ? AGENT_RATE_PER_MIN : DEFAULT_RATE_PER_MIN));
    void this.touch(key.id);

    return {
      actorType: key.isAgentKey ? 'agent' : 'api-key',
      tenantId: key.tenantId,
      apiKeyId: key.id,
      scopes: key.scopes,
    };
  }

  private async enforceRate(keyId: string, limit: number): Promise<void> {
    const bucket = `rl:apikey:${keyId}:${Math.floor(Date.now() / 60_000)}`;
    let count: number;
    try {
      count = await this.redis.incr(bucket);
      if (count === 1) await this.redis.expire(bucket, 120);
    } catch {
      return; // fail open: availability over strict metering during a Redis blip
    }
    if (count > limit) {
      throw new ApiError(API_ERROR_CODES.RATE_LIMITED, `API key rate limit of ${limit}/min exceeded`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** lastUsedAt is informational; writing it at most once a minute keeps hot keys off the DB. */
  private async touch(keyId: string): Promise<void> {
    try {
      const first = await this.redis.set(`apikey:touch:${keyId}`, '1', 'EX', 60, 'NX');
      if (first === 'OK') await this.system.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date() } });
    } catch (err) {
      this.logger.debug({ err, keyId }, 'api key touch failed');
    }
  }
}
