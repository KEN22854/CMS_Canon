# Canon CMS — Architecture

Modular monolith (NestJS) with DDD bounded contexts, ready to split along the same seams.
The **Intelligence** context (AI gateway, agents, RAG, Canon fact graph) has its own workers and
infrastructure (GPU pool, embedding queues) from day one.

## 1. C4 — System context

```mermaid
C4Context
  title Canon CMS — system context
  Person(editor, "Editor / Marketer", "Builds pages, manages content, approves AI changes")
  Person(dev, "Developer", "Consumes headless API, writes plugins")
  Person(visitor, "Site visitor", "Reads published sites, asks the AI chat")
  System_Ext(agent, "External AI agent", "Claude Desktop, custom agents via MCP")

  System(canon, "Canon CMS", "AI-native headless CMS with a fact graph as single source of truth")

  System_Ext(llm, "LLM providers", "Anthropic, OpenAI, Google, self-hosted Ollama/vLLM")
  System_Ext(stripe, "Stripe", "Billing")
  System_Ext(mail, "Resend / Postmark", "Transactional email")
  System_Ext(cdn, "Cloudflare", "CDN, WAF, edge")
  System_Ext(sources, "Fact sources", "Pricing APIs, docs pages, spreadsheets watched by Drift Sentinel")

  Rel(editor, canon, "Admin UI", "HTTPS / WebSocket")
  Rel(dev, canon, "REST, GraphQL, tRPC, SDK")
  Rel(agent, canon, "MCP tools", "SSE")
  Rel(visitor, cdn, "HTTPS")
  Rel(cdn, canon, "SSR / ISR origin")
  Rel(canon, llm, "Completions, embeddings, vision", "HTTPS")
  Rel(canon, stripe, "Subscriptions, usage")
  Rel(canon, mail, "Email")
  Rel(canon, sources, "Polls for changes")
```

## 2. C4 — Containers

```mermaid
C4Container
  title Canon CMS — containers
  Person(editor, "Editor")
  Person(visitor, "Visitor")

  Container_Boundary(canon, "Canon CMS") {
    Container(admin, "Admin", "Next.js 14 App Router", "Page builder, collections, AI Studio, Canon graph UI")
    Container(web, "Renderer", "Next.js SSR/ISR", "Multi-domain public sites, AI chat widget")
    Container(api, "API", "NestJS 11", "REST v1, GraphQL, tRPC, MCP, SSE; all bounded contexts")
    Container(collab, "Collab gateway", "Socket.io + y-websocket", "Yjs CRDT rooms, awareness, AI-agent cursors")
    Container(worker, "Workers", "NestJS + BullMQ", "publish, webhooks, media, outbox relay")
    Container(aiw, "AI workers", "NestJS + BullMQ", "agent runs, Canon extraction/propagation, embeddings, RAG reindex")
    Container(gpu, "Local LLM pool", "vLLM / Ollama on GPU nodes", "Degraded tier + private-data tenants (optional)")
    ContainerDb(pg, "PostgreSQL 16", "pgvector, pg_trgm, RLS, partitions", "Content, fact graph, vectors, AI ledger")
    ContainerDb(redis, "Redis 7", "", "Cache, rate limits, quotas, pub/sub, BullMQ")
    ContainerDb(s3, "Object storage", "S3 / R2 / MinIO", "Media originals + variants")
    ContainerDb(meili, "Meilisearch", "", "Typo-tolerant search, facets")
    Container(langfuse, "Langfuse", "self-hosted", "LLM traces, prompt versions, evals")
  }
  System_Ext(llm, "LLM providers")

  Rel(editor, admin, "HTTPS")
  Rel(visitor, web, "HTTPS (via CDN)")
  Rel(admin, api, "tRPC / REST / SSE")
  Rel(admin, collab, "WebSocket")
  Rel(web, api, "REST (content), SSE (chat)")
  Rel(api, pg, "Prisma (canon_app role, RLS)")
  Rel(api, redis, "ioredis")
  Rel(api, s3, "presigned URLs")
  Rel(api, meili, "index/query")
  Rel(worker, pg, "canon_system role")
  Rel(aiw, llm, "via AI Gateway")
  Rel(aiw, gpu, "via AI Gateway")
  Rel(api, llm, "via AI Gateway")
  Rel(api, langfuse, "ingestion API")
  Rel(collab, redis, "pub/sub fan-out")
```

## 3. C4 — Components of the Intelligence context

```mermaid
flowchart LR
  subgraph Presentation
    AIC[AiController<br/>REST + SSE]
    MCP[MCP server<br/>Phase 7]
    Q[BullMQ consumers<br/>agent-run, canon-*, embed]
  end
  subgraph Application
    GW[AiGateway<br/>route · fallback · cache · guard · cost]
    AR[Agent Runtime<br/>LangGraph state machines]
    RAG[RAG pipeline<br/>chunk · embed · hybrid search]
    CAN[Canon services<br/>extract · resolve · lint · propagate]
  end
  subgraph Ports
    P1[[LlmProvider]]
    P2[[ModelCatalog / TenantPolicy]]
    P3[[Quota]]
    P4[[Exact / Semantic cache]]
    P5[[Guardrails]]
    P6[[UsageRecorder / Tracer]]
  end
  subgraph Adapters
    A1[Anthropic · OpenAI · Gemini · Ollama]
    A2[(ai_models / tenants)]
    A3[(Redis counters)]
    A4[(Redis · pgvector)]
    A5[Heuristic · Lakera/NeMo]
    A6[(ai_generations) · Langfuse · Prometheus]
  end
  AIC --> GW
  MCP --> CAN
  Q --> AR & CAN & RAG
  AR --> GW
  CAN --> GW
  RAG --> GW
  GW --> P1 & P2 & P3 & P4 & P5 & P6
  P1 --> A1
  P2 --> A2
  P3 --> A3
  P4 --> A4
  P5 --> A5
  P6 --> A6
```

## 4. AI request flow (gateway)

```mermaid
sequenceDiagram
  autonumber
  participant C as Caller (API / worker / agent)
  participant G as AiGateway
  participant GR as Guardrails
  participant QT as Quota (Redis)
  participant CA as Cache (Redis exact · pgvector semantic)
  participant P1 as Primary model
  participant P2 as Fallback model(s)
  participant R as Recorder (ai_generations · Langfuse · Prometheus)

  C->>G: complete(request, ctx{tenant, feature})
  G->>GR: inspectInput (injection, PII)
  alt blocked
    G->>R: BLOCKED
    G-->>C: 422 AI_BLOCKED_BY_GUARDRAIL
  end
  G->>G: candidate chain = requested → tenant default → fallbacks<br/>(filtered by allow-list, capabilities, configured providers)
  G->>QT: check(rate/min, monthly budget)
  alt over limit
    G-->>C: 429 / 402
  end
  G->>CA: lookup (exact key; semantic if Q&A)
  alt hit
    G->>R: SUCCEEDED, cacheHit, cost 0
    G-->>C: cached result
  end
  loop each candidate (breaker per provider)
    G->>P1: request (retry ×2 with jitter on 429/5xx/network)
    alt success
      P1-->>G: text + usage
      G->>GR: inspectOutput
      G->>QT: commit(cost µ$)
      G->>CA: store
      G->>R: SUCCEEDED
      G-->>C: result
    else refusal
      Note over G: terminal — never re-routed to bypass model safety
    else failure
      G->>P2: next candidate
    end
  end
  G->>CA: semantic lookup (looser threshold)
  G->>R: DEGRADED / FAILED
  G-->>C: degradeWith text (200 DEGRADED) or 503
```

Streaming uses the same pipeline; fallback is possible only until the first token is sent
(`peekFirst` puts connect + TTFT inside the breaker/retry scope).

## 5. Domain events & sagas

```mermaid
flowchart TB
  subgraph TX[Single DB transaction]
    W[Aggregate change<br/>Page/Entry/Fact] --> O[(outbox_events)]
  end
  O -->|relay worker, canon_system| BUS{{Redis Streams / Kafka}}
  BUS --> WH[webhook-deliver<br/>HMAC, retry, DLQ]
  BUS --> RV[revalidate<br/>ISR tags + CDN purge]
  BUS --> IX[search-index<br/>Meilisearch]
  BUS --> EMB[ai-embedding-batch<br/>RAG + fact vectors]
  BUS --> EX[canon-extract<br/>claims → facts/mentions]
  BUS --> AU[(audit_logs)]

  FC[FactValueChanged] --> IA[canon-impact<br/>mentions where factVersionSeen < version]
  IA --> BR[ContentBranch created]
  BR --> TEAM[Agent team run<br/>Strategist → Copywriter → Translator → SEO → Fact-Checker]
  TEAM --> HITL{Human approval<br/>WAITING_HUMAN}
  HITL -->|approve| MG[Merge: optimistic version check<br/>→ PagePublished × N]
  MG --> O
```

Events are versioned (`outbox_events.schemaVersion`); consumers upcast older payloads.
Core events: `Page{Created,Updated,Published,Scheduled,Unpublished,Deleted}`, `Entry*`,
`Media{Uploaded,Deleted}`, `User{Invited,Joined,RoleChanged}`, `AbTest{Started,Completed}`,
`FormSubmitted`, `Webhook{Delivered,Failed}`, `AiGeneration{Requested,Completed,Failed}`,
`AgentTask{Started,Progressed,Completed}`, `ContentQualityScored`, `RagIndexUpdated`,
`EmbeddingGenerated`, and Canon's `Fact{Created,ValueChanged,Deprecated}`,
`Mention{Detected,Stale,Conflict}`, `Branch{Opened,Merged}`.

## 6. ERD (core + Canon)

```mermaid
erDiagram
  TENANT ||--o{ TENANT_MEMBER : has
  USER ||--o{ TENANT_MEMBER : joins
  TENANT ||--o{ SITE : owns
  SITE ||--o{ PAGE : contains
  PAGE ||--o{ PAGE_VERSION : versions
  SITE ||--o{ COLLECTION : defines
  COLLECTION ||--o{ ENTRY : holds
  SITE ||--o{ MEDIA : stores
  TENANT ||--o{ AI_GENERATION : spends
  AI_MODEL ||--o{ AI_GENERATION : serves
  AI_PROVIDER ||--o{ AI_MODEL : offers
  TENANT ||--o{ AI_AGENT : configures
  AI_AGENT ||--o{ AI_AGENT_RUN : executes
  AI_AGENT_RUN ||--o{ AI_AGENT_STEP : traces

  KG_ENTITY ||--o{ FACT : "is subject of"
  KG_ENTITY ||--o{ FACT_RELATION : "from / to"
  FACT ||--o{ FACT_VERSION : history
  FACT ||--o{ FACT_MENTION : "appears in"
  FACT_SOURCE ||--o{ FACT : "verifies"
  SITE ||--o{ CONTENT_BRANCH : branches
  CONTENT_BRANCH ||--o{ BRANCH_CHANGE : "proposes"
  AI_AGENT_RUN ||--o{ CONTENT_BRANCH : "opens"

  FACT { string key "pro_plan.price" json value "{amount:49,currency:USD}" int version datetime validFrom datetime expiresAt vector embedding }
  FACT_MENTION { enum entityType "PAGE|ENTRY" string fieldPath json anchor "Yjs rel-pos + text quote" enum kind "BOUND|DETECTED" enum state "IN_SYNC|STALE|CONFLICT" int factVersionSeen }
  PAGE { string fullPath string locale json content "block tree" int version tsvector searchVector }
```

Full schema: [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma) — 47 models.

## 7. Multi-tenancy & data protection

| Layer | Mechanism |
|---|---|
| Resolution | subdomain → custom domain → `x-tenant` header (API keys) → JWT claim (Phase 1) |
| App layer | repositories always filter by `tenantId`; tenant id never read from request bodies |
| DB layer | RLS on every tenant table, `FORCE ROW LEVEL SECURITY`, policies on `app.tenant_id` GUC set per transaction (`SET LOCAL` semantics) — fail-closed |
| Roles | `canon` owner (migrations), `canon_app` runtime (RLS applies), `canon_system` BYPASSRLS for cross-tenant workers |
| Audit | `audit_logs` partitioned monthly; `canon_app` has no UPDATE/DELETE on it |
| Scale-out | Enterprise: schema-per-tenant (`Tenant.isolation = SCHEMA`) → database-per-tenant, same code via datasource routing |

Verified in Phase 0 against a live Postgres: no GUC → 0 rows; foreign tenant → 0 rows;
cross-tenant INSERT → `violates row-level security policy`; `DELETE FROM audit_logs` → permission denied.

## 8. Key decisions

| Decision | Choice | Why |
|---|---|---|
| ORM | **Prisma 6** | Mature migrations + client extensions (RLS), team familiarity. pgvector/tsvector/HNSW handled via `Unsupported` + raw SQL; drift verified empty. Drizzle would model pgvector natively but loses Prisma's migration/introspection DX. |
| NestJS | **11** (spec said 10) | 10 is two majors behind in 2026; nestjs-pino and other ecosystem packages require 11+. |
| Model IDs | Data in `ai_models` | Providers ship models monthly; routing/pricing changes are a seed/DB update, not a deploy. |
| Fallback on refusal | **No** cross-provider retry | Re-routing a safety refusal would turn the fallback chain into a jailbreak path. |
| Langfuse client | Direct ingestion HTTP API | Stable across v2/v3 self-hosted; SDK majors churned. |
| Cost unit | Integer micro-USD | Exact sums over millions of calls; `price/1M × tokens` is already µ$. |
| Partitions | Child tables in schema `partitions` | Prisma diffs only `public`, so partitions never show as drift. |
| HNSW indexes | Partial (`embedding IS NOT NULL`) | Excludes rows awaiting embeddings; Prisma ignores partial indexes (no drop proposals). |
