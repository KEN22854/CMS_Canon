# Canon 2.0 — progress

Last update: 2026-11-03.

## Iteration 3 (this one) — Stage 5, Canon AI edits the page

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
2. Stage 4: more layouts (target 100+ distinct layouts, today 29 × 4 tones), block variants,
   section thumbnails in the palette.
3. Operation-based undo (today undo is still snapshot-based with structural sharing; the
   operation log is for history, audit and AI).
4. Lighthouse CI with mobile throttling; Yjs diff that skips unchanged subtrees; virtualised Layers.
5. Remaining admin screens in Russian (collections, settings, analytics…).

Stages 6–18 (CMS 2.0, e-commerce, CRM, SEO, themes, animation, analytics, hosting, security,
multilingual, developer platform, migration, local integrations) have not started. See ROADMAP.md.
