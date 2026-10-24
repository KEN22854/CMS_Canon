-- Phase 6: segments & personalization (edge-evaluated), daily analytics rollups, Yjs document storage.
CREATE TYPE "PersonalizationStatus" AS ENUM ('ACTIVE', 'PAUSED');

CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "personalizations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "patch" JSONB NOT NULL,
    "status" "PersonalizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personalizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "analytics_daily_pages" (
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "path" TEXT NOT NULL,
    "pageId" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "entrances" INTEGER NOT NULL DEFAULT 0,
    "bounces" INTEGER NOT NULL DEFAULT 0,
    "engagedMs" BIGINT NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_daily_pages_pkey" PRIMARY KEY ("siteId","day","path")
);

CREATE TABLE "analytics_daily_dims" (
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "dim" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analytics_daily_dims_pkey" PRIMARY KEY ("siteId","day","dim","value")
);

CREATE TABLE "collab_documents" (
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collab_documents_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "segments_tenantId_idx" ON "segments"("tenantId");

CREATE INDEX "segments_siteId_idx" ON "segments"("siteId");

CREATE INDEX "personalizations_tenantId_idx" ON "personalizations"("tenantId");

CREATE INDEX "personalizations_siteId_status_idx" ON "personalizations"("siteId", "status");

CREATE UNIQUE INDEX "personalizations_pageId_segmentId_key" ON "personalizations"("pageId", "segmentId");

CREATE INDEX "analytics_daily_pages_tenantId_idx" ON "analytics_daily_pages"("tenantId");

CREATE INDEX "analytics_daily_dims_tenantId_idx" ON "analytics_daily_dims"("tenantId");

CREATE INDEX "collab_documents_tenantId_idx" ON "collab_documents"("tenantId");

ALTER TABLE "segments" ADD CONSTRAINT "segments_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "personalizations" ADD CONSTRAINT "personalizations_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "personalizations" ADD CONSTRAINT "personalizations_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation, same policy as every other tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['segments', 'personalizations', 'analytics_daily_pages', 'analytics_daily_dims', 'collab_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant())', t);
  END LOOP;
END
$$;
