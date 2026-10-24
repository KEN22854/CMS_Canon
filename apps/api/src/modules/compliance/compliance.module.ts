import { Body, Controller, Get, HttpCode, Module, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RateLimit, RequirePermission } from '../../common/auth/decorators';
import { Principal, TenantScope, type RequestPrincipal, type TenantPrincipal } from '../../common/auth/principal';
import { forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { AuditTrailService, auditQuery, type AuditQuery } from './audit-trail.service';
import { PrivacyService } from './privacy.service';

const exportQuery = auditQuery.extend({ format: z.enum(['csv', 'jsonl']).default('csv') });
const verifyQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const deleteMeBody = z.object({ password: z.string().max(200).optional(), confirm: z.literal('DELETE') });

@ApiTags('compliance')
@ApiBearerAuth()
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(
    private readonly trail: AuditTrailService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('read', 'AuditLog')
  @ApiOperation({ summary: 'Audit log: who did what, when, from where; filter by actor, action, entity, AI involvement, dates' })
  list(@Query(new ZodBody(auditQuery)) q: AuditQuery, @TenantScope() p: TenantPrincipal) {
    return this.trail.list(p.tenantId, q);
  }

  @Get('export')
  @RequirePermission('read', 'AuditLog')
  @RateLimit({ bucket: 'audit-export', limit: 20, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'Stream the filtered audit log as CSV or JSON Lines' })
  async export(@Query(new ZodBody(exportQuery)) q: z.infer<typeof exportQuery>, @TenantScope() p: TenantPrincipal, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.audit.record({ tenantId: p.tenantId, action: 'audit.exported', entityType: 'AuditLog', entityId: p.tenantId, changes: { format: q.format, from: q.from ?? null, to: q.to ?? null } }, p, req);
    res.setHeader('content-type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson');
    res.setHeader('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.${q.format}"`);
    for await (const chunk of this.trail.export(p.tenantId, q, q.format)) if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    res.end();
  }

  @Get('integrity')
  @RequirePermission('read', 'AuditLog')
  @ApiOperation({ summary: 'Recompute the daily SHA-256 chain: any edited, inserted or deleted row breaks its day' })
  integrity(@Query(new ZodBody(verifyQuery)) q: z.infer<typeof verifyQuery>, @TenantScope() p: TenantPrincipal) {
    return this.trail.verify(p.tenantId, q.from, q.to);
  }
}

@ApiTags('compliance')
@ApiBearerAuth()
@Controller({ version: '1' })
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly audit: AuditService,
  ) {}

  @Get('me/export')
  @RateLimit({ bucket: 'me-export', limit: 5, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'GDPR art. 15/20: download everything Canon holds about you' })
  async exportMe(@Principal() p: RequestPrincipal, @Res({ passthrough: true }) res: Response) {
    if (!p.userId || p.actorType !== 'user') throw forbidden('Only a signed-in person can export their data');
    res.setHeader('content-disposition', 'attachment; filename="canon-my-data.json"');
    return this.privacy.exportMe(p.userId);
  }

  @Post('me/delete')
  @HttpCode(204)
  @RateLimit({ bucket: 'me-delete', limit: 5, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'GDPR art. 17: erase your account (anonymized; owners must hand over workspaces first)' })
  async deleteMe(@Body(new ZodBody(deleteMeBody)) body: z.infer<typeof deleteMeBody>, @Principal() p: RequestPrincipal, @Req() req: Request): Promise<void> {
    await this.privacy.deleteMe(p, body.password, req);
  }

  @Get('workspace/export')
  @RequirePermission('delete', 'Tenant')
  @RateLimit({ bucket: 'tenant-export', limit: 5, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'Owner: export the whole workspace (sites, pages, collections, entries, facts, media metadata, settings)' })
  async exportTenant(@TenantScope() p: TenantPrincipal, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.audit.record({ tenantId: p.tenantId, action: 'tenant.exported', entityType: 'Tenant', entityId: p.tenantId }, p, req);
    res.setHeader('content-disposition', `attachment; filename="canon-workspace-${p.tenantId}.json"`);
    return this.privacy.exportTenant(p.tenantId);
  }
}

@Module({
  controllers: [AuditController, PrivacyController],
  providers: [AuditTrailService, PrivacyService],
  exports: [AuditTrailService, PrivacyService],
})
export class ComplianceModule {}
