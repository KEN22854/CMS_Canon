import { AiGateway, microUsdToUsd, type AiCallContext, type CompletionResult, type StreamEvent } from '@canon/ai-gateway';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodBody } from '../../../common/http/zod-body.pipe';
import { RequirePermission } from '../../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../../common/auth/principal';
import { forbidden } from '../../../common/http/api-error';
import { AiUsageService } from '../application/ai-usage.service';
import { DbModelCatalog } from '../infrastructure/db-model-catalog';
import { TenantAiSettingsService } from '../infrastructure/tenant-ai-settings';
import { completeBody, embedBody, usageQuery, type CompleteBody, type EmbedBody, type UsageQuery } from './ai.dto';

@ApiTags('ai')
@ApiBearerAuth()
@Controller({ version: '1' })
export class AiController {
  constructor(
    private readonly gateway: AiGateway,
    private readonly catalog: DbModelCatalog,
    private readonly settings: TenantAiSettingsService,
    private readonly usage: AiUsageService,
  ) {}

  @Post('ai/complete')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Single completion through the AI gateway (routing, fallback, cache, guardrails)' })
  async complete(
    @Body(new ZodBody(completeBody)) body: CompleteBody,
    @TenantScope() principal: TenantPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const abort = abortOnClose(res);
    const { feature, relatedEntity, ...request } = body;
    const result = await this.gateway.complete(request, this.ctx(principal, req, feature, relatedEntity), { signal: abort.signal });
    return present(result);
  }

  @Post('ai/complete-stream')
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Streaming completion over Server-Sent Events (events: start, delta, done, error)' })
  async completeStream(
    @Body(new ZodBody(completeBody)) body: CompleteBody,
    @TenantScope() principal: TenantPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const abort = abortOnClose(res);
    const { feature, relatedEntity, ...request } = body;
    const events = this.gateway.stream(request, this.ctx(principal, req, feature, relatedEntity), { signal: abort.signal });

    // Pull the first event before committing to SSE headers: pre-flight failures (quota,
    // guardrails, validation) then surface as normal JSON errors with the right status code.
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disables proxy buffering (nginx/Traefik) so tokens reach the browser as they are produced.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      let next = first;
      while (!next.done) {
        writeEvent(res, next.value);
        next = await iterator.next();
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : 'stream failed' })}\n\n`);
      }
    } finally {
      res.end();
    }
  }

  @Post('ai/embed')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Batch embeddings with the tenant embedding model' })
  async embed(@Body(new ZodBody(embedBody)) body: EmbedBody, @TenantScope() principal: TenantPrincipal, @Req() req: Request) {
    const res = await this.gateway.embed(body, this.ctx(principal, req, 'EMBEDDING'));
    return { model: res.model, dimensions: res.vectors[0]?.length ?? 0, vectors: res.vectors, usage: res.usage, costUsd: microUsdToUsd(res.costMicroUsd) };
  }

  @Get('ai/models')
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Models this tenant can use right now (configured provider + allow-list)' })
  async models(@TenantScope() principal: TenantPrincipal) {
    const policy = await this.settings.get(principal.tenantId);
    const available = new Set(this.gateway.availableProviders());
    const allowed = new Set(policy.allowedModels);
    return {
      defaultModel: policy.defaultModel,
      fallbackModels: policy.fallbackModels,
      models: this.catalog
        .list()
        .filter((m) => available.has(m.provider) && (allowed.size === 0 || allowed.has(m.key)) && (!policy.allowedTiers || policy.allowedTiers.includes(m.tier)))
        .map((m) => ({
          key: m.key,
          tier: m.tier,
          contextWindow: m.contextWindow,
          capabilities: m.capabilities,
          pricePer1M: { input: m.inputPricePer1M, output: m.outputPricePer1M },
        })),
    };
  }

  @Get('ai/usage')
  @RequirePermission('read', 'AiUsage')
  @ApiOperation({ summary: 'AI usage for the active tenant: totals, by feature/model/day, budget, forecast, limits' })
  usageReport(@Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.usage.report(p.tenantId, parseUsage(query));
  }

  @Get('tenants/:tenantId/ai-usage')
  @RequirePermission('read', 'AiUsage')
  tenantUsage(@Param('tenantId') tenantId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    if (tenantId !== p.tenantId) throw forbidden('Switch to this tenant first', { reason: 'TENANT_MISMATCH' });
    return this.usage.report(tenantId, parseUsage(query));
  }

  private ctx(principal: TenantPrincipal, req: Request, feature: AiCallContext['feature'], relatedEntity?: AiCallContext['relatedEntity']): AiCallContext {
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      feature,
      traceId: typeof req.id === 'string' ? req.id : undefined,
      relatedEntity,
    };
  }
}

function parseUsage(query: Record<string, string>): UsageQuery {
  return new ZodBody(usageQuery).transform(query);
}

function present(r: CompletionResult) {
  return {
    id: r.generationId,
    text: r.text,
    model: r.model,
    status: r.status,
    finishReason: r.finishReason,
    usage: r.usage,
    costUsd: microUsdToUsd(r.costMicroUsd),
    latencyMs: r.latencyMs,
    cacheHit: r.cacheHit,
    fallbackUsed: r.fallbackUsed,
  };
}

function writeEvent(res: Response, e: StreamEvent): void {
  const data = e.type === 'done' ? present(e.result) : e.type === 'delta' ? { text: e.text } : { id: e.generationId, model: e.model };
  res.write(`event: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Client disconnect cancels the upstream LLM call — otherwise abandoned tabs keep burning tokens.
 * Listens on the response: IncomingMessage 'close' also fires once the body is read, which would
 * abort every request.
 */
function abortOnClose(res: Response): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}
