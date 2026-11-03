-- CreateTable
CREATE TABLE "redirects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "redirects_siteId_fromPath_key" ON "redirects"("siteId", "fromPath");

-- CreateIndex
CREATE INDEX "redirects_tenantId_idx" ON "redirects"("tenantId");

-- AddForeignKey
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the listed codes are redirects the renderer understands.
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_statusCode_check" CHECK ("statusCode" IN (301, 302, 307, 308));

-- Tenant isolation, as for every tenant table.
ALTER TABLE "redirects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "redirects" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "redirects" USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant());
