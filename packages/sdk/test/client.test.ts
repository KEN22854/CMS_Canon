import { describe, expect, it } from 'vitest';
import { CanonError, createCanon } from '../src';

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    return handler(req);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('@canon/sdk', () => {
  it('sends the API key and builds content queries', async () => {
    const m = mockFetch(() =>
      json({
        collection: 'blog',
        total: 1,
        limit: 5,
        offset: 0,
        items: [{ id: 'e1', slug: 'hello', data: { body: 'Hi' } }],
      }),
    );
    const canon = createCanon({ baseUrl: 'https://api.example.com/', apiKey: 'ck_test', fetch: m.fetch });
    const list = await canon.content.entries<{ body: string }>('site 1', 'blog', {
      limit: 5,
      tag: 'news',
      expand: true,
      locale: undefined,
    });
    expect(list.items[0]!.data.body).toBe('Hi');
    const req = m.calls[0]!;
    expect(req.url).toBe(
      'https://api.example.com/v1/content/sites/site%201/collections/blog/entries?limit=5&tag=news&expand=true',
    );
    expect(req.headers.get('x-api-key')).toBe('ck_test');
  });

  it('posts JSON bodies and surfaces the error envelope', async () => {
    const m = mockFetch(async (req) => {
      expect(req.headers.get('content-type')).toBe('application/json');
      expect(await req.json()).toEqual({ question: 'Price?', locale: 'en' });
      return json(
        {
          error: {
            code: 'QUOTA_EXCEEDED',
            message: 'AI budget used up',
            details: { limit: 5 },
            requestId: 'r1',
          },
        },
        402,
      );
    });
    const canon = createCanon({ baseUrl: 'https://api.example.com', accessToken: 'jwt', fetch: m.fetch });
    const err = await canon.ask('s1', 'Price?', { locale: 'en' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanonError);
    expect(err).toMatchObject({
      status: 402,
      code: 'QUOTA_EXCEEDED',
      message: 'AI budget used up',
      details: { limit: 5 },
      requestId: 'r1',
    });
    expect(m.calls[0]!.headers.get('authorization')).toBe('Bearer jwt');
  });

  it('exposes the generated, fully typed client for every route', async () => {
    const m = mockFetch(() => json({ id: 'f1' }));
    const canon = createCanon({ baseUrl: 'https://api.example.com', apiKey: 'ck_x', fetch: m.fetch });
    // Path params and the request body are typed from the OpenAPI document.
    const { data } = await canon.raw.PATCH('/v1/forms/{formId}', {
      params: { path: { formId: 'f1' } },
      body: { name: 'Contact sales' },
    });
    expect(data).toEqual({ id: 'f1' });
    expect(m.calls[0]!.url).toBe('https://api.example.com/v1/forms/f1');
    expect(m.calls[0]!.method).toBe('PATCH');
  });

  it('returns undefined for 204', async () => {
    const m = mockFetch(() => new Response(null, { status: 204 }));
    const canon = createCanon({ baseUrl: 'https://api.example.com', fetch: m.fetch });
    await expect(canon.forms.submissions('f1')).resolves.toBeUndefined();
  });

  it('moves orders and syncs contacts', async () => {
    const m = mockFetch((req) => json(req.method === 'PATCH' ? { id: 'o1', status: 'SHIPPED' } : { items: [], total: 0, counts: {}, tags: [] }));
    const canon = createCanon({ baseUrl: 'https://api.example.com', apiKey: 'ck_shop', fetch: m.fetch });
    await canon.orders.list('s1', { status: 'PAID', limit: 10 });
    expect(m.calls[0]!.url).toBe('https://api.example.com/v1/sites/s1/orders?status=PAID&limit=10');
    const o = await canon.orders.setStatus('s1', 'o1', 'SHIPPED', 'DHL 123');
    expect(o.status).toBe('SHIPPED');
    expect(m.calls[1]!.method).toBe('PATCH');
    expect(await m.calls[1]!.json()).toEqual({ status: 'SHIPPED', note: 'DHL 123' });
    await canon.contacts.list('s1', { customers: true });
    expect(m.calls[2]!.url).toBe('https://api.example.com/v1/sites/s1/contacts?customers=true');
  });
});
