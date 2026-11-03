# Canon 2.0 — performance report

Machine: Windows 11 dev workstation, Node 24, measured on 2026-11-03. Numbers are averages of 20 runs
after a warm-up. Reproduce with the benchmark script described below.

## Document engine (Stage 2/3)

Synthetic pages: sections with 9 styled children each (3 breakpoints of overrides per node).

| Nodes | JSON size | validate (ms) | compileStyles (ms) | CSS size |
|---|---|---|---|---|
| 100 | 23 KB | 0.89 | 1.59 | 15 KB |
| 500 | 117 KB | 2.45 | 7.11 | 74 KB |
| 1000 | 234 KB | 4.55 | 12.86 | 149 KB |
| 3000 | 704 KB | 13.52 | 35.30 | 453 KB |

- `validatePageContent` runs on every save (API) — 13.5 ms at the 3000-node cap is negligible next to
  the database write.
- `compileStyles` runs on every canvas render. Up to ~1000 nodes it fits in one frame (≤ 16 ms).
  At 3000 nodes it costs ~35 ms per edit. **Planned fix:** memoise compiled rules per node (the
  tree is immutable, so unchanged nodes keep their object identity) — tracked in TECHNICAL_DEBT.md.
- The published site compiles once per ISR render, so its cost does not reach visitors.

## Builder (measured in the E2E runs)

- Builder route opens and renders the canvas in ~1.5–2 s on a dev server (Next.js dev mode, no
  production build); full E2E suite (15 specs) runs in 51 s.
- Editing at 100–3000 nodes in the real editor and Lighthouse scores of published pages are **not
  measured yet**: they need a seeded large page and a production build of admin and web. Next step
  in the backlog.

## How to reproduce

The benchmark builds pages of 100–3000 nodes with `@canon/blocks` (`packages/blocks/dist`) and
times `validatePageContent` and `compileStyles`. The script lives with the session notes; it will be
added as `packages/blocks/bench/document.bench.ts` together with the memoisation work.
