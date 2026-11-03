# Canon 2.0 — backlog

Ordered by priority. Each stage ships only with tests, screenshots and docs (see `ROADMAP.md`).
Status: ✅ done · 🟡 in progress · ⬜ not started.

## P0 — Builder foundation (Stages 1–3)

- ✅ Audit and planning documents.
- ✅ BEFORE screenshots of the running app.
- ✅ Design system (first iteration): Canon palette as tokens, dark and light themes with a manual switch, token docs, Skeleton and EmptyState primitives.
- ⬜ Design system: Radix-based dialog, dropdown and tooltip primitives; migrate screens to EmptyState/Skeleton.
- ✅ Responsive style layer (`packages/blocks/src/styles.ts`): typed, whitelisted properties; breakpoints with desktop-first inheritance; validation; compilation to scoped CSS.
- ✅ Renderer and canvas apply node styles (one compiler for both).
- ✅ Style panel: layout, spacing, size, typography, background, border, effects, visibility per breakpoint, "reset override".
- ✅ Layers: rename, hide, lock, duplicate, delete.
- ✅ Workspace: full-bleed editor, zoom, five breakpoints, real-width preview with fit.
- ✅ Memoised style compilation and canvas rendering; browser measurements at 1–3k blocks.
- ⬜ Custom viewport width; rulers and grid guides.
- ✅ Multi-select, group/ungroup (Group block), copy/cut/paste across pages.
- ✅ Typed editor operations (NODE_INSERT/…) shared by builder, API and AI; operation log (History tab).
- ⬜ Operation-based undo (undo is still snapshot-based with structural sharing).
- ✅ Global components with per-page overrides, detach, draft/published versions, component builder.
- ✅ Builder strings in Russian; theme colour chips in the site colours.

## P1

- 🟡 Section library: 29 layouts × 4 tones, EN/RU copy, searchable palette (Stage 4). Next: more layouts, thumbnails, block variants.
- ✅ AI planner → typed operations → diff → approve per operation, one undo step (Stage 5, first part).
- ⬜ Stage 5: live canvas preview of a plan, multi-page plans, plans as review requests.
- ⬜ CMS dynamic pages, table/grid views, bulk actions (Stage 6).
- ⬜ E-commerce: products, variants, cart, checkout, orders, payment adapters with webhook verification (Stage 7).
- ⬜ Redirects, SEO audit, Schema.org, per-site 404 (Stage 9).
- ⬜ Site releases: atomic publish of many pages, history, rollback (Stage 13).

## P2

- ⬜ CRM and workflow builder (Stage 8).
- ⬜ Themes marketplace (Stage 10).
- ⬜ Animation studio (Stage 11).
- ⬜ Heatmaps, funnels (Stage 12).
- 🟡 Remaining admin screens in Russian (builder done); server-side notification i18n.

## P3

- ⬜ Developer mode, CLI, API explorer (Stage 16).
- ⬜ Migration center (Stage 17).
- ⬜ Local integrations: YooKassa, CloudPayments, GigaChat, YandexGPT, Metrica… (Stage 18).
