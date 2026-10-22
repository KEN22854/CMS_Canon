import { randomUUID } from 'node:crypto';
import { microUsdToUsd } from '../domain/pricing';
import type { GatewayLogger, GenerationRecord, TracerPort } from '../ports';

export interface LangfuseTracerOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  flushIntervalMs?: number;
  maxBatch?: number;
  /** Prompts/outputs can be large; truncation keeps ingestion payloads bounded. */
  maxFieldChars?: number;
}

interface IngestionEvent {
  id: string;
  type: 'trace-create' | 'generation-create';
  timestamp: string;
  body: Record<string, unknown>;
}

/**
 * Talks to Langfuse's public ingestion HTTP API directly rather than through an SDK: the
 * endpoint contract is stable across Langfuse v2/v3 self-hosted, while SDK majors have churned.
 * Buffered + batched; failures are logged and dropped — observability must never take the
 * request path down with it.
 */
export class LangfuseHttpTracer implements TracerPort {
  private buffer: IngestionEvent[] = [];
  private readonly timer: NodeJS.Timeout;
  private readonly auth: string;
  private readonly maxBatch: number;
  private readonly maxChars: number;

  constructor(
    private readonly opts: LangfuseTracerOptions,
    private readonly logger: GatewayLogger,
  ) {
    this.auth = `Basic ${Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString('base64')}`;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxChars = opts.maxFieldChars ?? 20_000;
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 2_000);
    this.timer.unref();
  }

  generation(rec: GenerationRecord & { startedAt: Date; endedAt: Date; system?: string }): void {
    const traceId = rec.ctx.traceId ?? rec.generationId;
    const now = new Date().toISOString();
    this.buffer.push(
      {
        id: randomUUID(),
        type: 'trace-create',
        timestamp: now,
        body: {
          id: traceId,
          name: `ai.${rec.ctx.feature.toLowerCase()}`,
          userId: rec.ctx.userId,
          sessionId: rec.ctx.tenantId,
          tags: [rec.ctx.feature, `tenant:${rec.ctx.tenantId}`],
          metadata: { tenantId: rec.ctx.tenantId, relatedEntity: rec.ctx.relatedEntity, ...rec.ctx.tags },
        },
      },
      {
        id: randomUUID(),
        type: 'generation-create',
        timestamp: now,
        body: {
          id: rec.generationId,
          traceId,
          name: rec.ctx.feature,
          model: rec.model,
          startTime: rec.startedAt.toISOString(),
          endTime: rec.endedAt.toISOString(),
          input: this.truncate(rec.promptText),
          output: this.truncate(rec.responseText),
          usage: { input: rec.usage.inputTokens, output: rec.usage.outputTokens, unit: 'TOKENS' },
          costDetails: { total: microUsdToUsd(rec.costMicroUsd) },
          level: rec.status === 'SUCCEEDED' ? 'DEFAULT' : rec.status === 'DEGRADED' ? 'WARNING' : 'ERROR',
          statusMessage: rec.errorMessage,
          metadata: {
            status: rec.status,
            cacheHit: rec.cacheHit,
            fallbackUsed: rec.fallbackUsed,
            attempts: rec.attempts,
            guardrails: rec.guardrailFindings.map((f) => `${f.type}:${f.detail}`),
          },
        },
      },
    );
    if (this.buffer.length >= this.maxBatch) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const res = await fetch(new URL('/api/public/ingestion', this.opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: this.auth },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok && res.status !== 207) {
        this.logger.warn({ status: res.status, dropped: batch.length }, 'langfuse.ingestion_rejected');
      }
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err), dropped: batch.length }, 'langfuse.ingestion_failed');
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private truncate(s: string): string {
    return s.length > this.maxChars ? `${s.slice(0, this.maxChars)}…[truncated ${s.length - this.maxChars} chars]` : s;
  }
}
