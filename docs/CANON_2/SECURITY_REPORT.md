# Canon 2.0 — security report

Scope of this iteration: everything Canon 2.0 added (style layer, node meta, theme switching,
builder changes). The baseline (tenancy, RLS, RBAC, sessions, webhooks, SSRF guards, SCIM) is
unchanged and covered by the existing integration suites.

## Infinite canvas (iteration 18)

| Area | Finding | Status |
|---|---|---|
| Custom CSS box | Free text typed by editors | Parsed into the style layer only (`parseCssDeclarations`): known properties, grammar-checked values; `url()`, `@import`, braces, quotes, unknown properties reported and dropped; tests in blocks and API |
| New block props | Icon names, image crop/fit/focus/overlay | Enums validated by the API; icons are a fixed inline-SVG map, no external request |
| Board layout in localStorage | Tampered or old data | `sanitizeDevices` drops anything out of range; worst case the default layout |
| Awareness cursors | Spoofed positions | Numbers and a breakpoint id only; names from the authenticated room membership |
| HTML attributes (18b) | Attribute injection, duplicate ids | Strict allowlist (`id` by pattern, `aria-label`, `title` ≤ 150 chars), unknown keys refused (400); React escapes values; the id is emitted on the site only |
| Interaction states (18b) | New style layers | `hover`/`active`/`focus` are the only extra layer names; same property grammars; rules stay scoped to the block |
| CSS classes | Requested by the prompt | Not added: they would let a page target CSS outside the validated layer — in BACKLOG as a decision |

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

## SEO platform (iteration 4)

- **Open redirects**: a target is a same-site path or an explicit http(s) URL typed by a site
  manager (`update Site`); `javascript:`, `data:` and protocol-relative `//host` sources are
  refused. Visitors can't create rules; the query string is copied only to same-site targets'
  missing query.
- **Loops** are refused on save (cycle detection over exact rules); a rule can't point at itself.
- Redirects table: RLS `tenant_isolation`, a CHECK on the status code, unique per site and source.
- **JSON-LD** is generated from published content only and escaped (`<` → `\u003c`) so a page
  text can't break out of the script element; noindex pages and previews get none.
- The 404 route handler validates the host header before using it.

## Templates, external media, animation (iteration 6)

- **Third-party templates** were downloaded once (with the owner's approval) and converted
  offline; their files are parsed as text, no script from them runs, at build time or in the
  product. Only text, classes mapped to an allowlist of style properties (each value validated
  by the style layer), and image URLs survive; event handlers, inline styles and unknown
  attributes are dropped. Every converted tree passes `validatePageContent` in a unit test.
- **External media**: https only, no credentials in the URL, host must be on an allowlist
  (images.unsplash.com, picsum.photos, fastly.picsum.photos, images.pexels.com and video stills
  from assets.mixkit.co; videos from assets.mixkit.co,
  videos.pexels.com), videos must end in .mp4/.webm. Validated server-side with the page.
  Images load with `referrerPolicy="no-referrer"` and lazily. A page's visitors fetch these
  files from the third party — documented for site owners; a later step copies media into the
  site's storage.
- **Animation** values are enums and bounded numbers (strict schema), so nothing user-typed
  reaches CSS.
- Licences: MIT texts of both libraries are kept next to the generated data and in
  THIRD_PARTY_NOTICES.md.

## CMS 2.0 (iteration 7)

- **Drafts never leak**: entry pages and collection lists read only `entry_versions` at
  `publishedVersion`, on the system role, pinned to the resolved site. The builder preview
  checks the workspace owns the site before those queries.
- **Template mould** pages aren't reachable by their own path (raw tokens) nor listed.
- **Injection**: token values are inserted as text into page data, rendered by React (escaped);
  rich text fields keep the closed node set; media links from entries pass the same host
  allowlist as typed ones (tested with an off-list host). Field filters use bind parameters and a
  field-name allowlist (the collection schema); a value like `x' OR '1'='1` is just a value
  (tested).
- **Bulk actions** reuse the single-entry paths: CASL checks per entry (a viewer gets
  FORBIDDEN per entry), the review gate before each publish, required-field validation; at most
  200 ids per call; audited as one `entry.bulk.<action>` record.

## Shop (iteration 8)

- **Prices can't be forged**: the browser sends product ids and quantities only (extra keys are
  dropped); unit prices come from published snapshots; amounts are integers in cents; CHECKs on
  the table refuse negative amounts and odd currencies.
- **No overselling**: stock is decremented by `UPDATE … WHERE stock >= qty` inside the order
  transaction; a failing line rolls back the whole order (tested: 1 left, 2 asked → 409, nothing
  changed).
- **Abuse**: orders only from the site's own hosts (internal or verified domain), 10 per IP per
  10 minutes, honeypot, minimum fill time; products of other sites or draft products are refused.
- **Personal data**: orders are readable by owners, admins and editors only (CASL + RLS);
  IPs stored truncated; webhooks carry number and amount, not the customer.
- **No card data**: payment is offline; online payments are not enabled without the owner's
  provider and keys.

## CRM (iteration 9)

- Contacts and their timelines are personal data: RLS, CASL (owners, admins, editors; only
  owners/admins erase), audit on erasure. Erasure removes the contact and timeline; orders and
  submissions are kept (they are business records) — documented for site owners.
- Automations can't call URLs (no SSRF surface; webhooks keep their own private-address checks);
  they email the contact or a fixed team address only. Template variables are a closed set; texts
  are escaped into the HTML part. One run per automation and event (no mail storms on retries).
- **Open item**: refresh-token rotation + a reload mid-refresh can log a user out (fail-closed).
  Relaxing it is a deliberate trade-off — see BACKLOG.

## Releases (iteration 10)

- Rollback changes the whole public site, so it needs `update Site` (owners, admins) and a
  confirmation in the UI; it is audited with counts; it is undoable (automatic backup release).
- Releases are tenant data (RLS); capture is bounded (20 000 live entries).

## Migration (iteration 12)

- The export is untrusted input: read as text, DOCTYPE/ENTITY refused (no XXE, no billion laughs),
  20 MB / 2 000 items; HTML → closed rich-text node set (no scripts, styles, frames, forms, event
  attributes, `javascript:`/`data:` links) — tested.
- No server-side fetching of the old site's images (SSRF); they are reported.
- Import needs a role that can create collections and publish pages; audited with counts.

## Telegram (iteration 14)

- Bot tokens: validated with Telegram before saving, encrypted at rest, never returned (a hint
  of the last 4 characters), not logged; managing the integration needs `update Site`.
- Outbound calls go only to `TELEGRAM_API_URL` (fixed in config, not user-provided), 10 s timeout.
- Messages contain order and form data the owner chose to receive; sent as plain text.

## Pass over iterations 7–16 (iteration 17)

| Area | Finding | Status |
|---|---|---|
| Entry pages | Links built from entry data could become `//host` (protocol-relative) or carry a script scheme via a whole-token link | Fixed: links re-checked after filling; `//` refused on save; tests |
| Checkout | Per-IP limit trusts the renderer's X-Forwarded-For | Mitigated: site-wide cap (300 / 10 min); proxy allowlist in BACKLOG |
| Funnels | Unbounded date range scans raw events | Fixed: 400 days per request |
| Migration | Regex-based reader on a 20 MB upload | Checked: lazy item matching, no DOCTYPE/ENTITY, item cap; OK |
| Telegram | Token handling | Checked: encrypted, never returned or logged, fixed API base; OK |
| Bulk / views / filters | Injection, permissions | Checked: bind parameters, field allowlist, per-entry CASL; OK |
| Orders / CRM | Personal data exposure | Checked: owner/admin/editor only, API-key scopes separate, IP truncation; OK |
| Releases | Destructive action | Checked: update Site, confirmation, automatic backup release; OK |

## Clipboard

Copied blocks are stored in the browser's `localStorage` (same origin as the admin) and are
re-validated by the server like any other content when the page is saved; ids are regenerated on
paste.


## Open items

- A Content-Security-Policy for the renderer that allows the one inline `<style>` via a nonce or hash.
- Custom code (Stage 16) must run only on the published site, in a sandboxed iframe or with a CSP.
