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
- 🟡 Custom viewport width and layout grid: done on the board (iteration 18). Next: rulers and draggable guides.
- ✅ Multi-select, group/ungroup (Group block), copy/cut/paste across pages.
- ✅ Typed editor operations (NODE_INSERT/…) shared by builder, API and AI; operation log (History tab).
- ⬜ Operation-based undo (undo is still snapshot-based with structural sharing).
- ✅ Global components with per-page overrides, detach, draft/published versions, component builder.
- ✅ Builder strings in Russian; theme colour chips in the site colours.

## P1

- 🟡 Section library: 114 own layouts × 4 tones + 257 converted from Tailblocks and HyperUI (MIT), 21 page templates with photos and video, live previews (Stage 4). Next: copy media into the site's own storage on insert, block variants.
- ✅ Simple editor: block bar, "+" inserters, block library, in-place text editing, free-form block with drag/resize per breakpoint, arrange for mobile.
- ⬜ Free-form next: multi-select and align/distribute, rotation handle, smart guides, z-order buttons, drag from the library onto a position.
- ✅ AI planner → typed operations → diff → approve per operation, one undo step (Stage 5, first part).
- ⬜ Stage 5: live canvas preview of a plan, multi-page plans, plans as review requests.
- 🟡 CMS 2.0 (Stage 6): entry pages from a template, Collection list block, field filters, saved views, bulk actions. Next: relation fields in templates (author, category pages), pagination and category filters on the site, inline cell editing, kanban/gallery views, scheduled bulk publish.
- 🟡 E-commerce (Stage 7): products, cart, checkout with stock and server-side prices, orders and statuses, order emails. Next: online payments (needs the owner's provider and keys), variants (size/colour), shipping rates and taxes, discount codes, order export.
- ✅ Redirects (manual, CSV, automatic on page move), SEO audit with scores, Schema.org JSON-LD, per-site 404 (Stage 9).
- ⬜ Stage 9 next: redirect hit counts, keyword/SERP preview, Core Web Vitals per page from analytics, hreflang audit.
- 🟡 Hosting (Stage 13): site releases and undoable whole-site rollback. Next: automatic releases on a schedule or on every publish, release retention, staging domain per release, rollback of URLs/redirects.

## P2

- 🟡 CRM and automation (Stage 8): contacts, timeline, tags, notes, erasure; automations on form and order events (emails, tags, run history). Next: segments from contacts, delays/schedules in automations, email templates with the site theme, CSV export, deduplication across sites.
- ⬜ Auth: a reload that interrupts a refresh-token rotation logs the user out (401 inside the grace window). Option: within the grace window return the successor session instead of 401 — a security trade-off to decide (OAuth BCP allows it).
- 🟡 Themes (Stage 10): gallery, studio with contrast checks, workspace themes, JSON import/export. Next: a public theme marketplace (publishing, moderation, payouts), per-section theme overrides, custom fonts upload.
- 🟡 Animation studio (Stage 11): entrance and hover animations, scroll trigger, staggered children, preview. Next: timeline, parallax, per-breakpoint settings.
- 🟡 Analytics and growth (Stage 12): funnels. Next: click heatmaps (pointer positions per block, sampled), cohorts and retention, revenue in funnels (orders), alerts on drops.
- 🟡 Remaining admin screens in Russian (builder done); server-side notification i18n.

## P3

- ⬜ Developer mode, CLI, API explorer (Stage 16).
- 🟡 Migration center (Stage 17): WordPress (WXR) import with redirects. Next: a guarded media importer for post images, Tilda/Webflow/Wix exports, background jobs with progress for very large sites.
- 🟡 Developer platform (Stage 16): order/CRM scopes, SDK methods, new webhook events. Next: a developer portal page with live API reference and code samples, CLI (`canon pull/push` of content), custom blocks as plugins with a sandboxed renderer.
- 🟡 Multilingual (Stage 15): shop, checkout and order emails in en/ru/de/fr/es. Next: the admin interface in German, French and Spanish (≈1 500 strings each), renderer placeholders for empty states in all site locales.
- 🟡 Local integrations (Stage 18): Telegram. Next (need the owner's accounts and keys): YooKassa/CloudPayments online payments, SMS (SMS.ru), amoCRM/Bitrix24 sync, Yandex Metrica and Google Analytics tags, VK pixel, delivery services (CDEK).

- ⬜ Security: trust X-Forwarded-For only from a configured proxy list in the renderer (today the per-IP limits for forms and checkout rely on it; site-wide caps limit the damage).

## Infinite canvas (iteration 18) — next
- 🟡 HTML attributes: allowlist done (anchor id, aria-label, title). CSS class names still need a decision (they would reach outside the validated style layer).
- ✅ State styles: Normal / Hover / Pressed / Focus in the style panel, plus a transition (iteration 18b).
- ✅ Drop at a position inside a free-form area from the library (iteration 18b).
- ⬜ All pages of a site on one board (today: one page per board, page switcher in the header).
- 🟡 Rulers done (iteration 18b). Next: draggable guides, distances while dragging (today: Alt + hover).
- ⬜ Virtualise artboards far outside the viewport for pages over ~3 000 blocks on 3+ artboards.
- ⬜ Free zones on phones: derive a stacked layout automatically for objects placed only on desktop (today: Arrange for this screen, per zone).
