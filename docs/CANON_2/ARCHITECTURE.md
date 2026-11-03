# Canon 2.0 — architecture

Canon 2.0 grows from the existing platform; nothing is rewritten. This document covers the
pieces added in Canon 2.0. The base architecture (tenancy, outbox, AI gateway, renderer) is in
[../architecture.md](../architecture.md).

## Page document (Stage 3, first step shipped with Stage 2)

The stored page tree stays `PageContent { root: BlockNode }`, so every existing page, version,
AI tool and the renderer keep working. A node gains optional fields:

```ts
interface BlockNode {
  id: string;
  type: string;
  props: Record<string, unknown>; // content and block-level options (unchanged)
  children: BlockNode[];
  name?: string;                  // label in Layers
  hidden?: boolean;               // not rendered anywhere (editor shows it dimmed)
  locked?: boolean;               // cannot be selected on the canvas, moved or deleted
  styles?: ResponsiveStyles;      // visual overrides, see below
}
```

Old documents have none of the new fields and render exactly as before.

## Responsive style layer (`packages/blocks/src/styles.ts`)

```ts
type Breakpoint = 'base' | 'laptop' | 'tablet' | 'mobileL' | 'mobileS';
type StyleProps = Partial<Record<StyleProperty, string>>;
type ResponsiveStyles = Partial<Record<Breakpoint, StyleProps>>;
```

- **Desktop first.** `base` applies everywhere; `laptop` (≤1279 px), `tablet` (≤991 px),
  `mobileL` (≤767 px) and `mobileS` (≤479 px) override it through `max-width` media queries in
  that order, so editing mobile never changes desktop. The resolved value for a breakpoint is
  the nearest override at or above it (`resolveStyles`).
- **Whitelisted properties.** About 45 CSS properties in eight groups (layout, position, size,
  spacing, typography, background, border, effects, transform), each with a value validator:
  lengths (`px|rem|em|%|vw|vh|auto|fr`), colours (hex, `rgb()`/`hsl()`, `var(--c-…)` theme
  tokens), enums, numbers, shadows and gradients built from those parts. Anything else is
  rejected at save time by `validatePageContent`, so stored documents are safe to render.
- **No injection.** Values may not contain `;`, `{`, `}`, `<`, `>`, backslashes, `url(` (images
  come from media ids via the background-image property's dedicated form), `expression` or
  `javascript:`. The compiler only emits whitelisted property names.
- **One compiler for editor and renderer.** `compileStyles(nodes)` returns one CSS string with
  rules scoped by `[data-cn="<id>"]`. The renderer puts it in a `<style>` element in the page;
  the builder canvas does the same, and simulates breakpoints by compiling the rules for the
  previewed width without media queries (`compileStyles(root, { breakpoint })`), because the canvas is a
  resized `div`, not a separate window.
- **Visibility per breakpoint** is the `display: none` override (`hide on mobile`).

## Builder workspace

- Full-bleed editor (the app sidebar is not rendered on the editor route).
- Left: Blocks / Layers. Layers support rename (double click), hide, lock, duplicate, delete.
- Centre: canvas with zoom (50–150 %), five breakpoint widths and a custom width.
- Right: Block (content props), **Style** (the style layer for the selected breakpoint, with
  overridden properties marked and a reset per property), Page & SEO, Versions, Translate, Review.
- Undo/redo keeps snapshot history (existing `useHistory`); every style edit coalesces per
  property, like content edits.
- Co-editing: the Yjs document carries the full tree, so styles sync with no protocol change.

## Design system (admin)

Tokens live in `apps/admin/src/app/globals.css` as HSL CSS variables consumed by Tailwind:
background, surface, surface-2, border, primary (#8B7CFF), accent (#42C8E8), success,
warning, danger, foreground, muted-foreground, plus radius, shadow and spacing scales. Dark is
the default; light is a full theme. The theme follows the OS until the user picks one in the
user menu (stored in `localStorage`). See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
