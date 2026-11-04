-- CreateTable
CREATE TABLE "site_releases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "note" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "pages" JSONB NOT NULL,
    "components" JSONB NOT NULL,
    "entries" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_releases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "site_releases_siteId_number_key" ON "site_releases"("siteId", "number");
CREATE INDEX "site_releases_tenantId_siteId_createdAt_idx" ON "site_releases"("tenantId", "siteId", "createdAt");

ALTER TABLE "site_releases" ADD CONSTRAINT "site_releases_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, as for every tenant table.
ALTER TABLE "site_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_releases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_releases" USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant());
