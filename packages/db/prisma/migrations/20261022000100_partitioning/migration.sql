-- Range-partition the two append-only, unbounded tables by month.
--
-- Why: analytics/audit grow without bound; monthly partitions make retention a metadata-only
-- DROP (no VACUUM storm) and keep "last 30 days" queries on 1–2 partitions.
--
-- Child partitions live in schema "partitions" on purpose: Prisma diffs only "public", so
-- `migrate dev` never sees the children and never proposes dropping them as drift.
-- Tables are empty at this point (fresh install), so drop & recreate is safe and simplest.

CREATE SCHEMA IF NOT EXISTS partitions;

DROP TABLE "analytics_events";
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT,
    "event" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "referrer" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");
CREATE INDEX "analytics_events_siteId_createdAt_idx" ON "analytics_events" ("siteId", "createdAt");
CREATE INDEX "analytics_events_pageId_createdAt_idx" ON "analytics_events" ("pageId", "createdAt");

DROP TABLE "audit_logs";
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "aiInvolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs" ("tenantId", "createdAt");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs" ("entityType", "entityId");

-- Idempotent: creates monthly partitions from the current month up to `months_ahead`.
-- Called here and by the `partition-maintenance` BullMQ cron (daily) so inserts never hit DEFAULT.
CREATE OR REPLACE FUNCTION canon_ensure_monthly_partitions(parent regclass, months_ahead int DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  base_name text := (SELECT relname FROM pg_class WHERE oid = parent);
  start_month date := date_trunc('month', now())::date;
  m int;
  from_d date;
  to_d date;
  part_name text;
BEGIN
  FOR m IN 0..months_ahead LOOP
    from_d := (start_month + make_interval(months => m))::date;
    to_d := (from_d + interval '1 month')::date;
    part_name := format('%s_%s', base_name, to_char(from_d, 'YYYY_MM'));
    IF to_regclass(format('partitions.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE partitions.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, from_d, to_d
      );
    END IF;
  END LOOP;
END;
$$;

-- DEFAULT partitions catch rows if maintenance ever lags; an alert fires when they are non-empty.
CREATE TABLE partitions.analytics_events_default PARTITION OF "analytics_events" DEFAULT;
CREATE TABLE partitions.audit_logs_default PARTITION OF "audit_logs" DEFAULT;

SELECT canon_ensure_monthly_partitions('"analytics_events"'::regclass, 3);
SELECT canon_ensure_monthly_partitions('"audit_logs"'::regclass, 3);
