# Canon 2.0 — API additions

All endpoints are under `/v1`, need a bearer token (or an API key) and are tenant-scoped. The full
OpenAPI document is served by the API at `/docs` (Swagger) and dumped by `pnpm --dir apps/api openapi`.
This page lists what Canon 2.0 added.

## Global components

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/sites/:siteId/components` | read Page | List the site's components |
| POST | `/sites/:siteId/components` | create Page | Create from `{ name, description?, tree }` |
| GET | `/components/:id` | read Page | One component (working copy + published version) |
| PATCH | `/components/:id` | update Page | `{ version, name?, description?, tree? }`; 409 when `version` is stale |
| POST | `/components/:id/publish` | publish Page | Make the working copy live on every page that uses it |
| DELETE | `/components/:id` | delete Page | Soft delete; instances render nothing from then on |

Response shape:

```json
{
  "id": "cmw…",
  "siteId": "cmw…",
  "name": "Site header",
  "description": null,
  "tree": { "id": "hdr", "type": "group", "props": {}, "children": [] },
  "version": 2,
  "publishedVersion": 1,
  "publishedAt": "2026-11-03T13:20:11.000Z",
  "hasUnpublishedChanges": true,
  "updatedAt": "2026-11-03T13:24:02.000Z"
}
```

`tree` is one block (any type except `column` and `component`), validated like page content.

### Using a component on a page

Put an instance block in the page content:

```json
{ "id": "i1", "type": "component", "props": { "componentId": "cmw…", "overrides": { "brand": { "text": "Acme Docs" } } }, "children": [] }
```

`overrides` maps a block id **inside the component** to a props patch. Delivery returns the
expanded blocks (`i1` becomes the component root, inner ids become `i1-<id>`); headless consumers
of `/v1/delivery/...` therefore never see `component` blocks.

## Canon AI edit plans

`POST /sites/:siteId/ai/plan` — permission `invoke Ai`. Nothing is saved.

```json
{ "instruction": "Make the hero punchier and add an FAQ", "content": { "root": { … } }, "selectedIds": ["hero1"], "locale": "en", "pageId": "cmw…" }
```

Response:

```json
{
  "summary": "A sharper headline and an FAQ about pricing.",
  "operations": [
    { "operation": { "op": "PROPS_UPDATE", "id": "hero1", "patch": { "title": "Ship faster" } }, "label": "Edit Hero: title", "status": "ok" },
    { "operation": { "op": "STYLE_SET", "id": "hero1", "breakpoint": "base", "property": "color", "value": "red;…" }, "label": "…", "status": "rejected", "reason": "Invalid value for color" }
  ],
  "repaired": false,
  "ai": { "model": "anthropic/claude-sonnet-5-5", "costUsd": 0.018, "calls": 1 }
}
```

Accepted operations apply in order to the content that was sent (`applyOperations` from
`@canon/blocks` gives the same result on the client). 502 `AI_BAD_OUTPUT` when the model proposed
nothing; 400 `INVALID_CONTENT` when the sent page is invalid. Requires the `builder.plan_edits`
prompt (`pnpm --dir packages/db seed` adds it to an existing database).

## Redirects

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/sites/:siteId/redirects` | read Page | List rules |
| POST | `/sites/:siteId/redirects` | update Site | `{ fromPath, toPath, statusCode?: 301\|302\|307\|308, note? }` |
| POST | `/sites/:siteId/redirects/import` | update Site | `{ csv }` "from,to[,status]" → `{ imported, errors: [{ line, message }] }` |
| PATCH | `/redirects/:id` | update Site | Change a rule |
| DELETE | `/redirects/:id` | update Site | Remove a rule |

`fromPath`: a path (normalised: lower case, no trailing slash) or a prefix `/old/*`. `toPath`: a path,
`/new/*` (only from a prefix) or an http(s) URL. 400 `INVALID_REDIRECT` / `REDIRECT_LOOP`, 409 for a
duplicate source. Automatic rules (`automatic: true`) are created when a published page moves.

## SEO audit

`GET /sites/:siteId/seo/audit` (read Page) → `{ score, totals: { error, warning, info }, pages: [{ id,
title, path, locale, published, score, words, issues: [{ code, severity, blockId?, detail? }] }],
checkedAt }`. Issue codes are listed in `packages/blocks/src/seo.ts` (`SeoIssueCode`).

## Delivery additions

- `GET /v1/delivery/sites/:siteId/runtime` includes `redirects: [{ from, to, status }]`.
- `GET /v1/delivery/sites/:siteId/page` includes `breadcrumbs: [{ title, path }]`.

## CMS 2.0

- Collection settings (`PATCH /v1/sites/:siteId/collections/:id`, `settings`):
  - `route: { basePath: "/blog", templatePageId }` — entry pages. 400 if the template isn't a page
    of the site or the path is malformed; 409 if another collection uses the path.
  - `views: [{ id, name, q?, status?, tag?, sort, order, filters[] }]` — saved views (max 20).
- `GET /v1/sites/:siteId/collections/:id/entries?filters=[{"field","op","value"}]` — ops `eq`
  (case-insensitive; lists match an element), `contains`, `empty`, `notEmpty`; up to 5, ANDed.
  400 `INVALID_FILTER` for unknown fields.
- `POST /v1/sites/:siteId/collections/:id/entries/bulk` — `{ ids (1–200), action: publish |
  unpublish | archive | delete | addTag | removeTag, tag?, force? }` → `{ done, failed: [{ id, code,
  message }] }`.
- `POST /v1/sites/:siteId/collection-lists/preview` — `{ blocks: [{ id, type: "collection-list",
  props }], locale }` → cards by block id (published entries).
- Delivery: `page` serves entry pages (with `entry: { id, collectionId, slug, basePath }`) and
  every page carries `lists`; `pages` adds `entries: [{ path, locale, updatedAt }]` for sitemaps.

## Releases

- `GET /v1/sites/:siteId/releases`, `POST /v1/sites/:siteId/releases { note? }` (publish Page).
- `GET /v1/sites/:siteId/releases/:id` → release + `changes: { restored, unpublished, missing,
  components, entries }`.
- `POST /v1/sites/:siteId/releases/:id/rollback` (update Site) → `{ restored, unpublished, skipped,
  backup }`. Webhook event `site.rolled_back`.

## CRM

- `GET /v1/sites/:siteId/contacts?q&tag&customers&limit&offset` → `{ items, total, tags }`;
  `GET|PATCH|DELETE /v1/sites/:siteId/contacts/:id` (PATCH: name, phone, tags);
  `POST /v1/sites/:siteId/contacts/:id/notes { text }`. Permission `Contact`.
- `GET|POST /v1/sites/:siteId/automations`, `PATCH|DELETE /v1/sites/:siteId/automations/:id`,
  `GET /v1/sites/:siteId/automations/:id/runs`. Body `{ name, enabled, trigger: { event:
  form.submitted | order.placed | order.status, formId?, status?, minTotal? }, actions: [{ type:
  email_contact, subject, body } | { type: email_team, to, subject, body } | { type: add_tag, tag }] }`.
  Permission `Automation`. Webhook event `order.status`.

## Shop

- Collection settings `commerce: { priceField, stockField?, skuField?, currency, paymentMethods:
  ["cash"|"card_on_delivery"|"transfer"], orderEmail? }` (number/text fields are checked).
- `GET /v1/sites/:siteId/orders?status&q&limit&offset` → `{ items, total, counts }`;
  `GET /v1/sites/:siteId/orders/:id`; `PATCH /v1/sites/:siteId/orders/:id { status, note? }` —
  409 for moves outside NEW → CONFIRMED → PAID → SHIPPED → COMPLETED / CANCELLED. Permission
  `Order` (owners, admins, editors).
- Renderer only: `POST /v1/delivery/sites/:siteId/orders` `{ items: [{ productId, quantity }],
  customer: { name, email, phone?, address?, note? }, paymentMethod, locale?, honeypot?, elapsedMs? }`
  → 201 `{ number, status, currency, total, items }`; errors `PRODUCT_UNAVAILABLE`,
  `OUT_OF_STOCK` (409), `PAYMENT_METHOD`, `MIXED_SHOPS` (400), `REJECTED` (422), `RATE_LIMITED` (429).
- Delivery pages carry `products` and `shop`. Webhook events `order.placed`, `order.cancelled`.

## Typed operations (library)

Not an HTTP endpoint yet: `applyOperation` / `applyOperations` / `describeOperation` are exported
by `@canon/blocks` for the builder, the API and Canon AI. See ARCHITECTURE.md for the operation
list. AI plans (above) return operations in this vocabulary.

## Section library (library)

`SECTION_PRESETS`, `SECTION_CATEGORIES`, `SECTION_TONES` and `getSectionPreset(key)` from
`@canon/blocks`; `preset.build(locale, tone)` returns a block tree with fresh ids.
