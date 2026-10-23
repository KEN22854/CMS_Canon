import { Controller, Get, Inject, Injectable, Module, Param, Query, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators';
import { safeEqual } from '../../common/crypto/tokens';
import { badRequest, unauthenticated } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { MediaModule } from '../media/media.module';
import { PagesModule } from '../pages/pages.module';
import { DeliveryService } from './delivery.service';

/** Only the platform renderer calls delivery; the shared token keeps the API from becoming a public scraping endpoint. */
@Injectable()
export class DeliveryTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest<Request>().header('x-canon-delivery') ?? '';
    if (!safeEqual(token, this.config.DELIVERY_TOKEN)) throw unauthenticated('Delivery token required');
    return true;
  }
}

@ApiExcludeController()
@Public()
@UseGuards(DeliveryTokenGuard)
@Controller({ path: 'delivery', version: '1' })
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('resolve')
  resolve(@Query('host') host?: string) {
    if (!host) throw badRequest('HOST_REQUIRED', 'host query parameter is required');
    return this.delivery.resolve(host);
  }

  @Get('sites/:siteId/page')
  page(@Param('siteId') siteId: string, @Query('path') path = '/', @Query('locale') locale?: string) {
    return this.delivery.page(siteId, path, locale);
  }

  @Get('sites/:siteId/pages')
  pages(@Param('siteId') siteId: string) {
    return this.delivery.list(siteId);
  }

  @Get('preview')
  preview(@Query('token') token?: string) {
    if (!token) throw badRequest('TOKEN_REQUIRED', 'token query parameter is required');
    return this.delivery.preview(token);
  }
}

@Module({ imports: [PagesModule, MediaModule], controllers: [DeliveryController], providers: [DeliveryService, DeliveryTokenGuard] })
export class DeliveryModule {}
