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

Screens from the brief that do not exist yet (E-commerce, CRM, automation, SEO manager, theme
marketplace, animation studio, AI website builder chat, AI inspector) have no screenshots: they will
be captured when those stages ship. No mock-ups are used in their place.
