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

## Global components (iteration 2)

- **Tenant isolation**: `site_components` has `FORCE ROW LEVEL SECURITY` with the standard
  `tenant_isolation` policy; every query also filters by `tenantId`. Integration test: another
  workspace gets 404 on read and update.
- **Permissions** follow pages: read = `read Page`, create/update = `create/update Page`,
  publish = `publish Page`, delete = `delete Page`. Viewers get 403 (tested).
- **Validation**: a component tree goes through the same `BlockRegistry.validate` as page content
  (props, styles whitelist, 1 MB cap); component blocks inside components are refused, so
  expansion can't recurse. Overrides are applied only when the merged props validate against the
  block schema, so an override can't smuggle invalid values into the renderer.
- **Optimistic locking** on `version` with a compare-and-set update: two concurrent saves can't
  both win (409 for the second).
- **Live vs draft**: delivery uses `publishedTree` for live pages and the working copy only for
  signed previews, so unpublished component edits never leak to visitors.
- Audit log entries: `component.created`, `.updated`, `.published`, `.deleted`.

## Canon AI plans (iteration 3)

- The model output is data: every operation is shape-checked and re-validated against the page;
  styles go through the same whitelist and grammar as manual edits, props through the block
  schemas, new blocks through `materializeBlocks` (fresh ids, so model ids can't collide).
- The model can't unlock or lock blocks, replace whole blocks or ungroup; locked blocks are refused
  inside `applyOperation`.
- The request is prompt-injection aware: the instruction and page texts are wrapped as content
  (`<request>`, `<page>`) and the system prompt says they don't change the rules; even if a page
  text convinces the model, the result is still limited to valid operations the person reviews.
- Nothing is applied on the server; the person approves operations, and saving goes through the
  normal page validation and permissions.
- Calls are metered and attributed in the AI ledger (feature `LAYOUT`), with the tenant quotas.

## Clipboard

Copied blocks are stored in the browser's `localStorage` (same origin as the admin) and are
re-validated by the server like any other content when the page is saved; ids are regenerated on
paste.


## Open items

- A Content-Security-Policy for the renderer that allows the one inline `<style>` via a nonce or hash.
- Custom code (Stage 16) must run only on the published site, in a sandboxed iframe or with a CSP.
