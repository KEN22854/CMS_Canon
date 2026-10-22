import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestPrincipal {
  tenantId: string;
  userId?: string;
  /** "user" | "api-key" | "agent" — feeds AuditLog.actorType and AI audit. */
  actorType: 'user' | 'api-key' | 'agent' | 'dev';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express request augmentation requires the namespace form.
  namespace Express {
    interface Request {
      principal?: RequestPrincipal;
    }
  }
}

/** Resolved by the auth/tenant guard; handlers never read tenant ids from bodies or params. */
export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestPrincipal => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.principal) {
    // A handler using @Principal without a guard is a wiring bug, not a client error.
    throw new Error('Principal requested on a route without a tenant guard');
  }
  return req.principal;
});
