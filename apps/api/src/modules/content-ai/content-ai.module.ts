import { Body, Controller, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { MediaModule } from '../media/media.module';
import { PagesModule } from '../pages/pages.module';
import { SitesModule } from '../sites/sites.module';
import { AiContentService } from './ai-content.service';
import { altBody, textBody, translateBody, translatePageBody, type TextBody, type TranslateBody } from './content-ai.dto';

@ApiTags('ai')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ContentAiController {
  constructor(private readonly ai: AiContentService) {}

  @Post('ai/text')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Rewrite / expand / shorten / tone / simplify / formalize / fix a text with the site brand voice' })
  text(@Body(new ZodBody(textBody)) body: TextBody, @TenantScope() p: TenantPrincipal) {
    return this.ai.text(p, body);
  }

  @Post('ai/translate')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Glossary-aware batch translation (order and count preserved)' })
  async translate(@Body(new ZodBody(translateBody)) body: TranslateBody, @TenantScope() p: TenantPrincipal) {
    const { translations, results } = await this.ai.translateTexts(p, body.texts, body.targetLocale, body.siteId);
    return { translations, costUsd: results.reduce((s, r) => s + r.costMicroUsd, 0) / 1_000_000, models: [...new Set(results.map((r) => r.model))] };
  }

  @Post('sites/:siteId/pages/:pageId/ai-translate')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Create (or overwrite) a machine-translated draft of a page in another locale' })
  translatePage(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(translatePageBody)) body: { targetLocale: string; overwrite: boolean }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    const ability = abilityOf(req);
    if (!ability.can('create', 'Page')) throw forbidden('Your role cannot create pages');
    return this.ai.translatePage(p, ability, siteId, pageId, body.targetLocale, body.overwrite);
  }

  @Post('sites/:siteId/pages/:pageId/ai-seo')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Suggest SEO title/description/keywords from page content (not applied)' })
  seo(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.ai.seo(p, siteId, pageId);
  }

  @Post('media/:mediaId/ai-alt')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Generate alt text with a vision model; { apply: true } also saves it' })
  alt(@Param('mediaId') mediaId: string, @Body(new ZodBody(altBody)) body: { apply: boolean; locale?: string }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    if (body.apply && !abilityOf(req).can('update', 'Media')) throw forbidden('Your role cannot edit media');
    return this.ai.altText(p, mediaId, body);
  }
}

@Module({
  imports: [IntelligenceModule, SitesModule, PagesModule, MediaModule],
  controllers: [ContentAiController],
  providers: [AiContentService],
})
export class ContentAiModule {}
