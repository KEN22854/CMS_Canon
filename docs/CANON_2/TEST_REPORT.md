# Canon 2.0 — test report

Run on 2026-11-03 against the local stack (Postgres 16, Redis, S3, Mailpit; API :4000, admin :3010,
renderer :3001).

| Suite | Result |
|---|---|
| `@canon/blocks` unit — style layer (8), typed operations and global components (9), section library (4), AI plans (4), tree (16) | 41 / 41 ✅ |
| `@canon/collab` unit | 8 / 8 ✅ |
| fields · ai-gateway · edge · sdk | 19 · 30 · 8 · 4 ✅ |
| admin unit — tree ops and history (7), Builder 2.0 store: multi-select, group, clipboard, operation log, block cap, plan batch (5) | 12 / 12 ✅ |
| API unit | 56 / 56 ✅ |
| API integration (real Postgres/Redis/S3) incl. 2 for global components, 2 for AI plans | 143 / 143 ✅ |
| Playwright E2E | 18 / 18 ✅ (+5 opt-in: 3 screenshot specs, 2 performance specs) |
| TypeScript (api, admin, web, blocks, ui-blocks, collab) | no errors ✅ |
| ESLint (`--max-warnings=0`) | clean ✅ |

Total automated tests: **339** (331 after iteration 2, 308 after iteration 1).

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
