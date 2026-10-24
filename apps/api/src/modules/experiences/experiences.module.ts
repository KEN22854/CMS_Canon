import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { ContentAiModule } from '../content-ai/content-ai.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { PagesModule } from '../pages/pages.module';
import { SitesModule } from '../sites/sites.module';
import {
  completeExperimentBody,
  createExperimentBody,
  personalizationBody,
  segmentBody,
  suggestBody,
  testSegmentBody,
  updateExperimentBody,
  type CreateExperimentBody,
  type PersonalizationBody,
  type SegmentBody,
  type SuggestBody,
  type UpdateExperimentBody,
} from './experiences.dto';
import { ExperimentsService } from './experiments.service';
import { PatchValidator } from './patch-validator';
import { PersonalizationService } from './personalization.service';
import { SuggestService } from './suggest.service';

@ApiTags('experiments')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ExperimentsController {
  constructor(
    private readonly experiments: ExperimentsService,
    private readonly suggestions: SuggestService,
  ) {}

  @Get('sites/:siteId/experiments')
  @RequirePermission('read', 'AbTest')
  list(@Param('siteId') siteId: string, @Query('pageId') pageId: string | undefined, @TenantScope() p: TenantPrincipal) {
    return this.experiments.list(p.tenantId, siteId, pageId);
  }

  @Post('sites/:siteId/pages/:pageId/experiments')
  @RequirePermission('create', 'AbTest')
  @ApiOperation({ summary: 'Create an A/B test: variants are validated block patches over the published page ("control" added automatically)' })
  create(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(createExperimentBody)) body: CreateExperimentBody, @TenantScope() p: TenantPrincipal) {
    return this.experiments.create(p, siteId, pageId, body);
  }

  @Post('sites/:siteId/pages/:pageId/experiments/suggest')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'AI alternatives for one block (optionally for a segment), as validated patches' })
  suggest(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(suggestBody)) body: SuggestBody, @TenantScope() p: TenantPrincipal) {
    return this.suggestions.suggest(p, siteId, pageId, body);
  }

  @Get('experiments/:id')
  @RequirePermission('read', 'AbTest')
  get(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.experiments.detail(p.tenantId, id);
  }

  @Patch('experiments/:id')
  @RequirePermission('update', 'AbTest')
  update(@Param('id') id: string, @Body(new ZodBody(updateExperimentBody)) body: UpdateExperimentBody, @TenantScope() p: TenantPrincipal) {
    return this.experiments.update(p, id, body);
  }

  @Post('experiments/:id/start')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  @ApiOperation({ summary: 'Start (or resume): visitors are assigned at the edge, each variant is its own cache entry' })
  start(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.experiments.start(p, id);
  }

  @Post('experiments/:id/pause')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  pause(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.experiments.pause(p, id);
  }

  @Post('experiments/:id/complete')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  complete(@Param('id') id: string, @Body(new ZodBody(completeExperimentBody)) body: { winnerVariantId?: string; applyToDraft: boolean }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.experiments.complete(p, abilityOf(req), id, body.winnerVariantId, body.applyToDraft);
  }

  @Post('experiments/:id/recommend')
  @HttpCode(200)
  @RequirePermission('read', 'AbTest')
  @ApiOperation({ summary: 'What to do next: AI reasoning bounded by statistical rules (no early winners)' })
  recommend(@Param('id') id: string, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    if (!abilityOf(req).can('invoke', 'Ai')) throw forbidden('Recommendations use AI; your role cannot invoke it');
    return this.experiments.recommend(p, id);
  }
}

@ApiTags('personalization')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId', version: '1' })
export class PersonalizationController {
  constructor(private readonly personalization: PersonalizationService) {}

  @Get('segments')
  @RequirePermission('read', 'Site')
  segments(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.personalization.segments(p.tenantId, siteId);
  }

  @Post('segments')
  @RequirePermission('update', 'Page')
  @ApiOperation({ summary: 'Create an audience segment evaluated at the edge (country, device, language, referrer, UTM, returning…)' })
  createSegment(@Param('siteId') siteId: string, @Body(new ZodBody(segmentBody)) body: SegmentBody, @TenantScope() p: TenantPrincipal) {
    return this.personalization.createSegment(p, siteId, body);
  }

  @Post('segments/test')
  @HttpCode(200)
  @RequirePermission('read', 'Site')
  testSegment(@Body(new ZodBody(testSegmentBody)) body: ReturnType<typeof testSegmentBody.parse>) {
    return this.personalization.test(body.rules, body.context);
  }

  @Patch('segments/:id')
  @RequirePermission('update', 'Page')
  updateSegment(@Param('siteId') siteId: string, @Param('id') id: string, @Body(new ZodBody(segmentBody.partial())) body: Partial<SegmentBody>, @TenantScope() p: TenantPrincipal) {
    return this.personalization.updateSegment(p, siteId, id, body);
  }

  @Delete('segments/:id')
  @HttpCode(204)
  @RequirePermission('update', 'Page')
  async deleteSegment(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.personalization.deleteSegment(p, siteId, id);
  }

  @Get('pages/:pageId/personalizations')
  @RequirePermission('read', 'Page')
  forPage(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @TenantScope() p: TenantPrincipal) {
    return this.personalization.forPage(p.tenantId, siteId, pageId);
  }

  @Put('pages/:pageId/personalizations')
  @RequirePermission('publish', 'Page')
  @ApiOperation({ summary: 'Set the patch a segment sees on this page (live immediately for published pages)' })
  upsert(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Body(new ZodBody(personalizationBody)) body: PersonalizationBody, @TenantScope() p: TenantPrincipal) {
    return this.personalization.upsert(p, siteId, pageId, body);
  }

  @Delete('pages/:pageId/personalizations/:id')
  @RequirePermission('publish', 'Page')
  remove(@Param('siteId') siteId: string, @Param('pageId') pageId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.personalization.remove(p, siteId, pageId, id);
  }
}

@Module({
  imports: [PagesModule, SitesModule, IntelligenceModule, ContentAiModule],
  controllers: [ExperimentsController, PersonalizationController],
  providers: [ExperimentsService, PersonalizationService, SuggestService, PatchValidator],
  exports: [ExperimentsService],
})
export class ExperiencesModule {}
