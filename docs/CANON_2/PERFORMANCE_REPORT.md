# Canon 2.0 — performance report

Machine: Windows 11 dev workstation, Node 24, Chromium 156 (Playwright), measured on 2026-11-03.
The admin runs as a Next.js **dev** server, the renderer as a production build. Treat the numbers
as a comparison between runs on one machine, not as device benchmarks.

## Document engine (`@canon/blocks`)

Synthetic pages: sections with 9 styled children each (styles at three breakpoints per node).
Averages of 20 runs after a warm-up. Script: `node packages/blocks/bench/document.cjs` (after
`tsc -p packages/blocks/tsconfig.build.json`).

| Nodes | JSON size | validate (ms) | compileStyles, cold (ms) | compileStyles after one edit (ms) | CSS size |
|---|---|---|---|---|---|
| 100 | 23 KB | 0.93 | 0.06 | 0.07 | 15 KB |
| 500 | 117 KB | 2.57 | 0.18 | 0.21 | 74 KB |
| 1000 | 234 KB | 4.73 | 0.42 | 0.40 | 149 KB |
| 3000 | 704 KB | 15.78 | 1.38 | 1.27 | 453 KB |

Before this iteration compiling 3000 nodes took **35.3 ms on every edit**. Compiled rules are now
memoised per `styles` object: edits are immutable and the shared tree functions keep untouched
subtrees by identity, so an edit recompiles one node. (The "cold" column is also cached after the
warm-up run; a truly first compile of 3000 nodes is the old ~35 ms, once per page load.)

## Editor in the browser (1 000 and 3 000 blocks)

`apps/admin/e2e/perf.spec.ts` (opt-in, `PERF_REPORT=… npx playwright test perf`) fills the home
page to exactly 1 000 / 3 000 blocks through the builder's own paste path and times each step from
the trigger to the next animation frame where the result is on screen. Raw numbers:
[`perf-browser.json`](perf-browser.json).

| Step | 1 000 blocks | 3 000 blocks |
|---|---|---|
| Paste ~1 000 / ~3 000 blocks onto the page | 239 ms | 733 ms |
| Select a block deep in the page | 8 ms | 17 ms |
| Style edit: type "77" into Padding top → compiled CSS on canvas (2 keystrokes) | 87 ms | 149 ms |
| Type one character into a prop → canvas text | 81 ms | 157 ms |
| Save (Ctrl+S → server acknowledged) | 376 ms | 844 ms |
| JS heap after the steps | 58 MB | 169 MB |

Three fixes came out of these measurements (before → after, 3 000 blocks):

| Change | Style edit (2 keys) | Typing (1 key) |
|---|---|---|
| Baseline: whole canvas re-renders, one 450 KB `<style>` | 1 292 ms | 315 ms |
| Memoised block rendering (`ctx.Child`, untouched subtrees skipped) | 908 ms | 78 ms |
| One stylesheet per top-level section (a style edit re-parses one small sheet) | **149 ms** | 78–157 ms |

Typing varies between 78 and 157 ms across runs (Next dev mode, collaboration sync on the same
thread). Remaining cost at 3 000 blocks is the Yjs diff of the whole tree per edit and React's
reconciliation of the edited path; both are on the list below.

## Published page (lab metrics)

Lighthouse is **not installed** in the repository, and adding it means downloading a package, so it
was not run. The same lab metrics were measured with Chromium's Performance APIs on the published
page (1280×800, no throttling, localhost):

| Metric | 1 000 blocks | 3 000 blocks |
|---|---|---|
| TTFB | 10 ms | 24 ms |
| First / Largest Contentful Paint | 148 ms | 364–848 ms (varies between runs) |
| Cumulative Layout Shift | 0 | 0 |
| Total Blocking Time (long tasks > 50 ms) | 33 ms | 0–333 ms |
| HTML transferred / decoded | 69 KB / 670 KB | 191 KB / 1 996 KB |
| JavaScript transferred | 140 KB | 140 KB |
| Requests | 11 | 11 |
| DOM elements | 1 959 | 5 788 |

The JavaScript stays at 140 KB regardless of page size (blocks render as React Server Components);
the page weight grows with the HTML. CLS is 0 at both sizes. Running real Lighthouse (with mobile
throttling) needs `lighthouse` added as a dev dependency — tracked in TECHNICAL_DEBT.md.

## Next steps

- Per-node Yjs diffing (skip unchanged subtrees by identity instead of comparing every node).
- Virtualise the Layers tree above ~500 rows.
- Lighthouse CI with mobile throttling on a production build of the renderer.
