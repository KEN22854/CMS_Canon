import { AiGateway } from '@canon/ai-gateway';
import { toPgVector } from '@canon/db';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NO_EMBEDDING } from './indexer.service';

/** Reciprocal Rank Fusion constant: 60 is the value from the original paper and works without tuning. */
const RRF_K = 60;
const CANDIDATES = 30;
const VECTOR_DIMS = 1536;

/** Function words that would make an OR-query match everything. Small on purpose: content words matter. */
const STOP = new Set(
  'a an the is are was were be been how what which who whom whose why when where much many does do did of for to in on at by and or not with without my our your their its it this that these those i you we they me us can could should would will shall may might about from as into than then there here please tell me wie was ist sind der die das und oder für mit von zu den dem ein eine что как это где когда сколько ли и в на с по для не'.split(' '),
);

export interface SearchHit {
  id: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
  chunkIndex: number;
  title: string;
  path: string;
  heading: string | null;
  collection: string | null;
  locale: string | null;
  text: string;
  snippet: string;
  score: number;
  /** Which retrievers found it: lexical, semantic or both. */
  via: ('lexical' | 'semantic')[];
}

interface Row {
  id: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
  chunkIndex: number;
  chunkText: string;
  locale: string | null;
  metadata: { title?: string; path?: string; heading?: string | null; collection?: string | null };
  snippet?: string;
}

/** Terms for an OR tsquery with prefix matching ("integration" finds "integrations"). */
export function queryTerms(q: string): string[] {
  const words = q
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12);
}

/**
 * Hybrid retrieval over published content: Postgres full-text (always) + pgvector cosine (when
 * the tenant has an embedding model), fused with RRF. Lexical search is what keeps exact terms —
 * SKUs, plan names, error codes — findable; vectors catch paraphrases. Neither needs the other.
 */
@Injectable()
export class KnowledgeSearch {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KnowledgeSearch.name);
  }

  async search(tenantId: string, siteId: string, q: string, opts: { locale?: string; limit?: number; perEntity?: number; userId?: string } = {}): Promise<{ hits: SearchHit[]; semantic: boolean }> {
    const limit = opts.limit ?? 10;
    const perEntity = opts.perEntity ?? 1;
    const terms = queryTerms(q);
    const tsq = terms.map((t) => `${t}:*`).join(' | ');
    const locale = opts.locale ?? null;

    const [lexical, semantic] = await Promise.all([
      tsq
        ? this.prisma.rawForTenant({ tenantId }, (tx) => tx.$queryRaw<(Row & { rank: number })[]>`
            SELECT d.id, d."entityType", d."entityId", d."chunkIndex", d."chunkText", d.locale, d.metadata,
                   ts_rank_cd(d."searchVector", query, 32) AS rank,
                   ts_headline('simple', d."chunkText", query, 'MaxFragments=1, MaxWords=28, MinWords=10, StartSel=<<, StopSel=>>') AS snippet
            FROM ai_vector_documents d, to_tsquery('simple', ${tsq}) query
            WHERE d."tenantId" = ${tenantId} AND d."siteId" = ${siteId} AND d."entityType" IN ('PAGE', 'ENTRY')
              AND d."searchVector" @@ query AND (${locale}::text IS NULL OR d.locale = ${locale})
            ORDER BY rank DESC LIMIT ${CANDIDATES}`)
        : Promise.resolve([]),
      this.semantic(tenantId, siteId, q, locale, opts.userId),
    ]);

    const fused = new Map<string, { row: Row; score: number; via: Set<'lexical' | 'semantic'>; snippet?: string }>();
    const add = (rows: Row[], via: 'lexical' | 'semantic') =>
      rows.forEach((r, rank) => {
        const cur = fused.get(r.id) ?? { row: r, score: 0, via: new Set(), snippet: r.snippet };
        cur.score += 1 / (RRF_K + rank + 1);
        cur.via.add(via);
        if (!cur.snippet && r.snippet) cur.snippet = r.snippet;
        fused.set(r.id, cur);
      });
    add(lexical, 'lexical');
    add(semantic ?? [], 'semantic');

    const perEntityCount = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const f of [...fused.values()].sort((a, b) => b.score - a.score)) {
      const key = `${f.row.entityType}:${f.row.entityId}`;
      const n = perEntityCount.get(key) ?? 0;
      if (n >= perEntity) continue;
      perEntityCount.set(key, n + 1);
      hits.push({
        id: f.row.id,
        entityType: f.row.entityType,
        entityId: f.row.entityId,
        chunkIndex: f.row.chunkIndex,
        title: f.row.metadata.title ?? '',
        path: f.row.metadata.path ?? '',
        heading: f.row.metadata.heading ?? null,
        collection: f.row.metadata.collection ?? null,
        locale: f.row.locale,
        text: f.row.chunkText,
        snippet: f.snippet ?? f.row.chunkText.slice(0, 220),
        score: Math.round(f.score * 10_000) / 10_000,
        via: [...f.via],
      });
      if (hits.length >= limit) break;
    }
    return { hits, semantic: semantic !== null };
  }

  /** null = no embedding model (lexical-only); [] = model available but nothing close. */
  private async semantic(tenantId: string, siteId: string, q: string, locale: string | null, userId?: string): Promise<Row[] | null> {
    let vector: number[] | undefined;
    let model = '';
    try {
      const res = await this.gateway.embed({ input: [q.slice(0, 2_000)] }, { tenantId, userId, feature: 'EMBEDDING', tags: { pipeline: 'search' } });
      vector = res.vectors[0];
      model = res.model;
    } catch (err) {
      this.logger.debug({ err }, 'knowledge.query_embedding_unavailable');
      return null;
    }
    if (!vector || vector.length !== VECTOR_DIMS) return null;
    const literal = toPgVector(vector);
    return this.prisma.rawForTenant({ tenantId }, async (tx) => {
      // Higher ef_search than the default 40: RAG cares more about recall than a millisecond.
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
      return tx.$queryRaw<Row[]>`
        SELECT d.id, d."entityType", d."entityId", d."chunkIndex", d."chunkText", d.locale, d.metadata
        FROM ai_vector_documents d
        WHERE d."tenantId" = ${tenantId} AND d."siteId" = ${siteId} AND d.embedding IS NOT NULL
          AND d."embeddingModel" = ${model} AND d."embeddingModel" <> ${NO_EMBEDDING}
          AND (${locale}::text IS NULL OR d.locale = ${locale})
        ORDER BY d.embedding <=> ${literal}::vector LIMIT ${CANDIDATES}`;
    });
  }
}
