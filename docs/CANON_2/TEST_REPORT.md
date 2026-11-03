# Canon 2.0 — test report

Run on 2026-11-03 against the local stack (Postgres 16, Redis, S3, Mailpit; API :4000, admin :3010,
renderer :3001).

| Suite | Result |
|---|---|
| `@canon/blocks` unit (incl. 7 new style-layer tests: grammar, injection, inheritance, compiler, document validation) | 23 / 23 ✅ |
| `@canon/collab` unit (incl. 2 new: styles round-trip, concurrent style merge) | 8 / 8 ✅ |
| fields · ai-gateway · edge · sdk | 19 · 30 · 8 · 4 ✅ |
| admin unit | 7 / 7 ✅ |
| API unit | 56 / 56 ✅ |
| API integration (real Postgres/Redis/S3) | 139 / 139 ✅ |
| Playwright E2E | 14 / 14 ✅ (+1 opt-in screenshot spec) |
| TypeScript (api, admin, web, blocks, ui-blocks, collab) | no errors ✅ |
| ESLint (`--max-warnings=0`) | clean ✅ |

Total automated tests: **308**.

## New E2E scenarios (Builder 2.0)

`apps/admin/e2e/builder2.spec.ts`

1. Select the hero → Style → padding 96 px on Desktop → canvas shows 96 px. Switch to Mobile L →
   the field shows the inherited 96 px as a hint → set 24 px → canvas 24 px. Back to Desktop →
   still 96 px. An injection attempt (`96px;color:red`) is flagged invalid and not applied.
   Rename the hero in Layers, hide the second section, save, **reload**: styles, name and
   visibility come back. Publish: the live page HTML contains the compiled CSS
   (`padding-top:96px`, the `@container (max-width: 767px)` override) and no hidden section.
2. Zoom out/in/reset on the bottom bar; Desktop renders at 1280 px scaled to fit, Mobile S at
   375 px at 100 %. Lock a block: Delete key and the Delete button do nothing; unlock → delete works.

## Bugs found and fixed by the tests

- **Responsive preview was wrong on Desktop**: the desktop frame filled the workspace (~740 px), so
  container queries applied the mobile overrides on "Desktop". Every breakpoint now renders at its
  real CSS width and the frame scales to fit.
- **Styles were lost on save**: the Yjs co-editing layer only carried `type/props/children`. It now
  carries names, flags and styles (one Yjs key per breakpoint+property, so concurrent style edits
  on one block merge).
- **Error toasts covered the Publish button** and paused while hovered, so the button became
  unreachable. Toasts moved to the bottom-right.

## Not covered yet

- Editor performance at 1000–3000 nodes in the browser, Lighthouse of published pages.
- Visual regression (screenshots are captured but not diffed automatically).
