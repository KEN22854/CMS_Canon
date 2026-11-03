-- CreateTable
CREATE TABLE "site_components" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tree" JSONB NOT NULL,
    "publishedTree" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedVersion" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "site_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_components_siteId_deletedAt_idx" ON "site_components"("siteId", "deletedAt");

-- CreateIndex
CREATE INDEX "site_components_tenantId_idx" ON "site_components"("tenantId");

-- AddForeignKey
ALTER TABLE "site_components" ADD CONSTRAINT "site_components_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, as for every tenant table.
ALTER TABLE "site_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_components" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_components" USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant());
