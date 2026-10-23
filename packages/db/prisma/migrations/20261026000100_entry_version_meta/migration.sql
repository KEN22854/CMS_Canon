-- Entry snapshots carry their published slug/title/tags/summary (see Entry.publishedVersion).
ALTER TABLE "entry_versions" ADD COLUMN "slug" TEXT NOT NULL DEFAULT '',
ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "summary" TEXT;
