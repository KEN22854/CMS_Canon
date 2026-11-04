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

## Simple editor (`apps/admin/src/components/builder/simple.tsx`, `block-library.tsx`)

- `mode: 'simple' | 'pro'` in the builder store (remembered per browser). Simple mode hides the
  palette and layers and turns the inspector into a drawer opened by `openInspector(panel)`.
- The overlay measures DOM rects (any zoom, any breakpoint) for the hovered top-level block: its
  bar, "+" inserters (`openLibrary(index)`), and for free-form blocks the add-element bar and
  height handle.
- **In-place text**: the renderer marks text elements with `data-field="title"` /
  `"items.2.q"` only when `ctx.editing`; a double-click makes the element `contenteditable`
  (plain text) and commits one `PROPS_UPDATE` on Enter/blur.
- **Free-form**: `canvas` renders a frame (centred 1200 px or the window); children carry
  `position:absolute` + left/top/width(/height) in the style layer, so positions are per
  breakpoint with desktop-first inheritance. Dragging previews with a CSS transform and commits
  `STYLE_SET` left/top (or width/height) at the current breakpoint through `applyMany` — one undo
  step. Height on desktop is the `height` prop (a CSS variable, so a per-breakpoint min-height
  override still wins).
- **Library previews** render each preset with the real `BlockRenderer` and the site theme at
  1200 px, scaled with CSS zoom to the card's measured width.

## Typed operations (`packages/blocks/src/edit.ts`)

Every change to a page tree is an `EditorOperation`:

| Operation | Payload |
|---|---|
| `NODE_INSERT` | `parentId`, `index`, `nodes[]` |
| `NODE_REMOVE` | `ids[]` |
| `NODE_MOVE` / `NODE_REORDER` | `id`, `parentId`, `index` / `delta` |
| `NODE_DUPLICATE` / `NODE_REPLACE` | `id` / `id`, `node` |
| `PROPS_UPDATE` | `id`, `patch` |
| `NODE_META` | `id`, `patch` (name, hidden, locked, styles) |
| `STYLE_SET` | `id`, `breakpoint`, `property`, `value \| null` |
| `NODE_GROUP` / `NODE_UNGROUP` | `ids[]`, optional `wrapper` / `id` |

`applyOperation(content, op)` is pure and all-or-nothing: an operation that breaks a nesting rule
or touches a locked block returns the same object (a no-op). Untouched subtrees keep their
identity, which the style compiler, the canvas (memoised blocks) and the undo history rely on.
The builder store applies every edit through `apply(op)` and keeps an operation log (History tab);
Canon AI (Stage 5) will propose operations in the same vocabulary, so a plan can be shown as a
diff and approved per operation. The API can apply the same functions.

## SEO platform

- **Redirects** live in `redirects` and travel to the renderer in the runtime config (cached per
  site version; `RedirectsChanged` bumps it). The proxy matches them before anything else
  (`matchRedirect` in `@canon/edge`: exact, then longest prefix), so bots follow moves too.
  `PageMoved` → automatic old → new rules (and `old/*`), older automatic rules re-pointed so
  there are no chains; `PagePublished` removes a rule from the page's own path.
- **Audit** is a pure function over one page plus site context; the API supplies the context
  (published paths, redirect sources/prefixes, title/description counts of indexable pages, media
  alt texts).
- **JSON-LD** is built from the published content (`structuredData`) and printed with `jsonLd`
  (escapes `<`, U+2028/2029).
- **404**: `app/s/[host]/not-found.tsx` stays static; `/api/not-found` (route handler, may read the
  host) returns the site's /404 page for the client to render.

## Canon AI plans (`packages/blocks/src/plan.ts`)

```
editor draft + selection + instruction
  → POST /ai/plan → prompt: catalog, operation vocabulary, style properties, facts, page outline
  → model JSON {summary, operations}
  → buildPlan: per operation — shape (zod) → prepare (materialise new blocks, coerce props via
    the catalog, check style grammar) → applyOperation (locks, nesting) → validatePageContent
  → accepted / rejected-with-reason
  → (nothing accepted) one repair round with the reasons
  → editor: diff per operation, person keeps/drops each → store.applyMany → one undo step
```

The model can't lock, replace or ungroup; ids of existing blocks must come from the outline
(invented ids are rejected because the operation doesn't apply). The page outline is capped at
400 blocks for the prompt.

## Global components (`packages/blocks/src/components.ts`, `apps/api/src/modules/components`)

- `SiteComponent` (table `site_components`, RLS by tenant): `tree` (working copy) and
  `publishedTree`, `version` (optimistic lock) and `publishedVersion`.
- A page holds an instance: `{ type: 'component', props: { componentId, overrides } }`.
  `overrides` maps an inner block id to a props patch (text and links in the UI).
- `expandInstance` turns an instance into blocks: the component root takes the instance id (so
  the instance's styles, name and visibility apply), inner ids are prefixed with the instance id
  (unique when used twice), overrides are applied only if the merged props still validate.
- Delivery expands **published** trees for live pages and working copies for previews, before
  media, facts and forms are collected. `ComponentPublished` (outbox) invalidates the site cache and
  the renderer's ISR tags, so every page that uses a component updates on publish.
- No recursion: a component can't contain component blocks (validated on save).
- The builder draws instances in place (inner blocks visible, not selectable), offers overrides,
  detach (replace with a copy of its blocks) and "Edit component", which opens the same workspace
  on the component tree.

## Section library (`packages/blocks/src/sections.ts`)

29 layouts × 4 tones built only from registry blocks and the style layer (so everything stays
editable and validated), copy in EN/RU picked by the page locale. Tones are styles on the
section root (`token:` colours), so they follow the site theme.

## Converted templates (`packages/blocks/src/vendor`)

`scripts/import-vendor-templates.cjs <download-dir>` turns Tailblocks (JSX) and HyperUI (HTML)
files into Canon block trees with a small markup parser — the sources are read as text, never
executed. Tailwind classes become style-layer values (largest breakpoint → base, unprefixed →
Mobile L), accent colours become theme tokens, copy becomes `[[h1|p|btn…]]` placeholders.
The output, `sections-data.ts`, is generated (do not edit) and loaded with a dynamic import, so
the ~0.9 MB stays out of the builder's first bundle; `fill(locale)` replaces placeholders from
per-category pools and gives fresh ids. Re-run the script after updating the downloads.

## Animation (`packages/blocks/src/animation.ts`)

`node.animation` = {type, trigger, duration, delay, easing, hover}, strict schema, defaults
dropped. The renderer marks the block (`data-anim`, `data-anim-trigger`, `data-hover`), the
style compiler writes its timing as CSS variables, `ANIMATION_CSS` holds the keyframes. Scroll
entrances are hidden only after `html.canon-anim` is set by the observer, so without JS (or with
reduced motion) content is simply visible. Collab stores the object as a JSON string per block.

## CMS 2.0 (`packages/blocks/src/entry.ts`, `apps/api/src/modules/delivery/entry-pages.service.ts`)

- **Entry pages.** `Collection.settings.route = { basePath, templatePageId }`. Delivery looks
  up a page by path first; when there is none, it splits the path into base + slug, finds the
  routed collection and the entry whose *published snapshot* has that slug, takes the template's
  published version and runs `bindEntry` before `assemble`, so components, media and forms of
  the result load as for any page. Template pages are refused by direct path and left out of
  lists and the sitemap. Entry pages are cached like pages and invalidated by the same events
  (EntryPublished/Unpublished, CollectionUpdated, PagePublished).
- **Tokens.** `{{entry.<name>}}` in any string prop; columns (title, slug, summary,
  publishedAt) first, then data fields. Values become text (React escapes it). Media link props
  (`src`, `imageUrl`, `videoUrl`, `fileUrl`) accept a whole token in templates and re-check
  the filled value against the external-media allowlist.
- **Collection lists.** `collectListSpecs(root)` → `EntryPagesService.lists()` → payload
  `lists[blockId]` → `RenderContext.lists`. Same code for the builder preview
  (`POST /v1/sites/:id/collection-lists/preview`, tenant checked first, then system queries
  pinned to the site).
- **Filters** are parameterised SQL on `entries.data` (field names must exist in the schema);
  **views** live in `Collection.settings.views`; **bulk** loops the single-entry service methods.

## Shop (`packages/blocks/src/shop.ts`, `apps/api/src/modules/shop`)

- `Collection.settings.commerce` makes a collection a shop. Delivery resolves Buy blocks
  (`collectProductIds` after entry binding) to `products[id] = {title, price (cents), currency,
  stock, available}` from published snapshots, and pages with a Cart block get `shop` (currency,
  payment methods).
- The site's `/api/shop/checkout` resolves the site from the request host and forwards to
  `POST /v1/delivery/sites/:id/orders` (delivery token). `ShopService.checkout`: host and rate
  checks → products of one shop collection, published, priced → one transaction: conditional
  stock decrement in the published `entry_versions` row and the working `entries` row, an
  advisory lock per site for the order number, the order, an `OrderPlaced` outbox event (bumps
  the delivery cache, feeds webhooks) → emails after commit.
- Status changes are compare-and-swap on the current status; CANCELLED returns stock the same
  way.

## No-op edits

Edits return the same tree object when nothing changes (also for props/meta/styles set to the
value they already have). The store treats "same object" as "skip": no undo step, no log entry,
no Yjs transaction. Keep this when adding an operation — otherwise an undo step that changes
nothing appears, and in co-editing Ctrl+Z jumps over it to the step before.

## Canvas rendering

`BlockRenderer` stays a plain server-compatible function. The builder passes `ctx.Child`, a
`memo`-wrapped renderer, so an edit re-renders the path to the changed block only; styles are
emitted as one `<style>` per top-level section (memoised), so a style edit replaces one small
sheet. The site renders one sheet with `PageStyles`.


## Design system (admin)

Tokens live in `apps/admin/src/app/globals.css` as HSL CSS variables consumed by Tailwind:
background, surface, surface-2, border, primary (#8B7CFF), accent (#42C8E8), success,
warning, danger, foreground, muted-foreground, plus radius, shadow and spacing scales. Dark is
the default; light is a full theme. The theme follows the OS until the user picks one in the
user menu (stored in `localStorage`). See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
