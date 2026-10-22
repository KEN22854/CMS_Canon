import { AiGateway, microUsdToUsd, type AiCallContext, type CompletionResult, type StreamEvent } from '@canon/ai-gateway';
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodBody } from '../../../common/http/zod-body.pipe';
import { DevTenantGuard } from '../../../common/tenancy/dev-tenant.guard';
import { Principal, type RequestPrincipal } from '../../../common/tenancy/tenant-context';
import { DbModelCatalog } from '../infrastructure/db-model-catalog';
import { TenantAiSettingsService } from '../infrastructure/tenant-ai-settings';
import { completeBody, embedBody, type CompleteBody, type EmbedBody } from './ai.dto';

@ApiTags('ai')
@ApiHeader({ name: 'x-tenant-slug', description: 'Development only — replaced by JWT/API key in Phase 1', required: true })
@UseGuards(DevTenantGuard)
@Controller({ path: 'ai', version: '1' })
export class AiController {
  constructor(
    private readonly gateway: AiGateway,
    private readonly catalog: DbModelCatalog,
    private readonly settings: TenantAiSettingsService,
  ) {}

  @Post('complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Single completion through the AI gateway (routing, fallback, cache, guardrails)' })
  async complete(
    @Body(new ZodBody(completeBody)) body: CompleteBody,
    @Principal() principal: RequestPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const abort = abortOnClose(res);
    const { feature, relatedEntity, ...request } = body;
    const result = await this.gateway.complete(request, this.ctx(principal, req, feature, relatedEntity), { signal: abort.signal });
    return present(result);
  }

  @Post('complete-stream')
  @ApiOperation({ summary: 'Streaming completion over Server-Sent Events (events: start, delta, done, error)' })
  async completeStream(
    @Body(new ZodBody(completeBody)) body: CompleteBody,
    @Principal() principal: RequestPrincipal,
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

  @Post('embed')
  @HttpCode(200)
  @ApiOperation({ summary: 'Batch embeddings with the tenant embedding model' })
  async embed(@Body(new ZodBody(embedBody)) body: EmbedBody, @Principal() principal: RequestPrincipal, @Req() req: Request) {
    const res = await this.gateway.embed(body, this.ctx(principal, req, 'EMBEDDING'));
    return { model: res.model, dimensions: res.vectors[0]?.length ?? 0, vectors: res.vectors, usage: res.usage, costUsd: microUsdToUsd(res.costMicroUsd) };
  }

  @Get('models')
  @ApiOperation({ summary: 'Models this tenant can use right now (configured provider + allow-list)' })
  async models(@Principal() principal: RequestPrincipal) {
    const policy = await this.settings.get(principal.tenantId);
    const available = new Set(this.gateway.availableProviders());
    const allowed = new Set(policy.allowedModels);
    return {
      defaultModel: policy.defaultModel,
      fallbackModels: policy.fallbackModels,
      models: this.catalog
        .list()
        .filter((m) => available.has(m.provider) && (allowed.size === 0 || allowed.has(m.key)))
        .map((m) => ({
          key: m.key,
          tier: m.tier,
          contextWindow: m.contextWindow,
          capabilities: m.capabilities,
          pricePer1M: { input: m.inputPricePer1M, output: m.outputPricePer1M },
        })),
    };
  }

  private ctx(principal: RequestPrincipal, req: Request, feature: AiCallContext['feature'], relatedEntity?: AiCallContext['relatedEntity']): AiCallContext {
    return {
      tenantId: principal.tenantId,
      userId: principal.userId,
      feature,
      traceId: typeof req.id === 'string' ? req.id : undefined,
      relatedEntity,
    };
  }
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
