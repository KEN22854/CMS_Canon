import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CollectionsModule } from '../collections/collections.module';
import { ContentAiModule } from '../content-ai/content-ai.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { PagesModule } from '../pages/pages.module';
import { BranchesService } from './branches.service';
import { createFactBody, lintBody, listFactsQuery, mergeBody, propagateBody, reviewChangeBody, updateFactBody, type CreateFactBody, type ReviewChangeBody, type UpdateFactBody } from './canon.dto';
import { FactsService } from './facts.service';
import { MentionsService } from './mentions.service';
import { PropagationService } from './propagation.service';
import { ContentTargets } from './targets';

const scanBody = z.object({ type: z.enum(['PAGE', 'ENTRY']), id: z.string().min(1), llm: z.boolean().default(true) });

@ApiTags('canon')
@ApiBearerAuth()
@Controller({ path: 'canon', version: '1' })
export class CanonController {
  constructor(
    private readonly facts: FactsService,
    private readonly mentions: MentionsService,
    private readonly propagation: PropagationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('facts')
  @RequirePermission('read', 'Fact')
  list(@Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.facts.list(p.tenantId, new ZodBody(listFactsQuery).transform(query));
  }

  @Post('facts')
  @RequirePermission('create', 'Fact')
  @ApiOperation({ summary: 'Create a canonical fact (subject entity is resolved or created)' })
  create(@Body(new ZodBody(createFactBody)) body: CreateFactBody, @TenantScope() p: TenantPrincipal) {
    return this.facts.create(p, body);
  }

  @Get('facts/:id')
  @RequirePermission('read', 'Fact')
  get(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.facts.detail(p.tenantId, id);
  }

  @Patch('facts/:id')
  @RequirePermission('update', 'Fact')
  @ApiOperation({ summary: 'Change a fact: new version, detected mentions become STALE, bound mentions re-render; returns the impact' })
  update(@Param('id') id: string, @Body(new ZodBody(updateFactBody)) body: UpdateFactBody, @TenantScope() p: TenantPrincipal) {
    return this.facts.update(p, id, body);
  }

  @Delete('facts/:id')
  @HttpCode(204)
  @RequirePermission('delete', 'Fact')
  async remove(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.facts.remove(p, id);
  }

  @Get('facts/:id/versions')
  @RequirePermission('read', 'Fact')
  versions(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.facts.versions(p.tenantId, id);
  }

  @Get('facts/:id/impact')
  @RequirePermission('read', 'Fact')
  @ApiOperation({ summary: 'Every page/entry/locale where the fact appears (bound or detected), with states' })
  impact(@Param('id') id: string, @Query('siteId') siteId: string | undefined, @TenantScope() p: TenantPrincipal) {
    return this.facts.impact(p.tenantId, id, siteId);
  }

  @Post('facts/:id/propagate')
  @HttpCode(202)
  @RequirePermission('create', 'Branch')
  @ApiOperation({ summary: 'Open a branch and run the agent team (Strategist → Copywriter/Translator → Fact-Checker) on stale spans' })
  propagate(@Param('id') id: string, @Body(new ZodBody(propagateBody)) body: { siteId: string }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    if (!abilityOf(req).can('invoke', 'Ai')) throw forbidden('Propagation uses AI; your role cannot invoke it');
    return this.propagation.propose(p, id, body.siteId);
  }

  @Get('conflicts')
  @RequirePermission('read', 'Fact')
  @ApiOperation({ summary: 'Canon inbox: content contradicting a fact or predating its last change' })
  conflicts(@Query('siteId') siteId: string | undefined, @TenantScope() p: TenantPrincipal) {
    return this.facts.conflicts(p.tenantId, siteId);
  }

  @Post('mentions/:id/dismiss')
  @HttpCode(200)
  @RequirePermission('update', 'Fact')
  dismiss(@Param('id') id: string, @Body() body: { dismissed?: boolean }, @TenantScope() p: TenantPrincipal) {
    return this.facts.dismiss(p, id, body?.dismissed !== false);
  }

  @Post('mentions/:id/bind')
  @HttpCode(200)
  @RequirePermission('update', 'Page')
  @ApiOperation({ summary: 'Replace a detected span with a bound {{fact:key}} token in the draft' })
  bind(@Param('id') id: string, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.facts.bind(p, abilityOf(req), id);
  }

  @Post('lint')
  @HttpCode(200)
  @RequirePermission('read', 'Fact')
  @ApiOperation({ summary: 'Deterministic fact linter for arbitrary text (no AI): matches and conflicts' })
  async lint(@Body(new ZodBody(lintBody)) body: { siteId: string; text: string }, @TenantScope() p: TenantPrincipal) {
    return { findings: await this.mentions.lint(p.tenantId, body.siteId, body.text) };
  }

  @Post('scan')
  @HttpCode(200)
  @RequirePermission('update', 'Fact')
  @ApiOperation({ summary: 'Re-scan one page/entry for fact mentions now (llm=false: deterministic only)' })
  scan(@Body(new ZodBody(scanBody)) body: z.infer<typeof scanBody>, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    const llm = body.llm && abilityOf(req).can('invoke', 'Ai');
    return this.mentions.index(p.tenantId, body.type, body.id, { llm });
  }

  @Get('entities')
  @RequirePermission('read', 'Fact')
  entities(@Query('q') q: string | undefined, @TenantScope() p: TenantPrincipal) {
    return this.prisma.forTenant({ tenantId: p.tenantId }).kgEntity.findMany({
      where: { tenantId: p.tenantId, deletedAt: null, ...(q ? { canonicalName: { contains: q, mode: 'insensitive' } } : {}) },
      select: { id: true, type: true, canonicalName: true, aliases: true },
      orderBy: { canonicalName: 'asc' },
      take: 50,
    });
  }

  @Get('runs/:id')
  @RequirePermission('read', 'Branch')
  @ApiOperation({ summary: 'Agent run tree with every step (prompt output, tokens, cost, duration)' })
  run(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.propagation.run(p.tenantId, id);
  }
}

@ApiTags('canon')
@ApiBearerAuth()
@Controller({ version: '1' })
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get('sites/:siteId/branches')
  @RequirePermission('read', 'Branch')
  list(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.branches.list(p.tenantId, siteId);
  }

  @Get('branches/:id')
  @RequirePermission('read', 'Branch')
  get(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.branches.get(p.tenantId, id);
  }

  @Patch('branches/:id/changes/:changeId')
  @RequirePermission('update', 'Branch')
  review(@Param('id') id: string, @Param('changeId') changeId: string, @Body(new ZodBody(reviewChangeBody)) body: ReviewChangeBody, @TenantScope() p: TenantPrincipal) {
    return this.branches.review(p, id, changeId, body);
  }

  @Post('branches/:id/merge')
  @HttpCode(200)
  @RequirePermission('update', 'Branch')
  @ApiOperation({ summary: 'Apply accepted changes (CAS per page), optionally publish, re-scan mentions' })
  merge(@Param('id') id: string, @Body(new ZodBody(mergeBody)) body: { publish: boolean }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    const ability = abilityOf(req);
    if (body.publish && !ability.can('publish', 'Page')) throw forbidden('Your role cannot publish');
    return this.branches.merge(p, ability, id, body.publish);
  }

  @Post('branches/:id/close')
  @HttpCode(200)
  @RequirePermission('update', 'Branch')
  close(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.branches.close(p, id);
  }
}

@Module({
  imports: [PagesModule, CollectionsModule, IntelligenceModule, ContentAiModule],
  controllers: [CanonController, BranchesController],
  providers: [ContentTargets, MentionsService, FactsService, PropagationService, BranchesService],
  exports: [FactsService, MentionsService, PropagationService],
})
export class CanonModule {}
