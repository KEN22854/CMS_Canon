# Canon 2.0 — technical debt

| Item | Where | Impact | Plan |
|---|---|---|---|
| Undo/redo is snapshot-based | `apps/admin/src/components/builder/store.ts` | With structural sharing a step costs only the changed path; typed operations are logged but undo does not replay them | Inverse operations per op type |
| Prettier config exists but the code base was never formatted with it | repo-wide | Formatting runs create huge diffs | Either format once in a dedicated commit or drop the config; until then format only new files |
| Block visuals are hard-coded Tailwind enums | `packages/ui-blocks/src/render.tsx` | Cannot express arbitrary values | Style layer (Stage 2) keeps enums as presets, styles override |
| Admin UI primitives are home-grown, no Radix | `apps/admin/src/components/ui.tsx` | Dropdowns, tooltips and dialogs lack focus management in places | Add Radix primitives where accessibility needs them (dialog, dropdown, tooltip) |
| English strings in several admin screens | collections, Canon, Studio, settings (builder done) | RU users see mixed language | Continue the i18n dictionaries screen by screen |
| `prisma generate` fails while the API runs on Windows (DLL lock) | dev only | Confusing turbo failures | Document; stop the API before generating |
| Server-generated notification texts are English | notifications, API errors | Mixed language | Render by `user.locale` |
| Per-page publishing only | pages/entries services | No atomic multi-page release | Site releases (Stage 13) |
| `locked` is not enforced by the API | by design | An editor can unlock and edit | Document; add a permission if agencies need it |
| Yjs diff walks the whole tree per edit | `packages/collab` `applyDraftDiff` | Part of the ~80–150 ms per keystroke at 3 000 blocks | Skip subtrees that kept their identity |
| No Lighthouse in CI | repo | Lab metrics come from Performance APIs, without mobile throttling | Add `lighthouse` as a dev dependency (needs approval to download) |
| Component instances are wrapped in a div on the canvas | `packages/ui-blocks` render `component` | In flex/grid parents the builder shows one extra box; the live site has none | Render the expanded root with the instance attributes merged |
| Section library copy lives in code | `packages/blocks/src/sections.ts` | Adding a language means editing code | Move copy to dictionaries when Stage 15 (multilingual) lands |
| Component edits outside the builder aren't co-edited | component builder | Two people editing one component get a 409 on the second save | Yjs rooms for components, like pages |
