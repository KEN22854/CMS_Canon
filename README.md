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
| S3 (SeaweedFS) | 9010 |
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
│   ├── admin/                    Next.js 16: auth, workspaces, sites, pages editor, media, AI (Phases 1–2 ✔; visual builder: 3)
│   └── web/                      Next.js 16 multi-domain renderer: proxy.ts → /s/<host>, ISR + tag revalidation, preview (Phase 2 ✔)
├── packages/
│   ├── db/                       Prisma schema (47 models), raw SQL migrations, RLS helper, seed
│   ├── ai-gateway/               Provider-agnostic LLM gateway (ports & adapters) + tests
│   ├── blocks/                   Block schemas, rich text, tree validation & text helpers (Phase 2 ✔; full set: 3)
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

## What is in Phase 5

The AI core and the Canon killer feature: **change a fact once, and the site rewrites itself.** Everything works without any AI keys too. The model-free path is the deterministic linter, the literal-substitution fallback, full-text search and template answers built from facts.

- **RAG** (`modules/knowledge`):
  - **ingestion of published content only** (page and entry snapshots) via outbox → the `ai-index` queue;
  - chunking by block or field with the heading kept in each chunk, sentence-boundary cuts with overlap, short blocks merged;
  - BOUND facts are rendered with their current values;
  - `FactChanged` triggers re-indexing of the pages that bind the fact;
  - embeddings are batched, and an unchanged document is skipped by hash.
- **Hybrid search** `GET /v1/sites/:id/search`:
  - Postgres full-text (a generated `tsvector`, OR query with prefixes, `ts_headline`) plus pgvector HNSW, fused with RRF;
  - lexical search works without an embedding model, and vectors are added when a 1536-dim model is present.
- **Grounded answers** `POST /v1/sites/:id/ask` and `/ask/stream` (SSE: `sources` → `delta` → `done`):
  - sources plus Canon facts named in the question (trigram) or present on the retrieved pages;
  - **a fact always outranks page text**;
  - citations `[1]` / `[F1]`;
  - cache is `exact`, not `semantic`, so a neighbouring site's answer can't leak;
  - without a provider, the answer is a template built from the best-matching fact.
- **Canon** (`modules/canon`, design in [docs/canon.md](docs/canon.md)):
  - **facts**: typed values (money, number, percent, date, text…), display formatting, an append-only version history with a reason, and impact analysis by page, locale and state;
  - **linter**:
    - BOUND `{{fact:key}}` tokens;
    - deterministic detection of the verbatim value, and of amounts in a sentence that names the subject (`$39` vs `$49` → CONFLICT), with no model involved;
    - plus `canon.extract_facts` for paraphrases ("forty-nine dollars");
    - runs after every draft save (`PageChanged`/`EntryChanged` → `canon-extract`, 20 s debounce);
    - dismissed mentions stay dismissed, and a changed fact turns IN_SYNC into STALE;
  - **inbox** of contradictions, **"Bind to fact"** (a span becomes a token and can't drift again), and `POST /v1/canon/lint` for any text.
- **Multi-agent propagation** (the unique feature):
  - `POST /v1/canon/facts/:id/propagate` opens a branch and a run tree:
    - **Strategist** (plan) →
    - **Copywriter** (default locale) / **Translator** (other locales), each rewriting a span in context with `canon.propagate_fact` →
    - **Fact-Checker** (deterministic rule "new value present, old value gone" + `canon.fact_check`);
  - every model call is an `ai_agent_steps` row (output, tokens, cost, time);
  - when there is no writer model, a literal substitution of the value is proposed, marked "uncertain";
  - nothing changes without a human: review with per-span diffs, manual edits, accept/reject;
  - **merge is a CAS against the base version** (a page edited after the proposal gives a conflict, never an overwrite), with optional publish and a re-scan of mentions.
- **AI Studio** (`modules/studio`):
  - **Prompt Manager**: platform prompts plus tenant versions, activation and rollback, unknown-variable checks, test runs (`ai_prompt_runs`), per-version stats from the ledger;
  - **Agent Builder**: a JSON-ReAct loop over a whitelist of read-only tools (`canon.get_fact`, `canon.search_claims`, `canon.impact_analysis`, `content.search`, `content.read`), every step recorded, plan-limited;
  - **Playground**: up to 3 models side by side (latency, tokens, cost), where one failing model doesn't hide the others.
- **Guardrails and cost**:
  - every call goes through the gateway (quotas, budgets, guardrails, ledger, Langfuse);
  - content in prompts is wrapped in tags with an explicit "this is data, not instructions";
  - agent tools are read-only, and content changes only through branches with a human.
- **Admin**:
  - **Canon**: facts, inbox, branches, fact page (value, impact, history, Propagate), branch review (diffs, verdicts, agent run timeline, merge);
  - **AI Studio**: prompts, agents, playground;
  - **site → "Search & answers"** (hybrid search, streamed answer with sources and facts, index status, rebuild).

## Phase 5 checklist

- [x] RAG pipeline: ingestion (published only), chunking, embeddings, re-indexing on publish/fact change
- [x] Hybrid search (full-text + vectors, RRF) and generative answers with citations (+ SSE, fallback without AI)
- [x] Canon: facts, versions, impact, linter (deterministic + LLM), inbox, bind, lint API
- [x] Multi-agent content team: Strategist → Copywriter/Translator → Fact-Checker in a branch, review, CAS merge
- [x] AI Studio: Prompt Manager (versions, activation, tests), Agent Builder (ReAct + tools), Playground
- [x] Guardrails / cost control / Langfuse: everything through the gateway; steps and costs per agent
- [x] Tests: 189 in total, all green — fields 15, blocks 16, gateway 30, API unit 31 (+13: chunker, fact values, fallback), admin 7, integration 90 (+17: RAG with vectors, Canon end-to-end, Studio)
- [x] Manual browser check without AI keys: fact → linter finds `$39` → value changed to $59 → Propagate → branch with 2 rewrites → merge → page says $59, inbox empty → search and an answer from the fact

## What is in Phase 4

Collections live under Sites → a site → **Collections**.

- **Field types** (`@canon/fields`, shared by the API and the admin):
  - 14 types: text, long text, rich text, number, yes/no, date, date & time, choice (single or multiple), email, URL, image/file (single or multiple), reference, colour, JSON;
  - each field can be required, unique, min/max and "use for AI";
  - a collection's schema is data checked by a meta-schema: reserved names, choice fields need options, references need a target collection;
  - entries are validated from the definitions; drafts may be incomplete and `required` applies on publish. An empty rich-text document counts as empty;
  - presets: blog, products, team, FAQ, blank.
- **Collections API**:
  - CRUD; a schema change is compared against the data, so a lossy type change on a field with values gives 409 `SCHEMA_CONFLICT` with the number of affected entries (or `force`);
  - delete is refused while other collections reference this one.
- **Entries API**:
  - CAS on `version` (409 `VERSION_CONFLICT`), publish snapshots (`entry_versions` stores slug/title/tags/summary too), versions with restore, duplicate;
  - slugs are generated from the title with a suffix on collision; the placeholder slug of an empty entry follows the title until first publish;
  - unique fields are checked per locale;
  - search with full-text (`tsvector`) + ILIKE, tag filter with counts, sorting including quality, plan limits on collections/entries.
- **Relations**: ids live in `data`, and the reverse index `entry_relations` (with RLS) gives "used by". Target existence is checked; deleting a referenced entry gives 409 `ENTRY_IN_USE` (or `force`).
- **Import/export**:
  - CSV (RFC 4180, BOM for Excel, formula-injection guard) and lossless JSON;
  - import has a dry run, upsert by slug + locale as a partial update, per-line errors that never stop the rest, references by slug, and publish on import.
- **Headless read API** `GET /v1/content/sites/:id/collections/:slug/entries[/:entrySlug]`:
  - only publish snapshots, so draft edits and draft summaries never leak;
  - `expand=true` resolves references (unpublished ones become null);
  - works with `content:read` API keys; Redis cache keyed by tenant and site version, invalidated through the outbox.
- **AI enrichment** (BullMQ, ~15 s debounce after saving, skipped when the text hasn't changed, never bumps `version`):
  - **tags + summary + quality score in one model call**; tags are normalised and filtered by the vocabulary;
  - **quality** = 40% measured completeness + 60% AI judgement, with concrete hints; without AI, the measured score with no hints;
  - **duplicate detection** combines trigram, full-text and word shingles in Postgres and works without any AI key; vector similarity is added when an embedding model is available;
  - plus "describe your content → field schema" (invalid fields are dropped).
- **Admin**:
  - collection list and creation from a preset or AI description;
  - entries table (search, tags, status, locale, sorting, pagination, quality);
  - CSV import with a preview of the dry-run report, CSV/JSON export;
  - field & AI settings editor with a warning about lossy changes;
  - **dynamic entry form generated from the schema** (rich text with Canon facts, references with search, media, multiple choice), autosave, inline publish errors, live duplicate warning, AI panel, "used by", versions.
- Not in this phase: the public form builder (`forms`/`form_submissions` models already exist), and entries inside page blocks (a "collection list" block).

## Phase 4 checklist

- [x] Collections: CRUD, field meta-schema, schema-change guard, presets, plan limits
- [x] Entries: CRUD, versions/snapshots, publish/unpublish, CAS, unique fields, slugs, search, tags
- [x] Dynamic forms in the admin generated from the schema (14 field types)
- [x] Relations with a reverse index, "used by", delete protection, expand in delivery
- [x] Import/export CSV + JSON (dry run, upsert, per-line errors)
- [x] AI: auto-tag, summary, quality score, duplicate detection (+ AI schema suggestion)
- [x] Headless read API for published content (API keys)
- [x] Tests: 159 in total, all green — fields 15, blocks 16, gateway 30, API unit 18, admin 7, integration 73 (+15)
- [x] Manual browser check: collection from a preset → new entry → publish blocked by a required field → publish → AI panel without keys (fallback) → live duplicate warning

## What is in Phase 3

The page builder: open any page in the admin (Sites → Pages → a page).

- **Block registry** (`@canon/blocks`):
  - 17 blocks: section, columns/column, hero, heading, text, image, video, button, call-to-action, features, stats, FAQ, quote, testimonial, spacer and divider;
  - list fields (FAQ items, feature cards, stats) are AI-translatable item by item;
  - video accepts only YouTube/Vimeo links and embeds them privacy-friendly (`youtube-nocookie`, `dnt=1`);
  - the seed publishes every block's JSON Schema (`z.toJSONSchema`) to the `block_definitions` registry.
- **Shared renderers** (`@canon/ui-blocks`):
  - the public site and the builder canvas render the same React components, so what you edit is what ships;
  - they are server-compatible (no hooks);
  - responsiveness uses **container queries**, so the canvas previews tablet/mobile by narrowing itself instead of the window;
  - theme → CSS variables (`site-*` Tailwind tokens) through one shared preset.
- **Builder** (`apps/admin/src/components/builder`):
  - Zustand store + **zundo** undo/redo: Ctrl+Z / Ctrl+Shift+Z, 200 steps; typing in one field collapses into one step, and selection never enters history;
  - live canvas with hover/selection outlines and a block toolbar (drag, parent, ↑↓, duplicate, ✨, delete);
  - **drag & drop** with dnd-kit from the palette, the canvas and the layers list. Drop positions come from the rendered DOM, so they work in any container at any width. Nesting rules: Columns hold only columns, sections only at the top, never into itself;
  - layers tree, desktop/tablet/mobile widths;
  - shortcuts: Delete, Ctrl+D, Alt+↑/↓, Esc = parent;
  - optimistic autosave: "dirty" is a draft-reference check, edits made during a save are kept, and the version CAS still yields 409 + a banner.
- **Inspector**: generated from field metadata, including a list editor and a **TipTap** rich-text editor. Its output is mapped back onto the closed schema, and **Canon facts** appear as chips showing the live value, inserted with a fact picker.
- **Inline AI**, all through the gateway (quotas, ledger, fallbacks):
  - ✨ on every text field (Phase 2);
  - ✨ **per block** (`POST /v1/sites/:id/ai/improve-block`): one call rewrites every text in the block leaf by leaf, keeping formatting, links and fact tokens;
  - **AI-generated block** (`/ai/generate-block`, fits the page outline, optional fixed type);
  - **AI page from prompt** (`/ai/generate-page`, optional reference screenshot via vision, or `createPage` to create a draft directly). It follows the brief → block catalog → validation → one repair round-trip path, and drops invalid blocks with reasons. `{{fact:key}}` tokens become bound `factRef`s, and unknown facts are removed. Results land in the undoable store and are never published;
  - new AI feature `LAYOUT` for metering, plus prompts `builder.generate_page` and `builder.generate_block`.
- `GET /v1/facts` is a read-only fact search for the picker; the full Canon API (editing, history, agent propagation) arrives with the AI core in Phase 5.

## Phase 3 checklist

- [x] Block registry: 17 blocks, schemas in the DB registry, an AI catalog generated from the same definitions
- [x] Canvas with real renderers + DnD (palette / canvas / layers), nesting rules, breakpoints (container queries)
- [x] Inspector: fields, lists, TipTap with Canon facts
- [x] Zustand + Zundo: undo/redo with typing coalescing; keyboard shortcuts
- [x] Autosave + optimistic updates + version conflict; preview; publish
- [x] AI ✨ on fields and on blocks, AI-generated block, AI page from prompt (+ screenshot)
- [x] Tests: 129 in total, all green — blocks 16, gateway 30, API unit 18, admin 7 (tree ops, nesting, undo/coalescing), integration 58 (+8: generation, repair, 502 on garbage, createPage, screenshot from another site → 400, block type, improve-block preserving marks/facts, facts search)
- [x] Manual browser check: DnD into containers and columns, undo/redo, Delete, autosave, publish → the new blocks render on the public site

## What is in Phase 2

Run it locally:

```bash
pnpm infra:up
```

```bash
pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev
```

Then open the admin at <http://localhost:3000> and the demo site at <http://acme-cloud.canon.localhost:3001>. `*.localhost` resolves to 127.0.0.1 in browsers, so no hosts-file entry is needed.

- **Sites**:
  - plan-limited creation with starter content (landing/blog/docs/blank) and an automatic `<site>-<tenant>.canon.localhost` address;
  - custom domain, locales, theme tokens, AI voice/glossary/forbidden topics;
  - admins configure sites, editors work inside them.
- **Pages**:
  - tree with materialised paths; moving or renaming a parent rewrites the subtree, and cycles are rejected;
  - reserved slugs and locale prefixes are protected;
  - every save is a compare-and-swap on `version` (409 `VERSION_CONFLICT`), with 5 s autosave and Ctrl+S in the editor;
  - **publishing snapshots the draft** into `page_versions`, and delivery only ever serves `publishedVersion`, so drafts can't leak;
  - restore copies a version into the draft; duplicate; soft delete with sub-pages;
  - scheduled publish via BullMQ, with the DB row as source of truth and pending jobs re-armed on boot;
  - signed preview links.
- **Blocks** (`@canon/blocks`):
  - Zod schemas for section, hero, heading, text, image and button;
  - closed rich-text schema with no raw HTML and safe links only;
  - Canon `factRef` nodes;
  - tree validation (types, nesting, depth ≤ 6, ≤ 500 nodes, unique ids);
  - text helpers used by translation.
- **Media**:
  - type detected from magic bytes, never the client MIME; HTML posing as `.jpg` is rejected and SVG is deferred;
  - sharp: EXIF orientation, metadata/GPS stripped, WebP + AVIF at 5 widths, thumbnail, dominant colour, decompression-bomb guard;
  - SHA-256 dedupe per site, presigned uploads for large files, storage quota;
  - usage lookup (`jsonb_path_exists`) and 409 `MEDIA_IN_USE` on delete.
- **Delivery & renderer**:
  - token-protected delivery API: resolve host, published page (with Canon facts, media, hreflang alternates, nav), list, preview;
  - Redis cache invalidated O(1) by a per-site version counter;
  - **transactional outbox** (`FOR UPDATE SKIP LOCKED`, backoff, dead letters) → `revalidateTag` on the renderer, so a publish is live in about a second;
  - renderer: Next 16 `proxy.ts` host routing, ISR, locale prefixes, metadata/OG/hreflang, `<picture>` AVIF/WebP, sitemap.xml with alternates, robots.txt, draft mode.
- **Basic AI**, all through the gateway with versioned prompts:
  - rewrite / shorten / expand / simplify / formalize / fix with the site brand voice;
  - glossary-aware batch translation;
  - **page translation into a new-locale draft** that keeps structure, links, media and Canon facts;
  - SEO suggestions;
  - vision alt text.
  - `preferModel` uses a prompt's tuned model when the plan allows it and falls back otherwise.
- **Admin**:
  - sites list and creation, page list with statuses and "changes" badges;
  - structured page editor: outline, generated inspector, ✨ AI on text fields, media picker, page/SEO, versions, schedule, translate, preview;
  - media library with drag & drop and AI alt text; site settings.
- **Infra**: MinIO replaced by SeaweedFS, because MinIO stopped publishing images in 2025; any S3 works via `S3_*`.

## Phase 2 checklist

- [x] Sites CRUD + theme + AI settings, plan limits
- [x] Pages: CRUD, tree/paths, versions, publish/unpublish/schedule, preview, optimistic locking
- [x] Media: upload/presign, S3, sharp variants, dedupe, usage, quotas
- [x] Admin: dashboard → sites → pages list → editor, media library, settings
- [x] Public renderer MVP (6 blocks), ISR + on-demand revalidation via outbox
- [x] AI: text actions, translate (texts + whole page), SEO, alt text
- [x] Tests: 108 total. 50 are integration tests on Postgres + Redis + SeaweedFS containers; Phase 2 alone adds 16, covering paths, conflicts, drafts vs live, preview, facts, ABAC, scheduling, cascade delete, media variants/dedupe/in-use, and AI translate/SEO/alt.

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
