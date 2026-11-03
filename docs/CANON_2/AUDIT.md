# Canon 2.0 — audit of the current repository

Date: 2026-11-03. Baseline: commit `251f83f` (Phase 9). Every statement below was checked
against the code, the tests or the running app, not the README.

## Stack (actual)

| Layer | Technology |
|---|---|
| Monorepo | pnpm 9 workspaces, Turborepo |
| API | NestJS 11 (SWC), Prisma 6, Postgres 16 + pgvector, RLS (`canon_app` / `canon_system`), Redis, BullMQ, transactional outbox |
| Admin | Next.js 16 (App Router), React 19, Tailwind 3, TanStack Query, Zustand, Lucide, sonner. No Radix: home-grown primitives in `components/ui.tsx` |
| Renderer | Next.js 16, ISR + on-demand revalidation, per-host routing `s/[host]` |
| Realtime | Yjs over WebSockets (`packages/collab`) |
| AI | `packages/ai-gateway`: Anthropic, OpenAI, Google, Ollama, caching, guardrails, quotas |
| Tests | Vitest (unit + integration on real Postgres/Redis/S3), Playwright E2E |
| Ops | One Dockerfile → api/admin/web/migrate images, compose, k8s manifest, Caddy edge |

Size: 60 Prisma models, 22 API integration suites (139 tests), 12 E2E specs, 297 tests total, all green.

## Module by module

| Module | Current state | Problems | Required changes | Priority |
|---|---|---|---|---|
| Auth, tenancy, RBAC | Production-grade: JWT + refresh families, 2FA, SSO SAML, SCIM, API keys with scopes, RLS on 44 tables, CASL roles | None blocking | Keep; extend roles for agencies (client seats) later | — |
| **Visual builder** | Works: block tree, drag & drop, nesting (row/column), undo/redo, 3 preview widths, inline AI, co-editing, comments | **No style model**: blocks only have enum props (`paddingY: lg`). No per-breakpoint overrides — the 3 breakpoints only resize the preview. No margin/padding/typography/border/shadow controls. No hide/lock/rename in Layers (58-line component). No zoom, no rulers. No components/symbols. 500-node cap. The canvas is squeezed by the app sidebar at ≤1280 px | Typed responsive style layer on every node, shared by editor and renderer; Style panel; layer operations; zoom; full-bleed editor | **P0** |
| Page document model | `BlockNode {id,type,props,children}`, Zod-validated, versions on publish, CAS saves | No `styles`, no `name`, no `hidden/locked`; no breakpoint config; no typed operation log (history = snapshots) | Extend the node with optional `name`, `styles`, `hidden`, `locked` (backward compatible), add style validation + compilation | **P0** |
| Block library | 18 block types (section, hero, heading, text, image, button, row, column, spacer, divider, quote, faq, cta, stats, features, testimonial, video, form) + plugin presets | Far from 100+; one visual variant each | Variants + section presets on top of the style layer (Stage 4) | P1 |
| Admin design system | shadcn-like HSL tokens in `globals.css`, light + dark via `prefers-color-scheme` | Default indigo palette, no manual theme switch, no documented tokens (radius/shadow/spacing scales), no skeleton/empty-state primitives | Canon palette as tokens, explicit theme switcher, token docs, Skeleton/EmptyState components | **P0** |
| AI | Gateway, RAG, AI Studio, page generation from a brief, block rewrite/translate, SEO suggestions, form spam classification, evals | Page generation writes props only; no typed operation plan with diff/approve; no media generation | AI planner → typed operations → diff → approve (Stage 5) | P1 |
| CMS | Collections with field schema, relations, draft/publish snapshots, CSV/JSON import/export, enrichment, headless content API, webhooks | No dynamic collection pages in the renderer, no table/grid view switch, no bulk actions UI, localisation per entry only | Dynamic routes + views (Stage 6) | P1 |
| Forms, notifications, reviews, domains, SCIM, SDK | Phase 9, tested end to end | Notification texts and API errors are English-only | Server-side i18n of notifications | P2 |
| E-commerce | **Absent** (no Product/Order models) | — | Stage 7, adapter-based payments | P1 |
| CRM / automation | Absent beyond form inbox and webhooks | — | Stage 8 (contacts from form submissions as the seed) | P2 |
| SEO | Per-page meta, OG, noindex, canonical, sitemap.xml, robots.txt, hreflang, AI SEO suggestions | No redirects (no model), no SEO audit, no custom 404 per site, no Schema.org | Redirect model + audit (Stage 9) | P1 |
| Analytics / A/B | First-party collector, rollups, realtime, AI insights, A/B at the edge with sequential stats, segments | No heatmaps, no funnels UI | Stage 12 | P2 |
| Hosting | Subdomains, verified custom domains, on-demand TLS, ISR, preview links | Publishing is per page (no site-level atomic release), no deployment history/rollback at site level (page versions exist) | Site releases (Stage 13) | P1 |
| Animation | Absent | — | Stage 11 (needs the style layer first) | P2 |
| Marketplace | Plugins (manifests, consent, scoped keys, block presets) | No themes | Themes as style-token presets + page sets (Stage 10) | P2 |
| i18n (admin) | EN/RU infra; shell, auth, dashboard, Phase 9 screens translated | Builder, collections, Canon, Studio, analytics, settings still English | Continue per screen | P2 |
| Developer platform | REST, OpenAPI (bodies from Zod), SDK, MCP, webhooks | No CLI, no API explorer page | Stage 16 | P3 |

## Visual builder — the critical problems (P0)

1. **Users cannot style anything.** The only visual controls are a handful of enums per block. A
   designer cannot set a margin, a font size, a radius, a colour or a shadow. This is the single
   biggest gap against Tilda/Webflow/Framer.
2. **Responsive editing is fake.** Switching Desktop/Tablet/Mobile only narrows the preview.
   There is nowhere to store "on mobile, font size 28 instead of 48".
3. **The renderer and the editor would both need the styles.** Today the renderer maps enums to
   Tailwind classes in `packages/ui-blocks/src/render.tsx`; arbitrary values cannot be expressed
   with prebuilt classes (Tailwind JIT does not see runtime values).
4. **Layers are minimal.** No rename, hide, lock or duplicate from the tree.
5. **Workspace ergonomics.** No zoom; the app sidebar steals 240 px from the canvas.

## Security notes

- Tenant isolation is enforced three ways (repository filters, RLS, CASL instance checks); new
  modules (forms, reviews, SCIM) follow the same pattern and have cross-tenant tests.
- Arbitrary CSS values in the upcoming style layer are an injection surface (`url(javascript:)`,
  `expression()`, `</style>` breakouts). The style layer must whitelist properties and validate
  values per property, and the renderer must emit them through React style objects or escaped
  CSS, never string-concatenated HTML.
- Custom code (Stage 16) must run only on the published site, never inside the admin.

## Performance notes

- Page trees are capped at 500 nodes; the editor re-renders the full canvas on each change
  (Zustand selector per block mitigates). Stage 2 measurements will decide whether virtualising
  Layers is needed.
- The renderer serves ISR pages from cache; the Delivery API caches page payloads in Redis keyed by
  a site version.
