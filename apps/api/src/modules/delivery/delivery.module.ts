import { collectListSpecs, type BlockNode } from '@canon/blocks';
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Request } from 'express';
import { Public, RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { safeEqual } from '../../common/crypto/tokens';
import { badRequest, unauthenticated } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { MediaModule } from '../media/media.module';
import { PagesModule } from '../pages/pages.module';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';
import { LOCALE_RE } from '../sites/sites.dto';
import { DeliveryService } from './delivery.service';
import { EntryPagesService } from './entry-pages.service';

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
  page(@Param('siteId') siteId: string, @Query('path') path = '/', @Query('locale') locale?: string, @Query('variant') variant?: string) {
    return this.delivery.page(siteId, path, locale, variant);
  }

  @Get('sites/:siteId/runtime')
  runtime(@Param('siteId') siteId: string) {
    return this.delivery.runtime(siteId);
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

const listPreviewBody = z.object({
  /** The Collection list blocks being edited (only their props matter). */
  blocks: z.array(z.object({ id: z.string().max(40), type: z.literal('collection-list'), props: z.record(z.string(), z.unknown()) })).max(10),
  locale: z.string().regex(LOCALE_RE),
});

/** The builder draws Collection list blocks with the cards visitors will see (published entries). */
@ApiTags('collections')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/collection-lists', version: '1' })
export class CollectionListsController {
  constructor(
    private readonly sites: SitesService,
    private readonly entryPages: EntryPagesService,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('read', 'Entry')
  @ApiOperation({ summary: 'Cards for Collection list blocks: published entries only, as on the live site' })
  async preview(@Param('siteId') siteId: string, @Body(new ZodBody(listPreviewBody)) body: z.infer<typeof listPreviewBody>, @TenantScope() p: TenantPrincipal) {
    // The tenant check comes first: below, queries run on the system role pinned to this site.
    await this.sites.get(p.tenantId, siteId);
    const root = { id: 'root', type: 'section', props: {}, children: body.blocks.map((b) => ({ ...b, children: [] })) } as BlockNode;
    return this.entryPages.lists(siteId, collectListSpecs(root), body.locale);
  }
}

@Module({
  imports: [PagesModule, MediaModule, SitesModule],
  controllers: [DeliveryController, CollectionListsController],
  providers: [DeliveryService, DeliveryTokenGuard, EntryPagesService],
  exports: [DeliveryTokenGuard],
})
export class DeliveryModule {}
