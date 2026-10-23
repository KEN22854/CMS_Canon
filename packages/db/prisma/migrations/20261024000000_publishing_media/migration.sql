-- Phase 2: publishing pointer, sibling order, media upload lifecycle.

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING_UPLOAD', 'PROCESSING', 'READY', 'FAILED');

-- DropIndex
DROP INDEX "pages_siteId_parentId_idx";

-- AlterTable: default only for the backfill, so existing rows get a value; new rows must set it.
ALTER TABLE "media" ADD COLUMN     "status" "MediaStatus" NOT NULL DEFAULT 'READY',
ADD COLUMN     "storageKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "media" ALTER COLUMN "storageKey" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publishedVersion" INTEGER;

-- Pages published before this migration go live from their latest snapshot.
UPDATE "pages" p SET "publishedVersion" = v.max_version
FROM (SELECT "pageId", max(version) AS max_version FROM "page_versions" GROUP BY "pageId") v
WHERE v."pageId" = p.id AND p.status = 'PUBLISHED';

-- CreateIndex
CREATE INDEX "pages_siteId_parentId_position_idx" ON "pages"("siteId", "parentId", "position");
