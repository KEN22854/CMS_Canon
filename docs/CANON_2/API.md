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

## Typed operations (library)

Not an HTTP endpoint yet: `applyOperation` / `applyOperations` / `describeOperation` are exported
by `@canon/blocks` for the builder, the API and Canon AI. See ARCHITECTURE.md for the operation
list. Stage 5 will add an endpoint that returns an AI plan as operations.

## Section library (library)

`SECTION_PRESETS`, `SECTION_CATEGORIES`, `SECTION_TONES` and `getSectionPreset(key)` from
`@canon/blocks`; `preset.build(locale, tone)` returns a block tree with fresh ids.
