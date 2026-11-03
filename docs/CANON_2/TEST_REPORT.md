# Canon 2.0 — test report

Run on 2026-11-04 against the local stack (Postgres 16, Redis, S3, Mailpit; API :4000, admin :3010,
renderer :3001).

| Suite | Result |
|---|---|
| `@canon/blocks` unit — style layer (8), typed operations, no-op edits and global components (10), section library and page templates (6), converted templates (2), animation (2), AI plans (4), SEO audit and JSON-LD (5), tree (16) | 53 / 53 ✅ |
| `@canon/collab` unit (incl. animation through Yjs) | 9 / 9 ✅ |
| fields · ai-gateway · edge (incl. 3 redirect tests) · sdk | 19 · 30 · 11 · 4 ✅ |
| admin unit — tree ops and history (7), Builder 2.0 store: multi-select, group, clipboard, operation log, block cap, plan batch (5) | 12 / 12 ✅ |
| API unit | 56 / 56 ✅ |
| API integration (real Postgres/Redis/S3) incl. 2 for global components, 2 for AI plans, 4 for SEO | 147 / 147 ✅ |
| Playwright E2E | 20 / 20 ✅ (+7 opt-in: 5 screenshot specs, 2 performance specs) |
| TypeScript (api, admin, web, blocks, ui-blocks, collab) | no errors ✅ |
| ESLint (`--max-warnings=0`) | clean ✅ (package scripts may log; the trail tool's own folder is ignored) |

Total automated tests: **361** (355 after iteration 5).

## Iteration 6 — templates, media, animation, the board

- `vendor.test.ts`: all 257 sections converted from Tailblocks and HyperUI validate as page
  content in English and Russian, keep no unfilled placeholder, use only allowlisted media hosts,
  and get fresh ids on every insert.
- `animation.test.ts`: the schema refuses unknown types and out-of-range numbers, defaults are
  dropped, the CSS rule carries the timing; collab keeps `animation` through a Yjs round trip.
- `edit.test.ts`: an edit that sets what is already there returns the same tree.
- `simple.spec.ts` (E2E) now also: Shift+click a second element, Align left, one Ctrl+Z restores
  only that; select one element (no text gets selected), its own Design → Animation, slide-up with
  200 ms delay, play it; insert a video hero from the library; the live HTML has `data-anim` on the
  headline, the delay variable, the Mixkit video and its own poster frame.

Bugs found by it: undo after a no-op align undid the previous step (a no-op still created a new
tree; in co-editing Yjs saw no change, so Ctrl+Z went one step further back); the block bar's
Design opened the whole free-form block, not the selected element (elements now have their own
Content / Design buttons); Shift+click extended the browser's text selection; two buttons named
"Preview" on one screen. Screenshots showed that several video heroes shared one cover photo —
each now uses its clip's own frame.

## Iteration 5 — the simple editor

`apps/admin/e2e/simple.spec.ts` runs the whole flow in a real browser, without mocks: the page
opens without side panels; double-click the hero title, type, Enter → canvas and inspector agree;
the block bar's Content opens the drawer; Add block → library → Pricing → insert; "+" at the top
of the hero inserts a free-form collage above it; drag its headline (the new left is on the 8 px
grid), Ctrl+Z restores it; on Mobile L, Arrange stacks the elements and desktop is unchanged;
save and publish: the live HTML has the free-form frame with absolute positions, the edited title,
and no editing attributes; a page template replaces the page; Pro brings back the palette.
Existing specs run in Pro mode (the helper sets it), so they keep testing the full builder.

Bugs found by it: the toolbar buttons (block bar and the older element toolbar) never received
clicks because their container stopped propagation in the capture phase; moving the mouse onto the
builder's own controls reset the hovered block, so the "+" disappeared before it could be clicked;
the API process must restart after new block types (it validates with the registry it loaded).

## Iteration 4 — SEO platform

- `packages/edge/test/redirects.test.ts`: normalisation, exact before longest prefix, `*`
  substitution, external targets, validation (home page, `javascript:`, same target), loop detection.
- `packages/blocks/test/seo.test.ts`: a clean page scores 100; every issue type is found on a
  bad page (links without a label are ignored, broken links report their href); duplicates
  across the site; JSON-LD types per page, hidden FAQ blocks left out, `</script>` escaped.
- `apps/api/test/integration/seo.test.ts`: validation, 409 on duplicates, loops refused, rules in
  the renderer's runtime config, permissions and tenant isolation; CSV import with per-line
  errors; a published page moving creates `/about` and `/about/*` rules, and publishing a page at
  `/about` removes the rule that would hide it; the audit with redirects counted as valid link
  targets, worst pages first; breadcrumbs in delivery; /404 out of nav and sitemap.
- `apps/admin/e2e/seo.spec.ts` (real renderer, no mocks): a redirect added in the UI answers 301
  on the live host with the query string kept; CSV import errors shown; the audit renders; the
  published home page carries Organization/WebSite JSON-LD; an unknown path is a 404; after
  publishing a page at /404 the visitor sees its content with status 404.

## Bugs found in iteration 4

- **Every page returned 500** in an intermediate version: reading the host with `headers()` in the
  site's not-found page turned all ISR pages of the segment dynamic. Found by the E2E run, fixed
  by loading the custom 404 content on the client from a route handler.
- The audit found that the **default home page of a new site links to /contact and /pricing**,
  which new sites don't have. Left as is (it is a template choice), but now visible in the audit.

## Iteration 3 — Canon AI plans

- `packages/blocks/test/plan.test.ts`: valid operations apply in order and the client replay gives
  the same page; facts resolve; an injection style, an unknown style property, an unknown prop, an
  invalid enum, an invented id, a locked block, an unknown operation, a non-container parent and a
  `javascript:` link are each rejected with a reason while the valid operation after them stays;
  garbage input and more than 30 operations are handled; the outline marks locked blocks.
- `apps/api/test/integration/builder-ai.test.ts`: the endpoint returns accepted and rejected
  operations (with the fake model proposing an unsafe style and an invented id), resolves facts,
  meters the call; repairs once when nothing applied; refuses invalid content (400) and viewers (403).
- `apps/admin/e2e/ai-plan.spec.ts`: the request carries the instruction, draft and selection; the
  diff shows before → after; a rejected operation is visible and can't be chosen; unchecking one
  operation keeps it out; two applied changes show on the canvas, appear in History and are
  undone by one Ctrl+Z. **The model reply is recorded in this test** (the E2E stack has no model
  provider); the server-side planner runs for real in the integration test.

## New scenarios in this iteration

`apps/admin/e2e/builder3.spec.ts`

1. **Sections, multi-select, groups, clipboard, history.** Insert "Pricing · three plans" in the
   dark tone. Ctrl+click two sections and press Ctrl+G → the builder explains that sections can't be
   grouped. Ctrl+click the pricing title and subtitle → Ctrl+G groups them; Ctrl+C / Ctrl+V pastes
   a copy right after; Ctrl+Shift+G ungroups it. The History tab lists `NODE_INSERT`, `NODE_GROUP`,
   `NODE_UNGROUP`; Ctrl+Z undoes one step. Typing "48" digit by digit into Padding top gives
   `padding-top:48px`. Ctrl+S → the server accepts the page.
2. **Global components.** Insert a header section → "Make a component" → the block becomes an
   instance. Override the brand text on this page → a second instance from the palette keeps the
   original. Publish → the live HTML contains both. The component opens in its own builder; the
   site's component list shows it.
3. **Russian builder.** With the interface in Russian: canvas, tabs, the section library, the Style
   panel ("Редактируется: Десктоп", "Внутренний сверху") are translated.

`apps/api/test/integration/components.test.ts`

1. Two instances (one with styles, one with an override) on a published page: before the
   component is published they render nothing; after publishing, delivery expands them with unique
   ids, the instance styles and the override. Editing the working copy doesn't change the live
   page until it is published again; a stale version is refused (409); a preview shows the working
   copy; deleting the component removes the instances from the live page.
2. Invalid props, a component inside a component and a CSS-injection style are refused (400);
   a viewer can read but not edit or publish (403); another workspace gets 404 (RLS).

Unit tests (`packages/blocks/test/edit.test.ts`, `sections.test.ts`) cover every operation type,
locked blocks, nesting rules, structural sharing, instance expansion, override validation, and
every section layout × tone × language passing server validation.

## Bugs found and fixed by the tests in this iteration

- **Bare numbers in style fields were mangled while typing**: typing "77" produced "7px7", because
  the field was rewritten to the stored "7px" after the first keystroke. (Found by the browser
  performance run; the earlier E2E filled values in one go.)
- **Undo merged several operations in co-editing mode**: `Y.UndoManager` joined every edit made
  within 800 ms, so grouping, pasting and ungrouping in quick succession were undone together with
  the section insert before them. Each new operation now closes the capture group; typing into one
  field still merges.
- **Ctrl+S during an autosave did nothing** (no save, no message). Saves now queue behind the one in
  flight and use the version it produced.
- **The builder let a page grow past the 3 000-block cap** and then failed on every save. Inserts
  and duplicates beyond the cap are refused in the editor with an explanation.
- **Duplicating a block dropped its name, styles and flags** (the copy helper only copied props).
- **Grouping that wasn't allowed failed silently**; it now says why.

## Not covered yet

- Visual regression (screenshots are captured, not diffed).
- Lighthouse with mobile throttling (see PERFORMANCE_REPORT.md).
