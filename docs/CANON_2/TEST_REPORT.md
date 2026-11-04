# Canon 2.0 — test report

Run on 2026-11-04 against the local stack (Postgres 16, Redis, S3, Mailpit; API :4000, admin :3010,
renderer :3001).

| Suite | Result |
|---|---|
| `@canon/blocks` unit — style layer (8), typed operations, no-op edits and global components (10), section library and page templates (6), converted templates (2), animation (2), entry pages and lists (3), shop (2), shop strings (2), themes (3), HTML import (3), entry links (1), stagger (1), AI plans (4), SEO audit and JSON-LD (5), tree (16) | 68 / 68 ✅ |
| `@canon/collab` unit (incl. animation through Yjs) | 9 / 9 ✅ |
| fields · ai-gateway · edge (incl. 3 redirect tests) · sdk | 19 · 30 · 11 · 5 ✅ |
| admin unit — tree ops and history (7), Builder 2.0 store: multi-select, group, clipboard, operation log, block cap, plan batch (5) | 12 / 12 ✅ |
| API unit | 58 / 58 ✅ |
| API integration (real Postgres/Redis/S3) incl. 2 for global components, 2 for AI plans, 4 for SEO, 5 for CMS 2.0, 3 for the shop, 3 for the CRM, 1 for releases, 1 for themes, 1 for migration, 1 for funnels, 1 for Telegram, 1 for staggered entrances | 164 / 164 ✅ |
| Playwright E2E | 27 / 27 ✅ (+7 opt-in: 5 screenshot specs, 2 performance specs) |
| TypeScript (api, admin, web, blocks, ui-blocks, collab) | no errors ✅ |
| ESLint (`--max-warnings=0`) | clean ✅ (package scripts may log; the trail tool's own folder is ignored) |

Total automated tests: **403** (400 after iteration 16).

## Iteration 17 — Stagger and security pass

- `animation.test.ts`: stagger expansion (delays, own entrances kept, hover kept on the container,
  minimum step, identity of untouched trees).
- `entry.test.ts`: `/{{entry.path}}` → "//evil…" dropped, `{{entry.shop}}` → "javascript:" dropped,
  a partner https link kept; `//host` refused on save.
- `cms2.test.ts`: a staggered grid on a live page has per-child entrances 0/120/240 ms.
- `funnels.test.ts`: a 7-year range is refused.

## Iteration 16 — Developer platform

- `shop.test.ts`: an `orders:read` key lists orders but can't change them, a `content:read` key gets
  403, order scopes don't open contacts, an `orders:write` key confirms an order.
- `crm.test.ts`: a `crm:read`+`crm:write` key lists and tags contacts but can't erase them.
- `client.test.ts` (SDK): order list query, status change body, contacts query.

## Iteration 15 — Multilingual shop

- `shop-i18n.test.ts` (blocks): five languages × every key × the same placeholders; regional
  locales and the English fallback.
- `shop.test.ts` (API): an order placed from a German page gets "Bakery: Bestellung Nr. 1002
  eingegangen" with "Zahlung: Banküberweisung".

## Iteration 14 — Telegram

- `telegram.test.ts` (API, a fake Bot API server): token format and rejection, encrypted storage
  (the token appears nowhere in the site row or API responses), test message, an order and a form
  request posted once each after two outbox drains, an automation message with variables, plain
  text (no parse mode, `<b>` stays text), editors refused, keeping the token when changing the chat,
  disconnect.

## Iteration 13 — Funnels

- `funnels.test.ts` (API): five visitors (full path, no add, wrong order, no product view, a return
  after 10 days) → 4/2/1/1 in 7 days, the return counted in 30 days but not in one visit; prefix
  paths don't match "/productsx"; other dates ignored; validation; viewers read, can't define.
- `funnels.spec.ts` (E2E): two browser visitors on the live site, one clicks the CTA; the funnel
  in the admin reads 2 → 1, converts 50%.

Bug found: `make_interval` needs an int, the bound number arrived as bigint (cast added).

## Iteration 12 — Migration center

- `import-html.test.ts` (blocks): structure (headings, lists, quotes, marks, links, images reported);
  scripts/styles/iframes/`javascript:` links/event handlers dropped; classic content and entities.
- `migration.test.ts` (API): dry run writes nothing; non-WXR and DOCTYPE files refused; viewers
  refused; import → Blog with categories, live entry page with structure and author/date line,
  draft stays draft, page hierarchy, 301 in the runtime config; importing again uses a second
  collection.
- `migration.spec.ts` (E2E): upload in the admin, report, import, live post and page, 301 from the
  old address.

Bugs found: the dry run reported redirects for child pages because it ignored their parents' path.

## Iteration 11 — Themes

- `themes.test.ts` (blocks): 24 unique presets in all categories; WCAG ratios; every preset readable
  (text, buttons with the better of white/dark text, links, bands); a bad palette flagged.
- `themes.test.ts` (API): a preset applied, saved to the workspace, applied to a second site;
  invalid colours and partial themes refused; editors read-only; another workspace sees none.
- `themes.spec.ts` (E2E): gallery → Forest → a low-contrast text colour is flagged → back to Forest
  → save → the live page has `--site-primary:21 128 61` and white button text → saved for the
  workspace.

Bug found by the contrast test: white button text on pale primaries (dark themes) — now the text
colour follows the primary.

## Iteration 10 — Releases

- `releases.test.ts` (API, real Postgres): a release of a page, a component and an entry; a bad
  change to all three plus a new page and entry; the diff; editors record but can't roll back;
  rollback restores page content and component tree on the live site, takes the new page and entry
  offline, keeps the draft; rolling back to the automatic backup restores the bad state again;
  release numbering; other workspaces 404.
- `releases.spec.ts` (E2E): publish, create a release, publish a bad title, review, roll back, the
  live site shows the old title.

## Iteration 9 — CRM and automation

- `crm.test.ts` (API, real Postgres): contacts from a form (email in capitals → one contact) and
  an order, events drained twice without doubling, revenue per currency, search, customers only,
  timeline, notes, tags normalised and de-duplicated, cancel takes the order off the totals,
  erasure; editor can't erase, viewer can't read, other workspace 404; automations: invalid form,
  no actions, unknown action types refused; form auto-reply with variables and escaped HTML, a
  team email only above the minimum, tags added, a run recorded once, disabled automation silent,
  editors read-only.
- `crm.spec.ts` (E2E): create an automation in the editor, buy on the live site, the contact shows
  up with the tag, the order and the team email; a note; the run history.

Bugs found: the contact's name was overwritten by a later order's name (now only gaps are
filled); an E2E reload loop logged the user out mid token rotation (recorded as an open item).

## Iteration 8 — Shop

- `shop.test.ts` (API, real Postgres): prices from snapshots (a client price is ignored), lines
  merged, unlimited stock without a value, stock taken atomically (1 left, 2 asked → 409 with
  nothing changed), order numbers 1001/1002, emails to buyer and shop, stock visible to Buy blocks,
  the working copy follows; refusals: draft product, no price, payment method not offered,
  honeypot, quantity over 99, bad email, foreign host, another site's product, no delivery token;
  admin: list/search/status filter, transitions and 409s, history, cancel returns stock, editor
  yes, viewer no, other workspace 404.
- `security.test.ts`: `Order` per role (authors and viewers can't read).
- `shop.test.ts` (blocks): money in cents and per locale; Buy finds its product only after binding.
- `shop.spec.ts` (E2E): collection → shop settings → cart page → product template → product →
  live product page → cart → order → Orders → Confirm.

Bugs found: entry templates in the site menu; the cart's "empty" text above a full cart; a
1.5 s minimum fill time rejected fast but real buyers (autofill) — now 300 ms, the honeypot is the
main signal.

## Iteration 7 — CMS 2.0

- `cms2.test.ts` (API, real Postgres): an entry page is served at /blog/<slug> with every token
  filled (a rich text field brings its structure, markup stays text), drafts and unknown slugs
  are 404, the template is 404 and not in the sitemap, entry pages are; a real page wins; unpublish
  takes the page down; route validation (template of another site, malformed path, two
  collections on one path); list cards by tag/order/limit with entry links, an off-list image host
  dropped, unknown collection empty, the builder preview equal to delivery and closed to other
  workspaces; field filters (eq on text, number and lists, contains, empty, not empty, combined, a
  SQL-looking value, unknown field, bad JSON); bulk publish with a validation failure listed, tags
  added/removed, a viewer refused per entry, archive and delete; saved views validated.
- `entry.test.ts` (blocks): token formatting (numbers, dates, lists), the template validates as
  page content, rich text expansion, allowlist on filled links, list cards, bounded list specs.
- `cms.spec.ts` (E2E): the whole editor flow up to the live entry page, sitemap and home page.

Bugs found: a template with `{{entry.cover}}` in an image link failed validation (links are
allowlisted) — tokens are now allowed there and the filled value is checked instead.

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
