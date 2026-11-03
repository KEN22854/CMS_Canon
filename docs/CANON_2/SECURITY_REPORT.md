# Canon 2.0 — security report

Scope of this iteration: everything Canon 2.0 added (style layer, node meta, theme switching,
builder changes). The baseline (tenancy, RLS, RBAC, sessions, webhooks, SSRF guards, SCIM) is
unchanged and covered by the existing integration suites.

## Style layer — CSS injection

Threat: a user (or an AI agent, or a plugin preset) stores a style value that breaks out of its
declaration and injects CSS or markup into every visitor's page.

Controls (`packages/blocks/src/styles.ts`):

1. **Whitelist of properties** (~50). Unknown keys are rejected on save.
2. **Per-property grammars**: lengths, colours (hex, rgb/hsl, theme tokens), enums, numbers,
   shadows and gradients composed only of those parts, restricted grid templates and filters.
3. **Global deny-list before grammars**: `; { } < > \ " ' `` `, `/*`, `url(`, `expression`,
   `javascript:`, `@import`. Images in backgrounds are deliberately not accepted as `url()`.
4. **Validation on the server** in `validatePageContent` (API save path, AI builder, plugin
   presets); invalid documents are refused with issues per path.
5. **The compiler re-validates** every value and emits only whitelisted CSS property names; node
   ids are re-checked against `^[A-Za-z0-9_-]{1,64}$` before being used in selectors.
6. The `<style>` element is rendered with `dangerouslySetInnerHTML`, which is safe only because of
   (3) — no value can contain `<`. Unit tests assert that `</style><script>`, `}body{…}`,
   `url(javascript:…)` and `expression()` are rejected.

## Node flags

`hidden` nodes are not rendered by the public renderer at all (not merely `display:none`), so
hidden draft content does not leak in the HTML. `locked` is an editor convenience, not a
permission: the API does not enforce it (any editor can unlock). This is intentional and documented.

## Theme boot script

The inline script in `apps/admin/src/app/layout.tsx` is a static string that only reads
`localStorage` and `matchMedia`; no user data is interpolated into it.

## Open items

- A Content-Security-Policy for the renderer that allows the one inline `<style>` via a nonce or hash.
- Custom code (Stage 16) must run only on the published site, in a sandboxed iframe or with a CSP.
