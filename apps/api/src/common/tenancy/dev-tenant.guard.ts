import { HttpStatus, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { API_ERROR_CODES, ApiError } from '../http/api-error';

/**
 * Phase 0 stand-in for the JWT/API-key guard (Phase 1): trusts an `x-tenant-slug` header so the
 * AI gateway can be exercised end-to-end before auth exists. It is hard-disabled in production —
 * the check is here, not in module wiring, so a mis-wired module still cannot open the hole.
 */
@Injectable()
export class DevTenantGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly system: SystemPrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.config.NODE_ENV === 'production') {
      throw new ApiError(API_ERROR_CODES.UNAUTHENTICATED, 'Authentication required', HttpStatus.UNAUTHORIZED);
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const slug = req.header('x-tenant-slug');
    if (!slug) {
      throw new ApiError(API_ERROR_CODES.UNAUTHENTICATED, 'x-tenant-slug header is required in development', HttpStatus.UNAUTHORIZED);
    }
    const tenant = await this.system.tenant.findUnique({ where: { slug }, select: { id: true, deletedAt: true } });
    if (!tenant || tenant.deletedAt) {
      throw new ApiError(API_ERROR_CODES.NOT_FOUND, `Tenant "${slug}" not found`, HttpStatus.NOT_FOUND);
    }
    req.principal = { tenantId: tenant.id, actorType: 'dev' };
    return true;
  }
}
