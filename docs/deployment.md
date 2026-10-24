# Deploying Canon

This guide takes Canon from a repository checkout to a production installation: what runs where,
how to build and roll out, what to configure (database roles, secrets, Stripe, SSO, AI), and how to
operate it (scaling, backups, upgrades, incident levers).

## 1. What runs

| Component | Image / process | Scales | State |
|---|---|---|---|
| **API** (`apps/api`, NestJS) | `canon-api` | horizontally, stateless | none — Postgres, Redis, S3 |
| **Admin** (`apps/admin`, Next.js) | `canon-admin` | horizontally | none |
| **Renderer** (`apps/web`, Next.js, multi-domain ISR) | `canon-web` | horizontally | ISR cache (local, rebuilt on demand) |
| **Migrations** | `canon-migrate` (one-off job) | — | — |
| PostgreSQL 16 + **pgvector** | managed (RDS, Cloud SQL, Neon, Crunchy) | vertical + read replicas | all content, audit, analytics |
| Redis 7 | managed (ElastiCache, Upstash, Memorystore) | — | queues (BullMQ), caches, rate limits, realtime |
| S3-compatible storage | S3, R2, GCS (S3 API), MinIO | — | media |
| SMTP | SES, Postmark, Mailgun | — | — |

Every API replica also runs the background workers (outbox relay, webhooks, publishing schedule,
AI enrichment, Canon agents, analytics rollups, billing overage, audit sealing). BullMQ and
`FOR UPDATE SKIP LOCKED` make that safe with any number of replicas; recurring jobs are
deduplicated with `upsertJobScheduler`. Each family can be switched off per process with an env
flag (`SCHEDULER`, `ENRICHMENT`, `KNOWLEDGE`, `CANON_EXTRACT`, `CANON_PROPAGATE`, `ANALYTICS_FLUSH`,
`ANALYTICS_JOBS`, `WEBHOOKS`, `BILLING_JOBS`, `COMPLIANCE_JOBS` = `off`) to split HTTP and worker
pools when you need to.

Traffic paths:

```
browser ── https://app.example.com ──► admin ──/api/v1/*──► api   (cookies stay first-party)
browser ── wss://app.example.com/api/v1/collab ─────────────► api   (Yjs co-editing, via the same proxy)
visitor ── https://<site>.sites.example.com ──► web ──► api /v1/delivery (delivery token)
Stripe  ── https://app.example.com/api/v1/billing/webhook ──► api
IdP     ── https://app.example.com/api/v1/auth/sso/saml/<id>/acs ──► api
agents  ── https://app.example.com/api/v1/mcp (Bearer ck_…) ──► api
```

## 2. Database

Canon uses three Postgres roles; never give the API the owner credentials.

| Role | Used by | Rights |
|---|---|---|
| `canon` (owner) | migrations, seed | owns the schema |
| `canon_app` | API request path | `NOBYPASSRLS` — every tenant table is protected by row-level security |
| `canon_system` | workers, cross-tenant jobs | `BYPASSRLS`, still no DDL |

`docker/postgres/init/00-roles-and-dbs.sql` creates the roles for a self-hosted database; on a managed
database run the same statements once as an admin, **with strong passwords**. Extensions needed:
`vector`, `pg_trgm`, `pgcrypto` (created by the first migration; the owner needs the right to
create them, or have them pre-installed).

Migrations are plain SQL under `packages/db/prisma/migrations` (Prisma Migrate) and include RLS
policies, partitions (`audit_logs` and `analytics_events` are partitioned monthly) and
grants. Apply them before every rollout:

```bash
docker run --rm -e DATABASE_URL="$MIGRATE_DATABASE_URL" registry.example.com/canon-migrate:$TAG
```

Migrations are additive within a release line, so old API replicas keep working against the new
schema during a rolling update.

## 3. Build

```bash
docker build -f docker/Dockerfile --target api     -t registry.example.com/canon-api:$TAG .
docker build -f docker/Dockerfile --target admin   -t registry.example.com/canon-admin:$TAG .
docker build -f docker/Dockerfile --target web     -t registry.example.com/canon-web:$TAG .
docker build -f docker/Dockerfile --target migrate -t registry.example.com/canon-migrate:$TAG .
```

All four targets share one build stage (BuildKit caches it). The admin and renderer are Next.js
`standalone` servers; the API image carries production dependencies only and runs as `node`
under `tini`. `NEXT_PUBLIC_CANON_COLLAB_URL` (build arg) is only needed when the collaboration
WebSocket must bypass the admin proxy.

CI should run, in order: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, unit tests
(`pnpm -r test`), integration tests (`pnpm --filter @canon/api test:integration`, uses
Testcontainers — needs Docker), then the image builds.

## 4. Configuration

All configuration is environment variables, validated at boot (`apps/api/src/config/env.ts`): the
API refuses to start on invalid values, and in production also on development secrets,
`MAIL_TRANSPORT=memory` and `SSO_DOMAIN_VERIFICATION=off`. A complete template is
`deploy/.env.production.example`.

| Variable | Notes |
|---|---|
| `APP_DATABASE_URL`, `SYSTEM_DATABASE_URL` | `canon_app` / `canon_system` connections (use a pooler such as PgBouncer in transaction mode for many replicas) |
| `REDIS_URL` | `rediss://` in production; `maxmemory-policy noeviction` (queues must not be evicted) |
| `JWT_ACCESS_SECRET` | ≥ 32 random chars; rotating it signs everyone out of access tokens (refresh tokens survive) |
| `ENCRYPTION_KEY` | 32 bytes base64 — encrypts TOTP seeds, webhook and plugin secrets. Keep it in a secret manager; rotating requires re-encryption |
| `ADMIN_PUBLIC_URL`, `API_PUBLIC_URL` | public URLs; SSO, Stripe redirects and e-mails are built from them |
| `PUBLIC_SITES_DOMAIN` | sites get `<site>-<tenant>.<domain>`; point a wildcard DNS record and certificate at the renderer |
| `DELIVERY_TOKEN`, `REVALIDATE_SECRET`, `WEB_REVALIDATE_URL` | shared between API and renderer |
| `TRUST_PROXY` | subnets of your load balancers, so rate limits and audit IPs see the real client |
| `S3_*` | bucket, credentials, `S3_PUBLIC_URL` (CDN in front of the bucket) |
| `SMTP_URL`, `MAIL_FROM` | transactional mail (verification, invites, billing notices) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL` | any subset; without providers Canon still works (deterministic fallbacks) |
| `AI_DEFAULT_MODEL`, `AI_FALLBACK_MODELS`, `AI_EMBEDDING_MODEL` | `provider/model` keys |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `STRIPE_AI_METER_EVENT` | billing (§5) |
| `SSO_DOMAIN_VERIFICATION` | `dns` in production (§6) |
| `LANGFUSE_*`, `OTEL_EXPORTER_OTLP_ENDPOINT` | LLM tracing and OpenTelemetry |

## 5. Billing (Stripe)

1. In Stripe create a product per paid plan (Pro, Business) with a **monthly recurring price**;
   put the price ids in `STRIPE_PRICE_PRO` / `STRIPE_PRICE_BUSINESS`.
2. For AI overage create a **Billing Meter** with event name `canon_ai_overage_cents`
   (or set `STRIPE_AI_METER_EVENT`), aggregation *sum*, customer mapping by `stripe_customer_id`,
   and add a metered price on that meter to each paid product (e.g. $0.01 per unit = 1 cent).
3. Add a webhook endpoint `https://app.example.com/api/v1/billing/webhook` with the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`; put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.
4. Enable the **customer portal** (plan switching between the two prices, cancellation, invoices).

How it behaves: the plan changes only from signature-verified webhooks — never from the
checkout redirect. Events are idempotent (`billing_events`) and ordered (`lastEventAt`), so retries
and late deliveries cannot roll a tenant back. `PAST_DUE` keeps paid features during Stripe's
retries; cancellation or `unpaid` returns the tenant to Free. Enterprise is contract-managed:
platform admins set it with `PATCH /v1/platform/tenants/:id/plan`, and Stripe events never change it.
AI overage above the plan's included budget is reported hourly to the meter as a delta, with an
idempotent identifier. Without `STRIPE_SECRET_KEY`, billing is read-only and super admins set plans.

## 6. Single sign-on (SAML 2.0, Enterprise)

Workspace owners configure SSO in **Settings → Single sign-on**:

1. Give the IdP the **ACS URL** and **Entity ID** shown there (or the metadata URL). NameID format:
   email address; sign the assertion (SHA-256). Attribute `email` (or the standard claim URIs) and
   optionally `displayName`.
2. Paste the IdP's SSO URL, entity id and signing certificate.
3. **Verify each email domain** with a DNS TXT record
   `_canon-verification.<domain>  "canon-verification=<token>"`. Only verified domains route
   sign-ins and enforce SSO; a domain can be verified by one workspace only; consumer mail domains
   are refused.
4. Optionally **require SSO**: password login is then refused for members on those domains, while
   owners keep password access as a break-glass path.

Security properties: responses must be signed by the configured certificate, answer an
AuthnRequest issued by Canon (`InResponseTo`, single use, stored in Redis for 10 minutes), target
the right audience and ACS, and carry an email on a verified domain. Users are provisioned just in
time with the connection's default role. SSO sign-ins bypass Canon's own 2FA (the IdP enforces MFA)
and are written to the audit log.

## 7. Plugins, webhooks and MCP

- **Webhooks** are delivered by the API workers with exponential backoff (8 attempts over ~40
  minutes), signed `Canon-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`, with an
  `Idempotency-Key` stable across retries. In production, targets must be HTTPS and resolve to
  public addresses (checked when saved and before each delivery). Endpoints with 15 consecutive
  dead deliveries are paused. Allow egress from the API to the internet for this.
- **Plugins** are integrations, not code executed by Canon: they receive events (signed webhooks or
  a built-in adapter such as Slack), act through a scoped API key the tenant consented to, and
  contribute block presets made of built-in blocks. First-party marketplace manifests live in
  `apps/api/src/modules/plugins/catalog.ts` and are synced at boot; Business and Enterprise
  workspaces can register private plugins from a manifest.
- **MCP**: `POST /v1/mcp` is a stateless Streamable-HTTP Model Context Protocol server. Agents
  authenticate with an API key (`Authorization: Bearer ck_…`); the tools offered follow the key's
  scopes, and writes are limited to drafts and review branches.

## 8. Kubernetes and single-host

- `deploy/k8s/canon.yaml` — namespace, config, secret template, migration job, API (3+ replicas,
  PDB, HPA, probes on `/health` and `/health/ready`), admin, renderer (HPA), and an nginx ingress
  with long WebSocket timeouts for co-editing. Run the migration job before updating deployments
  (Argo CD / Helm hook / CI step).
- `deploy/docker-compose.prod.yml` — Postgres, Redis, migrate, API, admin and renderer on one host
  behind your TLS proxy; copy `deploy/.env.production.example` to `deploy/.env.production`.

Ingress requirements: WebSocket upgrade for `/api/v1/collab/*`, request bodies up to the media
upload limit, `X-Forwarded-For`/`X-Forwarded-Host` passed through, and the wildcard sites domain
plus customer custom domains routed to the renderer.

## 9. Operations

- **Health**: `/health` (liveness), `/health/ready` (database and Redis).
- **Logs**: JSON (pino) with request ids; secrets and auth headers are redacted.
- **Tracing / metrics**: OpenTelemetry (`OTEL_EXPORTER_OTLP_ENDPOINT`); LLM calls in Langfuse.
- **Backups**: Postgres PITR (WAL archiving) is the source of truth; S3 versioning for media. Redis
  holds only queues and caches — after a loss, jobs are re-created by the outbox and schedulers.
- **Retention**: partitions for `audit_logs` and `analytics_events` are created
  three months ahead by the hourly compliance job; drop old analytics partitions per your policy (daily rollups keep history). Audit
  partitions should be kept for your compliance period (the daily hash chain lets auditors verify
  them: Settings → Audit log → Verify).
- **Tenant deletion**: deleted workspaces are purged 30 days later (`COMPLIANCE_JOBS`).
- **Upgrades**: build images → run `canon-migrate` → roll API, then admin and renderer. Roll back by
  redeploying the previous images (migrations are forward-compatible within a minor line).
- **Incident levers**: pause a noisy webhook or plugin from the admin; switch a worker family off
  with its env flag; cap AI spend per tenant in Settings → AI usage or globally by removing a
  provider key; rotate `DELIVERY_TOKEN` / `REVALIDATE_SECRET` together on API and renderer.

## 10. Security checklist

- [ ] Owner DB credentials only in the migration job; API uses `canon_app` / `canon_system` with strong passwords
- [ ] `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`, `DELIVERY_TOKEN`, `REVALIDATE_SECRET` from a secret manager
- [ ] TLS everywhere; `AUTH_COOKIE_DOMAIN` set only if admin and API are on different subdomains
- [ ] `TRUST_PROXY` set to your load balancer subnets
- [ ] Redis with auth + TLS, `noeviction`
- [ ] S3 bucket private, served through a CDN; upload size limit set
- [ ] Stripe webhook secret configured; only the listed events enabled
- [ ] `SSO_DOMAIN_VERIFICATION=dns`
- [ ] Egress allowed for webhooks/AI providers; ingress to the API only through the admin proxy and the renderer
- [ ] PITR backups tested by restoring into a staging environment
