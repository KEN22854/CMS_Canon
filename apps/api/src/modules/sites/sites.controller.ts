import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import {
  createSiteBody,
  siteAiSettingsBody,
  themeBody,
  updateSiteBody,
  type CreateSiteBody,
  type SiteAiSettingsBody,
  type ThemeBody,
  type UpdateSiteBody,
} from './sites.dto';
import { DEFAULT_THEME, SitesService, presentSite } from './sites.service';

@ApiTags('sites')
@ApiBearerAuth()
@Controller({ path: 'sites', version: '1' })
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('read', 'Site')
  list(@TenantScope() p: TenantPrincipal) {
    return this.sites.list(p.tenantId);
  }

  @Post()
  @RequirePermission('create', 'Site')
  @ApiOperation({ summary: 'Create a site with a starter home page; respects the plan site limit' })
  create(@Body(new ZodBody(createSiteBody)) body: CreateSiteBody, @TenantScope() p: TenantPrincipal) {
    return this.sites.create(p, body);
  }

  @Get(':siteId')
  @RequirePermission('read', 'Site')
  async get(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return presentSite(await this.sites.get(p.tenantId, siteId), this.config);
  }

  @Patch(':siteId')
  @RequirePermission('update', 'Site')
  update(@Param('siteId') siteId: string, @Body(new ZodBody(updateSiteBody)) body: UpdateSiteBody, @TenantScope() p: TenantPrincipal) {
    return this.sites.update(p, siteId, body);
  }

  @Delete(':siteId')
  @HttpCode(204)
  @RequirePermission('delete', 'Site')
  async remove(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.sites.softDelete(p, siteId);
  }

  @Get(':siteId/theme')
  @RequirePermission('read', 'Site')
  async theme(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return { ...DEFAULT_THEME, ...((await this.sites.get(p.tenantId, siteId)).theme as object) };
  }

  @Patch(':siteId/theme')
  @RequirePermission('update', 'Site')
  updateTheme(@Param('siteId') siteId: string, @Body(new ZodBody(themeBody)) body: ThemeBody, @TenantScope() p: TenantPrincipal) {
    return this.sites.updateTheme(p, siteId, body);
  }

  @Get(':siteId/ai-settings')
  @RequirePermission('read', 'Site')
  async aiSettings(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return (await this.sites.get(p.tenantId, siteId)).aiSettings;
  }

  @Patch(':siteId/ai-settings')
  @RequirePermission('update', 'Site')
  updateAiSettings(@Param('siteId') siteId: string, @Body(new ZodBody(siteAiSettingsBody)) body: SiteAiSettingsBody, @TenantScope() p: TenantPrincipal) {
    return this.sites.updateAiSettings(p, siteId, body);
  }
}
