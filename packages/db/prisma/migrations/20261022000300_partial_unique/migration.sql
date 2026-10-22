-- Uniqueness that must ignore soft-deleted rows (Prisma cannot express partial indexes).
-- Without these, deleting "/pricing" would block ever creating "/pricing" again.

CREATE UNIQUE INDEX "pages_site_path_locale_live_key"
  ON "pages" ("siteId", "fullPath", "locale") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "entries_collection_slug_locale_live_key"
  ON "entries" ("collectionId", "slug", "locale") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "sites_domain_live_key"
  ON "sites" (lower("domain")) WHERE "deletedAt" IS NULL AND "domain" IS NOT NULL;

-- NULLs are distinct in a plain UNIQUE, so (NULL, name, version) could repeat for platform prompts.
CREATE UNIQUE INDEX "ai_prompts_global_name_version_key"
  ON "ai_prompts" ("name", "version") WHERE "tenantId" IS NULL;

-- One mention per span: re-extraction upserts instead of duplicating.
CREATE UNIQUE INDEX "fact_mentions_span_key"
  ON "fact_mentions" ("factId", "entityType", "entityId", "locale", "fieldPath", md5("surfaceText"));
