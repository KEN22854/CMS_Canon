-- Runs once on first container start (docker-entrypoint-initdb.d).
--
-- Two roles by design:
--   canon      — owner/migrator (superuser in dev only). Runs migrations and seed.
--   canon_app    — runtime role used by the API. NOT owner, NOBYPASSRLS, so RLS policies
--                  always apply to it. Prod must never hand the owner credentials to the API.
--   canon_system — cross-tenant background workers (BYPASSRLS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canon_app') THEN
    CREATE ROLE canon_app LOGIN PASSWORD 'canon_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canon_system') THEN
    CREATE ROLE canon_system LOGIN PASSWORD 'canon_system' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE canon TO canon_app, canon_system;

CREATE DATABASE langfuse;
