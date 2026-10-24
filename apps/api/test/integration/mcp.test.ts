import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, type TestApp } from './harness';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off', ANALYTICS_FLUSH: 'off', ANALYTICS_JOBS: 'off' });
});

afterAll(async () => {
  await t.close();
});

let rpcId = 0;
function rpc(key: string | null, method: string, params: Record<string, unknown> = {}) {
  const req = t.http.post('/v1/mcp').set('accept', 'application/json, text/event-stream').set('content-type', 'application/json');
  if (key) req.set('authorization', `Bearer ${key}`);
  return req.send({ jsonrpc: '2.0', id: ++rpcId, method, params });
}
const call = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await rpc(key, 'tools/call', { name, arguments: args });
  expect(res.status, res.text).toBe(200);
  const result = res.body.result as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(result.isError), data: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) };
};

async function setup() {
  const owner = await signUp(t);
  const h = bearer(owner.accessToken);
  const site = await t.http.post('/v1/sites').set(h).send({ name: 'Agents', defaultLocale: 'en', locales: ['en'] }).expect(201);
  const text = (s: string) => ({ id: `t${s.length}`, type: 'text', props: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] } }, children: [] });
  const page = await t.http.post(`/v1/sites/${site.body.id}/pages`).set(h).send({ title: 'Pricing', slug: 'pricing', content: { root: { id: 'root', type: 'section', props: {}, children: [text('The Pro plan costs $39 per month.')] } } }).expect(201);
  await t.http.post('/v1/canon/facts').set(h).send({ key: 'pro_plan.price', siteId: site.body.id, subject: { type: 'plan', name: 'Pro plan' }, predicate: 'monthly_price', valueType: 'MONEY', value: { amount: 49, currency: 'USD', period: 'month' } }).expect(201);
  const key = async (scopes: string[]) => (await t.http.post('/v1/api-keys').set(h).send({ name: `mcp ${scopes.join(' ')}`, scopes }).expect(201)).body.key as string;
  return { owner, h, siteId: site.body.id as string, pageId: page.body.id as string, key };
}

describe('MCP server', () => {
  it('speaks MCP over stateless Streamable HTTP, authenticated by API key', async () => {
    const c = await setup();
    const key = await c.key(['content:read', 'canon:read']);
    expect((await rpc(null, 'tools/list')).status).toBe(401);
    expect((await t.http.get('/v1/mcp').set('authorization', `Bearer ${key}`)).status).toBe(405);

    const init = await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }).expect(200);
    expect(init.body.result).toMatchObject({ serverInfo: { name: 'canon-cms' }, capabilities: { tools: expect.anything() } });
    expect(init.body.result.instructions).toContain('fact graph');

    const tools = (await rpc(key, 'tools/list').expect(200)).body.result.tools as { name: string }[];
    // A read-only key sees read tools only.
    expect(tools.map((x) => x.name).sort()).toEqual(['get_page', 'lint_text', 'list_facts', 'list_pages', 'list_sites', 'search_content']);
  });

  it('reads content and checks text against Canon facts', async () => {
    const c = await setup();
    const key = await c.key(['content:read', 'canon:read']);
    expect((await call(key, 'list_sites')).data).toEqual([expect.objectContaining({ id: c.siteId, name: 'Agents' })]);
    expect((await call(key, 'list_pages', { siteId: c.siteId })).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: c.pageId, path: '/pricing', status: 'DRAFT' })]));
    const page = (await call(key, 'get_page', { siteId: c.siteId, pageId: c.pageId })).data;
    expect(page.text).toEqual([expect.objectContaining({ text: 'The Pro plan costs $39 per month.' })]);
    const lint = (await call(key, 'lint_text', { siteId: c.siteId, text: 'The Pro plan is just $39 a month!' })).data;
    expect(lint).toMatchObject({ contradictions: 1, spans: [expect.objectContaining({ key: 'pro_plan.price', inSync: false, canonical: '$49/month' })] });
    expect((await call(key, 'list_facts', { q: 'pro' })).data).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'pro_plan.price' })]));

    // Another tenant's ids are not reachable through MCP either.
    const other = await setup();
    const otherKey = await other.key(['content:read']);
    const cross = await call(otherKey, 'get_page', { siteId: c.siteId, pageId: c.pageId });
    expect(cross.isError).toBe(true);
    // Unknown tools are refused.
    const unknown = await rpc(key, 'tools/call', { name: 'create_draft_page', arguments: { siteId: c.siteId, title: 'x', slug: 'x' } });
    expect(unknown.body.error ?? unknown.body.result?.isError).toBeTruthy();
  });

  it('writes only drafts and review branches', async () => {
    const c = await setup();
    const key = await c.key(['content:read', 'content:write', 'canon:read', 'canon:write']);
    const tools = (await rpc(key, 'tools/list').expect(200)).body.result.tools.map((x: { name: string }) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['create_draft_page', 'propose_fact_change']));
    expect(tools).not.toContain('ask'); // no ai:invoke scope

    const draft = (await call(key, 'create_draft_page', { siteId: c.siteId, title: 'Launch notes', slug: 'launch-notes' })).data;
    expect(draft).toMatchObject({ path: '/launch-notes', status: 'DRAFT' });
    const stored = await t.system.page.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.publishedVersion).toBeNull();

    const changed = (await call(key, 'propose_fact_change', { factKey: 'pro_plan.price', siteId: c.siteId, value: { amount: 59, currency: 'USD', period: 'month' }, reason: 'Price increase approved by finance' })).data;
    expect(changed.fact).toMatchObject({ key: 'pro_plan.price', displayValue: '$59/month', version: 2 });
    const audit = await t.system.auditLog.findMany({ where: { tenantId: c.owner.tenantId, actorType: 'api-key' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['page.created', 'fact.value_changed']));
  });
});
