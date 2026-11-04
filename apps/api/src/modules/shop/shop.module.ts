import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { DeliveryModule, DeliveryTokenGuard } from '../delivery/delivery.module';
import { SitesModule } from '../sites/sites.module';
import { checkoutBody, listOrdersQuery, updateOrderBody, type CheckoutBody, type UpdateOrderBody } from './shop.dto';
import { ShopService } from './shop.service';

@ApiTags('shop')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/orders', version: '1' })
export class OrdersController {
  constructor(private readonly shop: ShopService) {}

  @Get()
  @RequirePermission('read', 'Order')
  @ApiOperation({ summary: 'Orders of the site, newest first: status filter, search by number, name or email; counts by status' })
  list(@Param('siteId') siteId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.shop.list(p.tenantId, siteId, new ZodBody(listOrdersQuery).transform(query));
  }

  @Get(':orderId')
  @RequirePermission('read', 'Order')
  get(@Param('siteId') siteId: string, @Param('orderId') id: string, @TenantScope() p: TenantPrincipal) {
    return this.shop.get(p.tenantId, siteId, id);
  }

  @Patch(':orderId')
  @RequirePermission('update', 'Order')
  @ApiOperation({ summary: 'Move the order along NEW → CONFIRMED → PAID → SHIPPED → COMPLETED, or CANCELLED (returns stock); 409 for other moves' })
  update(@Param('siteId') siteId: string, @Param('orderId') id: string, @Body(new ZodBody(updateOrderBody)) body: UpdateOrderBody, @TenantScope() p: TenantPrincipal) {
    return this.shop.update(p, siteId, id, body);
  }
}

/** Called only by the platform renderer, which proxies the visitor's checkout from the site's origin. */
@ApiExcludeController()
@Public()
@UseGuards(DeliveryTokenGuard)
@Controller({ path: 'delivery/sites/:siteId/orders', version: '1' })
export class CheckoutController {
  constructor(private readonly shop: ShopService) {}

  @Post()
  @HttpCode(201)
  checkout(@Param('siteId') siteId: string, @Body(new ZodBody(checkoutBody)) body: CheckoutBody, @Req() req: Request) {
    return this.shop.checkout(siteId, body, { ip: req.header('x-canon-ip') ?? null, host: req.header('x-canon-host') ?? null });
  }
}

@Module({
  imports: [SitesModule, DeliveryModule],
  controllers: [OrdersController, CheckoutController],
  providers: [ShopService],
})
export class ShopModule {}
