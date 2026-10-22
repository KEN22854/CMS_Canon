# Canon CMS

**AI-native headless CMS with a fact graph as the single source of truth.**
*Change a fact once — the site rewrites itself.*

- Killer feature and economics: [docs/canon.md](docs/canon.md)
- Architecture (C4, ERD, AI flow, events, decisions): [docs/architecture.md](docs/architecture.md)

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

Edit `.env` and set `SEED_ADMIN_PASSWORD` (≥ 12 chars). For real completions also set at least one of `ANTHROPIC_API_KEY`,
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

Check it:

```bash
curl -s localhost:4000/health/ready
```

```bash
curl -s -H "x-tenant-slug: acme" localhost:4000/v1/ai/models
```

First AI request (the dev-only `x-tenant-slug` header stands in for auth until Phase 1):

```bash
curl -s -X POST localhost:4000/v1/ai/complete -H "x-tenant-slug: acme" -H "content-type: application/json" -d "{\"feature\":\"REWRITE\",\"messages\":[{\"role\":\"user\",\"content\":\"Rewrite in a friendlier tone: Pro costs 49 USD per month.\"}]}"
```

Streaming (SSE):

```bash
curl -N -X POST localhost:4000/v1/ai/complete-stream -H "x-tenant-slug: acme" -H "content-type: application/json" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Write a 3-line product tagline\"}]}"
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
│   ├── api/                      NestJS 11 — modular monolith (Phase 0 ✔)
│   │   └── src/
│   │       ├── main.ts           helmet, CORS, compression (SSE-safe), versioning, Swagger, shutdown
│   │       ├── instrumentation.ts OpenTelemetry (enabled by OTEL_EXPORTER_OTLP_ENDPOINT)
│   │       ├── config/           Zod env schema — boot fails on invalid config
│   │       ├── common/           error format, exception filter, Zod pipe, tenancy
│   │       ├── infrastructure/   Prisma (app + system roles), Redis, Prometheus
│   │       └── modules/
│   │           ├── health/       /health, /health/ready, /metrics
│   │           └── intelligence/ AI gateway composition root, REST + SSE
│   ├── admin/                    Next.js admin + page builder            (Phase 2–3)
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
├── docs/                         architecture.md, canon.md
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
| `pnpm dev` | API in watch mode (builds workspace deps first) |
| `pnpm build` / `typecheck` / `test` | Turborepo pipelines |

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

### Known limits (by design, next phases)
- Auth is a dev-only tenant header and is hard-disabled in production. JWT/API keys/RBAC come in Phase 1.
- No real LLM call has been run in this environment (no provider keys). The adapters are typechecked against the installed SDKs (`@anthropic-ai/sdk` 1.x, `openai` 7.x, `@google/genai` 2.x), and the gateway logic is covered by tests with fake providers.
- Model prices for OpenAI/Google in the seed must be re-checked against provider pricing pages before billing goes live.

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
