# Canon 2.0 — progress

Last update: 2026-11-04.

## Iteration 7 (this one) — Stage 6, CMS 2.0: entry pages, collection lists, views, bulk

- **Entry pages**: a collection gets an address (`/blog`) and a template page. Every published
  entry is then a page at `/blog/<slug>`: the template's `{{entry.title}}`, `{{entry.<field>}}`
  tokens are filled from the entry's published snapshot (texts, list items, rich text — a rich
  text field alone in a paragraph brings its headings and lists — and image links). Title, SEO
  title and description come from the entry; breadcrumbs work; entry pages are in the sitemap;
  the template itself is never served or listed; a real page at the same path wins; two
  collections can't share an address. "Create and publish a template" builds a first template
  from the collection's fields in one click.
- **Collection list block** (new `collection-list`): cards of published entries — collection,
  grid or list, 1–4 columns, how many, order (newest, oldest, title), tag filter, image and text
  fields (automatic when empty), date, link label, empty text. Cards link to entry pages. The
  builder shows the same cards visitors will see (published entries only) through a preview
  endpoint. Kept out of the AI catalog for now (it needs real collection slugs).
- **Entries table**: field filters (is, contains, empty, not empty — combinable, up to 5),
  **saved views** shared in the workspace (search, status, tag, sort, filters), **bulk actions**
  on the selection: publish, unpublish, add/remove tag, archive, delete. Each entry goes through
  the same checks as a single action (permissions, review gate, required fields); failures are
  listed, the rest is done. The table is now in Russian and English.
- Inspector: number fields and a collection picker.
- Tests: +3 blocks unit (tokens, cards, list specs), +5 API integration (entry pages, route
  validation, lists, filters with SQL-looking values, bulk with per-entry permissions, views),
  +1 E2E (collection → template → drafts → filter → saved view → bulk publish → live entry page
  and sitemap → list on the home page, in the builder and on the site).

## Iteration 6 — hundreds of templates, photos and video, animation, the board

- **Open-source templates**: 257 sections converted from two MIT libraries, **Tailblocks**
  (mertJF/tailblocks, 126) and **HyperUI** (markmead/hyperui, 131). A converter
  (`packages/blocks/scripts/import-vendor-templates.cjs`) reads their Tailwind markup **as text**
  (nothing from them is executed), maps elements to Canon blocks (headings, text, buttons, images,
  forms, grids/rows/stacks) and Tailwind classes to the responsive style layer (desktop and mobile
  values), turns accent colours into theme tokens, fills placeholder copy per locale (en/ru, pools
  per category: shop products, team names, quotes) and validates every tree. 2 of 259 were dropped
  (logo clouds made of inline SVG). They load lazily in the block library with a source badge
  ("Tailblocks · MIT") and the licence files ship next to them.
- **Own library**: 114 layouts × 4 tones (was 92), incl. **19 media heroes** (10 background videos,
  9 full-bleed photos) and 3 free-form video compositions; **21 page templates** (was 12): video
  landing, creative studio, travel, wellness, interior, school, music, eco farm, business; startup,
  local business and event now open with video/photo. A new **Shop** category. Total in the
  library: **371 sections** plus 21 pages. Photo and video heroes lead the Hero category; each video
  hero's cover is the first frame of its own clip.
- **Photos and video from external links**: hero (`imageUrl`, `videoUrl`, overlay), image (`src`),
  video (`fileUrl`, autoplay), free-form block background. Only https and an allowlist of hosts
  (Unsplash, Picsum, Pexels images; Mixkit, Pexels videos). Background video is muted, looped,
  `playsInline`, `preload=metadata`, hidden under `prefers-reduced-motion`, not autoplayed in
  the editor.
- **Animation** (start of Stage 11): any block gets an entrance (fade, slide ×4, zoom in/out, blur,
  rotate, flip), a trigger (on load / when scrolled into view), duration, delay, easing (incl.
  spring) and a hover effect (lift, grow, glow, dim, tilt). Stored as `node.animation`, validated
  by a strict schema, compiled to CSS variables per block; the live site adds an
  IntersectionObserver only when a page uses scroll animations; reduced motion turns it all off.
  Design → Animation in the editor, with "Play the animation".
- **The free-form block is a board**: Shift/Ctrl+click selects several elements, they move
  together; **smart guides** snap to the frame's edges and centre and to other elements (pink
  lines); rotate handle (Shift: 15° steps); align left/centre/right/top/middle/bottom, distribute
  (3+), bring to front / send to back; arrow keys nudge 1 px (Shift 10); drag an element from the
  add bar and drop it where it should be. A selected element has its own **Content** and
  **Design and animation** buttons (the block bar above belongs to the whole block).
- Fixes found on the way: an edit that sets what is already there (align aligned elements, retype
  the same text) now returns the same tree, so it is no undo step and no log entry — before, in
  co-editing, the next Ctrl+Z silently undid the step before it; Shift+click extended the
  browser's text selection; two buttons named "Preview" on one screen; a grid's inline column count
  beat the responsive style layer (now a CSS variable).
- Tests: +5 blocks unit (all 257 converted sections validate in both locales with allowed hosts
  only; animation schema and CSS; no-op edits), +1 collab (animation survives Yjs), the
  simple-editor E2E now covers the board, animation and a video hero up to the live HTML.

## Iteration 5 — the simple editor (block-by-block, free-form)

The builder now opens in a **simple mode** made for people who build pages, not trees:
- A clean page of blocks, no side panels. Hovering a block shows its name and a bar: **Content**,
  **Design**, Canon AI, move up/down, duplicate, hide, delete. Content/Design open the inspector as
  a drawer; it closes again.
- **"+" between blocks** and a big **Add block** at the end open the **block library**: categories
  on the left, real previews (the site's renderer and theme, scaled to the card) on the right, four
  colour tones, search. A click inserts exactly where the "+" was.
- **Edit text in place**: double-click any heading, paragraph, button label, card title, FAQ
  question, stat… type, Enter. Formatted rich text opens in the panel instead (nothing is lost).
- **Free-form block** (new `canvas` block): add text, headings, buttons, images and shapes (new
  `shape` block) and **drag them anywhere**; resize by the handles; snap to an 8 px grid (Alt: free);
  drag the block's bottom to set its height. Positions are kept **per breakpoint**: on Tablet or
  Mobile you move things without touching desktop, and **Arrange** stacks the elements for that
  screen in one step. Every drag is one undo step.
- **Library size**: 92 section layouts (16 heroes, 20 feature grids, 14 social-proof, 11 content,
  6 pricing, 6 CTA, 5 team, 4 free-form compositions, 4 header/footer, 3 contact, 3 FAQ) × 4 tones,
  20 basic blocks, **12 whole-page templates** (landing, startup, agency, portfolio, course, event,
  local business, about, pricing, contact, article, coming soon). Russian names for all.
- **Pro mode** (switch in the toolbar) keeps the full builder: palette, layers, history, all panels.
- Fixes on the way: toolbar buttons never fired (a capture-phase stopPropagation on their
  container), hovering the builder's own controls dropped the hovered block.
- Free-form blocks and shapes are kept out of the AI catalog (they need hand-placed coordinates).
- Tests: +2 blocks unit (templates, free-form), +1 E2E (the whole simple-editor flow, incl. the live site).

## Iteration 4 — Stage 9, SEO platform

- **Redirects**: exact and prefix rules (`/blog/*` → `/news/*`), 301/302/307/308, created in
  Site → SEO, imported from CSV (per-line errors), or **automatically** when a published page
  moves (old path and old/* → new). A live page always wins: publishing at a redirected path
  removes the rule. Loops are refused on save. The renderer's proxy applies them first, to bots
  too, keeping the query string. Table `redirects` with RLS and a status check constraint.
- **SEO audit** (`packages/blocks/src/seo.ts`): title and description length and duplicates,
  h1 missing/multiple, heading level jumps, image alt texts (block or library), empty and
  **broken internal links** (against published pages and redirects), noindex, thin content, social
  image, long slugs. Score per page and for the site; issues link straight to the block in the
  builder (`?block=<id>`). Checks run on drafts so problems are fixed before publishing.
- **Schema.org JSON-LD** on published pages: Organization + WebSite on the home page,
  BreadcrumbList (from published ancestors) below it, FAQPage from visible FAQ blocks; escaped so
  content can't close the script tag.
- **Site 404**: a published page at /404 replaces the default message; the 404 status stays (the
  content is swapped in on the client, because reading the host on the server would make every
  cached page dynamic). /404 is kept out of the navigation and the sitemap.
- Tests: +5 SEO unit, +3 redirect unit, +4 API integration, +1 E2E (352 automated).

## Iteration 3 — Stage 5, Canon AI edits the page

- **Planner** (`packages/blocks/src/plan.ts`): the model's answer becomes checked typed
  operations. Shape, catalog fields, style grammar, locks, nesting and page validity are checked
  operation by operation on a working copy; rejected ones keep a reason. New blocks are
  materialised (fresh ids, Canon facts bound). The model gets a compact outline of the page
  (ids, types, key texts) and may not lock, replace or ungroup.
- **API** `POST /v1/sites/:siteId/ai/plan` (`invoke Ai`): draft + selection + instruction →
  summary and operations; one repair round when nothing applies; metered in the AI ledger like the
  other builder features. New prompt `builder.plan_edits` in the seed.
- **Builder**: a "Canon AI" inspector tab. The plan is shown as a diff (before → after per field
  and style), each operation can be dropped, rejected ones show why, hovering highlights the
  block; "Apply" runs the kept ones as **one undo step** (also in co-editing) and logs them in
  History. If the page changed meanwhile, operations that no longer fit are skipped and counted.
- Tests: +4 planner unit, +1 store unit, +2 API integration, +1 E2E (339 automated).

## Iteration 2

**Builder 2.0 — editing model.**
- Typed operations in `@canon/blocks` (`edit.ts`): `NODE_INSERT/REMOVE/MOVE/REORDER/DUPLICATE/
  REPLACE`, `PROPS_UPDATE`, `NODE_META`, `STYLE_SET`, `NODE_GROUP/UNGROUP`. The builder applies
  every edit through them, logs them (History tab) and they are the vocabulary for Canon AI
  (Stage 5). Locked blocks and nesting rules are enforced inside the operations.
- The tree helpers moved from the admin into `@canon/blocks` and keep untouched subtrees by
  identity (structural sharing).
- Multi-select (Ctrl/Shift+click on canvas and in Layers), a multi-selection toolbar, Ctrl+A.
- Copy / cut / paste across pages (Ctrl+C/X/V), group / ungroup (Ctrl+G / Ctrl+Shift+G), a new
  Group block (stack, row or grid).
- Global components: create from any block, instances with per-page text/link overrides, detach,
  a component builder, draft vs published versions, a component list per site; delivery expands
  published components (API, RLS, audit, outbox invalidation).

**Stage 4 (first part) — section library.** 29 section layouts (hero, features, social proof,
pricing, CTA, FAQ, team, contact, content, header/footer) × 4 tones = 116 variants, built from the
regular blocks and styles, copy in English and Russian. Searchable palette.

**Performance.** Memoised style compilation (35 → 1.3 ms per edit at 3 000 blocks), memoised canvas
rendering, one stylesheet per section on the canvas. Browser measurements at 1 000 / 3 000 blocks
and lab metrics of published pages (PERFORMANCE_REPORT.md).

**Polish.** The whole builder in Russian (≈ 380 strings, including block names, fields and the
renderer's placeholders), theme colour chips in the site's colours, status badges translated.

**Fixes** found by the new tests: see TEST_REPORT.md (style input mangling, co-editing undo
merging operations, Ctrl+S during autosave, block cap, duplicate losing styles, silent group).

Tests: 331 automated (unit 173, API integration 141, E2E 17).

## Iteration 1

Stage 0 audit; Stage 1 design system (tokens, dark/light, toggle); Builder 2.0 foundation
(responsive style layer, Style panel, five breakpoints, real-width canvas, zoom, Layers actions).

## Not done yet (next)

1. Stage 5, next steps: streaming plans, canvas preview before applying, multi-page plans
   ("update the price on every page"), plans as review requests for approval by someone else.
2. Stage 4: own media library for templates (today photos and videos are external links),
   block variants; Stage 11: timeline, scroll-linked (parallax) effects, per-breakpoint animation.
3. Operation-based undo (today undo is still snapshot-based with structural sharing; the
   operation log is for history, audit and AI).
4. Lighthouse CI with mobile throttling; Yjs diff that skips unchanged subtrees; virtualised Layers.
5. Remaining admin screens in Russian (collections, settings, analytics…).

Stages 7–18 (e-commerce, CRM, SEO, themes, animation, analytics, hosting, security,
multilingual, developer platform, migration, local integrations) have not started. See ROADMAP.md.
