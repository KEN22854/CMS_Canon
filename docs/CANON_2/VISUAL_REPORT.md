# Canon 2.0 — visual report

## Builder: before → after

| Before | After |
|---|---|
| ![before](screenshots/before/builder/builder-desktop-1440.png) | ![after](screenshots/after/builder/builder-desktop-1440.png) |

- The editor is now full-bleed: the app sidebar is gone on the builder route, so the canvas gets
  the space between the palette and the inspector.
- Desktop is rendered at its real width (1280 px) and scaled to fit, so what you see is what a
  desktop visitor gets. The bottom bar shows zoom, viewport and the selection.

## Style panel

![style panel](screenshots/after/builder/builder-style-panel-1440.png)

Layout, spacing, size, typography, background (colour, gradient), border, effects, position and
transform for any block, per breakpoint. Overridden fields are marked, each has a reset, and
values inherited from a larger breakpoint appear as hints. Theme colour chips keep styles in sync
with the site theme.

## Responsive editing

| Tablet (820 px) | Mobile L (430 px) |
|---|---|
| ![tablet](screenshots/after/responsive/builder-tablet-breakpoint-1440.png) | ![mobile](screenshots/after/responsive/builder-mobile-breakpoint-1440.png) |

Five breakpoints (Desktop, Laptop, Tablet, Mobile L, Mobile S). Editing a smaller breakpoint only
adds overrides; desktop never changes.

## Layers

![layers](screenshots/after/builder/builder-layers-1440.png)

Rename (double click), hide, lock, duplicate, delete, drag; styled blocks are marked.

## Design system

| Dark (default) | Light |
|---|---|
| ![dark](screenshots/after/dashboard/dashboard-desktop-1440.png) | ![light](screenshots/after/dashboard/dashboard-light-1440.png) |

Canon palette as tokens (background #0B0D12, surface #121620, accent #8B7CFF / #42C8E8), a full
light theme, theme toggle in the user menu, shadow and radius scales, Skeleton and EmptyState
primitives. See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

---

# Iteration 2 — editing model, components, sections

## Section library

| Palette | On the page |
|---|---|
| ![sections palette](screenshots/after/builder/builder-sections-palette-1440.png) | ![sections inserted](screenshots/after/builder/builder-sections-inserted-1440.png) |

Search across blocks and sections; 29 layouts in ten categories, each in four tones (light, soft,
dark, brand). Inserted sections are ordinary blocks: the pricing cards are Groups with styles.

## Multi-select, groups, operation log

| Multi-selection | History |
|---|---|
| ![multi-select](screenshots/after/builder/builder-multiselect-1440.png) | ![history](screenshots/after/builder/builder-history-1440.png) |

Ctrl/Shift+click selects several blocks; the toolbar sits above the whole selection (group,
duplicate, delete). Every edit appears in History as a typed operation.

## Global components

| Instance and overrides | Component builder |
|---|---|
| ![instance](screenshots/after/builder/builder-component-instance-1440.png) | ![component editor](screenshots/after/builder/builder-component-editor-1440.png) |

A header became a component: the inspector shows its live version, "Edit component", "Detach"
and per-page overrides of its texts and links. The component opens in its own builder with
draft/live status and a publish button. Site → Components lists them:

![components list](screenshots/after/cms/components-list-1440.png)

## Russian and theme colours

| Builder in Russian | Theme chips in the site colours |
|---|---|
| ![ru](screenshots/after/builder/builder-ru-1440.png) | ![chips](screenshots/after/builder/builder-style-theme-chips-1440.png) |

---

# Iteration 3 — Canon AI edits the page (Stage 5)

| Proposed plan | Applied |
|---|---|
| ![plan](screenshots/after/ai/canon-ai-plan-1440.png) | ![applied](screenshots/after/ai/canon-ai-plan-applied-1440.png) |

The Canon AI tab sends the request with the draft and selection. The plan comes back as typed
operations with a before → after diff; an unsafe style is shown as rejected with its reason and
can't be chosen. "Apply" runs the kept operations as one undo step. (For the screenshot the model
reply is recorded; the planner's checks run on the server in the integration tests.)

---

# Iteration 4 — SEO platform (Stage 9)

| Audit | Redirects |
|---|---|
| ![audit](screenshots/after/seo/seo-audit-1440.png) | ![redirects](screenshots/after/seo/seo-redirects-1440.png) |

Site → SEO shows the site score and, per page, what to fix — each issue with a block links into
the builder with that block selected. Redirects can be typed in, imported from CSV, and appear
automatically (marked "automatic") when a published page moves.

---

# Iteration 11 — Themes

![theme studio](screenshots/after/themes/themes-gallery-1440.png)

The studio previews the theme being edited; the gallery shows each preset with its own colours,
font and corners; workspace themes sit below.

# Iteration 10 — Releases

| Review before rolling back | After the rollback (automatic backup release) |
|---|---|
| ![review](screenshots/after/releases/releases-review-1440.png) | ![list](screenshots/after/releases/releases-list-1440.png) |

# Iteration 9 — CRM and automation

| Contact with timeline (order, team email, note) | Automation editor |
|---|---|
| ![contacts](screenshots/after/crm/crm-contacts-1440.png) | ![editor](screenshots/after/crm/crm-automation-editor-1440.png) |

![automations](screenshots/after/crm/crm-automations-1440.png)

# Iteration 8 — Shop

| Product page (Buy, stock, toast) | Cart and checkout |
|---|---|
| ![product](screenshots/after/shop/shop-product-1440.png) | ![cart](screenshots/after/shop/shop-cart-1440.png) |

| Orders with the order panel | Products collection with the shop card |
|---|---|
| ![orders](screenshots/after/shop/shop-orders-1440.png) | ![collection](screenshots/after/shop/shop-collection-1440.png) |

# Iteration 7 — CMS 2.0

| Entries: entry pages, saved view, bulk actions | Collection list block in the builder |
|---|---|
| ![bulk](screenshots/after/cms/cms2-entries-bulk-1440.png) | ![list](screenshots/after/cms/cms2-collection-list-builder-1440.png) |

The entry pages card says where entries live (/blog/…) and opens the template; the bulk bar
appears with the selection. In the builder the list shows the published entries a visitor will
see, with links to their pages.

# Iteration 6 — templates, media, animation, the board

| Board: two elements selected, align tools | Animation on a selected element |
|---|---|
| ![board](screenshots/after/builder/simple-board-1440.png) | ![animation](screenshots/after/builder/simple-animation-1440.png) |

| Hero with a background video | Library: converted heroes |
|---|---|
| ![video](screenshots/after/builder/simple-video-hero-1440.png) | ![library](screenshots/after/library/library-hero-1440.png) |

| Library: shop | Library: features |
|---|---|
| ![shop](screenshots/after/library/library-shop-1440.png) | ![features](screenshots/after/library/library-features-1440.png) |

# Iteration 5 — the simple editor

| Page with the block bar | Block library |
|---|---|
| ![page](screenshots/after/builder/simple-page-1440.png) | ![library](screenshots/after/builder/simple-library-1440.png) |

| Free-form block | Page template |
|---|---|
| ![free-form](screenshots/after/builder/simple-freeform-1440.png) | ![template](screenshots/after/builder/simple-template-1440.png) |

The page is edited where it is: hover a block for its bar, "+" to add a block exactly there,
double-click text to change it. In a free-form block, elements are dragged and resized directly;
the size shows under the element and positions snap to an 8 px grid.
