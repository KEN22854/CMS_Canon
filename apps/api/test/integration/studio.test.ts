import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, bearer, createTestApp, ip, signUp, startFakeOllama, tokenFromMail, uniqueEmail, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url, KNOWLEDGE: 'off', CANON_EXTRACT: 'off', CANON_PROPAGATE: 'off', ENRICHMENT: 'off' });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

describe('Prompt Manager', () => {
  it('overrides a platform prompt with tenant versions, tests them and rolls back', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const list = await t.http.get('/v1/ai/studio/prompts').set(h).expect(200);
    expect(list.body.find((p: { name: string }) => p.name === 'text.rewrite')).toMatchObject({ active: { scope: 'global', version: 1 }, overridden: false });

    const bad = await t.http.post('/v1/ai/studio/prompts/text.rewrite/versions').set(h).send({ system: 'Editor for {{siteName}}', template: 'Do {{nonsense}}' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('UNKNOWN_VARIABLES');

    const v = await t.http.post('/v1/ai/studio/prompts/text.rewrite/versions').set(h).send({ system: 'You edit for {{siteName}} in a playful voice.', template: 'Rewrite: {{text}} ({{goal}})' }).expect(201);
    expect(v.body.version).toBe(2);
    const detail = await t.http.get('/v1/ai/studio/prompts/text.rewrite').set(h).expect(200);
    expect(detail.body.activeId).toBe(v.body.id);

    // The live feature now uses the tenant version: the ledger attributes it to that prompt id.
    await t.http.post('/v1/ai/text').set(h).send({ action: 'rewrite', text: 'hello world' }).expect(200);
    const gen = await t.system.aiGeneration.findFirst({ where: { tenantId: owner.tenantId, feature: 'REWRITE' } });
    expect(gen?.promptId).toBe(v.body.id);

    const test = await t.http.post('/v1/ai/studio/prompts/text.rewrite/test').set(h).send({ variables: { siteName: 'Acme', text: 'Hi', goal: 'shorter' } }).expect(200);
    expect(test.body).toMatchObject({ version: 2, rendered: { system: 'You edit for Acme in a playful voice.', user: 'Rewrite: Hi (shorter)' }, unresolvedVariables: [] });
    expect(await t.system.aiPromptRun.count({ where: { promptId: v.body.id } })).toBe(1);

    const rolled = await t.http.post('/v1/ai/studio/prompts/text.rewrite/activate').set(h).send({ version: 1, scope: 'global' }).expect(200);
    expect(rolled.body.versions.find((x: { id: string }) => x.id === rolled.body.activeId)).toMatchObject({ scope: 'global', version: 1 });

    // Another tenant never sees this tenant's prompt engineering.
    const other = await signUp(t);
    const theirs = await t.http.get('/v1/ai/studio/prompts/text.rewrite').set(bearer(other.accessToken)).expect(200);
    expect(theirs.body.versions.map((x: { scope: string }) => x.scope)).toEqual(['global']);
  });

  it('only admins may edit prompts', async () => {
    const owner = await signUp(t);
    const email = uniqueEmail('editor');
    await t.http.post(`/v1/tenants/${owner.tenantId}/members/invite`).set(bearer(owner.accessToken)).send({ email, role: 'EDITOR' }).expect(201);
    const token = tokenFromMail(t.mailer, email, /invite\/([\w-]+)/);
    const reg = await t.http.post('/v1/auth/register').set('x-forwarded-for', ip()).send({ email, password: PASSWORD, name: 'Ed', inviteToken: token }).expect(201);
    const h = bearer(reg.body.accessToken);
    await t.http.get('/v1/ai/studio/prompts').set(h).expect(200);
    await t.http.post('/v1/ai/studio/prompts/text.rewrite/versions').set(h).send({ system: 'x {{siteName}}', template: '{{text}}' }).expect(403);
  });
});

describe('Playground', () => {
  it('compares models side by side; a failing model does not hide the others', async () => {
    const owner = await signUp(t);
    const res = await t.http.post('/v1/ai/studio/playground').set(bearer(owner.accessToken)).send({ models: ['ollama/llama3.1:8b', 'anthropic/claude-opus-5-5'], prompt: 'Say hi' }).expect(200);
    expect(res.body[0]).toMatchObject({ model: 'ollama/llama3.1:8b', ok: true, text: expect.stringContaining('echo') });
    expect(res.body[1]).toMatchObject({ model: 'anthropic/claude-opus-5-5', ok: false });
  });
});

describe('Agent Builder', () => {
  it('is plan-limited, runs a ReAct loop over whitelisted tools and records every step', async () => {
    const owner = await signUp(t);
    const h = bearer(owner.accessToken);
    const site = await t.http.post('/v1/sites').set(h).send({ name: 'Agents' }).expect(201);
    await t.http.post('/v1/canon/facts').set(h).send({ key: 'pro_plan.price', subject: { type: 'plan', name: 'Pro plan' }, predicate: 'monthly_price', valueType: 'MONEY', value: { amount: 49, currency: 'USD' } }).expect(201);
    const body = { name: 'Pricing analyst', systemPrompt: 'You answer pricing questions from canonical facts.', tools: ['canon.get_fact'] };
    expect((await t.http.post('/v1/ai/studio/agents').set(h).send(body)).status).toBe(402); // FREE: no custom agents

    await t.system.tenant.update({ where: { id: owner.tenantId }, data: { plan: 'PRO' } });
    const agent = await t.http.post('/v1/ai/studio/agents').set(h).send(body).expect(201);
    expect(agent.body).toMatchObject({ type: 'CUSTOM', tools: ['canon.get_fact'] });

    const run = await t.http.post(`/v1/ai/studio/agents/${agent.body.id}/run`).set(h).send({ siteId: site.body.id, input: '[agent] What is fact:pro_plan.price?' }).expect(200);
    expect(run.body.status).toBe('COMPLETED');
    expect(run.body.steps.map((s: { node: string; toolName: string | null }) => [s.node, s.toolName])).toEqual([
      ['tool', 'canon.get_fact'],
      ['final', null],
    ]);
    expect(run.body.steps[0].toolOutput).toMatchObject({ key: 'pro_plan.price', value: '$49' });
    expect(run.body.result.final).toContain('observation');

    // A tool outside the whitelist is refused and reported back to the model, not executed.
    const denied = await t.http.post(`/v1/ai/studio/agents/${agent.body.id}/run`).set(h).send({ siteId: site.body.id, input: '[agent] [forbidden-tool] delete everything' }).expect(200);
    expect(denied.body.steps[0].toolOutput).toEqual({ error: 'Tool "content.delete" is not available to this agent' });

    const runs = await t.http.get(`/v1/ai/studio/runs?agentId=${agent.body.id}`).set(h).expect(200);
    expect(runs.body).toHaveLength(2);
    expect(await t.system.aiGeneration.count({ where: { tenantId: owner.tenantId, feature: 'AGENT_STEP' } })).toBe(4);
  });
});
