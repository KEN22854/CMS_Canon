import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { WEBHOOK_EVENT_NAMES } from './events';
import { WebhooksService, webhookBody, type WebhookBody } from './webhooks.service';

@ApiTags('webhooks')
@ApiBearerAuth()
@Controller({ path: 'webhooks', version: '1' })
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events')
  @ApiOperation({ summary: 'Event names a webhook can subscribe to' })
  events() {
    return WEBHOOK_EVENT_NAMES;
  }

  @Get()
  @RequirePermission('read', 'Webhook')
  list(@TenantScope() p: TenantPrincipal) {
    return this.webhooks.list(p.tenantId);
  }

  @Post()
  @RequirePermission('create', 'Webhook')
  @ApiOperation({ summary: 'Create an endpoint; the signing secret is returned once' })
  create(@Body(new ZodBody(webhookBody)) body: WebhookBody, @TenantScope() p: TenantPrincipal) {
    return this.webhooks.create(p, body);
  }

  @Patch(':id')
  @RequirePermission('update', 'Webhook')
  update(@Param('id') id: string, @Body(new ZodBody(webhookBody.partial())) body: Partial<WebhookBody>, @TenantScope() p: TenantPrincipal) {
    return this.webhooks.update(p, id, body);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequirePermission('update', 'Webhook')
  rotate(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.webhooks.rotateSecret(p, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('delete', 'Webhook')
  async remove(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.webhooks.remove(p, id);
  }

  @Get(':id/deliveries')
  @RequirePermission('read', 'Webhook')
  @ApiOperation({ summary: 'Last 100 deliveries with status, attempts, response code and timing' })
  deliveries(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.webhooks.deliveries(p.tenantId, id);
  }

  @Post(':id/test')
  @HttpCode(202)
  @RequirePermission('update', 'Webhook')
  @ApiOperation({ summary: 'Send a signed ping now' })
  test(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.webhooks.test(p, id);
  }

  @Post('deliveries/:deliveryId/redeliver')
  @HttpCode(202)
  @RequirePermission('update', 'Webhook')
  redeliver(@Param('deliveryId') deliveryId: string, @TenantScope() p: TenantPrincipal) {
    return this.webhooks.redeliver(p, deliveryId);
  }
}

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
