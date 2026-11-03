# Screenshot index

All images are real captures of the running app, taken by Playwright
(`apps/admin/e2e/screenshots.spec.ts`) against the local stack. Recapture:

```bash
cd apps/admin && SCREENSHOTS_DIR=../../docs/CANON_2/screenshots/after E2E_ADMIN_URL=http://localhost:3010 npx playwright test screenshots
```

Viewport 1440 × 900 unless noted. BEFORE = baseline commit `251f83f` (Phase 9). AFTER = Canon 2.0
Stages 1–2 (design system, Builder 2.0 foundation).

| File | Stage | Viewport | What it shows |
|---|---|---|---|
| before/dashboard/dashboard-desktop-1440.png | baseline | 1440 | Workspace dashboard, old light theme |
| before/dashboard/project-pages-desktop-1440.png | baseline | 1440 | Site pages list |
| before/dashboard/sites-desktop-1440.png | baseline | 1440 | Sites list |
| before/builder/builder-desktop-1440.png | baseline | 1440 | Builder: app sidebar + palette + 500 px canvas + inspector |
| before/builder/builder-layers-1440.png | baseline | 1440 | Layers: type + summary only |
| before/builder/builder-tablet-1024.png · builder-mobile-390.png | baseline | 1024 · 390 | Builder on small screens |
| before/cms, ai, analytics, settings, marketplace/* | baseline | 1440 | Other screens for comparison |
| after/dashboard/dashboard-desktop-1440.png | 1 | 1440 | Dashboard in the Canon dark theme |
| after/dashboard/dashboard-light-1440.png | 1 | 1440 | Same, light theme |
| after/dashboard/sites-desktop-1440.png · project-pages-desktop-1440.png | 1 | 1440 | Lists in the new theme |
| after/builder/builder-desktop-1440.png | 2 | 1440 | Full-bleed builder, desktop rendered at 1280 px scaled to fit, bottom bar |
| after/builder/builder-style-panel-1440.png | 2 | 1440 | Style panel: padding, gradient, radius overrides on the hero, live on canvas |
| after/builder/builder-layers-1440.png | 2 | 1440 | Layers with styled marker and row actions |
| after/responsive/builder-tablet-breakpoint-1440.png | 2 | 1440 | Tablet breakpoint (820 px), inherited values as hints |
| after/responsive/builder-mobile-breakpoint-1440.png | 2 | 1440 | Mobile L breakpoint (430 px) |
| after/builder/builder-light-1440.png | 1–2 | 1440 | Builder in the light theme |
| after/builder/builder-tablet-1024.png | 2 | 1024 | Builder on a 1024 px screen |
| after/builder/builder-mobile-390.png | 2 | 390 | Builder on a phone (read/inspect only; editing is desktop-first) |
| after/cms/* | 1 | 1440 | Collections, forms, reviews, media in the new theme |
| after/ai/* | 1 | 1440 | AI Studio, Canon facts, search & answers |
| after/analytics/* | 1 | 1440 | Analytics, A/B testing, audiences |
| after/marketplace/integrations.png | 1 | 1440 | Plugin marketplace |
| after/settings/* | 1 | 1440 | Team, site settings, billing, notifications |
| after/builder/builder-sections-palette-1440.png | 4 | 1440 | Palette with search and the section library (tone picker) |
| after/builder/builder-sections-inserted-1440.png | 4 | 1440 | Pricing (brand tone) and testimonials (light) sections on the page |
| after/builder/builder-multiselect-1440.png | 2–3 | 1440 | Two blocks selected (Ctrl+click in Layers), multi-selection toolbar |
| after/builder/builder-history-1440.png | 3 | 1440 | History tab: the typed operation log after grouping |
| after/builder/builder-style-theme-chips-1440.png | 2 | 1440 | Style panel colour field with theme chips in the site colours |
| after/builder/builder-component-instance-1440.png | 3 | 1440 | A header turned into a global component; instance inspector with overrides |
| after/builder/builder-component-editor-1440.png | 3 | 1440 | The component builder (draft vs live version, publish) |
| after/cms/components-list-1440.png | 3 | 1440 | Site → Components list |
| after/builder/builder-ru-1440.png | 2 | 1440 | The builder in Russian: palette, tabs, Style panel |
| after/ai/canon-ai-plan-1440.png | 5 | 1440 | Canon AI tab: a proposed plan as a diff, one operation rejected with its reason (model reply recorded) |
| after/seo/seo-audit-1440.png | 9 | 1440 | Site → SEO → Audit: score, totals, issues per page (the default home page links to pages a new site does not have) |
| after/seo/seo-redirects-1440.png | 9 | 1440 | Redirects imported from CSV (exact, prefix, temporary) |
| after/ai/canon-ai-plan-applied-1440.png | 5 | 1440 | The canvas after applying three operations |

Recapture iteration 2 only: add `-g "iteration 2"` to the command above.

Screens from the brief that do not exist yet (E-commerce, CRM, automation, SEO manager, theme
marketplace, animation studio, AI website builder chat, AI inspector) have no screenshots: they will
be captured when those stages ship. No mock-ups are used in their place.
