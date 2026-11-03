-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('OPEN', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "form_submissions" ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "forms" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "link" TEXT;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "domainCheckedAt" TIMESTAMP(3),
ADD COLUMN     "domainError" TEXT,
ADD COLUMN     "domainStatus" "DomainStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "domainToken" TEXT,
ADD COLUMN     "domainVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "requireReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenant_members" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "scimManaged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notificationPrefs" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "review_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "requestedById" TEXT,
    "reviewerIds" TEXT[],
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "blockId" TEXT,
    "parentId" TEXT,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_requests_tenantId_status_createdAt_idx" ON "review_requests"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "review_requests_entityType_entityId_createdAt_idx" ON "review_requests"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_entityType_entityId_createdAt_idx" ON "comments"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_tenantId_idx" ON "comments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_tokenHash_key" ON "scim_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "scim_tokens_tenantId_idx" ON "scim_tokens"("tenantId");

-- CreateIndex
CREATE INDEX "notifications_emailedAt_createdAt_idx" ON "notifications"("emailedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenantId_externalId_key" ON "tenant_members"("tenantId", "externalId");


-- A claimed but unverified domain must not block its real owner: uniqueness applies to verified,
-- live sites only. Delivery only ever routes verified domains.
DROP INDEX IF EXISTS "sites_domain_live_key";
CREATE UNIQUE INDEX "sites_domain_verified_key" ON "sites" (lower("domain")) WHERE "deletedAt" IS NULL AND "domain" IS NOT NULL AND "domainStatus" = 'VERIFIED';

-- Sites that already had a domain keep serving it (they were routed before verification existed).
UPDATE "sites" SET "domainStatus" = 'VERIFIED', "domainVerifiedAt" = now() WHERE "domain" IS NOT NULL AND "deletedAt" IS NULL;

-- Tenant isolation, same policy as every other tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['review_requests', 'comments', 'scim_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant())', t);
  END LOOP;
END
$$;

-- SCIM tokens are checked by the system role at the edge of the request; the app role never reads hashes.
REVOKE ALL ON "scim_tokens" FROM canon_app;
