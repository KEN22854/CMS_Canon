# Canon 2.0 — technical debt

| Item | Where | Impact | Plan |
|---|---|---|---|
| Undo/redo is snapshot-based | `apps/admin/src/components/builder/store.ts` | Memory grows with big trees; no operation log for audit/AI diffs | Typed operations (Stage 3) |
| Prettier config exists but the code base was never formatted with it | repo-wide | Formatting runs create huge diffs | Either format once in a dedicated commit or drop the config; until then format only new files |
| Block visuals are hard-coded Tailwind enums | `packages/ui-blocks/src/render.tsx` | Cannot express arbitrary values | Style layer (Stage 2) keeps enums as presets, styles override |
| Admin UI primitives are home-grown, no Radix | `apps/admin/src/components/ui.tsx` | Dropdowns, tooltips and dialogs lack focus management in places | Add Radix primitives where accessibility needs them (dialog, dropdown, tooltip) |
| English strings in most admin screens | builder, collections, Canon, Studio, settings | RU users see mixed language | Continue the i18n dictionaries screen by screen |
| `prisma generate` fails while the API runs on Windows (DLL lock) | dev only | Confusing turbo failures | Document; stop the API before generating |
| Server-generated notification texts are English | notifications, API errors | Mixed language | Render by `user.locale` |
| Per-page publishing only | pages/entries services | No atomic multi-page release | Site releases (Stage 13) |
| Style compilation is not memoised | `packages/blocks/src/styles.ts`, canvas | ~35 ms per edit at 3000 nodes | Cache rules per node object identity |
| Theme colour chips in the Style panel show grey dots | `style-panel.tsx` | Cosmetic: site colour vars exist only inside the canvas | Pass the site theme to the panel |
| `locked` is not enforced by the API | by design | An editor can unlock and edit | Document; add a permission if agencies need it |
