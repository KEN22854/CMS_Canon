# Canon 2.0 — roadmap

The 18 stages of the Canon 2.0 brief, in the order that respects dependencies. A stage is done
only with a working UI, backend where needed, permissions, error/loading/empty states, tests,
real screenshots and updated docs.

| # | Stage | Depends on | Status |
|---|---|---|---|
| 0 | Audit | — | ✅ |
| 1 | Design system | — | 🟡 first iteration |
| 2 | Visual Builder 2.0 | 1, 3 | 🟡 simple mode (library, in-place text, free-form board: multi-select, guides, align, rotate), pro mode |
| 3 | Page document engine | — | 🟡 node fields, styles, typed operations, components |
| 4 | Component library (100+ sections, variants) | 2 | 🟡 114 own layouts × 4 tones + 257 from Tailblocks/HyperUI (MIT), 21 page templates, photo/video heroes |
| 5 | AI Website Builder (planner → operations → diff → approve) | 3, 4 | 🟡 planner, diff, approve, one undo step |
| 6 | CMS 2.0 (dynamic pages, views, bulk) | — | 🟡 entry pages from templates, collection list block, field filters, saved views, bulk actions |
| 7 | E-commerce | 6 | 🟡 products, Buy and Cart blocks, checkout with stock, orders with statuses (offline payment) |
| 8 | CRM and automation | 7 (orders), forms | 🟡 contacts from forms and orders, timeline, tags, notes, erasure; automations (form/order events → emails, tags) |
| 9 | SEO platform (redirects, audit, schema) | — | 🟡 redirects, audit, JSON-LD, 404 |
| 10 | Themes and marketplace | 1, 4 | 🟡 24-theme gallery, theme studio with WCAG checks, workspace themes, JSON sharing (no public marketplace yet) |
| 11 | Animation studio | 2 | 🟡 entrance/hover animations per block, scroll trigger, reduced motion |
| 12 | Analytics and growth (heatmaps, funnels) | — | ⬜ |
| 13 | Hosting: site releases, rollback | — | 🟡 releases of the live site, diff, one-click rollback (undoable) |
| 14 | Security audit | each stage | continuous |
| 15 | Multilingual platform (DE/FR/ES) | — | ⬜ |
| 16 | Developer platform | — | ⬜ |
| 17 | Migration center | 4, 9 | 🟡 WordPress import (posts, pages, categories, 301 redirects); CSV/JSON into collections |
| 18 | Local integrations | 7, 8 | ⬜ |

The previous roadmap (Phases 10–11 in [../roadmap.md](../roadmap.md)) folds into stages 5, 9, 12,
17 and 18.
