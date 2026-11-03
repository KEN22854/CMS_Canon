# Canon 2.0 — progress

Last update: 2026-11-03.

## Done in this iteration

**Stage 0 — audit.** AUDIT, ARCHITECTURE, ROADMAP, BACKLOG, TECHNICAL_DEBT; 24 BEFORE screenshots.

**Stage 1 — design system (first iteration).** Canon palette as HSL tokens, dark default + full light
theme, theme toggle (Dark → Light → System) with no flash on load, shadow/radius/type scales,
Skeleton and EmptyState, DESIGN_SYSTEM.md. Toasts moved to the bottom-right.

**Stage 2/3 — Builder 2.0 foundation.**
- Page document: nodes gain `name`, `hidden`, `locked`, `styles` (backward compatible); depth cap
  6 → 10, node cap 500 → 3000.
- Responsive style layer in `@canon/blocks`: 5 breakpoints, ~50 whitelisted properties with value
  grammars, desktop-first inheritance, one compiler for canvas and site (container queries).
- Renderer: `data-cn` on the block's own root element, `<PageStyles>`; hidden nodes are not rendered.
- Co-editing: Yjs carries names, flags and styles (per breakpoint+property granularity).
- Builder UI: Style panel, five-breakpoint toolbar, real-width preview with fit and zoom, bottom bar,
  Layers with rename/hide/lock/duplicate/delete, shortcuts (Ctrl+Shift+H/L, Ctrl+=/−/0),
  full-bleed editor.
- Tests: 9 new unit tests, 2 new E2E scenarios; 308 automated tests green.

## Not done yet (next)

1. Typed editor operations (NODE_INSERT/…), multi-select, copy/paste, group/ungroup.
2. Global components with overrides.
3. Memoised style compilation; editor performance at 1–3k nodes; Lighthouse on published pages.
4. Theme colour chips in the Style panel should show the site's actual colours.
5. Builder strings in Russian.
6. Stage 4 (block variants, 100+ sections) and Stage 5 (AI planner → operations → diff).

Stages 6–18 have not started. See ROADMAP.md.
