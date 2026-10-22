import type { GenerationRecord, GuardrailFinding, UsageRecorderPort } from '@canon/ai-gateway';
import { Prisma } from '@canon/db';
import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../../infrastructure/metrics/metrics.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

const MAX_TEXT = 50_000;

/** Persists every gateway call to ai_generations (+ guardrail events) and mirrors it to Prometheus. */
@Injectable()
export class PrismaUsageRecorder implements UsageRecorderPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async record(rec: GenerationRecord): Promise<void> {
    this.observe(rec);
    const db = this.prisma.forTenant({ tenantId: rec.ctx.tenantId, userId: rec.ctx.userId });
    await db.aiGeneration.create({
      data: {
        id: rec.generationId,
        tenantId: rec.ctx.tenantId,
        userId: rec.ctx.userId ?? null,
        feature: rec.ctx.feature,
        modelId: rec.modelId ?? null,
        modelKey: rec.model,
        promptId: rec.ctx.promptId ?? null,
        traceId: rec.ctx.traceId ?? null,
        promptText: rec.promptText.slice(0, MAX_TEXT),
        responseText: rec.responseText.slice(0, MAX_TEXT),
        promptTokens: rec.usage.inputTokens,
        completionTokens: rec.usage.outputTokens,
        totalTokens: rec.usage.inputTokens + rec.usage.outputTokens,
        costUsd: new Prisma.Decimal(rec.costMicroUsd).div(1_000_000),
        latencyMs: rec.latencyMs,
        cacheHit: rec.cacheHit !== 'none',
        fallbackUsed: rec.fallbackUsed,
        status: rec.status,
        errorMessage: rec.errorMessage ?? null,
        responseMetadata: {
          cacheKind: rec.cacheHit,
          finishReason: rec.finishReason ?? null,
          attempts: rec.attempts,
        },
        relatedEntityType: rec.ctx.relatedEntity?.type ?? null,
        relatedEntityId: rec.ctx.relatedEntity?.id ?? null,
      },
    });
    if (rec.guardrailFindings.length > 0) {
      await db.aiGuardrailEvent.createMany({
        data: rec.guardrailFindings.map((f: GuardrailFinding) => ({
          tenantId: rec.ctx.tenantId,
          generationId: rec.generationId,
          type: f.type,
          severity: f.severity,
          action: rec.guardrailAction ?? 'LOGGED',
          details: { detail: f.detail },
        })),
      });
    }
  }

  private observe(rec: GenerationRecord): void {
    const labels = { feature: rec.ctx.feature, model: rec.model };
    this.metrics.aiGenerations.inc({ ...labels, status: rec.status, cache: rec.cacheHit, fallback: String(rec.fallbackUsed) });
    this.metrics.aiLatency.observe(labels, rec.latencyMs);
    if (rec.costMicroUsd > 0) this.metrics.aiCostMicroUsd.inc(labels, rec.costMicroUsd);
    this.metrics.aiTokens.inc({ model: rec.model, direction: 'input' }, rec.usage.inputTokens);
    this.metrics.aiTokens.inc({ model: rec.model, direction: 'output' }, rec.usage.outputTokens);
  }
}
