import { createHash } from 'node:crypto';
import type { AiFeature, CachedCompletion, SemanticCachePort } from '@canon/ai-gateway';
import { toPgVector } from '@canon/db';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

const VECTOR_DIMS = 1536;

export type EmbedFn = (tenantId: string, text: string) => Promise<number[]>;

interface Row {
  id: string;
  responseText: string;
  modelKey: string;
  similarity: number;
}

/**
 * Semantic cache in pgvector (ai_semantic_cache, HNSW cosine). Lives in Postgres rather than a
 * separate vector store because hit volume is low and RLS gives tenant isolation for free.
 * `embed` is injected late: the gateway computes the embeddings, and the gateway depends on this cache.
 */
@Injectable()
export class PgSemanticCache implements SemanticCachePort {
  private embedFn?: EmbedFn;

  constructor(private readonly prisma: PrismaService) {}

  bindEmbedder(fn: EmbedFn): void {
    this.embedFn = fn;
  }

  async lookup(tenantId: string, query: string, feature: AiFeature, minSimilarity: number): Promise<CachedCompletion | null> {
    const vector = await this.embed(tenantId, query);
    if (!vector) return null;
    const literal = toPgVector(vector);
    const rows = await this.prisma.rawForTenant({ tenantId }, (tx) => tx.$queryRaw<Row[]>`
      SELECT id, "responseText", "modelKey", 1 - (embedding <=> ${literal}::vector) AS similarity
      FROM ai_semantic_cache
      WHERE "tenantId" = ${tenantId}
        AND feature = ${feature}::"AiFeature"
        AND "expiresAt" > now()
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector
      LIMIT 1`);
    const best = rows[0];
    if (!best || best.similarity < minSimilarity) return null;
    await this.prisma.rawForTenant({ tenantId }, (tx) => tx.$executeRaw`UPDATE ai_semantic_cache SET "hitCount" = "hitCount" + 1 WHERE id = ${best.id}`);
    return {
      text: best.responseText,
      model: best.modelKey as CachedCompletion['model'],
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'stop',
    };
  }

  async store(tenantId: string, query: string, feature: AiFeature, value: CachedCompletion, ttlSec: number): Promise<void> {
    const vector = await this.embed(tenantId, query);
    if (!vector) return;
    const literal = toPgVector(vector);
    const queryHash = createHash('sha256').update(`${feature}:${query}`).digest('hex');
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    await this.prisma.rawForTenant({ tenantId }, (tx) => tx.$executeRaw`
      INSERT INTO ai_semantic_cache (id, "tenantId", "queryHash", "queryText", "responseText", embedding, "modelKey", feature, "expiresAt")
      VALUES (gen_random_uuid()::text, ${tenantId}, ${queryHash}, ${query}, ${value.text}, ${literal}::vector, ${value.model}, ${feature}::"AiFeature", ${expiresAt})
      ON CONFLICT ("tenantId", "queryHash", "modelKey")
      DO UPDATE SET "responseText" = EXCLUDED."responseText", embedding = EXCLUDED.embedding, "expiresAt" = EXCLUDED."expiresAt"`);
  }

  private async embed(tenantId: string, text: string): Promise<number[] | null> {
    if (!this.embedFn || !text.trim()) return null;
    const v = await this.embedFn(tenantId, text);
    // The column is vector(1536); a model with other dims would fail the cast deep inside SQL.
    return v.length === VECTOR_DIMS ? v : null;
  }
}
