# Canon 2.0 — visual report (Stages 1–2)

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
