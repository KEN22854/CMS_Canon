import { SetMetadata } from '@nestjs/common';
import type { Action, SubjectName } from './abilities';

export const IS_PUBLIC = 'canon:isPublic';
export const PERMISSION = 'canon:permission';
export const RATE_LIMIT = 'canon:rateLimit';

/** Opt-out of the global AuthGuard. Everything is authenticated unless it says so. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export interface PermissionRequirement {
  action: Action;
  subject: SubjectName;
}

/**
 * Route-level (type) check. Instance-level conditions (e.g. AUTHOR may edit only own pages)
 * are checked in services with `ability.can(action, subject('Page', page))`.
 */
export const RequirePermission = (action: Action, subject: SubjectName): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION, { action, subject } satisfies PermissionRequirement);

export interface RateLimitRule {
  /** Bucket name, shared by routes that should share a budget. */
  bucket: string;
  limit: number;
  windowSec: number;
  /** "ip" for anonymous endpoints; "principal" for authenticated ones. */
  by: 'ip' | 'principal';
}

export const RateLimit = (rule: RateLimitRule): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT, rule);
