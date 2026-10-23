-- Phase 5: hybrid retrieval. The lexical half of RAG works with no embedding provider at all;
-- vectors (HNSW, partial on embedding IS NOT NULL) join in when a 1536-dim model is configured.
ALTER TABLE "ai_vector_documents" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("metadata"->>'title', '')), 'A') ||
    setweight(to_tsvector('simple', "chunkText"), 'B')
  ) STORED;
CREATE INDEX "ai_vector_documents_search_gin" ON "ai_vector_documents" USING gin ("searchVector");
-- Re-index replaces an entity's chunks wholesale; this keeps the delete cheap.
CREATE INDEX "ai_vector_documents_entity_idx" ON "ai_vector_documents" ("tenantId", "entityType", "entityId");
