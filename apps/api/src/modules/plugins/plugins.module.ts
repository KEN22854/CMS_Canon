import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PluginsService, installBody, updateInstanceBody } from './plugins.service';

@ApiTags('plugins')
@ApiBearerAuth()
@Controller({ path: 'plugins', version: '1' })
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  @RequirePermission('read', 'Tenant')
  @ApiOperation({ summary: 'Marketplace and private plugins, with this workspace’s installation state' })
  catalog(@TenantScope() p: TenantPrincipal) {
    return this.plugins.catalog(p.tenantId);
  }

  @Get('blocks')
  @RequirePermission('read', 'Site')
  @ApiOperation({ summary: 'Block presets contributed by installed plugins (builder palette)' })
  blocks(@TenantScope() p: TenantPrincipal) {
    return this.plugins.blocks(p.tenantId);
  }

  @Post()
  @RequirePermission('manage', 'Plugin')
  @ApiOperation({ summary: 'Register or update a private plugin from its manifest (Business+)' })
  register(@Body() body: { manifest?: unknown }, @TenantScope() p: TenantPrincipal) {
    return this.plugins.registerPrivate(p, body?.manifest);
  }

  @Post(':pluginId/install')
  @RequirePermission('manage', 'Plugin')
  @ApiOperation({ summary: 'Install with settings and explicit consent to the plugin’s permissions' })
  install(@Param('pluginId') pluginId: string, @Body(new ZodBody(installBody)) body: z.infer<typeof installBody>, @TenantScope() p: TenantPrincipal) {
    return this.plugins.install(p, pluginId, body);
  }

  @Patch('installations/:id')
  @RequirePermission('manage', 'Plugin')
  @ApiOperation({ summary: 'Change settings, pause/resume, or consent to an upgrade' })
  update(@Param('id') id: string, @Body(new ZodBody(updateInstanceBody)) body: z.infer<typeof updateInstanceBody>, @TenantScope() p: TenantPrincipal) {
    return this.plugins.update(p, id, body);
  }

  @Delete('installations/:id')
  @HttpCode(204)
  @RequirePermission('manage', 'Plugin')
  @ApiOperation({ summary: 'Uninstall: revokes the plugin’s API key and removes its subscriptions' })
  async uninstall(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.plugins.uninstall(p, id);
  }
}

@Module({
  imports: [WebhooksModule],
  controllers: [PluginsController],
  providers: [PluginsService],
})
export class PluginsModule {}
