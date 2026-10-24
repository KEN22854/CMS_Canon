import { Body, Controller, Get, Headers, HttpCode, Module, Param, Patch, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Public, RateLimit, RequirePermission } from '../../common/auth/decorators';
import { Principal, TenantScope, type RequestPrincipal, type TenantPrincipal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BillingService, PAID_PLANS } from './billing.service';
import { StripeClient } from './stripe.client';

const checkoutBody = z.object({ plan: z.enum(PAID_PLANS) });
const setPlanBody = z.object({ plan: z.enum(['FREE', 'PRO', 'BUSINESS', 'ENTERPRISE']) });

@ApiTags('billing')
@ApiBearerAuth()
@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequirePermission('read', 'Tenant')
  @ApiOperation({ summary: 'Plan, limits, usage this month, subscription state and purchasable plans' })
  overview(@TenantScope() p: TenantPrincipal) {
    return this.billing.overview(p.tenantId);
  }

  @Post('checkout')
  @HttpCode(200)
  @RequirePermission('manage', 'Billing')
  @RateLimit({ bucket: 'billing-checkout', limit: 10, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'Stripe Checkout URL for a paid plan (the plan changes only when Stripe confirms)' })
  checkout(@Body(new ZodBody(checkoutBody)) body: z.infer<typeof checkoutBody>, @TenantScope() p: TenantPrincipal) {
    return this.billing.checkout(p, body.plan);
  }

  @Post('portal')
  @HttpCode(200)
  @RequirePermission('manage', 'Billing')
  @ApiOperation({ summary: 'Stripe customer portal URL (payment method, invoices, plan changes, cancellation)' })
  portal(@TenantScope() p: TenantPrincipal) {
    return this.billing.portal(p);
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined) {
    if (!req.rawBody) throw new ApiError('INVALID_SIGNATURE', 'Raw body unavailable', 400);
    return this.billing.handleWebhook(req.rawBody, signature);
  }
}

@ApiTags('platform')
@ApiBearerAuth()
@Controller({ path: 'platform/tenants', version: '1' })
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @Patch(':tenantId/plan')
  @HttpCode(204)
  @ApiOperation({ summary: 'Super admin: set a tenant plan by hand (enterprise contracts, installs without Stripe)' })
  async setPlan(@Param('tenantId') tenantId: string, @Body(new ZodBody(setPlanBody)) body: z.infer<typeof setPlanBody>, @Principal() p: RequestPrincipal): Promise<void> {
    await this.billing.setPlan(p, tenantId, body.plan);
  }
}

@Module({
  imports: [TenancyModule, IntelligenceModule],
  controllers: [BillingController, PlatformBillingController],
  providers: [StripeClient, BillingService],
  exports: [BillingService],
})
export class BillingModule {}
