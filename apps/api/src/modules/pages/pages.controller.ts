import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import {
  checkpointBody,
  createPageBody,
  listPagesQuery,
  publishBody,
  reorderBody,
  scheduleBody,
  updatePageBody,
  type CreatePageBody,
  type ReorderBody,
  type ScheduleBody,
  type UpdatePageBody,
} from './pages.dto';
import { PagesService } from './pages.service';

@ApiTags('pages')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/pages', version: '1' })
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @RequirePermission('read', 'Page')
  list(@Param('siteId') siteId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.pages.list(p.tenantId, siteId, new ZodBody(listPagesQuery).transform(query));
  }

  @Post()
  @RequirePermission('create', 'Page')
  create(@Param('siteId') siteId: string, @Body(new ZodBody(createPageBody)) body: CreatePageBody, @TenantScope() p: TenantPrincipal) {
    return this.pages.create(p, siteId, body);
  }

  @Post('reorder')
  @HttpCode(200)
  @RequirePermission('update', 'Page')
  @ApiOperation({ summary: 'Move/reorder pages in the tree; child URLs follow their parent' })
  reorder(@Param('siteId') siteId: string, @Body(new ZodBody(reorderBody)) body: ReorderBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.reorder(p, abilityOf(req), siteId, body);
  }

  @Get(':pageId')
  @RequirePermission('read', 'Page')
  get(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.pages.detail(p.tenantId, siteId, pageId);
  }

  @Patch(':pageId')
  @RequirePermission('update', 'Page')
  @ApiOperation({ summary: 'Save the draft (optimistic lock via expectedVersion → 409 VERSION_CONFLICT)' })
  update(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(updatePageBody)) body: UpdatePageBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.update(p, abilityOf(req), siteId, pageId, body);
  }

  @Delete(':pageId')
  @HttpCode(204)
  @RequirePermission('delete', 'Page')
  async remove(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal, @Req() req: Request): Promise<void> {
    await this.pages.remove(p, abilityOf(req), siteId, pageId);
  }

  @Post(':pageId/duplicate')
  @RequirePermission('create', 'Page')
  duplicate(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.pages.duplicate(p, siteId, pageId);
  }

  @Post(':pageId/publish')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  publish(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(publishBody)) body: { comment?: string }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.publish(p, abilityOf(req), siteId, pageId, body.comment);
  }

  @Post(':pageId/unpublish')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  unpublish(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.unpublish(p, abilityOf(req), siteId, pageId);
  }

  @Post(':pageId/schedule')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  schedule(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(scheduleBody)) body: ScheduleBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.schedule(p, abilityOf(req), siteId, pageId, body);
  }

  @Delete(':pageId/schedule')
  @RequirePermission('publish', 'Page')
  cancelSchedule(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.pages.cancelSchedule(p, siteId, pageId);
  }

  @Get(':pageId/versions')
  @RequirePermission('read', 'Page')
  versions(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.pages.versions(p.tenantId, siteId, pageId);
  }

  @Post(':pageId/versions')
  @RequirePermission('update', 'Page')
  checkpoint(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(checkpointBody)) body: { comment?: string }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.checkpoint(p, abilityOf(req), siteId, pageId, body.comment);
  }

  @Get(':pageId/versions/:version')
  @RequirePermission('read', 'Page')
  version(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Param('version', ParseIntPipe) version: number, @TenantScope() p: TenantPrincipal) {
    return this.pages.version(p.tenantId, siteId, pageId, version);
  }

  @Post(':pageId/versions/:version/restore')
  @HttpCode(200)
  @RequirePermission('update', 'Page')
  restore(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Param('version', ParseIntPipe) version: number, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.pages.restore(p, abilityOf(req), siteId, pageId, version);
  }

  @Post(':pageId/preview')
  @HttpCode(200)
  @RequirePermission('read', 'Page')
  @ApiOperation({ summary: 'Short-lived signed link that opens the draft on the renderer' })
  preview(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.pages.previewUrl(p.tenantId, siteId, pageId);
  }
}
