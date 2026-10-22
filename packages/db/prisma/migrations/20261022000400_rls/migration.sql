-- Row-Level Security: layer 2 of tenant isolation (layer 1 = app-side tenantId filters).
--
-- Session contract (set per transaction by packages/db withTenant / withUser, is_local = true):
--   app.tenant_id — active tenant; absent → tenant-scoped tables return nothing (fail closed)
--   app.user_id   — authenticated user; lets login list "my tenants" before a tenant is chosen
--
-- Roles:
--   canon_app    — API runtime. RLS applies (not owner, NOBYPASSRLS).
--   canon_system — cross-tenant workers (outbox relay, schedulers, partition maintenance). BYPASSRLS.
-- Prod provisions both with LOGIN via Terraform/Vault; NOLOGIN here keeps the migration self-contained.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canon_app') THEN
    CREATE ROLE canon_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canon_system') THEN
    CREATE ROLE canon_system NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION canon_current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE OR REPLACE FUNCTION canon_current_user() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

-- ── Standard tenant-scoped tables ────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'invitations', 'api_keys', 'sites', 'pages', 'page_versions', 'collections', 'entries',
    'entry_versions', 'media', 'webhooks', 'webhook_deliveries', 'forms', 'form_submissions',
    'ab_tests', 'ab_test_events', 'analytics_events', 'audit_logs', 'scheduled_publishes',
    'plugin_instances', 'ai_generations', 'ai_prompt_runs', 'ai_agents', 'ai_agent_runs',
    'ai_agent_steps', 'ai_vector_documents', 'ai_semantic_cache', 'ai_feedback',
    'ai_guardrail_events', 'kg_entities', 'facts', 'fact_versions', 'fact_mentions',
    'fact_relations', 'fact_sources', 'content_branches', 'branch_changes', 'outbox_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the table owner is also subject to policies (except superusers / BYPASSRLS).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = canon_current_tenant()) '
      'WITH CHECK ("tenantId" = canon_current_tenant())', t);
  END LOOP;
END
$$;

-- ── Special cases ───────────────────────────────────────────────────────────

-- Memberships: visible inside the tenant, or to the member themself (tenant switcher, login).
ALTER TABLE "tenant_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_members"
  USING ("tenantId" = canon_current_tenant() OR "userId" = canon_current_user())
  WITH CHECK ("tenantId" = canon_current_tenant());

-- Tenants: the active one, or any the current user belongs to.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING (
    "id" = canon_current_tenant()
    OR EXISTS (SELECT 1 FROM "tenant_members" m WHERE m."tenantId" = "tenants"."id" AND m."userId" = canon_current_user())
  )
  WITH CHECK ("id" = canon_current_tenant());

-- Prompts: platform defaults (tenantId NULL) are readable by everyone, writable by nobody via canon_app.
ALTER TABLE "ai_prompts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_prompts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_prompts"
  USING ("tenantId" IS NULL OR "tenantId" = canon_current_tenant())
  WITH CHECK ("tenantId" = canon_current_tenant());

-- Notifications are per user; tenantId is only a filter hint.
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON "notifications"
  USING ("userId" = canon_current_user())
  WITH CHECK ("userId" = canon_current_user());

-- Global tables (users, sessions, blocks, plugins, ai_providers, ai_models) are not tenant data;
-- access to them is mediated by the auth module, so they carry no RLS.

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public, partitions TO canon_app, canon_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO canon_app, canon_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA partitions TO canon_app, canon_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO canon_app, canon_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA partitions GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO canon_app, canon_system;
GRANT EXECUTE ON FUNCTION canon_current_tenant(), canon_current_user() TO canon_app, canon_system;
GRANT EXECUTE ON FUNCTION canon_ensure_monthly_partitions(regclass, int) TO canon_system;

-- Audit log is append-only for the API: tampering requires a different role (and leaves a trace in pgaudit).
REVOKE UPDATE, DELETE ON "audit_logs" FROM canon_app;
