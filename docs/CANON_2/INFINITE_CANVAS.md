# Canon 2.0 — Infinite Canvas Website Builder

Last update: 2026-11-04 (iteration 18).

The page builder now opens on a **board**: an infinite, pannable, zoomable workspace (in the spirit of
Miro, FigJam and Figma) on which the page is shown as **device artboards** side by side — Desktop,
Laptop, Tablet, Mobile or any custom width. You build on the artboards with the library on the left,
the inspector on the right and an edit bar on top; the page itself stays a real, responsive website.

## 1. Stage 1 — audit of what existed

| Area | What was already there (reused) | Gap for an infinite canvas |
|---|---|---|
| Page model | `PageContent` block tree (`@canon/blocks`): typed props per block, `styles` per breakpoint (5 breakpoints, compiled to `@container` queries), `animation`, `hidden`, `locked`, `name` | none — the board edits this tree; no new storage |
| Editing core | `store.ts` (Zustand + zundo): every edit is a typed `EditorOperation`, one undo step, op log; clipboard across pages; group/ungroup; multi-select | a few view-state fields (snap, grid, cursors, focus), `selectMany` |
| Canvas | `canvas.tsx`: the page rendered with the **real site renderers** (`@canon/ui-blocks`), overlays from DOM rects, inline text editing, drop resolution from the rendered DOM (`drop.ts`) | one scrolling frame at one width; no pan/zoom space, no multiple widths |
| Free positioning | the `canvas` (free-form) block with `FreeSelection`: move, resize, rotate, guides, 8 px grid, align/distribute, arrow nudges | snapping not switchable; align/distribute only from its own bar |
| Panels | palette (search, categories, sections, components, plugins, AI "generate a block"), layers (drag, rename, hide, lock), inspector, style panel, animation panel | element set (no icon/badge/list), library not organised by layout/elements/components/templates/media, no media tab |
| Collaboration | Yjs room per page (`collab.ts`), per-user `Y.UndoManager`, remote selections, leader autosave | no cursors |
| AI | generate page, generate block, AI plan (typed operations, reviewed before applying), block AI menu | no design-assistant shortcuts on the selection |
| Persistence / publishing | page `PATCH` with CAS version, versions/restore, publish/unpublish, preview links, releases, the `apps/web` renderer | nothing — reused as is |

Constraints kept: no parallel block system, no second collaboration system, no second publishing
path, no schema change, old pages untouched.

## 2. Architecture decision: DOM + CSS, no canvas library

| Option | Verdict |
|---|---|
| **tldraw SDK** | A complete whiteboard with its own shape store and renderer; site blocks would have to become custom shapes mirrored from our tree (two models to keep in sync), and its licence needs a key (or a watermark) in production. Rejected. |
| **Konva / react-konva** | Draws on `<canvas>`: real HTML, CSS, fonts, forms and container queries would not exist on the board — the editor could never show what the renderer publishes. Rejected. |
| **React Flow** | Nodes-and-edges graph editor; pan/zoom is good but artboards are not graph nodes, and every block would be wrapped in a node container. Rejected. |
| **Own DOM + CSS board** ✅ | The artboards render the same React components the live site renders; container queries make each artboard show exactly what a screen of that width shows; all existing overlays, inline editing, drop logic and free-form tools keep working. No new heavy dependency. |

**Coordinates.** World = CSS px of the page; screen = world × zoom + pan. Panning moves one
transformed layer (`translate(x, y)`) directly — no React render. Zooming previews with
`scale()` on that layer while the wheel turns, then commits: artboards are laid out at the new zoom
(`zoom` on the page content, so text stays crisp and DOM rects stay true for the overlays).

**Layout model (the main design rule).** The board is only the workspace. The page is built with
normal document flow, sections, containers, flex and grid (the Layout tab: Section, Container, Grid,
Flexbox row, Columns, Rows, Stack, Spacer), styled per breakpoint. Free positioning is an extra tool:
the *Free-form area* block, whose children are placed by coordinates per breakpoint. A design that
looks right on the board is what the renderer publishes, because it *is* the renderer.

## 3. Components and where they live

| Responsibility (prompt §14) | Implementation |
|---|---|
| Canvas state / element registry / properties / parent–child | `BuilderState.draft.content` (block tree) + `@canon/blocks` registry (`BLOCKS`, `STYLE_PROPS`) |
| Layout engine | the browser: flow, flex, grid, container queries; `compileStyles()` per breakpoint |
| Selection manager | store `selectedIds` / `selectMany`; marquee in `board/board.tsx` + `marqueeSelect()` |
| Drag manager | dnd-kit in `workspace.tsx`, DOM drop resolution `drop.ts`; library items carry whole trees |
| Transform manager | `free-board.tsx` (move/resize/rotate/align/distribute, snap switch) |
| History manager | zundo (solo) / `Y.UndoManager` (live session, per user) — unchanged |
| Viewport manager | `board/geometry.ts` (`zoomAt`, `fitView`, `fitWidthView`, `revealView`) + `Board.applyView` |
| Responsive manager | devices → breakpoint (`breakpointForWidth`); the active artboard sets `store.breakpoint` |
| Collaboration adapter | `collab.ts`: awareness carries `cursor {bp, x, y}` (throttled); remote cursors per artboard |
| Serialization | the existing page API; board layout + view are per-viewer `localStorage` (`canon.board.v1.<pageId>`) |

New files: `builder/board/{board,geometry,library,minimap,context-menu,actions,board-actions}.tsx|ts`,
`ui-blocks/src/icons.tsx`, messages `board-en/ru.ts`.

## 4. What the user gets

- **Board**: dot grid, pan with the wheel, the Hand tool (H), Space+drag or the middle button; zoom
  with Ctrl/⌘+wheel or pinch (around the pointer), Ctrl ±/0, presets, *Zoom to fit* (⇧1),
  *Zoom to selection* (⇧2); minimap (click/drag to navigate); rectangle selection from the empty
  board; right-click menus on blocks and on the board.
- **Artboards**: Desktop 1440, Laptop 1200, Tablet 768, Mobile 390, or a custom width 320–2560; add,
  resize, remove, drag them around by the title. The artboard you click is the one you edit: its
  breakpoint's styles change, the others show the result live. The top-bar breakpoint buttons pick
  (or create) the matching artboard.
- **Edit bar**: copy, paste, duplicate, delete, group, ungroup, forward/backward, align (left,
  centre, right for any block — via its own alignment or `align-self`; top/middle/bottom for
  free-form elements), distribute; toggles for the side panels.
- **Library** (left, searchable across tabs): Layout · Elements (Heading, Paragraph, Rich text,
  Button, Link, Image, Video, Icon, Divider, Badge, List, Numbered list, Quote, Shape) · Components
  (Navbar, Header, Hero, Feature cards, Pricing, Testimonials, FAQ, Gallery, Contact form, CTA,
  Product cards, Blog cards, Footer, saved site components) · Templates (21 whole pages, all section
  presets with tones) · Media (the site's library, upload). Click adds next to the selection; drag
  drops where the indicator shows. *Generate a block* (Canon AI) sits on top.
- **Inspector**: content fields per block type; style panel with layout (flex/grid incl. new
  `align-self`, `justify-self`, `align-content`, `order`, `flex-shrink/basis`, grid rows), size (incl.
  `aspect-ratio`), spacing, typography (incl. italic, wrapping), background (size, position,
  repeat), border, effects (incl. backdrop blur, cursor), position, transform, animation;
  **visibility per breakpoint** chips; **Custom CSS** box (see §6). Images: crop by aspect ratio,
  fit, focal point, overlay.
- **Layers**: unchanged features, plus picking a layer brings the block into view on the board;
  big pages open with sections folded.
- **Distances**: hold Alt with a block selected and hover another — the gaps in px.
- **Collaboration**: live cursors with names on the right artboard, selections outlined in the
  collaborator's colour, edits and per-user undo as before.
- **AI**: Generate page (top bar), Generate a block/section (library), and the Canon AI plan panel
  with one-click design-assistant requests for the selection — *Make it minimal*, *New colour
  palette*, *Better typography*, *Add tasteful animations*, *Adapt for mobile* (phone breakpoints
  only), *Rework the composition*. Results are typed operations you review, then regular blocks.
- **Modes**: *Board* is the default for new editors; *Pro* (the previous full editor) and *Simple*
  (Tilda-like) stay, and a chosen mode is remembered.
- **Page switcher** in the header: jump to another page of the site (each page is its own board).

## 5. Persistence, preview, publishing

Unchanged and reused: autosave (debounced, leader-only in a live session), Ctrl+S, CAS versions,
versions panel with restore, preview links, publish/unpublish, releases. The only fix: opening a page
no longer looks "unsaved" — the collaboration room's copy of an untouched page is recognised as the
saved page (before, every open autosaved an identical version).

## 6. Security notes

- **Custom CSS** is parsed into the existing style layer (`parseCssDeclarations`): only known
  properties with values matching their grammar are kept; `url()`, `expression`, `@import`, braces,
  quotes, script schemes and unknown properties are reported and dropped. The site receives only
  CSS compiled from that layer, scoped to `[data-cn="<block id>"]`.
- New props (`icon.name`, image `ratio/fit/focus/overlay`) are enums validated by the API like all
  block props; the icon set is a fixed map rendered as inline SVG (no external request).
- Board layout and view live in `localStorage` per viewer and are validated on read (`sanitizeDevices`).
- Cursor positions in awareness are numbers and a breakpoint id; names come from the authenticated
  room membership, as for selections.

## 7. Performance (1 500 blocks, two artboards, this machine — `board-perf.json`)

| Gesture | Time | Long tasks (longest) |
|---|---|---|
| Paste 1 500 blocks | 0.67 s | 1 (0.50 s) |
| 30 wheel pans | — | **0** |
| Ctrl+wheel zoom incl. relayout | — | 3 (0.23 s) |
| Select a block | — | 4 (0.09 s) |
| Zoom to selection | — | 5 (0.18 s) |
| Open Layers | 0.8 s | 18 (0.24 s; was 1.47 s before folding big trees) |

Panning never re-renders; artboards render memoised blocks (an edit re-renders one path per
artboard); styles are emitted once per section for all artboards.

## 8. Stage status

| Stage | Status |
|---|---|
| 1 Architecture audit | ✅ this document |
| 2 Infinite canvas core | ✅ pan/zoom/fit/selection zoom, marquee, drag & drop, transform (free-form), grid, snap, guides, distances, minimap |
| 3 Element system | ✅ registry reused; new Icon, Badge, List; image crop/fit/focus/overlay; nesting, grouping |
| 4 Editor interface | ✅ library, inspector (incl. states and attributes), edit bar, layers, context menus, rulers, collapsible panels |
| 5 Layout engine | ✅ flow + flex + grid containers, per-breakpoint layout props; free-form as an option |
| 6 Responsive system | ✅ device artboards, custom widths, per-breakpoint styles and visibility |
| 7 Persistence | ✅ existing API/versions; board layout per viewer |
| 8 Collaboration | ✅ cursors, selections, live edits, per-user undo |
| 9 AI | ✅ generate page/section, design-assistant requests incl. mobile adaptation |
| 10 Renderer integration | ✅ same renderer on the board and the site; preview/publish unchanged; E2E checks the live HTML |
| 11 QA & optimisation | ✅ unit, integration, E2E, perf run; fixes listed in PROGRESS |

### Second pass (iteration 18b)

- **Interaction states**: the style panel edits *Normal*, *Hover*, *Pressed* and *Focus*. States live
  in the same `styles` object (`hover`, `active`, `focus` layers next to the breakpoints), so
  validation, Yjs sync, undo and the API needed no new paths; they compile to `:hover`, `:active`,
  `:focus-visible`. A **Transition** property makes the change smooth.
- **Buttons** style the button itself: colours, background/gradient, border, radius, shadow, type and
  states go to the link element (`[data-cn-el]`), layout and spacing stay on the block; a **Size**
  setting (S/M/L).
- **HTML attributes** (allowlist): anchor id, aria-label, title — validated by the API
  (`blockAttrsSchema`), synced through Yjs, rendered as escaped attribute values; the id is only
  emitted on the site (artboards repeat the page).
- **Drop at a point**: library items dropped into a free-form area land where you release them
  (absolute position on the 8 px grid when snapping).
- **Rulers** (⇧R): page px from the active artboard's corner, the selection's extent highlighted.

### Building the site like a board (iteration 18c)

- **Free placement** (on by default; the move icon in the bottom tools): an object from the
  library goes exactly where you release it. Over a free zone it lands at that point; anywhere
  else a free zone appears in the page right there with the object in it. A click in the library
  drops it in the middle of what you see. Whole bands (sections, hero, CTA, features, FAQ…) still
  go into the page flow between sections.
- **Overlap like shapes**: objects in a free zone are absolutely positioned and may cover each
  other; the stacking order is the layer order (Ctrl+] / Ctrl+[, the edit bar, the context menu).
- **Direct drag**: press any object of a free zone and drag it — no need to select it first; one
  undo step, the 8 px grid when snapping, positions stored for the breakpoint being edited.
- **Zones grow** to fit what you drop or move below their bottom (desktop height, or a min-height
  for smaller screens).
- **Blank board page** (Templates): one big free zone to compose a whole page freely.
- Phones: positions are per breakpoint; on a phone artboard the zone's *Arrange for this screen*
  stacks its objects in reading order, then you adjust.

Not done, on purpose (see BACKLOG): CSS class names (they would reach outside the validated style
layer), arbitrary attributes beyond the allowlist, all pages of a site on one board.
