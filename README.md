# Canon CMS

**AI-native headless CMS with a fact graph as the single source of truth.**
*Change a fact once — the site rewrites itself.*

- Killer feature and economics: [docs/canon.md](docs/canon.md)
- Architecture (C4, ERD, AI flow, events, decisions): [docs/architecture.md](docs/architecture.md)
- Auth, tenancy, RBAC and AI quotas: [docs/auth.md](docs/auth.md)

---

## From zero to the first AI request in 10 minutes

Requirements: Node ≥ 20.11, Docker Desktop, Corepack (bundled with Node; enable once with `corepack enable`).

```bash
corepack enable
```

```bash
pnpm install
```

```bash
cp .env.example .env
```

Edit `.env`: set `SEED_ADMIN_PASSWORD` (≥ 12 chars) and `ENCRYPTION_KEY`
(`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). For real completions also set at least one of `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_API_KEY`, or start Ollama (`pnpm infra:up:full`, then `docker compose exec ollama ollama pull llama3.1:8b`).

```bash
pnpm infra:up
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

```bash
pnpm dev
```

Open the admin at <http://localhost:3000>. You can either:

- **Sign up.** The confirmation email lands in Mailpit at <http://localhost:8035>; the link signs you in as OWNER of a new FREE workspace.
- **Sign in as the seeded super admin.** Use `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`; the admin owns the BUSINESS demo tenant `acme`.

From the command line:

```bash
curl -s localhost:4000/health/ready
```

Sign in as a native client (refresh token in the body) and keep the access token:

```bash
TOKEN=$(curl -s -X POST localhost:4000/v1/auth/login -H "x-canon-client: native" -H "content-type: application/json" -d "{\"email\":\"admin@canon.local\",\"password\":\"$SEED_ADMIN_PASSWORD\"}" | node -pe "JSON.parse(require('fs').readFileSync(0)).accessToken")
```

First AI request:

```bash
curl -s -X POST localhost:4000/v1/ai/complete -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"feature\":\"REWRITE\",\"messages\":[{\"role\":\"user\",\"content\":\"Rewrite in a friendlier tone: Pro costs 49 USD per month.\"}]}"
```

Streaming (SSE):

```bash
curl -N -X POST localhost:4000/v1/ai/complete-stream -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Write a 3-line product tagline\"}]}"
```

Usage, budget and forecast:

```bash
curl -s -H "authorization: Bearer $TOKEN" localhost:4000/v1/ai/usage
```

With no provider configured, the gateway walks the fallback chain and either returns `degradeWith`
(`status: "DEGRADED"`) or `503 AI_ALL_PROVIDERS_FAILED`. Both are recorded in `ai_generations`.

OpenAPI docs: <http://localhost:4000/api/docs> · Prometheus: <http://localhost:4000/metrics>

### Local ports

Host ports are offset so Canon runs next to other stacks; override with `CANON_*_PORT`.

| Service | Port |
|---|---|
| API | 4000 |
| Postgres (pgvector) | 5442 |
| Redis | 6389 |
| MinIO API / console | 9010 / 9011 |
| Mailpit SMTP / UI | 1035 / 8035 |
| Meilisearch | 7710 |
| Langfuse (`--profile observability`) | 3110 |
| Ollama (`--profile local-llm`) | 11434 |
| Qdrant (`--profile vector-scale`) | 6333 |

---

## Monorepo

```
canon-cms/
├── apps/
│   ├── api/                      NestJS 11 — modular monolith (Phases 0–1 ✔)
│   │   ├── src/
│   │   │   ├── main.ts · bootstrap.ts  HTTP pipeline shared with integration tests
│   │   │   ├── instrumentation.ts OpenTelemetry (enabled by OTEL_EXPORTER_OTLP_ENDPOINT)
│   │   │   ├── config/           Zod env schema — boot fails on invalid config
│   │   │   ├── common/
│   │   │   │   ├── auth/         AuthGuard (JWT + API keys), CASL abilities, rate limits, revocation
│   │   │   │   ├── crypto/       argon2id + zxcvbn, AES-GCM fields, RFC 6238 TOTP, tokens
│   │   │   │   └── http/         error format, exception filter, Zod pipe
│   │   │   ├── infrastructure/   Prisma (app + system roles), Redis, mail, audit, Prometheus
│   │   │   └── modules/
│   │   │       ├── identity/     register, verify, login, 2FA, refresh rotation, sessions, reset
│   │   │       ├── tenancy/      tenants, members, invitations, plans & limits
│   │   │       ├── api-keys/     scoped keys for integrations and AI agents
│   │   │       ├── intelligence/ AI gateway, quotas, budget alerts, usage ledger, REST + SSE
│   │   │       └── health/       /health, /health/ready, /metrics
│   │   └── test/                 unit/ (vitest) · integration/ (Testcontainers: Postgres + Redis)
│   ├── admin/                    Next.js 16: auth, workspaces, members, security, AI usage, API keys (Phase 1 ✔; builder 2–3)
│   └── web/                      Next.js public renderer                 (Phase 2)
├── packages/
│   ├── db/                       Prisma schema (47 models), raw SQL migrations, RLS helper, seed
│   ├── ai-gateway/               Provider-agnostic LLM gateway (ports & adapters) + tests
│   ├── blocks/                   Block registry (Zod schemas + renderers) (Phase 3)
│   ├── canon/                    Fact graph domain: extract, lint, propagate (Phase 5)
│   ├── agents/                   LangGraph agent runtime + tool registry  (Phase 5)
│   ├── sdk/                      Typed client (ts-rest/orval)            (Phase 2)
│   └── ui/                       shadcn/ui design system                 (Phase 2)
├── docker/postgres/init/         roles (canon_app, canon_system), langfuse DB
├── docs/                         architecture.md, canon.md, auth.md
├── docker-compose.yml            core + profiles: observability, local-llm, vector-scale
└── turbo.json · pnpm-workspace.yaml · tsconfig.base.json
```

### Scripts

| Command | What it does |
|---|---|
| `pnpm infra:up` / `infra:up:full` / `infra:down` | Docker services (core / + Langfuse + Ollama) |
| `pnpm db:migrate` | `prisma migrate deploy` (includes RLS, partitions, HNSW, tsvector) |
| `pnpm db:migrate:dev` | New migration from schema changes |
| `pnpm db:seed` | Idempotent seed: admin, demo tenant `acme`, 50 blocks, AI models/prompts/agents, Canon demo graph |
| `pnpm dev` | API + admin in watch mode (builds workspace deps first) |
| `pnpm build` / `typecheck` / `test` | Turborepo pipelines (unit tests) |
| `pnpm test:integration` | API integration tests on throwaway Postgres + Redis containers (needs Docker) |

---

## What is in Phase 0

### Data layer
- **47 Prisma models and 28 enums**: identity/tenancy, sites/pages/blocks, collections, media, forms, A/B, analytics, audit, plugins, the full AI ledger (providers, models, generations, prompts, agents, runs, steps, vectors, semantic cache, feedback, guardrail events), the **Canon graph** (entities, facts, versions, mentions, relations, sources), content branches, and the outbox.
- **Raw SQL migrations**:
  - `partitioning`: monthly range partitions for analytics and audit, with a self-maintaining function.
  - `search_indexes`: HNSW cosine ×4, tsvector generated columns + GIN, trigram, JSONB path ops.
  - `partial_unique`: soft-delete-aware uniqueness.
  - `rls`: policies on 41 tables, plus the roles and an append-only audit table.
- **Verified on Postgres 16 + pgvector**: all migrations apply, Prisma drift is empty, RLS isolation behaves as expected, and the seed is idempotent.

### AI gateway (`packages/ai-gateway`)
- Ports & adapters: Anthropic, OpenAI, Google Gemini, Ollama. Every SDK error is normalised to a `ProviderError` (anti-corruption layer).
- Routing: requested model → tenant default → fallbacks. The chain is filtered by the tenant allow-list, required capabilities (vision, JSON) and which providers are configured.
- Resilience: a circuit breaker per provider (bulkhead), retries with full jitter on 429/5xx/network, a timeout and cancellation via `AbortSignal` (client disconnect stops the LLM call), and stream fallback before the first token.
- Fallback ladder: primary → cheaper models → local model → semantic cache at a looser threshold → caller-supplied degrade text.
- Caching: exact (Redis, tenant-scoped, keyed by model) and semantic (pgvector, tenant-scoped via RLS).
- Guardrails: prompt-injection/jailbreak heuristics, PII redaction (email, Luhn-checked cards, IBAN, phone) before sending and always before storing, and an output check. Refusals are terminal: never re-routed.
- Cost: integer micro-USD per call. Redis quotas give a per-minute rate limit and a monthly budget (hard/soft). Redis failure fails open.
- Observability: `ai_generations` and `ai_guardrail_events` rows, Langfuse ingestion (batched, never blocks), and Prometheus counters/histograms without tenant labels.
- **23 unit tests** (vitest) covering fallback, retry, refusal, degrade, cache isolation, guardrails, quota, capabilities, allow-list, streaming and pricing.

### API (`apps/api`)
- Endpoints: `POST /v1/ai/complete`, `POST /v1/ai/complete-stream` (SSE), `POST /v1/ai/embed`, `GET /v1/ai/models`, `GET /health`, `GET /health/ready`, `GET /metrics`.
- Errors have a single shape: `{ error: { code, message, details?, requestId } }`. AI error codes map to 400/402/403/422/429/503.
- Pino structured logs with a request id, tenant id and redacted secrets.

### Known limits
- No real LLM call has been run in this environment (no provider keys). The adapters are typechecked against the installed SDKs (`@anthropic-ai/sdk` 1.x, `openai` 7.x, `@google/genai` 2.x), and the gateway logic is covered by tests with fake providers.
- Model prices for OpenAI/Google in the seed must be re-checked against provider pricing pages before billing goes live.

## What is in Phase 1

Details and threat model: [docs/auth.md](docs/auth.md).

- **Identity**:
  - registration with enumeration-safe responses and email verification (the link signs you in);
  - password login with per-email lockout and per-IP sliding-window limits;
  - 15-min JWT plus rotating refresh tokens (httpOnly SameSite=Strict cookie) with reuse detection that revokes the whole session family;
  - instant revocation via a Redis deny-list;
  - TOTP 2FA (RFC 6238, encrypted secret, replay guard, single-use backup codes);
  - forgot/reset/change password (signs out other sessions);
  - session list and revoke.
- **Tenancy**:
  - FREE workspace on signup, more via `POST /tenants`, `switch-tenant`;
  - invitations bound to the invited email, which a new user can redeem at registration;
  - roles OWNER/ADMIN/EDITOR/AUTHOR/VIEWER with last-owner protection;
  - plan limits with per-tenant overrides.
- **RBAC**: CASL abilities in the API (route and instance level, every rule tenant-scoped). The same packed rules are sent to the admin UI for gating.
- **API keys**: scoped (`content:*`, `ai:invoke`, `canon:*`…), hashed, per-key rate limit, agent keys flagged in the audit log.
- **AI quotas**:
  - model tiers per plan;
  - per-workspace and per-user requests/min;
  - concurrency slots (released on stream abort);
  - monthly token allowance and USD budget (hard/soft);
  - 50/80/100% alerts as notifications and email;
  - Redis counters re-seeded from the ledger;
  - `/ai/usage` with breakdowns and a forecast.
- **Admin** (Next.js 16, Tailwind, TanStack Query, react-hook-form + Zod):
  - sign-in, 2FA step, sign-up, invite acceptance, verify/reset flows;
  - workspace switcher and creation;
  - members and invitations, security (2FA enrollment with a locally rendered QR, password, devices), AI usage, API keys.
  - The access token is held in memory only; the browser talks to the API through the same-origin `/api/v1` proxy.
- **Tests: 79, all green.**
  - 28 gateway unit tests (quotas, tiers, slots).
  - 17 API unit tests (RFC 6238 vectors, AES-GCM tamper, password policy, RBAC matrix, plans, alert thresholds).
  - 34 integration tests against real Postgres + Redis: signup/verify, lockout, IP rate limit, rotation and reuse detection, logout and device revocation, untrusted Origin, reset, 2FA with replay rejection and backup codes, invitations, role escalation attempts, forced refresh on demotion, last owner, seat limits, tenant isolation, RLS fail-closed, API key scopes and revocation, AI tier/rate/concurrency/token caps, VIEWER cannot invoke AI.
- Also verified by hand in the browser: signup → Mailpit → verification → dashboard, session restored after reload, invitation, 2FA enrollment, sign-in with a TOTP code.

## Phase 1 checklist

- [x] Auth module: register, login, refresh with rotation and reuse detection, logout, verify email, forgot/reset/change password, 2FA (TOTP + backup codes), sessions
- [x] Users, tenants, invitations, members with role rules and plan seat limits
- [x] RBAC via CASL (route and instance checks) + scoped API keys for AI agents
- [x] AI quota system: plan tiers, rate/user rate, concurrency, tokens, budget, alerts, usage report
- [x] Admin frontend: login/2FA, register, verify, reset, invite, workspace switcher, members, security, AI usage, API keys
- [x] Migration `20261023000000_auth` (zero drift)
- [x] Unit + integration tests; CI job for integration tests

Deferred on purpose: OAuth social login, WebAuthn/passkeys and SAML/OIDC SSO move to Phase 7 (Enterprise), as do Stripe-driven plan changes.

## Phase 0 checklist

- [x] Architecture diagrams: C4 context/container/component, ERD, AI flow, event flow
- [x] Full `schema.prisma` with AI and Canon models, enums, relations, indexes
- [x] Raw SQL: RLS, partitioning, pgvector HNSW, tsvector/trigram, partial uniques
- [x] Monorepo structure, `turbo.json`, root `package.json`, `pnpm-workspace.yaml`
- [x] `docker-compose.yml`: Postgres+pgvector, Redis, MinIO, Mailpit, Meilisearch, plus Langfuse v3, Ollama and Qdrant profiles
- [x] `apps/api`: `main.ts`, `AppModule`, Zod config
- [x] `packages/db`: Prisma client, RLS tenant extension, seed (admin, tenant, site, blocks, pages, AI prompts, agents, Canon demo)
- [x] AI gateway: adapters (Anthropic, OpenAI, Google, Ollama), fallback, caching, Langfuse integration
- [x] README: from zero to the first AI request
