# Canon CMS

**An AI-native headless CMS with a fact graph as the single source of truth.**
*Change a fact once — the site rewrites itself.*

**English** · [Русский](README.ru.md)

---

## What is Canon

Canon is a multi-tenant headless CMS for marketing and product teams. You get a visual page builder,
structured collections, a multi-domain renderer and a REST API, with AI built in throughout.

What sets it apart is **Canon, the fact graph**. Prices, limits, dates and other claims live once as
typed, versioned facts. Canon finds every place on every site and in every language where a fact is
mentioned, including paraphrases. When the fact changes, a team of AI agents rewrites the affected
copy in a review branch, and a human merges it.

```
Fact "Pro plan price" $49 → $59
   └─► linter finds 14 mentions on 6 pages in 3 locales (incl. "forty-nine dollars")
        └─► Strategist → Copywriter / Translator → Fact-checker rewrite them in a branch
             └─► editor reviews per-span diffs → merge (CAS) → publish → site updated
```

## Features

**Content**
- Visual page builder: drag and drop, nested layouts, breakpoints, undo/redo, inline AI for blocks and whole pages.
- Collections with a field schema, relations, validation for drafts and for publishing, CSV/JSON import and export, and a headless content API.
- Multi-domain renderer (Next.js) with ISR, on-demand revalidation, previews, locales and hreflang.
- Media library with variants and AI alt text.

**AI**
- Provider-agnostic gateway (Anthropic, OpenAI, Google, Ollama) with fallbacks and caching. It also enforces guardrails, PII redaction, per-tenant quotas and budgets, and keeps a cost ledger.
- RAG: hybrid search (full-text + pgvector, RRF) and grounded answers with citations.
- AI Studio: versioned prompts, ReAct agents with read-only tools, model playground.
- Auto-tagging, summaries, quality scores and duplicate detection for entries.

**Canon fact graph**
- Typed facts with history and impact analysis, and a linter for contradictions (deterministic + LLM).
- "Bind to fact" tokens that can never drift.
- A multi-agent propagation team working in review branches; merges use compare-and-swap.

**Growth**
- Realtime co-editing (Yjs) with presence, per-user undo and leader-elected autosave.
- First-party, privacy-first analytics with AI insights.
- A/B testing with variants assigned at the edge and statistics that are safe to watch mid-test.
- Personalization by audience segments.

**Platform and enterprise**
- Billing with Stripe: checkout, customer portal, dunning, AI overage metering.
- Plugins and a marketplace: integrations act through scoped API keys after explicit consent and can add block presets to the builder.
- Webhooks: signed, retried, with a delivery log and SSRF protection.
- **MCP server** for AI agents. The available tools depend on the API key's scopes, and agents can never publish.
- SAML single sign-on with DNS-verified domains and just-in-time provisioning.
- Audit log with a daily hash chain, GDPR export and erasure, workspace export.
- Multi-tenancy enforced by Postgres row-level security, RBAC, 2FA, API keys.

## Tech stack

| Layer | Technology |
|---|---|
| API | NestJS 11 (modular monolith), Prisma 6, Zod, BullMQ, transactional outbox |
| Data | PostgreSQL 16 + pgvector (RLS, partitions, HNSW, tsvector), Redis 7, S3 |
| Admin | Next.js 16, React 19, TanStack Query, Zustand + zundo, dnd-kit, TipTap 3, Tailwind |
| Renderer | Next.js 16, multi-domain proxy, ISR |
| Realtime | Yjs, y-protocols over WebSocket, Redis fan-out |
| AI | Anthropic / OpenAI / Google / Ollama adapters, Langfuse, OpenTelemetry |
| Integrations | Stripe, SAML 2.0 (`@node-saml/node-saml`), Model Context Protocol SDK |
| Tooling | pnpm workspaces, Turborepo, Vitest, Testcontainers, Docker |

## Architecture

```
browser ── admin (Next.js) ──/api/v1──► API (NestJS) ──► Postgres + pgvector (RLS)
   │            └── ws: /api/v1/collab ──┘      │   ├──► Redis (queues, cache, realtime)
visitor ── renderer (Next.js, ISR) ── delivery ─┘   ├──► S3 (media)
AI agents ── MCP /v1/mcp ──► API                    └──► LLM providers · Stripe · IdPs · webhooks
```

The API is stateless and also runs the background workers (outbox relay, webhooks, AI enrichment,
Canon agents, analytics rollups, billing, audit sealing). BullMQ coordinates them, so you can add
replicas freely. The full picture (C4, data model, AI flow, events, decisions) is in
[docs/architecture.md](docs/architecture.md).

## Quick start

Requirements: Node ≥ 20.11, Docker Desktop, Corepack (`corepack enable` once).

```bash
corepack enable
```

```bash
pnpm install
```

```bash
cp .env.example .env
```

Edit `.env`. Set `SEED_ADMIN_PASSWORD` (≥ 12 chars) and `ENCRYPTION_KEY`; you can generate the key with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. For real AI completions,
also add at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or run Ollama.
Without any of them, Canon still works on its deterministic fallbacks.

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

- Admin: <http://localhost:3000> (sign up — the confirmation e-mail lands in Mailpit at <http://localhost:8035> — or sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`)
- Sites: <http://localhost:3001> (each site gets `<site>-<tenant>.canon.localhost:3001`)
- API docs (OpenAPI): <http://localhost:4000/api/docs> · health: <http://localhost:4000/health/ready> · metrics: <http://localhost:4000/metrics>

### Local ports

Host ports are offset so Canon can run next to other stacks; override them with `CANON_*_PORT`.

| Service | Port |
|---|---|
| Admin / renderer / API | 3000 / 3001 / 4000 |
| Postgres (pgvector) | 5442 |
| Redis | 6389 |
| S3 (SeaweedFS) | 9010 |
| Mailpit SMTP / UI | 1035 / 8035 |
| Meilisearch | 7710 |
| Langfuse (`--profile observability`) | 3110 |
| Ollama (`--profile local-llm`) | 11434 |

## Repository layout

```
canon-cms/
├── apps/
│   ├── api/          NestJS API: identity, tenancy, sites, pages, collections, media, delivery,
│   │                 AI gateway, knowledge (RAG), Canon, studio, analytics, experiences, collab,
│   │                 billing, compliance, SSO, webhooks, plugins, MCP
│   ├── admin/        Next.js admin: builder, collections, Canon, AI Studio, analytics,
│   │                 experiments, audiences, billing, integrations, audit, SSO
│   └── web/          Next.js multi-domain renderer with edge variant assignment and tracker
├── packages/
│   ├── db/           Prisma schema (57 models), SQL migrations (RLS, partitions, indexes), seed
│   ├── ai-gateway/   provider-agnostic LLM gateway
│   ├── blocks/       block schemas, rich text, tree validation
│   ├── ui-blocks/    shared block renderers (builder canvas and public sites)
│   ├── fields/       collection field types, validation, CSV, schema diffs
│   ├── edge/         visitor context, segments, sticky A/B assignment, block patches
│   └── collab/       page draft ⇄ Yjs document
├── docker/           Dockerfile (api, admin, web, migrate) and Postgres init (roles)
├── deploy/           production docker-compose, Kubernetes manifests, env template
└── docs/             architecture, Canon, auth, deployment, build log by phase
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm infra:up` / `infra:up:full` / `infra:down` | Docker services (core / + Langfuse and Ollama / stop) |
| `pnpm db:migrate` / `db:migrate:dev` / `db:seed` / `db:reset` | apply migrations / create one / seed demo data / reset |
| `pnpm dev` | API, admin and renderer in watch mode |
| `pnpm build` / `typecheck` / `test` | Turborepo pipelines (unit tests) |
| `pnpm test:integration` | API integration tests on throwaway Postgres + Redis containers (needs Docker) |
| `pnpm --filter @canon/api test:coverage` | unit + integration tests with V8 coverage |

## Tests

234 tests, all green:

| Package | Tests |
|---|---|
| fields · blocks · ai-gateway | 15 · 16 · 30 |
| edge · collab | 8 · 6 |
| admin | 7 |
| API unit | 35 |
| API integration (real Postgres + Redis, fake LLM, Stripe and IdP) | 117 |

API coverage: 81% statements, 87% lines, 83% functions, 66% branches.

## Deployment

One Dockerfile builds four images (`api`, `admin`, `web`, `migrate`). For running them in
production there are:

- `deploy/docker-compose.prod.yml` for a single host;
- `deploy/k8s/canon.yaml` for Kubernetes (probes, PDB, HPA, a WebSocket-ready ingress).

[docs/deployment.md](docs/deployment.md) covers database roles, the configuration reference, setting up
Stripe and SAML, scaling, backups, upgrades and a security checklist.

## Documentation

| Document | Contents |
|---|---|
| [docs/canon.md](docs/canon.md) | the fact graph: model, linter, propagation, API, economics |
| [docs/architecture.md](docs/architecture.md) | C4 diagrams, data model, AI flow, events, decisions |
| [docs/auth.md](docs/auth.md) | authentication, tenancy, RBAC, AI quotas, threat model |
| [docs/deployment.md](docs/deployment.md) | production deployment and operations |
| [docs/phases.md](docs/phases.md) | build log: what each phase delivered, checklists, manual checks |

## Build history

| Phase | Scope |
|---|---|
| [0](docs/phases.md#what-is-in-phase-0) | Monorepo, data model, RLS, AI gateway |
| [1](docs/phases.md#what-is-in-phase-1) | Auth, tenancy, RBAC, API keys, AI quotas |
| [2](docs/phases.md#what-is-in-phase-2) | Sites, pages, media, renderer, AI writing tools |
| [3](docs/phases.md#what-is-in-phase-3) | Visual page builder with inline AI |
| [4](docs/phases.md#what-is-in-phase-4) | Collections, entries, import/export, AI enrichment |
| [5](docs/phases.md#what-is-in-phase-5) | RAG, Canon agent team, AI Studio |
| [6](docs/phases.md#what-is-in-phase-6) | Realtime collaboration, analytics, A/B testing, personalization |
| [7](docs/phases.md#what-is-in-phase-7) | Billing, plugins, webhooks, MCP, SSO, compliance, deployment |

## Known limitations

- Real LLM providers, Stripe and SAML identity providers have not been called from this
  environment. The adapters are typechecked against the official SDKs and APIs, and the flows are
  covered by integration tests with fakes: a fake Ollama, a fake Stripe server, and SAML responses
  signed with test certificates.
- Model prices in the seed should be checked against the providers' pricing pages before billing goes live.
