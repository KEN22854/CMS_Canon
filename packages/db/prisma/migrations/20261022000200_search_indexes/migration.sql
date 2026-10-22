-- ── Vector (pgvector HNSW, cosine) ───────────────────────────────────────────
-- m=16 / ef_construction=64 are pgvector defaults made explicit: good recall (>0.95) up to
-- tens of millions of rows; raise ef_search per query (SET LOCAL hnsw.ef_search) for RAG.
-- Partial (embedding IS NOT NULL): rows still awaiting an embedding stay out of the graph, and
-- Prisma — which cannot model HNSW — ignores partial indexes instead of proposing to drop them.
CREATE INDEX "ai_vector_documents_embedding_hnsw"
  ON "ai_vector_documents" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

CREATE INDEX "ai_semantic_cache_embedding_hnsw"
  ON "ai_semantic_cache" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

-- Canon: entity resolution and fact similarity (dedupe extractor output against known facts).
CREATE INDEX "kg_entities_embedding_hnsw"
  ON "kg_entities" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

CREATE INDEX "facts_embedding_hnsw"
  ON "facts" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

-- ── Full-text (pg fallback when Meilisearch is unavailable; also BM25-ish leg of hybrid search) ──
-- 'simple' config: content is multilingual; per-locale stemming happens in Meilisearch.
ALTER TABLE "pages" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B') ||
    setweight(jsonb_to_tsvector('simple', "content", '["string"]'), 'C')
  ) STORED;
CREATE INDEX "pages_search_vector_gin" ON "pages" USING gin ("searchVector");

ALTER TABLE "entries" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (jsonb_to_tsvector('simple', "data", '["string"]')) STORED;
CREATE INDEX "entries_search_vector_gin" ON "entries" USING gin ("searchVector");

-- ── Trigram (typo-tolerant title/name lookup for Cmd+K and entity resolution) ──
CREATE INDEX "pages_title_trgm" ON "pages" USING gin ("title" gin_trgm_ops);
CREATE INDEX "media_original_name_trgm" ON "media" USING gin ("originalName" gin_trgm_ops);
CREATE INDEX "kg_entities_name_trgm" ON "kg_entities" USING gin ("canonicalName" gin_trgm_ops);

-- ── JSONB containment for data-bound blocks (collection.query → entries.data @> {...}) ──
CREATE INDEX "entries_data_gin" ON "entries" USING gin ("data" jsonb_path_ops);
