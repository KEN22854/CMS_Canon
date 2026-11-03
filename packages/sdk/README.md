# @canon/sdk

Typed client for the [Canon CMS](https://github.com/KEN22854/CMS_Canon) REST API. Types are
generated from the API's OpenAPI document, and request bodies come from the same Zod schemas the
server validates with, so the client and the server cannot drift apart.

```ts
import { createCanon, CanonError } from '@canon/sdk';

const canon = createCanon({ baseUrl: 'https://api.your-canon.example', apiKey: process.env.CANON_API_KEY });

// Published content (API key scope content:read)
const posts = await canon.content.entries<{ body: string; cover: string }>(siteId, 'blog', { limit: 10, expand: true });
const post = await canon.content.entry(siteId, 'blog', 'hello-world');

// Search and grounded answers
const { hits } = await canon.search(siteId, 'pricing');
const { answer, citations } = await canon.ask(siteId, 'Do you have a free plan?');

// Every other route, fully typed
const { data, error } = await canon.raw.PATCH('/v1/forms/{formId}', { params: { path: { formId } }, body: { isActive: false } });

try {
  await canon.pages.publish(siteId, pageId);
} catch (err) {
  if (err instanceof CanonError && err.code === 'REVIEW_REQUIRED') console.log('Needs an approved review first');
}
```

## Regenerating

```bash
pnpm --filter @canon/api openapi
```

This builds the API, writes `packages/sdk/openapi.json` without starting the server, and
regenerates `src/schema.d.ts`.

The SDK is MIT-licensed so it can be embedded in any frontend; the Canon server is AGPL-3.0.
