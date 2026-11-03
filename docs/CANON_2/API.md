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

## Typed operations (library)

Not an HTTP endpoint yet: `applyOperation` / `applyOperations` / `describeOperation` are exported
by `@canon/blocks` for the builder, the API and Canon AI. See ARCHITECTURE.md for the operation
list. AI plans (above) return operations in this vocabulary.

## Section library (library)

`SECTION_PRESETS`, `SECTION_CATEGORIES`, `SECTION_TONES` and `getSectionPreset(key)` from
`@canon/blocks`; `preset.build(locale, tone)` returns a block tree with fresh ids.
