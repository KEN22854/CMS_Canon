import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Public, RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { ContentAiModule } from '../content-ai/content-ai.module';
import { DeliveryTokenGuard } from '../delivery/delivery.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { SitesModule } from '../sites/sites.module';
import { CollectorService, collectBody, type CollectBody } from './collector.service';
import { InsightsService } from './insights.service';
import { ReportsService } from './reports.service';
import { RollupService, dayString } from './rollup.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z
  .object({ from: day.optional(), to: day.optional() })
  .transform((q) => {
    const to = q.to ?? dayString(new Date());
    const from = q.from ?? dayString(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000));
    return { from, to };
  })
  .refine((q) => q.from <= q.to, 'from must not be after to');
const insightsBody = z.object({ from: day.optional(), to: day.optional(), ai: z.boolean().default(true) });

/** Called only by the platform renderer, which proxies the browser beacon from the site's own origin. */
@ApiExcludeController()
@Public()
@UseGuards(DeliveryTokenGuard)
@Controller({ path: 'delivery', version: '1' })
export class CollectController {
  constructor(private readonly collector: CollectorService) {}

  @Post('collect')
  @HttpCode(202)
  collect(@Body(new ZodBody(collectBody)) body: CollectBody, @Req() req: Request) {
    return this.collector.collect(body, {
      userAgent: req.header('x-canon-ua') ?? null,
      country: (req.header('x-canon-country') ?? '').toUpperCase().slice(0, 2) || null,
      host: req.header('x-canon-host') ?? null,
    });
  }
}

@ApiTags('analytics')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/analytics', version: '1' })
export class AnalyticsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly insights: InsightsService,
    private readonly rollup: RollupService,
    private readonly collector: CollectorService,
  ) {}

  @Get()
  @RequirePermission('read', 'Analytics')
  @ApiOperation({ summary: 'Traffic report: totals vs previous period, daily series, top pages, dimensions (UTC days)' })
  report(@Param('siteId') siteId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    const q = new ZodBody(rangeQuery).transform(query);
    return this.reports.report(p.tenantId, siteId, q.from, q.to);
  }

  @Get('realtime')
  @RequirePermission('read', 'Analytics')
  realtime(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.reports.realtime(p.tenantId, siteId);
  }

  @Post('insights')
  @HttpCode(200)
  @RequirePermission('read', 'Analytics')
  @ApiOperation({ summary: 'Deterministic signals + AI narrative and recommendations (rules-only without AI)' })
  insightsFor(@Param('siteId') siteId: string, @Body(new ZodBody(insightsBody)) body: z.infer<typeof insightsBody>, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    const to = body.to ?? dayString(new Date());
    const from = body.from ?? dayString(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000));
    if (from > to) throw badRequest('INVALID_RANGE', 'from must not be after to');
    return this.insights.insights(p, siteId, from, to, { ai: body.ai && abilityOf(req).can('invoke', 'Ai') });
  }

  @Post('rollup')
  @HttpCode(200)
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Flush buffered events and recompute today\'s rollup now' })
  async rollupNow(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    await this.reports.realtime(p.tenantId, siteId); // ownership check
    const flushed = await this.collector.flush();
    return { flushed, ...(await this.rollup.rollupDay(siteId, dayString(new Date()))) };
  }
}

@Module({
  imports: [SitesModule, IntelligenceModule, ContentAiModule],
  controllers: [CollectController, AnalyticsController],
  providers: [CollectorService, RollupService, ReportsService, InsightsService, DeliveryTokenGuard],
  exports: [CollectorService, ReportsService],
})
export class AnalyticsModule {}
