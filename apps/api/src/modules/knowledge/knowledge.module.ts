import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ContentAiModule } from '../content-ai/content-ai.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';
import { LOCALE_RE } from '../sites/sites.dto';
import { KnowledgeAnswers } from './answer.service';
import { KnowledgeIndexer } from './indexer.service';
import { KnowledgeSearch } from './search.service';

const searchQuery = z.object({ q: z.string().trim().min(1).max(300), locale: z.string().regex(LOCALE_RE).optional(), limit: z.coerce.number().int().min(1).max(30).default(10) });
const askBody = z.object({ question: z.string().trim().min(3).max(1_000), locale: z.string().regex(LOCALE_RE).optional() });
type AskBody = z.infer<typeof askBody>;

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId', version: '1' })
export class KnowledgeController {
  constructor(
    private readonly search: KnowledgeSearch,
    private readonly answers: KnowledgeAnswers,
    private readonly indexer: KnowledgeIndexer,
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
  ) {}

  @Get('search')
  @RequirePermission('read', 'Page')
  @ApiOperation({ summary: 'Hybrid search over published pages and entries (full-text + vectors, RRF)' })
  async find(@Param('siteId') siteId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    const q = new ZodBody(searchQuery).transform(query);
    await this.sites.get(p.tenantId, siteId); // 404 for another tenant's site, not an empty list
    const res = await this.search.search(p.tenantId, siteId, q.q, { locale: q.locale, limit: q.limit, userId: p.userId });
    // Chunk text stays server-side; the snippet is enough for a result list.
    return { semantic: res.semantic, hits: res.hits.map(({ text: _text, ...h }) => h) };
  }

  @Post('ask')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Generative answer grounded in published content and Canon facts, with citations' })
  ask(@Param('siteId') siteId: string, @Body(new ZodBody(askBody)) body: AskBody, @TenantScope() p: TenantPrincipal) {
    return this.answers.ask(p, siteId, body.question, body.locale);
  }

  @Post('ask/stream')
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Same as /ask over SSE: events sources → delta* → done' })
  async askStream(@Param('siteId') siteId: string, @Body(new ZodBody(askBody)) body: AskBody, @TenantScope() p: TenantPrincipal, @Res() res: Response): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => !res.writableFinished && abort.abort());
    const events = this.answers.stream(p, siteId, body.question, body.locale, abort.signal);
    // First event before headers: retrieval/quota errors still come back as JSON with a status code.
    const first = await events.next();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try {
      let next = first;
      while (!next.done) {
        res.write(`event: ${next.value.event}\ndata: ${JSON.stringify(next.value.data)}\n\n`);
        next = await events.next();
      }
    } catch (err) {
      if (!abort.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : 'stream failed' })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Post('knowledge/reindex')
  @HttpCode(202)
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Queue re-indexing of every published page and entry of the site' })
  async reindex(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    await this.sites.get(p.tenantId, siteId);
    return this.indexer.reindexSite(p.tenantId, siteId);
  }

  @Get('knowledge/stats')
  @RequirePermission('read', 'Page')
  async stats(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    await this.sites.get(p.tenantId, siteId);
    const rows = await this.prisma.rawForTenant({ tenantId: p.tenantId }, (tx) => tx.$queryRaw<{ chunks: bigint; embedded: bigint; entities: bigint; updated: Date | null }[]>`
      SELECT count(*)::bigint AS chunks, count(embedding)::bigint AS embedded, count(DISTINCT "entityId")::bigint AS entities, max("updatedAt") AS updated
      FROM ai_vector_documents WHERE "tenantId" = ${p.tenantId} AND "siteId" = ${siteId} AND "entityType" IN ('PAGE', 'ENTRY')`);
    const r = rows[0]!;
    return { chunks: Number(r.chunks), embedded: Number(r.embedded), entities: Number(r.entities), updatedAt: r.updated };
  }
}

@Module({
  imports: [SitesModule, IntelligenceModule, ContentAiModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeIndexer, KnowledgeSearch, KnowledgeAnswers],
  exports: [KnowledgeSearch, KnowledgeIndexer],
})
export class KnowledgeModule {}
