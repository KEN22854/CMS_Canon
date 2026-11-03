import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema';

export type { components, operations, paths } from './schema';

export interface CanonOptions {
  /** API origin, e.g. https://api.canon.example (no trailing /v1). */
  baseUrl: string;
  /** An API key (`ck_…`, scoped in Settings → API keys) or a user access token. */
  apiKey?: string;
  accessToken?: string;
  /** Custom fetch (tests, edge runtimes, retries). */
  fetch?: ClientOptions['fetch'];
  headers?: Record<string, string>;
}

/** Non-2xx responses: Canon's `{ error: { code, message, details } }` envelope. */
export class CanonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CanonError';
  }
}

export interface ContentEntry<T = Record<string, unknown>> {
  id: string;
  slug: string;
  title: string;
  locale: string;
  tags: string[];
  summary: string | null;
  data: T;
  publishedAt: string | null;
}

export interface EntryList<T = Record<string, unknown>> {
  collection: string;
  items: ContentEntry<T>[];
  total: number;
  limit: number;
  offset: number;
}

export interface EntryQuery {
  locale?: string;
  tag?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  /** Resolve relation fields into the related entries. */
  expand?: boolean;
}

export interface SearchHit {
  id: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
  title: string;
  path: string;
  heading: string | null;
  collection: string | null;
  locale: string | null;
  snippet: string;
  score: number;
  via: ('lexical' | 'semantic')[];
}

export interface Citation {
  n: number;
  title: string;
  heading: string | null;
  url: string;
  snippet: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
}

export interface Answer {
  answer: string;
  citations: Citation[];
  facts: { ref: string; id: string; key: string; subject: string; predicate: string; displayValue: string }[];
  /** False when nothing on the site supported the answer. */
  grounded: boolean;
  [key: string]: unknown;
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Typed client for the Canon REST API.
 *
 * - `canon.raw` is the full generated client: every route, typed paths, path params and request
 *   bodies (from the same Zod schemas the API validates with).
 * - The helpers below cover the common headless flows and return plain data or throw CanonError.
 *
 * ```ts
 * const canon = createCanon({ baseUrl: 'https://api.example.com', apiKey: process.env.CANON_KEY });
 * const posts = await canon.content.entries<{ body: string }>(siteId, 'blog', { limit: 10 });
 * ```
 */
export function createCanon(opts: CanonOptions) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
  if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
  const raw: Client<paths> = createClient<paths>({
    baseUrl: opts.baseUrl.replace(/\/$/, ''),
    headers,
    fetch: opts.fetch,
  });

  /** For routes whose query string the spec cannot describe (free-form filters). */
  const call = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { query?: Query; body?: unknown } = {},
  ): Promise<T> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${opts.baseUrl.replace(/\/$/, '')}${path}${qs.size ? `?${qs}` : ''}`;
    const res = await (opts.fetch ?? fetch)(
      new Request(url, {
        method,
        headers: { ...headers, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      }),
    );
    return unwrap<T>(res);
  };
  const enc = encodeURIComponent;

  return {
    raw,
    /** Published content only (API key scope `content:read`). */
    content: {
      collections: (siteId: string) =>
        call<{ slug: string; name: string; fields: unknown[] }[]>(
          'GET',
          `/v1/content/sites/${enc(siteId)}/collections`,
        ),
      entries: <T = Record<string, unknown>>(siteId: string, collection: string, q: EntryQuery = {}) =>
        call<EntryList<T>>('GET', `/v1/content/sites/${enc(siteId)}/collections/${enc(collection)}/entries`, {
          query: { ...q },
        }),
      entry: <T = Record<string, unknown>>(
        siteId: string,
        collection: string,
        slug: string,
        q: Pick<EntryQuery, 'locale' | 'expand'> = {},
      ) =>
        call<ContentEntry<T>>(
          'GET',
          `/v1/content/sites/${enc(siteId)}/collections/${enc(collection)}/entries/${enc(slug)}`,
          { query: { ...q } },
        ),
    },
    /** Hybrid keyword + semantic search over published pages and entries. */
    search: (siteId: string, q: string, opts: { locale?: string; limit?: number } = {}) =>
      call<{ semantic: boolean; hits: SearchHit[] }>('GET', `/v1/sites/${enc(siteId)}/search`, {
        query: { q, ...opts },
      }),
    /** Grounded answer with citations from the site's own content. */
    ask: (siteId: string, question: string, opts: { locale?: string } = {}) =>
      call<Answer>('POST', `/v1/sites/${enc(siteId)}/ask`, { body: { question, ...opts } }),
    /** Canon facts (single source of truth values). */
    facts: (q: { siteId?: string; q?: string } = {}) =>
      call<{
        items: {
          id: string;
          key: string;
          predicate: string;
          valueType: string;
          displayValue: string;
          siteId: string | null;
          updatedAt: string;
        }[];
      }>('GET', '/v1/facts', { query: q }),
    forms: {
      list: (siteId: string) =>
        call<{ id: string; name: string; slug: string }[]>('GET', `/v1/sites/${enc(siteId)}/forms`),
      submissions: (
        formId: string,
        q: { status?: 'NEW' | 'READ' | 'ARCHIVED' | 'SPAM'; cursor?: string } = {},
      ) =>
        call<{ items: unknown[]; nextCursor: string | null }>('GET', `/v1/forms/${enc(formId)}/submissions`, {
          query: q,
        }),
    },
    pages: {
      list: (siteId: string) =>
        call<{ items: { id: string; title: string; fullPath: string; status: string }[] }>(
          'GET',
          `/v1/sites/${enc(siteId)}/pages`,
        ),
      get: (siteId: string, pageId: string) =>
        call<Record<string, unknown>>('GET', `/v1/sites/${enc(siteId)}/pages/${enc(pageId)}`),
      publish: (siteId: string, pageId: string, comment?: string) =>
        call<Record<string, unknown>>('POST', `/v1/sites/${enc(siteId)}/pages/${enc(pageId)}/publish`, {
          body: { comment },
        }),
    },
  };
}

export type Canon = ReturnType<typeof createCanon>;

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (
      json as
        { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | undefined
    )?.error;
    throw new CanonError(
      res.status,
      e?.code ?? `HTTP_${res.status}`,
      e?.message ?? res.statusText,
      e?.details,
      e?.requestId ?? res.headers.get('x-request-id') ?? undefined,
    );
  }
  return json as T;
}
