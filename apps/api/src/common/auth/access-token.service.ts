import type { MemberRole, UserRole } from '@canon/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { API_ERROR_CODES, ApiError } from '../http/api-error';

const ISSUER = 'canon';
const ACCESS_AUDIENCE = 'canon-api';
const MFA_AUDIENCE = 'canon-mfa';
const MFA_TTL_SEC = 300;

export interface AccessClaims {
  sub: string;
  sid: string;
  tid?: string;
  /** Tenant role, re-read from the DB on every refresh, so demotions apply within one TTL. */
  trl?: MemberRole;
  srl: UserRole;
  typ: 'access';
}

interface MfaClaims {
  sub: string;
  typ: 'mfa';
  /** Carried through the challenge so the session is created with the same context. */
  tid?: string;
}

/**
 * Stateless access tokens (HS256, short TTL) plus a Redis deny-list keyed by session family,
 * so logout / "sign out other devices" / role changes take effect immediately instead of
 * waiting for expiry. The deny-list entry only needs to outlive the access-token TTL.
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  get accessTtlSec(): number {
    return this.config.JWT_ACCESS_TTL_SEC;
  }

  signAccess(claims: Omit<AccessClaims, 'typ'>): Promise<string> {
    return this.jwt.signAsync({ ...claims, typ: 'access' } satisfies AccessClaims, {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
      expiresIn: this.config.JWT_ACCESS_TTL_SEC,
    });
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const claims = await this.verify<AccessClaims>(token, ACCESS_AUDIENCE);
    if (claims.typ !== 'access') throw unauthenticated();
    if (await this.isRevoked(claims.sid)) throw unauthenticated('Session has been revoked');
    return claims;
  }

  signMfaChallenge(userId: string, tenantId?: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId, typ: 'mfa', tid: tenantId } satisfies MfaClaims, {
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
      expiresIn: MFA_TTL_SEC,
    });
  }

  async verifyMfaChallenge(token: string): Promise<MfaClaims> {
    const claims = await this.verify<MfaClaims>(token, MFA_AUDIENCE);
    if (claims.typ !== 'mfa') throw unauthenticated();
    return claims;
  }

  async revokeFamilies(familyIds: readonly string[]): Promise<void> {
    if (familyIds.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const id of familyIds) pipeline.set(revokedKey(id), '1', 'EX', this.config.JWT_ACCESS_TTL_SEC + 60);
    await pipeline.exec();
  }

  private async isRevoked(familyId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(revokedKey(familyId))) === 1;
    } catch {
      // Fail open on Redis outage: tokens are ≤15 min and refresh re-checks the DB.
      return false;
    }
  }

  private async verify<T extends object>(token: string, audience: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, { issuer: ISSUER, audience, algorithms: ['HS256'] });
    } catch {
      throw unauthenticated('Invalid or expired token');
    }
  }
}

function revokedKey(familyId: string): string {
  return `auth:revoked:${familyId}`;
}

function unauthenticated(message = 'Authentication required'): ApiError {
  return new ApiError(API_ERROR_CODES.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
}
