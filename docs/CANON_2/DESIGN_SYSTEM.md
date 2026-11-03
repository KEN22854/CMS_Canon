# Canon design system

Source of truth: `apps/admin/src/app/globals.css` (tokens), `apps/admin/tailwind.config.ts`
(Tailwind mapping), `apps/admin/src/components/ui.tsx` (primitives), `apps/admin/src/lib/theme.ts`
(theme switching).

## Themes

Dark is the default. Light is a complete theme, not an inversion. The user toggles
Dark → Light → System in the user menu; the choice lives in `localStorage` (`canon.theme`), and an
inline script sets `html[data-theme]` before first paint so there is no flash.

## Colour tokens

| Token | Tailwind | Dark | Light | Use |
|---|---|---|---|---|
| `--background` | `bg-background` | #0B0D12 | #FFFFFF | app canvas |
| `--card` | `bg-card` | #121620 | #F7F8FB | surfaces, panels, cards |
| `--muted` / `--secondary` | `bg-muted` | #191F2B | #EEF0F5 | secondary surface, hover, inputs groups |
| `--border` | `border` | #282F3D | #DFE3EB | dividers, outlines |
| `--primary` | `bg-primary` | #8B7CFF | #5B4BE0 | primary actions, selection, focus ring |
| `--accent` | `bg-accent` | #42C8E8 | #1592B0 | secondary accent, data highlights |
| `--success` | `text-success` | #29C58B | #1A8A60 | success states |
| `--warning` | `text-warning` | #E9B45B | #B26E14 | warnings |
| `--destructive` | `text-destructive` | #EF6B73 | #D93644 | errors, destructive actions |
| `--foreground` | `text-foreground` | #F5F6FA | #0F1320 | primary text |
| `--muted-foreground` | `text-muted-foreground` | #929BAE | #5B6476 | secondary text |

Contrast: primary buttons use dark text on #8B7CFF in the dark theme and white text on #5B4BE0 in
the light theme; both pass WCAG AA for body text.

## Scales

- **Radius**: `--radius` 10 px → `rounded-lg`; `rounded-md` 8 px; `rounded-sm` 6 px; pills `rounded-full`.
- **Shadows**: `shadow-sm` (controls), `shadow` / `shadow-md` (cards, popovers), `shadow-lg`
  (dialogs, floating panels). Shadows are tinted by `--shadow-color` per theme.
- **Spacing**: Tailwind 4 px scale. Panels use 16 px (`p-4`) padding, cards 20 px (`p-5`), page
  gutters 16 px on mobile and 32 px on desktop.
- **Type**: system font stack (no downloads). Page title 24/600, section title 16/600, body 14/400,
  captions 12 and 11 px. Monospace via `font-mono` for keys and code.
- **Motion**: 150–200 ms colour/opacity transitions; `prefers-reduced-motion` disables animation.

## Primitives (`components/ui.tsx`)

Button (default, secondary, outline, ghost, destructive, link; sizes sm/default/lg/icon; `loading`),
Input, Select, Label, Card (+Header/Title/Description/Content), Alert (info/error/success/warning),
Badge, FieldError, Progress, **Skeleton** (shimmer placeholder) and **EmptyState** (icon, title,
one-line explanation, next action). Notifications use `sonner` toasts.

## Rules

- Never hard-code colours in components; use the tokens (`bg-card`, `text-muted-foreground`…).
- Icons are Lucide, 16 px in controls, 20 px in empty states. No emoji as icons.
- Every list has loading (Skeleton), empty (EmptyState) and error (Alert tone="error") states.
