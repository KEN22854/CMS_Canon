-- Phase 4: collections & entries — display title, tags, AI enrichment state, publish snapshots,
-- relation reverse index.

ALTER TABLE "entries" ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "summary" TEXT,
ADD COLUMN "aiMeta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "publishedVersion" INTEGER;

CREATE INDEX "entries_tags_gin" ON "entries" USING gin ("tags");
-- Typo-tolerant title match: the cheap, always-available half of duplicate detection.
CREATE INDEX "entries_title_trgm" ON "entries" USING gin ("title" gin_trgm_ops);

CREATE TABLE "entry_relations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEntryId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "toEntryId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "entry_relations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entry_relations_fromEntryId_field_position_key" ON "entry_relations"("fromEntryId", "field", "position");
CREATE INDEX "entry_relations_toEntryId_idx" ON "entry_relations"("toEntryId");
CREATE INDEX "entry_relations_tenantId_idx" ON "entry_relations"("tenantId");
ALTER TABLE "entry_relations" ADD CONSTRAINT "entry_relations_fromEntryId_fkey" FOREIGN KEY ("fromEntryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entry_relations" ADD CONSTRAINT "entry_relations_toEntryId_fkey" FOREIGN KEY ("toEntryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entry_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entry_relations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "entry_relations"
  USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant());
