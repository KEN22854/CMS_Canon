import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, startFakeOllama, type TestApp } from './harness';

let t: TestApp;
let ollama: Awaited<ReturnType<typeof startFakeOllama>>;

beforeAll(async () => {
  ollama = await startFakeOllama();
  t = await createTestApp({ OLLAMA_BASE_URL: ollama.url });
});

afterAll(async () => {
  await t.close();
  await ollama.close();
});

const ask = (token: string, content: string, extra: object = {}) =>
  t.http.post('/v1/ai/complete').set(bearer(token)).send({ feature: 'REWRITE', cache: 'none', messages: [{ role: 'user', content }], maxTokens: 64, ...extra });

describe('AI gateway behind real auth', () => {
  it('serves a FREE tenant through the local tier and records the generation', async () => {
    const s = await signUp(t);
    const res = await ask(s.accessToken, 'Make this friendlier');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'ollama/llama3.1:8b', status: 'SUCCEEDED', usage: { inputTokens: 12, outputTokens: 6 } });

    const usage = await t.http.get('/v1/ai/usage').set(bearer(s.accessToken)).expect(200);
    expect(usage.body.totals.requests).toBe(1);
    expect(usage.body.byModel[0]).toMatchObject({ key: 'ollama/llama3.1:8b', tokens: 18 });
    expect(usage.body.limits).toMatchObject({ plan: 'FREE', modelTiers: ['economy', 'local'], requestsPerUserPerMin: 5 });
    expect(usage.body.month.budgetUsd).toBe(5);
  });

  it('refuses models above the plan tier', async () => {
    const s = await signUp(t);
    const res = await ask(s.accessToken, 'hi', { model: 'anthropic/claude-opus-5-5' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AI_MODEL_NOT_ALLOWED');
  });

  it('lists only models the plan can use', async () => {
    const s = await signUp(t);
    const res = await t.http.get('/v1/ai/models').set(bearer(s.accessToken)).expect(200);
    expect(res.body.models.map((m: { key: string }) => m.key)).toEqual(['ollama/llama3.1:8b']);
  });

  it('enforces the per-user rate limit (FREE: 5/min)', async () => {
    const s = await signUp(t);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await ask(s.accessToken, `msg ${i}`)).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });

  it('enforces the concurrency cap (FREE: 2 in flight)', async () => {
    const s = await signUp(t);
    const results = await Promise.all([ask(s.accessToken, '[slow] a'), ask(s.accessToken, '[slow] b'), ask(s.accessToken, '[slow] c')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 429]);
    const rejected = results.find((r) => r.status === 429);
    expect(rejected?.body.error.details.reason).toBe('concurrency');
    // Slots are released: the next call goes through.
    expect((await ask(s.accessToken, 'after')).status).toBe(200);
  });

  it('enforces the monthly token allowance from the plan / overrides', async () => {
    const s = await signUp(t);
    await t.system.tenant.update({ where: { id: s.tenantId }, data: { quota: { aiTokensPerMonth: 80 } } });
    // Settings are cached for 30 s; a fresh tenant row is read on first use, so ask after the update.
    // Pre-flight estimate ≈ 2 input + 64 maxTokens: first fits (66 ≤ 80), second does not (18 used + 66 > 80).
    expect((await ask(s.accessToken, 'one')).status).toBe(200);
    const res = await ask(s.accessToken, 'two');
    expect(res.status).toBe(402);
    expect(res.body.error.details.reason).toBe('tokens');
  });

  it('requires the invoke permission (VIEWER cannot call AI)', async () => {
    const owner = await signUp(t);
    await t.system.tenantMember.update({ where: { tenantId_userId: { tenantId: owner.tenantId, userId: owner.userId } }, data: { role: 'VIEWER' } });
    const refreshed = await t.http.post('/v1/auth/refresh').set('Cookie', owner.cookie).expect(200);
    const res = await ask(refreshed.body.accessToken, 'hi');
    expect(res.status).toBe(403);
  });
});
