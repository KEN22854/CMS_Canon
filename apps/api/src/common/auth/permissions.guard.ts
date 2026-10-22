import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_ERROR_CODES, ApiError } from '../http/api-error';
import { defineAbilityFor, type AppAbility } from './abilities';
import { PERMISSION, type PermissionRequirement } from './decorators';

const ABILITY = Symbol('ability');

type RequestWithAbility = Request & { [ABILITY]?: AppAbility };

/** Ability is built once per request and reused by services for instance-level checks. */
export function abilityOf(req: Request): AppAbility {
  const r = req as RequestWithAbility;
  if (!r[ABILITY]) {
    if (!req.principal) throw new Error('abilityOf called before authentication');
    r[ABILITY] = defineAbilityFor(req.principal);
  }
  return r[ABILITY];
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const required = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(PERMISSION, [ctx.getHandler(), ctx.getClass()]);
    if (!required || !req.principal) return true;

    if (!req.principal.tenantId && req.principal.systemRole !== 'SUPER_ADMIN') {
      throw new ApiError(API_ERROR_CODES.FORBIDDEN, 'Select a tenant first (POST /v1/auth/switch-tenant)', HttpStatus.FORBIDDEN, {
        reason: 'NO_ACTIVE_TENANT',
      });
    }
    // Type-level check: passes if *some* rule could allow it; conditions are enforced on instances.
    if (!abilityOf(req).can(required.action, required.subject)) {
      throw new ApiError(API_ERROR_CODES.FORBIDDEN, `Not allowed to ${required.action} ${required.subject}`, HttpStatus.FORBIDDEN);
    }
    return true;
  }
}
