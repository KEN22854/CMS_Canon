import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Read-only fact lookup for the editor's fact picker (inserting bound {{fact:key}} tokens). The
 * full Canon fact graph API — editing, history, agent propagation — lands with the AI core (Phase 5).
 */
@ApiTags('canon')
@ApiBearerAuth()
@Controller({ path: 'facts', version: '1' })
export class FactsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('read', 'Fact')
  @ApiOperation({ summary: 'Search active facts visible to a site (site-scoped + tenant-wide) by key, predicate or value' })
  async list(@TenantScope() p: TenantPrincipal, @Query('siteId') siteId?: string, @Query('q') q?: string) {
    const term = q?.trim().slice(0, 100);
    const rows = await this.prisma.forTenant({ tenantId: p.tenantId }).fact.findMany({
      where: {
        tenantId: p.tenantId,
        deletedAt: null,
        status: 'ACTIVE',
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
        ...(term
          ? {
              AND: [
                {
                  OR: [
                    { key: { contains: term, mode: 'insensitive' as const } },
                    { predicate: { contains: term, mode: 'insensitive' as const } },
                    { displayValue: { contains: term, mode: 'insensitive' as const } },
                  ],
                },
              ],
            }
          : {}),
      },
      select: { id: true, key: true, predicate: true, valueType: true, displayValue: true, siteId: true, updatedAt: true },
      orderBy: { key: 'asc' },
      take: 50,
    });
    return { items: rows };
  }
}

@Module({ controllers: [FactsController] })
export class FactsModule {}
