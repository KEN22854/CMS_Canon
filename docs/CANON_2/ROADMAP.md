# Canon 2.0 — roadmap

The 18 stages of the Canon 2.0 brief, in the order that respects dependencies. A stage is done
only with a working UI, backend where needed, permissions, error/loading/empty states, tests,
real screenshots and updated docs.

| # | Stage | Depends on | Status |
|---|---|---|---|
| 0 | Audit | — | ✅ |
| 1 | Design system | — | 🟡 first iteration |
| 2 | Visual Builder 2.0 | 1, 3 | 🟡 style layer, style panel, layers, zoom |
| 3 | Page document engine | — | 🟡 node fields + styles; typed operations next |
| 4 | Component library (100+ sections, variants) | 2 | ⬜ |
| 5 | AI Website Builder (planner → operations → diff → approve) | 3, 4 | ⬜ |
| 6 | CMS 2.0 (dynamic pages, views, bulk) | — | ⬜ |
| 7 | E-commerce | 6 | ⬜ |
| 8 | CRM and automation | 7 (orders), forms | ⬜ |
| 9 | SEO platform (redirects, audit, schema) | — | ⬜ |
| 10 | Themes and marketplace | 1, 4 | ⬜ |
| 11 | Animation studio | 2 | ⬜ |
| 12 | Analytics and growth (heatmaps, funnels) | — | ⬜ |
| 13 | Hosting: site releases, rollback | — | ⬜ |
| 14 | Security audit | each stage | continuous |
| 15 | Multilingual platform (DE/FR/ES) | — | ⬜ |
| 16 | Developer platform | — | ⬜ |
| 17 | Migration center | 4, 9 | ⬜ |
| 18 | Local integrations | 7, 8 | ⬜ |

The previous roadmap (Phases 10–11 in [../roadmap.md](../roadmap.md)) folds into stages 5, 9, 12,
17 and 18.
