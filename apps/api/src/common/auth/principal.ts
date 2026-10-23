import { createParamDecorator, HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { MemberRole, UserRole } from '@canon/db';
import type { Request } from 'express';
import { API_ERROR_CODES, ApiError } from '../http/api-error';

/** 'system' = scheduled jobs and other platform-initiated actions (no human or key behind them). */
export type ActorType = 'user' | 'api-key' | 'agent' | 'system';

/** Who is calling, resolved once per request by AuthGuard from a JWT or an API key. */
export interface RequestPrincipal {
  actorType: ActorType;
  /** Undefined for API keys (they act for a tenant, not a person). */
  userId?: string;
  /** Active tenant; undefined for a user who has not picked one yet. */
  tenantId?: string;
  /** Session family id (`sid` claim) — revoking it kills outstanding access tokens. */
  sessionId?: string;
  memberRole?: MemberRole;
  systemRole?: UserRole;
  apiKeyId?: string;
  scopes?: string[];
}

export interface TenantPrincipal extends RequestPrincipal {
  tenantId: string;
}

declare global {
  // Express request augmentation requires the namespace form.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: RequestPrincipal;
    }
  }
}

export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestPrincipal => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.principal) {
    // A handler using @Principal on a @Public route is a wiring bug, not a client error.
    throw new Error('Principal requested on a route without authentication');
  }
  return req.principal;
});

/** Same as @Principal but rejects callers without an active tenant (tenant-scoped routes). */
export const TenantScope = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantPrincipal => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const p = req.principal;
  if (!p) throw new Error('TenantScope requested on a route without authentication');
  if (!p.tenantId) {
    throw new ApiError(API_ERROR_CODES.FORBIDDEN, 'Select a tenant first (POST /v1/auth/switch-tenant)', HttpStatus.FORBIDDEN, { reason: 'NO_ACTIVE_TENANT' });
  }
  return p as TenantPrincipal;
});
